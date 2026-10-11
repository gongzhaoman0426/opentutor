import { createHash } from 'node:crypto';
import { crc32, deflateRawSync } from 'node:zlib';
import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { importMarkdownArchive, prepareMarkdownImport } from '../src/server/markdown-import';
import { uploadImage, discardUploadedImages } from '../src/server/artifacts';
import { MARKDOWN_IMPORT_LIMITS as limits } from '../src/shared/markdown-import';

vi.mock('../src/server/artifacts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/server/artifacts')>();
  return { ...actual, uploadImage: vi.fn(), discardUploadedImages: vi.fn() };
});

interface ZipItem { name: string; body?: string | Buffer; flags?: number; mode?: number; size?: number; crc?: number }
/** Real ZIP headers exercise the decoder, including metadata it must distrust. */
function zip(items: ZipItem[]): Buffer {
  const local: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const item of items) {
    const name = Buffer.from(item.name); const data = Buffer.from(item.body || ''); const compressed = deflateRawSync(data);
    const checksum = item.crc ?? crc32(data); const size = item.size ?? data.length; const flags = 0x800 | (item.flags || 0);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(flags, 6); header.writeUInt16LE(8, 8);
    header.writeUInt32LE(checksum, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(size, 22); header.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(0x314, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(flags, 8); entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(checksum, 16); entry.writeUInt32LE(compressed.length, 20); entry.writeUInt32LE(size, 24); entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(((item.mode ?? (item.name.endsWith('/') ? 0x41ed : 0x81a4)) << 16) >>> 0, 38); entry.writeUInt32LE(offset, 42);
    local.push(header, name, compressed); central.push(entry, name); offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(items.length, 8); end.writeUInt16LE(items.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#22bbff' } }).png().toBuffer();
const alternatePng = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#ee4411' } }).png().toBuffer();
const md = (markdown: string, images: ZipItem[] = []) => zip([{ name: '讲义/chapter.md', body: markdown }, ...images]);

beforeEach(() => {
  vi.clearAllMocks();
  let sequence = 0;
  vi.mocked(uploadImage).mockImplementation(async (bytes, name) => {
    const id = `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
    return { id, name, mime: 'image/png', url: `/api/artifacts/${id}`, hash: createHash('sha256').update(bytes).digest('hex'), width: 16, height: 16 };
  });
  vi.mocked(discardUploadedImages).mockResolvedValue();
});

describe('chapter Markdown ZIP import', () => {
  it('imports one nested Markdown file, resolves paths from its location and rewrites only image URLs', async () => {
    const markdown = '# 文稿\r\n\r\n![A](../images/a.png "图 A")\r\n\r\n![B](./images/a.png)\r\n\r\n[普通链接](https://example.com)';
    const result = await importMarkdownArchive(zip([
      { name: '素材/' }, { name: '素材/notes/chapter.MARKDOWN', body: markdown },
      { name: '素材/images/a.png', body: png }, { name: '素材/notes/images/a.png', body: alternatePng },
      { name: '素材/unused.svg', body: '<svg/>' },
    ]));
    expect(result.rootFolder).toBe('素材'); expect(result.markdownPath).toBe('素材/notes/chapter.MARKDOWN');
    expect(result.assets).toHaveLength(2); expect(result.assets[0].hash).not.toBe(result.assets[1].hash);
    expect(result.markdown).toBe(markdown.replace('../images/a.png', `asset://${result.assets[0].id}`).replace('./images/a.png', `asset://${result.assets[1].id}`));
  });

  it('supports Unicode normalization, spaces, percentage encoding, entities and escaped parentheses', async () => {
    const markdown = '![中文](<图片/空 格.png>)\n![编码](图片/%E7%A9%BA%20%E6%A0%BC.png)\n![百分号](100%25.png)\n![括号](a\\(1\\).png)\n![实体](a&amp;b.png)\n![重音](café.png)\n![符号](q%3F%23.png)';
    const result = await importMarkdownArchive(md(markdown, [
      { name: '讲义/图片/空 格.png', body: png }, { name: '讲义/100%.png', body: png }, { name: '讲义/a(1).png', body: png },
      { name: '讲义/a&b.png', body: png }, { name: '讲义/cafe\u0301.png', body: png }, { name: '讲义/q?#.png', body: png },
    ]));
    expect(result.assets).toHaveLength(6);
    expect(result.markdown.match(/asset:\/\//g)).toHaveLength(7);
    expect(result.markdown).toContain(`![中文](<asset://${result.assets[0].id}>)`);
    expect(result.markdown).toContain(`![编码](asset://${result.assets[0].id})`);
  });

  it('handles reference images and multiline blockquotes, keeping titles and ordinary shared links intact', async () => {
    const markdown = '> ![跨行](\n> <images/a.png> "说明")\n\n![引用][FIG]\n![FIG][]\n![FIG]\n\n[fig]: <images/a.png> "原始图注"\n\n[普通链接][shared]\n![**强调**][shared]\n\n> [shared]:\n>   <images/a.png> "共用\\\"标题"';
    const result = await importMarkdownArchive(md(markdown, [{ name: '讲义/images/a.png', body: png }]));
    const url = `asset://${result.assets[0].id}`;
    expect(result.assets).toHaveLength(1);
    expect(result.markdown).toContain(`> ![跨行](\n> <${url}> "说明")`);
    expect(result.markdown).toContain(`[fig]: <${url}> "原始图注"`);
    expect(result.markdown).toContain('![引用][FIG]\n![FIG][]\n![FIG]');
    expect(result.markdown).toContain(`[普通链接][shared]\n![**强调**](${url} "共用\\\"标题")`);
    expect(result.markdown).toContain('> [shared]:\n>   <images/a.png> "共用\\\"标题"');
  });

  it('ignores metadata and leaves examples in code, inline code and math unchanged', async () => {
    const markdown = '# 示例\n\n```md\n![缺图](absent.png)\n<img src="not-present.png">\n```\n\n`![缺图][unknown]`\n\n\\![这是一段文字]\n\n$$\n![math]\n$$\n';
    const result = await importMarkdownArchive(md(markdown, [
      { name: '__MACOSX/讲义/._chapter.md', body: 'ignored' }, { name: '讲义/.DS_Store' }, { name: 'Thumbs.db' },
      { name: '讲义/nested/._extra.md', body: 'not a second markdown' },
    ]));
    expect(result.markdown).toBe(markdown); expect(result.assets).toEqual([]); expect(uploadImage).not.toHaveBeenCalled();
  });

  it('accepts UTF-8 BOM and an empty Markdown chapter without inventing content', async () => {
    expect((await importMarkdownArchive(md('\ufeff# 标题'))).markdown).toBe('\ufeff# 标题');
    const result = await importMarkdownArchive(md('\ufeff![simple](img.png)', [{ name: '讲义/img.png', body: png }]));
    expect(result.markdown).toBe(`\ufeff![simple](asset://${result.assets[0].id})`);
    expect((await importMarkdownArchive(md(''))).markdown).toBe('');
  });

  it('preserves a long BOM prefix without recursive stack growth', async () => {
    const prefix = '\ufeff'.repeat(10000);
    const result = await importMarkdownArchive(md(`${prefix}![simple](img.png)`, [{ name: '讲义/img.png', body: png }]));
    expect(result.markdown).toBe(`${prefix}![simple](asset://${result.assets[0].id})`);
  });

  it('rewrites the outer image URL when its alt text contains Markdown links or images', async () => {
    for (const markdown of ['![a [linked](https://example.com)](img.png)', '![a ![nested](other.png)](img.png)']) {
      const result = await importMarkdownArchive(md(markdown, [{ name: '讲义/img.png', body: png }]));
      expect(result.markdown).toBe(markdown.replace('](img.png)', `](asset://${result.assets[0].id})`));
      expect(result.assets).toHaveLength(1);
    }
  });

  it.each([
    ['![图][missing]', 'MARKDOWN_IMAGE_REFERENCE'], ['![**格式**][missing]', 'MARKDOWN_IMAGE_REFERENCE'], ['![missing]', 'MARKDOWN_IMAGE_REFERENCE'],
    ['![图片](a missing.png)', 'MARKDOWN_IMAGE_REFERENCE'], ['<img src="a.png">', 'MARKDOWN_HTML_IMAGE'],
    ['![图片](a.png)', 'MARKDOWN_IMAGE_MISSING'], ['![图片](A.png)', 'MARKDOWN_IMAGE_MISSING'],
  ])('rejects missing or unsupported image syntax: %s', async (markdown, code) => {
    await expect(importMarkdownArchive(md(markdown, [{ name: '讲义/b.png', body: png }]))).rejects.toMatchObject({ code });
    expect(uploadImage).not.toHaveBeenCalled();
  });

  it.each(['https://example.com/a.png', '//example.com/a.png', 'data:image/png;base64,ABC', 'asset://abc', '/a.png', '../a.png', '../../讲义/a.png', 'C:/a.png', 'a.png?v=1', 'a.png#part', 'a%ZZ.png', '%2Fetc%2Fpasswd', '..%2f..%2fa.png', 'a%5Cb.png'])('rejects non-relative or escaping image URL %s', async url => {
    await expect(importMarkdownArchive(md(`![图](${url})`))).rejects.toMatchObject({ code: 'MARKDOWN_IMAGE_PATH' });
    expect(uploadImage).not.toHaveBeenCalled();
  });

  it.each([
    [{ name: 'chapter.md', body: '# 根目录下的文件' }],
    [{ name: 'one/a.md' }, { name: 'two/a.png', body: png }],
    [{ name: 'one/' }],
  ])('rejects ZIPs without one top-level folder and one document', async (...entries) => {
    await expect(prepareMarkdownImport(zip(entries as ZipItem[]))).rejects.toMatchObject({ code: expect.stringMatching(/MARKDOWN_ZIP_(ROOT|DOCUMENT_COUNT)/) });
  });

  it('counts Markdown files across the entire tree and ignores extension case', async () => {
    await expect(prepareMarkdownImport(zip([{ name: 'root/a.md' }, { name: 'root/deep/B.Markdown' }]))).rejects.toMatchObject({ code: 'MARKDOWN_ZIP_DOCUMENT_COUNT', params: { count: 2 } });
  });

  it.each(['../escape.md', '/absolute.md', 'C:/absolute.md', 'root/../a.md', 'root/a\\b.md', 'root/./a.md', 'root//a.md'])('rejects unsafe ZIP entry %s', async name => {
    await expect(prepareMarkdownImport(zip([{ name, body: '#' }]))).rejects.toMatchObject({ code: expect.stringMatching(/^MARKDOWN_ZIP_(INVALID|PATH)$/) });
  });

  it('rejects encrypted files, symlinks, duplicate normalized names and impossible file parents', async () => {
    for (const [entries, code] of [
      [[{ name: 'root/a.md', flags: 1 }], 'MARKDOWN_ZIP_ENCRYPTED'],
      [[{ name: 'root/a.md', mode: 0xa1ff }], 'MARKDOWN_ZIP_SPECIAL_FILE'],
      [[{ name: 'root/a.md' }, { name: 'root/a.md' }], 'MARKDOWN_ZIP_DUPLICATE'],
      [[{ name: 'root/café.md' }, { name: 'root/cafe\u0301.md' }], 'MARKDOWN_ZIP_DUPLICATE'],
      [[{ name: 'root/a.md' }, { name: 'root/a.md/pic.png' }], 'MARKDOWN_ZIP_PATH'],
    ] as [ZipItem[], string][]) await expect(prepareMarkdownImport(zip(entries))).rejects.toMatchObject({ code });
  });

  it('validates UTF-8 and CRC rather than accepting partial or corrupted input', async () => {
    await expect(prepareMarkdownImport(Buffer.from('not a ZIP'))).rejects.toMatchObject({ code: 'MARKDOWN_ZIP_INVALID' });
    await expect(prepareMarkdownImport(zip([{ name: 'root/a.md', body: Buffer.from([0xff, 0xfe, 0x80]) }]))).rejects.toMatchObject({ code: 'MARKDOWN_UTF8' });
    await expect(prepareMarkdownImport(zip([{ name: 'root/a.md', body: '# hello', crc: 1 }]))).rejects.toMatchObject({ code: 'MARKDOWN_ZIP_INVALID' });
    await expect(prepareMarkdownImport(zip([{ name: 'root/a.md', body: '# hello', size: 1 }]))).rejects.toMatchObject({ code: 'MARKDOWN_ZIP_INVALID' });
  });

  it('rejects a forged central-directory count or size that hides another Markdown file', async () => {
    const archive = zip([{ name: 'root/main.md' }, { name: 'root/hidden.md' }]);
    archive.writeUInt16LE(1, archive.length - 22 + 8); archive.writeUInt16LE(1, archive.length - 22 + 10);
    await expect(prepareMarkdownImport(archive)).rejects.toMatchObject({ code: 'MARKDOWN_ZIP_INVALID' });
    archive.writeUInt32LE(46 + Buffer.byteLength('root/main.md'), archive.length - 22 + 12);
    await expect(prepareMarkdownImport(archive)).rejects.toMatchObject({ code: 'MARKDOWN_ZIP_INVALID' });
  });

  it('accepts a ZIP64 directory even for a small compliant package', async () => {
    const archive = md('# ZIP64'); const oldEnd = archive.subarray(archive.length - 22); const offset = archive.length - 22;
    const end64 = Buffer.alloc(56); end64.writeUInt32LE(0x06064b50); end64.writeBigUInt64LE(44n, 4); end64.writeUInt16LE(45, 12); end64.writeUInt16LE(45, 14);
    end64.writeBigUInt64LE(1n, 24); end64.writeBigUInt64LE(1n, 32); end64.writeBigUInt64LE(BigInt(oldEnd.readUInt32LE(12)), 40); end64.writeBigUInt64LE(BigInt(oldEnd.readUInt32LE(16)), 48);
    const locator = Buffer.alloc(20); locator.writeUInt32LE(0x07064b50); locator.writeBigUInt64LE(BigInt(offset), 8); locator.writeUInt32LE(1, 16);
    const end = Buffer.from(oldEnd); end.writeUInt16LE(0xffff, 8); end.writeUInt16LE(0xffff, 10); end.writeUInt32LE(0xffffffff, 12); end.writeUInt32LE(0xffffffff, 16);
    const result = await prepareMarkdownImport(Buffer.concat([archive.subarray(0, offset), end64, locator, end]));
    expect(result.markdown).toBe('# ZIP64');
  });

  it('bounds compressed size, declared expansion, entry count and Markdown size', async () => {
    await expect(prepareMarkdownImport(Buffer.alloc(limits.archiveBytes + 1))).rejects.toMatchObject({ code: 'MARKDOWN_ZIP_SIZE' });
    await expect(prepareMarkdownImport(zip([{ name: 'root/a.md', size: limits.expandedBytes + 1 }]))).rejects.toMatchObject({ code: 'MARKDOWN_ZIP_EXPANDED' });
    await expect(prepareMarkdownImport(zip(Array.from({ length: 1001 }, (_, index) => ({ name: `root/${index}.png` }))))).rejects.toMatchObject({ code: 'MARKDOWN_ZIP_ENTRIES' });
    await expect(prepareMarkdownImport(zip([{ name: 'root/a.md', size: limits.markdownBytes + 1 }]))).rejects.toMatchObject({ code: 'MARKDOWN_ZIP_FILE_SIZE' });
    await expect(prepareMarkdownImport(md('a'.repeat(limits.markdownCharacters + 1)))).rejects.toMatchObject({ code: 'MARKDOWN_TOO_LONG' });
  });

  it('enforces referenced-image count and each image size before publishing', async () => {
    const names = Array.from({ length: 51 }, (_, index) => `image-${index}.png`);
    await expect(importMarkdownArchive(md(names.map(name => `![图](${name})`).join('\n'), names.map(name => ({ name: `讲义/${name}`, body: png }))))).rejects.toMatchObject({ code: 'MARKDOWN_IMAGE_COUNT' });
    await expect(importMarkdownArchive(md('![图](huge.png)', [{ name: '讲义/huge.png', size: limits.imageBytes + 1 }]))).rejects.toMatchObject({ code: 'MARKDOWN_ZIP_FILE_SIZE' });
    expect(uploadImage).not.toHaveBeenCalled();
  });

  it('fully decodes every image before publishing, including late corrupt images and animation', async () => {
    const animatedWebp = await sharp(Buffer.from([255, 0, 0, 255, 0, 0, 255, 255]), { raw: { width: 1, height: 2, pageHeight: 1, channels: 4 } }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
    const chunk = Buffer.alloc(20); chunk.writeUInt32BE(8); chunk.write('acTL', 4); chunk.writeUInt32BE(2, 8); chunk.writeUInt32BE(crc32(chunk.subarray(4, 16)), 16);
    const animatedPng = Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]);
    for (const bad of [Buffer.from('<svg/>'), png.subarray(0, png.length - 20), animatedWebp, animatedPng]) {
      await expect(importMarkdownArchive(md('![有效](good.png)\n![损坏](bad.png)', [{ name: '讲义/good.png', body: png }, { name: '讲义/bad.png', body: bad }]))).rejects.toMatchObject({ code: 'MARKDOWN_IMAGE_INVALID', params: { path: '讲义/bad.png' } });
      expect(uploadImage).not.toHaveBeenCalled();
    }
  });

  it('rolls back only newly published assets when a later publish fails', async () => {
    vi.mocked(uploadImage).mockResolvedValueOnce({ id: '00000000-0000-4000-8000-000000000001', name: 'a.png', mime: 'image/png', url: '/api/artifacts/test', hash: 'hash', width: 16, height: 16 }).mockRejectedValueOnce(new Error('database unavailable'));
    await expect(importMarkdownArchive(md('![A](a.png)\n![B](b.png)', [{ name: '讲义/a.png', body: png }, { name: '讲义/b.png', body: png }]))).rejects.toThrow('database unavailable');
    expect(discardUploadedImages).toHaveBeenCalledExactlyOnceWith(['00000000-0000-4000-8000-000000000001']);
  });

  it('checks expanded asset URLs against the Markdown limit before publishing', async () => {
    const markdown = 'a'.repeat(limits.markdownCharacters - 20) + '\n![A](a.png)';
    await expect(importMarkdownArchive(md(markdown, [{ name: '讲义/a.png', body: png }]))).rejects.toMatchObject({ code: 'MARKDOWN_TOO_LONG' });
    expect(uploadImage).not.toHaveBeenCalled();
  });
});
