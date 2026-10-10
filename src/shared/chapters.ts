import { SettingsSchema, SceneSchema, type Chapter, type ProjectSnapshot, type Project } from './schema';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { toString } from 'mdast-util-to-string';
import type { Root } from 'mdast';

interface Heading { offset: number; level: 1 | 2; title: string }

function fingerprint(text: string) {
  let value = 2166136261;
  for (let index = 0; index < text.length; index++) value = Math.imul(value ^ text.charCodeAt(index), 16777619);
  return (value >>> 0).toString(36);
}
function trimBlankLines(markdown: string) {
  return markdown.replace(/^(?:[\t ]*\r?\n)+/, '').replace(/(?:\r?\n[\t ]*)+$/, '');
}
export function createEmptyChapter(title = '新章节'): Chapter {
  const id = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return { id: `chapter-${id}`, title: title.slice(0, 120) || '新章节', markdown: '' };
}

/** Split imported notes without treating headings inside fenced code as chapters. */
export function splitMarkdownChapters(markdown: string): Chapter[] {
  const document = unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(markdown) as Root;
  const headings: Heading[] = document.children.filter(node => node.type === 'heading' && node.depth <= 2).map(node => {
    if (node.type !== 'heading') throw new Error('Unexpected Markdown node');
    return { offset: node.position?.start.offset ?? 0, level: node.depth as 1 | 2, title: toString(node).slice(0, 120) || '未命名章节' };
  });
  const h1 = headings.filter(h => h.level === 1);
  const h2 = headings.filter(h => h.level === 2);
  const selected = h1.length > 1 ? h1 : h2.length > 1 ? h2 : h1.length ? h1 : h2;
  if (!selected.length) return [{ id: `chapter-1-${fingerprint(markdown)}`, title: '导入素材', markdown }];
  const segments: { title: string; markdown: string }[] = [];
  const prefix = markdown.slice(0, selected[0].offset);
  // A standalone course heading belongs with its first chapter. Keep actual
  // introductory prose as a separate chapter instead of dropping it.
  const prefixBody = prefix.replace(/^ {0,3}#{1,2}(?:[\t ]+|$).*$/gm, '').trim();
  const attachPrefix = !prefixBody;
  if (prefix.trim() && !attachPrefix) segments.push({ title: headings.find(h => h.offset < selected[0].offset)?.title || '导入', markdown: prefix });
  selected.forEach((heading, index) => {
    segments.push({ title: heading.title, markdown: (index === 0 && attachPrefix ? prefix : '') + markdown.slice(heading.offset, selected[index + 1]?.offset ?? markdown.length) });
  });
  return segments.map((chapter, index) => ({ ...chapter, id: `chapter-${index + 1}-${fingerprint(chapter.markdown)}` }));
}

/** The editable chapters own the source; joins only normalize separating blank lines. */
export function joinChapterMarkdown(chapters: readonly Chapter[]): string {
  return chapters.map(chapter => trimBlankLines(chapter.markdown)).filter(markdown => markdown.trim()).join('\n\n');
}

/** Legacy projects are adapted for display without rewriting their stored notes. */
export function getProjectChapters(project: Pick<ProjectSnapshot, 'markdown' | 'chapters'>): Chapter[] {
  if (project.chapters?.length) return project.chapters.map(chapter => ({ ...chapter }));
  return splitMarkdownChapters(project.markdown);
}

type ChapterSource = Pick<ProjectSnapshot, 'chapters' | 'markdown' | 'settings' | 'assets'>;
/** Only this chapter's material, own settings, and referenced figure dependencies affect its video. */
export function getChapterSourceKey(project: ChapterSource, chapter: Chapter): string {
  const parse = (markdown: string) => unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(markdown) as Root;
  let tree = parse(chapter.markdown);
  const definitions = new Map<string, string>();
  const inherited: string[] = [];
  for (const node of tree.children) if (node.type === 'definition') definitions.set(node.identifier.toLowerCase(), node.url);
  for (const part of getProjectChapters(project)) for (const node of parse(part.markdown).children) {
    if (node.type === 'definition' && !definitions.has(node.identifier.toLowerCase())) {
      definitions.set(node.identifier.toLowerCase(), node.url);
      inherited.push(part.markdown.slice(node.position?.start.offset ?? 0, node.position?.end.offset ?? part.markdown.length));
    }
  }
  // Unresolved reference images are text nodes until their definitions exist.
  // Reparse with inherited definitions so those dependencies cannot be missed.
  if (inherited.length) tree = parse(`${chapter.markdown}\n\n${inherited.join('\n\n')}`);
  const references: [string, string][] = [];
  const urls: string[] = [];
  const walk = (node: Record<string, unknown>) => {
    if (node.type === 'image') urls.push(String(node.url || ''));
    if (node.type === 'imageReference') {
      const identifier = String(node.identifier || '').toLowerCase(); const url = definitions.get(identifier) || '';
      references.push([identifier, url]); urls.push(url);
    }
    if (Array.isArray(node.children)) for (const child of node.children) walk(child as Record<string, unknown>);
  };
  walk(tree as unknown as Record<string, unknown>);
  const referenced = project.assets.filter(asset => urls.some(url => {
    let name = url.replace(/^\.\//, ''); try { name = decodeURIComponent(name); } catch { return false; }
    const id = /^asset:\/\/([a-f0-9-]{36})$/i.exec(name)?.[1];
    return asset.id === (id || name) || asset.url === url || asset.name === name || asset.name === name.split('/').at(-1);
  })).map(asset => [asset.id, asset.name, asset.mime, asset.hash, asset.width ?? null, asset.height ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  // Preserve the pre-intent fingerprint for existing videos: append only active
  // new choices, keeping the order of every legacy settings field unchanged.
  const { videoIntent, creativeBrief, ...legacySettings } = SettingsSchema.parse(chapter.settings ?? project.settings);
  const settings = { ...legacySettings, ...(videoIntent !== 'auto' ? { videoIntent } : {}), ...(creativeBrief !== '' ? { creativeBrief } : {}) };
  return bytesToHex(sha256(utf8ToBytes(JSON.stringify({ version: 'chapter-video-v1', id: chapter.id, title: chapter.title, markdown: chapter.markdown, settings, references, assets: referenced }))));
}
export function isChapterVideoCurrent(project: Pick<Project, 'chapterVideos' | 'chapters' | 'markdown' | 'settings' | 'assets'>, chapterId: string): boolean {
  const chapter = getProjectChapters(project).find(value => value.id === chapterId);
  const video = project.chapterVideos?.[chapterId];
  if (!chapter || !video || !video.renderPlan || video.sourceKey !== getChapterSourceKey(project, chapter) || video.renderPlan.previewMode === 'draft' || video.renderPlan.previewMode === 'partial') return false;
  try {
    const settings = SettingsSchema.parse(chapter.settings ?? project.settings);
    const plan = video.renderPlan;
    const palette = (value: typeof video.lesson.palette) => value ? [value.background, value.surface, value.text, value.muted, value.accent].map(color => color.toLowerCase()) : null;
    if (plan.theme !== settings.theme || plan.width !== (settings.resolution === '1080p' ? 1920 : 1280) || plan.height !== (settings.resolution === '1080p' ? 1080 : 720) || plan.voice !== settings.voice || plan.rate !== settings.rate || JSON.stringify(palette(plan.palette)) !== JSON.stringify(palette(video.lesson.palette))) return false;
    return JSON.stringify(plan.scenes.map(scene => SceneSchema.parse(scene.scene))) === JSON.stringify(video.lesson.scenes.map(scene => SceneSchema.parse(scene)));
  }
  catch { return false; }
}
