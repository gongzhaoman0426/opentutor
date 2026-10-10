import { createHash } from 'node:crypto';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { toString } from 'mdast-util-to-string';
import type { Root, RootContent } from 'mdast';
import type { Asset, Chapter, Diagnostic, ImageOccurrence, SourceBlock, SourceDocument } from './schema';

export function parseSource(markdown: string, assets: Asset[] = [], chapters?: Chapter[]): SourceDocument {
  if (chapters?.length) {
    if (chapters.reduce((sum, chapter) => sum + chapter.markdown.length, 0) > 300000) throw new Error('项目素材超过 300,000 字符，请拆分项目。');
    if (new Set(chapters.map(c => c.id)).size !== chapters.length) throw new Error('章节 ID 重复');
    const blocks: SourceBlock[] = [];
    const imageOccurrences: ImageOccurrence[] = [];
    const diagnostics: Diagnostic[] = [];
    const sharedDefinitions = new Map<string, string>();
    for (const chapter of chapters) {
      const tree = unified().use(remarkParse).parse(chapter.markdown) as Root;
      for (const node of tree.children) if (node.type === 'definition' && !sharedDefinitions.has(node.identifier.toLowerCase())) sharedDefinitions.set(node.identifier.toLowerCase(), node.url);
    }
    const indexed = chapters.map(chapter => {
      if (!chapter.markdown.trim()) {
        diagnostics.push({ code: 'EMPTY_CHAPTER', severity: 'warning', message: `章节“${chapter.title}”暂无正文，已跳过，补充内容后可重新生成。` });
        return { ...chapter, blockIds: [] };
      }
      const parsed = parseSingleSource(chapter.markdown, assets, chapter.id, chapter.title, sharedDefinitions);
      const meaningful = parsed.blocks.some(b => b.type !== 'heading' && b.type !== 'definition');
      if (!meaningful) {
        diagnostics.push({ code: 'EMPTY_CHAPTER', severity: 'warning', message: `章节“${chapter.title}”只有标题，已跳过，不生成虚构内容。` });
        return { ...chapter, blockIds: [] };
      }
      const content = parsed.blocks.filter(b => b.type !== 'definition');
      blocks.push(...content);
      imageOccurrences.push(...(parsed.imageOccurrences ?? [])); diagnostics.push(...parsed.diagnostics);
      return { ...chapter, blockIds: content.map(b => b.id) };
    });
    if (!blocks.length) throw new Error('所有章节都没有可呈现的正文或图片，请先填写至少一章。');
    const title = markdown.trim() ? titleFromMarkdown(markdown) : chapters[0].title;
    return { title, hash: createHash('sha256').update(JSON.stringify(chapters)).digest('hex'), blocks, diagnostics, chapters: indexed, imageOccurrences };
  }
  return parseSingleSource(markdown, assets);
}

function titleFromMarkdown(markdown: string): string {
  const tree = unified().use(remarkParse).parse(markdown) as Root;
  const title = tree.children.find(node => node.type === 'heading');
  return title ? toString(title).slice(0, 120) : '未命名项目';
}

