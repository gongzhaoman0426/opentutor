import path from 'node:path';
import { crc32 } from 'node:zlib';
import { fromBuffer, type Entry, type ZipFile } from 'yauzl';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { parse, postprocess, preprocess } from 'micromark';
import type { Definition, Image, ImageReference, Root, RootContent } from 'mdast';
import type { Asset } from '../shared/schema';
import { MARKDOWN_IMPORT_LIMITS as limits, type MarkdownImportResult } from '../shared/markdown-import';
import { discardUploadedImages, uploadImage, validateImage } from './artifacts';
import { AppError } from './errors';

interface ArchiveFile { entry: Entry; path: string; directory: boolean }
interface Range { start: number; end: number }
interface ImageReplacement extends Range { imagePath: string; inlineReference?: { label: string; title?: string | null } }
interface PreparedImport { markdown: string; markdownPath: string; rootFolder: string; images: Map<string, Buffer>; replacements: ImageReplacement[] }

const invalidArchive = (message = 'ZIP 文件损坏或格式不受支持，请重新压缩文件夹') => new AppError(422, 'MARKDOWN_ZIP_INVALID', message);
const invalidPath = (filePath: string) => new AppError(422, 'MARKDOWN_ZIP_PATH', `压缩包路径无效：${filePath}。请使用单一文件夹压缩，不要包含绝对路径、反斜杠或 .. 路径`, { path: filePath });
const imagePathError = (filePath: string) => new AppError(422, 'MARKDOWN_IMAGE_PATH', `图片必须使用指向压缩包根文件夹内文件的相对路径：${filePath || '（空路径）'}`, { path: filePath });
const rangeOf = (node: { position?: { start: { offset?: number }; end: { offset?: number } } }): Range => ({ start: node.position?.start.offset ?? 0, end: node.position?.end.offset ?? 0 });

function archivePath(entry: Entry): { filePath: string; directory: boolean; ignored: boolean } {
  const filePath = entry.fileName.normalize('NFC');
  const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
  if (entry.isEncrypted()) throw new AppError(422, 'MARKDOWN_ZIP_ENCRYPTED', `不支持加密 ZIP：${filePath}`, { path: filePath });
  if (mode && mode !== 0x8000 && mode !== 0x4000) throw new AppError(422, 'MARKDOWN_ZIP_SPECIAL_FILE', `压缩包不能包含符号链接或特殊文件：${filePath}`, { path: filePath });
  if (!filePath || filePath.startsWith('/') || /^[a-zA-Z]:/.test(filePath) || /[\\\u0000-\u001f\u007f]/.test(filePath)) throw invalidPath(filePath);
  const directory = filePath.endsWith('/');
  const normalized = directory ? filePath.slice(0, -1) : filePath;
  const segments = normalized.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) throw invalidPath(filePath);
  if (mode === 0x4000 && !directory) throw invalidPath(filePath);
  const ignored = segments.some(segment => segment === '__MACOSX' || segment === '.DS_Store' || segment === 'Thumbs.db' || segment.startsWith('._'));
  return { filePath: normalized, directory, ignored };
}

async function openArchive(bytes: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    fromBuffer(bytes, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true }, (error, zip) => error ? reject(invalidArchive()) : resolve(zip));
  });
}

function centralDirectory(bytes: Buffer): Range {
  // yauzl intentionally trusts the EOCD entry count. Verify that the entries
  // actually consume the directory as well, so a forged smaller count cannot
  // hide a second Markdown file at the end of an otherwise readable ZIP.
  let endRecord = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 22 - 65535); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { endRecord = offset; break; }
  }
  if (endRecord < 0) throw invalidArchive();
  let start = bytes.readUInt32LE(endRecord + 16);
  let size = bytes.readUInt32LE(endRecord + 12);
  let trailerStart = endRecord;
  if (endRecord >= 20 && bytes.readUInt32LE(endRecord - 20) === 0x07064b50) {
    const offset = Number(bytes.readBigUInt64LE(endRecord - 12));
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + 56 > endRecord - 20 || bytes.readUInt32LE(offset) !== 0x06064b50) throw invalidArchive();
    const recordSize = Number(bytes.readBigUInt64LE(offset + 4));
    if (!Number.isSafeInteger(recordSize) || offset + 12 + recordSize !== endRecord - 20) throw invalidArchive();
    start = Number(bytes.readBigUInt64LE(offset + 48));
    size = Number(bytes.readBigUInt64LE(offset + 40));
    trailerStart = offset;
  }
  const end = start + size;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > trailerStart) throw invalidArchive();
  // PKWARE permits an optional digital signature after the file headers.
  const signatureEnd = (offset: number) => offset + 6 <= trailerStart && bytes.readUInt32LE(offset) === 0x05054b50 ? offset + 6 + bytes.readUInt16LE(offset + 4) : offset;
  if (signatureEnd(end) !== trailerStart) throw invalidArchive();
  return { start, end };
}

