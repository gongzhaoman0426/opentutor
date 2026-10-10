import { describe, expect, it } from 'vitest';
import { createEmptyChapter, getProjectChapters, getChapterSourceKey, joinChapterMarkdown, splitMarkdownChapters } from '../src/shared/chapters';
import { defaultSettings, SettingsSchema, type Asset, type GenerationSettings } from '../src/shared/schema';

describe('editable lecture chapters', () => {
  it('uses H2 chapters below a single course title and retains the title', () => {
    const markdown = '# 课程标题\n\n## 第一章\n第一部分\n\n## 第二章\n第二部分';
    const chapters = splitMarkdownChapters(markdown);
    expect(chapters.map(c => c.title)).toEqual(['第一章', '第二章']);
    expect(chapters[0].markdown).toContain('# 课程标题');
    expect(joinChapterMarkdown(chapters)).toBe(markdown);
    expect(splitMarkdownChapters(markdown).map(c => c.id)).toEqual(chapters.map(c => c.id));
  });
  it('keeps introductory prose and splits multiple H1 chapters', () => {
    const markdown = '导入说明\n\n# 第一章\n内容 A\n\n## 小节\n细节\n\n# 第二章\n内容 B';
    const chapters = splitMarkdownChapters(markdown);
    expect(chapters.map(c => c.title)).toEqual(['导入', '第一章', '第二章']);
    expect(joinChapterMarkdown(chapters)).toBe(markdown);
  });
  it('ignores fenced headings including longer backticks, tildes and an unclosed block', () => {
    const markdown = '# 第一章\n\n````markdown\n# 代码里的标题\n```\n## 仍在代码里\n````\n\n~~~text\n# 波浪代码标题\n~~~\n\n# 第二章\n\n```\n# 未闭合代码';
    const chapters = splitMarkdownChapters(markdown);
    expect(chapters.map(c => c.title)).toEqual(['第一章', '第二章']);
    expect(joinChapterMarkdown(chapters)).toBe(markdown);
  });
  it('supports setext headings and CRLF without losing source text', () => {
    const markdown = '第一章\r\n======\r\n\r\n内容\r\n\r\n第二章\r\n======\r\n\r\n内容';
    const chapters = splitMarkdownChapters(markdown);
    expect(chapters.map(c => c.title)).toEqual(['第一章', '第二章']);
    expect(chapters.map(c => c.markdown).join('')).toBe(markdown);
  });
  it('uses Markdown structure for multiline titles, thematic breaks and quoted code', () => {
    const markdown = '多行\n章节标题\n=====\n\n正文\n\n# 第二章\n---\n\n> ```\n> # 引用代码标题\n> ```';
    const chapters = splitMarkdownChapters(markdown);
    expect(chapters).toHaveLength(2);
    expect(chapters[0].title).toBe('多行\n章节标题');
    expect(chapters[1].title).toBe('第二章');
    expect(chapters.map(c => c.markdown).join('')).toBe(markdown);
  });
  it('preserves meaningful indentation while canonicalizing chapter separators', () => {
    const chapters = [createEmptyChapter('第一章'), createEmptyChapter('第二章')];
    chapters[0].markdown = '\n\n    print("indented code")\n\n';
    chapters[1].markdown = '\n第二段\n';
    expect(joinChapterMarkdown(chapters)).toBe('    print("indented code")\n\n第二段');
  });
  it('gives repeated sections distinct stable IDs and adapts empty legacy projects', () => {
    const repeated = '# 同名\n正文\n\n# 同名\n正文';
    const chapters = splitMarkdownChapters(repeated);
    expect(new Set(chapters.map(c => c.id)).size).toBe(2);
    const old = { markdown: '   ' }; const first = getProjectChapters(old); const second = getProjectChapters(old);
    expect(first).toEqual(second); expect(first).toHaveLength(1); expect(old.markdown).toBe('   ');
    const a = createEmptyChapter(); const b = createEmptyChapter(); expect(a.id).not.toBe(b.id);
  });
  it('tracks referenced cross-chapter definitions and real asset hashes, leaving unrelated prose independent', () => {
    const a = { id: 'a', title: '图片章', markdown: '正文\n\n![配图][figure]' };
    const b = { id: 'b', title: '引用章', markdown: '[figure]: first.png\n\n其他正文' };
    const asset: Asset = { id: '3da6feef-0562-4d83-883c-d0e7d3400e03', name: 'first.png', mime: 'image/png', url: '/api/artifacts/3da6feef-0562-4d83-883c-d0e7d3400e03', hash: 'first-bytes', width: 10, height: 20 };
    const p = { chapters: [a, b], markdown: '', settings: defaultSettings, assets: [asset] };
    const key = getChapterSourceKey(p, a);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(getChapterSourceKey({ ...p, chapters: [a, { ...b, markdown: '[figure]: first.png\n\n改变的无关正文' }] }, a)).toBe(key);
    expect(getChapterSourceKey({ ...p, chapters: [a, { ...b, markdown: '[figure]: second.png\n\n其他正文' }] }, a)).not.toBe(key);
    expect(getChapterSourceKey({ ...p, assets: [{ ...asset, hash: 'different-bytes' }] }, a)).not.toBe(key);
    const own = { ...a, markdown: '![配图][figure]\n\n[figure]: local.png' };
    expect(getChapterSourceKey({ ...p, chapters: [own, b] }, own)).toBe(getChapterSourceKey({ ...p, chapters: [own, { ...b, markdown: '[figure]: ignored.png' }] }, own));
  });
  it('preserves pre-intent saved video fingerprints and only invalidates active creative choices', () => {
    const oldSettings = { language: 'zh-CN', audience: '初学者', mode: 'full', voice: 'zh-CN-XiaoxiaoNeural', rate: 0, theme: 'sage', resolution: '720p', model: '', creationMode: 'stable', stylePrompt: '' };
    const chapter = { id: 'legacy-chapter', title: '已生成章节', markdown: '已保存的素材。' };
    const project = { chapters: [chapter], markdown: chapter.markdown, settings: oldSettings as GenerationSettings, assets: [] };
    // Captured from the pre-video-intent chapter-video-v1 serializer.
    const savedKey = '4aa50a02207f10ba2761004247c26ba24887de36e7624f6e1a3e96e242f39029';
    expect(getChapterSourceKey(project, chapter)).toBe(savedKey);
    expect(getChapterSourceKey({ ...project, settings: SettingsSchema.parse(oldSettings) }, chapter)).toBe(savedKey);
    for (const changed of [{ videoIntent: 'product' }, { creativeBrief: '面向客户，呈现产品价值' }]) {
      expect(getChapterSourceKey({ ...project, settings: SettingsSchema.parse({ ...oldSettings, ...changed }) }, chapter)).not.toBe(savedKey);
    }
    const ownChapter = { ...chapter, settings: SettingsSchema.parse(oldSettings) };
    expect(getChapterSourceKey({ ...project, settings: SettingsSchema.parse({ ...oldSettings, videoIntent: 'story' }) }, ownChapter)).toBe(savedKey);
    expect(SettingsSchema.parse(oldSettings).audience).toBe('初学者');
    expect(SettingsSchema.parse({}).audience).toBe('普通观众');
  });
});