function parseSingleSource(markdown: string, assets: Asset[], chapterId?: string, chapterTitle?: string, sharedDefinitions = new Map<string, string>()): SourceDocument {
  if (!markdown.trim()) throw new Error('素材为空，请先输入 Markdown 内容。');
  if (markdown.length > 300000) throw new Error('素材超过 300,000 字符，请按章节分成多个项目。');
  // Reference nodes are only recognized by mdast when definitions participate in the same parse.
  // Append inherited definitions for parsing, then exclude their synthetic ranges from source blocks.
  const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
  const originalTree = parser.parse(markdown) as Root;
  const localKeys = new Set(originalTree.children.filter(node => node.type === 'definition').map(node => node.identifier.toLowerCase()));
  const inherited = [...sharedDefinitions].filter(([key]) => !localKeys.has(key)).map(([key, url]) => `[${key.replace(/[\\\[\]]/g, '\\$&')}]: <${url.replace(/>/g, '%3E').replace(/\n/g, '%0A')}>`).join('\n');
  const tree = inherited ? parser.parse(`${markdown}\n\n${inherited}`) as Root : originalTree;
  let chapter = '导入';
  const occurrences = new Map<string, number>();
  const diagnostics: Diagnostic[] = [];
  const imageOccurrences: ImageOccurrence[] = [];
  const definitions = new Map([...sharedDefinitions, ...originalTree.children.filter(n => n.type === 'definition').map(n => [n.identifier.toLowerCase(), n.url] as [string, string])]);
  const blocks = tree.children.filter(node => (node.position?.start.offset ?? 0) < markdown.length).map((node: RootContent) => {
    const start = node.position?.start.offset ?? 0;
    const end = node.position?.end.offset ?? start;
    const raw = markdown.slice(start, end);
    const text = toString(node) || raw;
    if (node.type === 'heading') chapter = text;
    const fingerprint = createHash('sha256').update(raw).digest('hex').slice(0, 12);
    const occurrence = (occurrences.get(fingerprint) ?? 0) + 1;
    occurrences.set(fingerprint, occurrence);
    const id = `${chapterId ? `chapter_${chapterId}_` : ''}block_${fingerprint}_${occurrence}`;
    if (node.type === 'html') diagnostics.push({ code: 'HTML_AS_TEXT', severity: 'warning', sourceBlockId: id, message: '原始 HTML 仅作为文字资料处理，不执行脚本或嵌入内容。' });
    if (node.type === 'code' && node.lang === 'mermaid') diagnostics.push({ code: 'MERMAID_FALLBACK', severity: 'warning', sourceBlockId: id, message: 'Mermaid 将转成步骤或关系文字；当前版本不执行 Mermaid 源码。' });
    const visit = (child: Record<string, unknown>) => {
      if (child.type === 'image' || child.type === 'imageReference') {
        const url = child.type === 'image' ? String(child.url ?? '') : definitions.get(String(child.identifier).toLowerCase()) || '';
        const resolved = resolveAsset(url, assets);
        if (!resolved.asset) diagnostics.push({ code: resolved.ambiguous ? 'AMBIGUOUS_SOURCE_IMAGE' : 'MISSING_SOURCE_IMAGE', severity: 'error', sourceBlockId: id, message: resolved.ambiguous ? `图片名称不唯一：${url}。请使用 asset://图片ID 明确引用。` : `图片未上传：${url || String(child.identifier)}。请补充同名素材或插入已上传图片。` });
        else {
          const alt = String(child.alt ?? '');
          const caption = String(child.title ?? '') || alt;
          const position = child.position as { start?: { offset?: number }; end?: { offset?: number } } | undefined;
          imageOccurrences.push({ id: `${id}_image_${imageOccurrences.filter(o => o.sourceBlockId === id).length + 1}`, assetId: resolved.asset.id, sourceBlockId: id, chapterId: chapterId || 'legacy', alt, caption, ...(position?.start?.offset !== undefined && position?.end?.offset !== undefined ? { start: position.start.offset, end: position.end.offset } : {}) });
        }
      }
      if (Array.isArray(child.children)) for (const nested of child.children) visit(nested as Record<string, unknown>);
    };
    visit(node as unknown as Record<string, unknown>);
    return { id, type: node.type, text, markdown: raw, start, end, chapter: chapterTitle || chapter, ...(chapterId ? { chapterId } : {}) };
  });
  if (!blocks.length) throw new Error('未找到可呈现的内容。');
  const titleNode = tree.children.find(n => n.type === 'heading');
  return { title: chapterTitle || (titleNode ? toString(titleNode).slice(0, 120) : '未命名项目'), hash: createHash('sha256').update(markdown).digest('hex'), blocks, diagnostics, imageOccurrences };
}

export function findAsset(source: string, assets: Asset[]): Asset | undefined {
  return resolveAsset(source, assets).asset;
}
function resolveAsset(source: string, assets: Asset[]): { asset?: Asset; ambiguous?: boolean } {
  if (/^https?:\/\//i.test(source)) return {};
  let name = source.replace(/^\.\//, '');
  try { name = decodeURIComponent(name); } catch { return {}; }
  const canonical = /^asset:\/\/([a-f0-9-]{36})$/i.exec(name);
  if (name.startsWith('asset://') && !canonical) return {};
  const direct = assets.filter(a => a.id === (canonical?.[1] || name) || a.url === source);
  if (direct.length === 1) return { asset: direct[0] };
  if (direct.length > 1) return { ambiguous: true };
  const named = assets.filter(a => a.name === name);
  const matches = named.length ? named : assets.filter(a => a.name === name.split('/').at(-1));
  return matches.length === 1 ? { asset: matches[0] } : { ambiguous: matches.length > 1 };
}