async function archiveFiles(zip: ZipFile, bytes: Buffer, directoryRange: Range): Promise<Map<string, ArchiveFile>> {
  if (zip.entryCount > limits.entries) throw new AppError(413, 'MARKDOWN_ZIP_ENTRIES', '压缩包最多包含 1,000 个文件和目录');
  return new Promise((resolve, reject) => {
    const files = new Map<string, ArchiveFile>();
    const names = new Set<string>();
    let expanded = 0; let directoryBytes = 0;
    zip.on('error', () => reject(invalidArchive()));
    zip.on('end', () => {
      let consumed = directoryRange.start + directoryBytes;
      if (consumed + 6 <= directoryRange.end && bytes.readUInt32LE(consumed) === 0x05054b50) consumed += 6 + bytes.readUInt16LE(consumed + 4);
      if (consumed !== directoryRange.end) reject(invalidArchive()); else resolve(files);
    });
    zip.on('entry', (entry: Entry) => {
      try {
        directoryBytes += 46 + entry.fileNameLength + entry.extraFieldLength + entry.fileCommentLength;
        if (directoryRange.start + directoryBytes > directoryRange.end) throw invalidArchive();
        expanded += entry.uncompressedSize;
        if (!Number.isSafeInteger(expanded) || expanded > limits.expandedBytes) throw new AppError(413, 'MARKDOWN_ZIP_EXPANDED', '压缩包展开后总大小不能超过 150 MiB');
        const { filePath, directory, ignored } = archivePath(entry);
        if (names.has(filePath)) throw new AppError(422, 'MARKDOWN_ZIP_DUPLICATE', `压缩包包含重复路径：${filePath}`, { path: filePath });
        names.add(filePath);
        if (!ignored) files.set(filePath, { entry, path: filePath, directory });
        zip.readEntry();
      } catch (error) { reject(error); }
    });
    zip.readEntry();
  });
}

async function readEntry(zip: ZipFile, file: ArchiveFile, limit: number): Promise<Buffer> {
  if (file.entry.uncompressedSize > limit) throw new AppError(413, 'MARKDOWN_ZIP_FILE_SIZE', `压缩包中的文件过大：${file.path}`, { path: file.path });
  try {
    const stream = await zip.openReadStreamPromise(file.entry);
    const chunks: Buffer[] = [];
    let size = 0;
    let checksum = 0;
    for await (const data of stream) {
      const chunk = Buffer.from(data);
      size += chunk.length;
      if (size > limit) { stream.destroy(); throw new AppError(413, 'MARKDOWN_ZIP_FILE_SIZE', `压缩包中的文件过大：${file.path}`, { path: file.path }); }
      checksum = crc32(chunk, checksum);
      chunks.push(chunk);
    }
    if (size !== file.entry.uncompressedSize || checksum !== file.entry.crc32) throw invalidArchive(`ZIP 文件校验失败：${file.path}`);
    return Buffer.concat(chunks);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw invalidArchive(`无法读取 ZIP 中的文件：${file.path}`);
  }
}

function resolveImagePath(url: string, markdownPath: string, rootFolder: string): string {
  // URL suffixes are not part of a local filename. Literal ?, # and % in names
  // are supported when percent-encoded; decoding is deliberately performed once.
  if (!url || /[?#\\\u0000-\u001f\u007f]/.test(url) || url.startsWith('/') || /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(url)) throw imagePathError(url);
  let decoded: string;
  try { decoded = decodeURIComponent(url).normalize('NFC'); } catch { throw imagePathError(url); }
  if (!decoded || decoded.startsWith('/') || /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(decoded) || /[\\\u0000-\u001f\u007f]/.test(decoded)) throw imagePathError(url);
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(markdownPath), decoded));
  if (!resolved.startsWith(`${rootFolder}/`)) throw imagePathError(url);
  return resolved;
}

function collectReplacements(markdown: string, markdownPath: string, rootFolder: string): ImageReplacement[] {
  // Both CommonMark parsers strip a leading BOM before assigning offsets.
  // Keep the original byte-order mark in the imported source and compensate.
  if (markdown.startsWith('\ufeff')) {
    let prefix = 1; while (markdown[prefix] === '\ufeff') prefix++;
    return collectReplacements(markdown.slice(prefix), markdownPath, rootFolder).map(value => ({ ...value, start: value.start + prefix, end: value.end + prefix }));
  }
  const tree = unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(markdown) as Root;
  const nodes: RootContent[] = [];
  const walk = (node: Root | RootContent) => { if (node.type !== 'root') nodes.push(node); if ('children' in node) for (const child of node.children) walk(child as RootContent); };
  walk(tree);
  const definitions = new Map<string, Definition>();
  for (const node of nodes) if (node.type === 'definition' && !definitions.has(node.identifier.toLowerCase())) definitions.set(node.identifier.toLowerCase(), node);
  const linkedDefinitions = new Set(nodes.filter(node => node.type === 'linkReference').map(node => node.identifier.toLowerCase()));
  const imageNodes = nodes.filter((node): node is Image | ImageReference => node.type === 'image' || node.type === 'imageReference');
  const events = postprocess(parse().document().write(preprocess()(markdown, 'utf8', true)));
  const destinations = events.flatMap(([event, token]) => event === 'enter' && (token.type === 'resourceDestinationString' || token.type === 'definitionDestinationString') ? [{ start: token.start.offset, end: token.end.offset }] : []);
  const labels = events.flatMap(([event, token]) => event === 'enter' && token.type === 'label' ? [{ start: token.start.offset, end: token.end.offset }] : []);
  const replacements = new Map<number, ImageReplacement>();
  for (const node of imageNodes) {
    const definition = node.type === 'imageReference' ? definitions.get(node.identifier.toLowerCase()) : undefined;
    const url = node.type === 'image' ? node.url : definition?.url || '';
    const imagePath = resolveImagePath(url, markdownPath, rootFolder);
    const target = rangeOf(definition || node);
    if (node.type === 'imageReference' && linkedDefinitions.has(node.identifier.toLowerCase())) {
      // A definition can also power ordinary hyperlinks. Preserve those links
      // by converting only its image occurrences to inline image syntax.
      const range = rangeOf(node);
      const label = labels.find(value => value.start === range.start && value.end <= range.end);
      if (!label) throw new AppError(422, 'MARKDOWN_IMAGE_SYNTAX', '图片引用格式无法识别，请使用标准 Markdown 图片语法');
      replacements.set(range.start, { ...range, imagePath, inlineReference: { label: markdown.slice(label.start, label.end), title: definition?.title } });
    } else {
      // An image alt label may itself contain Markdown links. The outer
      // image's destination follows all destinations inside that label.
      const destination = destinations.findLast(value => value.start >= target.start && value.end <= target.end);
      if (!destination) throw new AppError(422, 'MARKDOWN_IMAGE_SYNTAX', '图片路径无法识别，请使用标准 Markdown 图片语法');
      replacements.set(destination.start, { ...destination, imagePath });
    }
  }

  // Unresolved reference images are emitted as text by CommonMark. Do not
  // silently import them without a corresponding image or reference definition.
  // Mask real images and code first so documentation examples stay untouched.
  const masked = markdown.split('');
  for (const node of nodes) {
    if (node.type === 'html' && /<\s*img\b/i.test(node.value)) throw new AppError(422, 'MARKDOWN_HTML_IMAGE', '请把 HTML <img> 改为 Markdown 图片语法：![说明](相对路径)');
    if (['image', 'imageReference', 'code', 'inlineCode', 'html', 'math', 'inlineMath', 'definition'].includes(node.type)) {
      const { start, end } = rangeOf(node);
      for (let index = start; index < end; index++) masked[index] = ' ';
    }
  }
  const visible = masked.join('');
  for (let index = 0; index < visible.length - 1; index++) if (visible[index] === '!' && visible[index + 1] === '[') {
    let escapes = 0; for (let before = index - 1; before >= 0 && visible[before] === '\\'; before--) escapes++;
    if (escapes % 2 === 0) {
      const snippet = markdown.slice(index, Math.min(index + 100, markdown.indexOf('\n', index) < 0 ? markdown.length : markdown.indexOf('\n', index)));
      throw new AppError(422, 'MARKDOWN_IMAGE_REFERENCE', `图片语法或引用定义不完整：${snippet}。请检查图片路径及引用定义；作为普通文本时请转义感叹号`, { reference: snippet });
    }
  }
  return [...replacements.values()];
}

/** Read and validate the whole import before any durable artifact is created. */
export async function prepareMarkdownImport(bytes: Uint8Array): Promise<PreparedImport> {
  if (!bytes.length || bytes.length > limits.archiveBytes) throw new AppError(413, 'MARKDOWN_ZIP_SIZE', '请选择 1 B 到 25 MiB 的 ZIP 压缩包');
  const buffer = Buffer.from(bytes);
  const directory = centralDirectory(buffer);
  const zip = await openArchive(buffer);
  try {
    const files = await archiveFiles(zip, buffer, directory);
    const roots = new Set([...files.values()].map(file => file.path.split('/')[0]));
    if (roots.size !== 1 || [...files.values()].some(file => !file.directory && !file.path.includes('/'))) throw new AppError(422, 'MARKDOWN_ZIP_ROOT', 'ZIP 必须由一个文件夹压缩而来，且只能包含一个顶层文件夹');
    for (const file of files.values()) {
      const parts = file.path.split('/');
      for (let count = 1; count < parts.length; count++) {
        const parent = files.get(parts.slice(0, count).join('/'));
        if (parent && !parent.directory) throw invalidPath(file.path);
      }
    }
    const rootFolder = [...roots][0];
    const markdownFiles = [...files.values()].filter(file => !file.directory && /\.(md|markdown)$/i.test(file.path));
    if (markdownFiles.length !== 1) throw new AppError(422, 'MARKDOWN_ZIP_DOCUMENT_COUNT', `整个文件夹中必须有且只有一个 Markdown 文件（.md 或 .markdown），当前找到 ${markdownFiles.length} 个`, { count: markdownFiles.length });
    const document = markdownFiles[0];
    const markdownBytes = await readEntry(zip, document, limits.markdownBytes);
    let markdown: string;
    try { markdown = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(markdownBytes); } catch { throw new AppError(422, 'MARKDOWN_UTF8', 'Markdown 文件必须使用 UTF-8 编码，请重新保存后再打包'); }
    if (markdown.length > limits.markdownCharacters) throw new AppError(413, 'MARKDOWN_TOO_LONG', 'Markdown 文件不能超过 300,000 字符');
    const replacements = collectReplacements(markdown, document.path, rootFolder);
    const imagePaths = [...new Set(replacements.map(value => value.imagePath))];
    if (imagePaths.length > limits.images) throw new AppError(413, 'MARKDOWN_IMAGE_COUNT', '一个压缩包最多引用 50 张不同的图片');
    const images = new Map<string, Buffer>();
    for (const imagePath of imagePaths) {
      const file = files.get(imagePath);
      if (!file || file.directory) throw new AppError(422, 'MARKDOWN_IMAGE_MISSING', `找不到 Markdown 引用的图片：${imagePath}。请检查相对路径和文件名大小写`, { path: imagePath });
      const image = await readEntry(zip, file, limits.imageBytes);
      try { await validateImage(image); }
      catch (error) { throw new AppError(error instanceof AppError ? error.status : 415, 'MARKDOWN_IMAGE_INVALID', `图片无效或格式不支持：${imagePath}。请使用 15 MiB 以内、不超过 4,000 万像素的静态 PNG、JPEG 或 WebP 图片`, { path: imagePath }); }
      images.set(imagePath, image);
    }
    return { markdown, markdownPath: document.path, rootFolder, images, replacements };
  } finally { zip.close(); }
}

export async function importMarkdownArchive(bytes: Uint8Array): Promise<MarkdownImportResult> {
  const prepared = await prepareMarkdownImport(bytes);
  const rewrite = (idForPath: (imagePath: string) => string) => {
    let markdown = prepared.markdown;
    for (const replacement of [...prepared.replacements].sort((a, b) => b.start - a.start)) {
      let text = `asset://${idForPath(replacement.imagePath)}`;
      if (replacement.inlineReference) {
        const { label, title } = replacement.inlineReference;
        const escapedTitle = title?.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        text = `${label}(${text}${title ? ` "${escapedTitle}"` : ''})`;
      }
      markdown = markdown.slice(0, replacement.start) + text + markdown.slice(replacement.end);
    }
    return markdown;
  };
  // UUIDs have a fixed width: reject an oversized rewritten document before
  // registering any image, even when the original text was just below the cap.
  if (rewrite(() => '00000000-0000-4000-8000-000000000000').length > limits.markdownCharacters) throw new AppError(413, 'MARKDOWN_TOO_LONG', '替换图片路径后 Markdown 超过 300,000 字符，请缩短正文或减少图片引用');
  const assets: Asset[] = [];
  const byPath = new Map<string, Asset>();
  try {
    for (const [imagePath, image] of prepared.images) {
      const asset = await uploadImage(image, path.posix.basename(imagePath));
      assets.push(asset); byPath.set(imagePath, asset);
    }
    const markdown = rewrite(imagePath => byPath.get(imagePath)!.id);
    return { markdown, assets, markdownPath: prepared.markdownPath, rootFolder: prepared.rootFolder };
  } catch (error) {
    await discardUploadedImages(assets.map(asset => asset.id));
    throw error;
  }
}
