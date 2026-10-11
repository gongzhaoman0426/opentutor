import { describe, expect, it } from 'vitest';
import { mergeProtectedChapterSettings, rememberChapterSettings } from '../src/shared/chapter-settings';
import { createEmptyChapter, getChapterSourceKey, splitMarkdownChapters } from '../src/shared/chapters';
import { defaultSettings, type JobRecord } from '../src/shared/schema';

const choices = { ...defaultSettings, resolution: '1080p' as const, voice: 'zh-CN-YunxiNeural', rate: 15, model: 'chosen-model', creationMode: 'creative' as const, theme: 'ocean' as const, stylePrompt: '蓝白配色', videoIntent: 'product' as const, audience: '新用户', creativeBrief: '先展示用途，再介绍使用方式' };
function source(): Parameters<typeof rememberChapterSettings>[0] & { assets: [] } {
  return { settings: { ...defaultSettings }, markdown: '', assets: [], chapters: ['before', 'current', 'next', 'custom'].map(id => ({ id, title: id, markdown: `# ${id}`, ...(id === 'custom' ? { settings: { ...defaultSettings, rate: 25 } } : {}) })) };
}

describe('remembered chapter generation settings', () => {
  it('keeps server-pinned settings through a second autosave without losing new text or explicit local choices', () => {
    const submitted = source().chapters!;
    const saved = submitted.map(chapter => ({ ...chapter, settings: { ...defaultSettings } }));
    const added = createEmptyChapter();
    const local = [
      { ...submitted[1], markdown: '保存期间继续编辑', settings: choices },
      { ...submitted[2], markdown: '后续章节的新正文' },
      added,
    ];
    const merged = mergeProtectedChapterSettings(local, submitted, saved);
    expect(merged.map(chapter => chapter.id)).toEqual(local.map(chapter => chapter.id));
    expect(merged[0]).toEqual(local[0]);
    expect(merged[1]).toEqual({ ...local[1], settings: defaultSettings });
    expect(merged[2]).toEqual(added);
    expect(local[1].settings).toBeUndefined();
  });
  it('applies all saved choices to later unconfigured, new and imported chapters while preserving earlier and explicit choices', () => {
    const project = source();
    const before = getChapterSourceKey(project, project.chapters![0]);
    const saved = { ...project, ...rememberChapterSettings(project, 'current', choices) };
    expect(saved.settings).toEqual(choices);
    expect(saved.chapters[1].settings).toEqual(choices);
    expect(saved.chapters[2].settings).toBeUndefined();
    expect(saved.chapters[2].settings ?? saved.settings).toEqual(choices);
    expect(createEmptyChapter().settings ?? saved.settings).toEqual(choices);
    for (const chapter of splitMarkdownChapters('# A\n内容\n# B\n内容')) expect(chapter.settings ?? saved.settings).toEqual(choices);
    expect(getChapterSourceKey(saved, saved.chapters[0])).toBe(before);
    expect(saved.chapters[3].settings?.rate).toBe(25);
    expect(project.settings).toEqual(defaultSettings);
    expect(project.chapters![1].settings).toBeUndefined();
  });

  it.each(['queued', 'running', 'cancelling'] as const)('keeps generated and %s chapters on their previous effective settings', status => {
    const project = source();
    project.chapters!.push({ id: 'generated', title: 'generated', markdown: '# generated' });
    const snapshot = { id: 'project', title: '项目', markdown: '# next', settings: defaultSettings, assets: [], revision: 1, lesson: null };
    const job: JobRecord = { id: 'job', projectId: 'project', chapterId: 'next', kind: 'preview', status, stage: 'speech', completed: 0, total: 0, inputRevision: 1, outputRevision: null, error: null, diagnostics: [], videoUrl: null, subtitleUrl: null, createdAt: '', updatedAt: '', snapshot, sceneId: null, instruction: null };
    project.chapterJobs = { next: job };
    project.chapterVideos = { generated: { chapterId: 'generated', sourceKey: getChapterSourceKey(project, project.chapters![4]), settings: defaultSettings, lesson: { schemaVersion: '0.1', title: 'generated', objectives: [], scenes: [] }, renderPlan: null, previewAssets: [], previewRevision: 1, latestExport: null, updatedAt: '' } };
    const keys = [2, 4].map(index => getChapterSourceKey(project, project.chapters![index]));
    const saved = { ...project, ...rememberChapterSettings(project, 'current', choices) };
    expect([2, 4].map(index => getChapterSourceKey(saved, saved.chapters[index]))).toEqual(keys);
    expect(saved.settings).toEqual(choices);
    expect(job.snapshot.settings).toEqual(defaultSettings);
  });

  it('uses the latest saved default without overwriting previously saved chapter choices', () => {
    const first = { ...source(), ...rememberChapterSettings(source(), 'current', choices) };
    const second = { ...first, ...rememberChapterSettings(first, 'next', { ...choices, rate: 30 }) };
    expect(second.settings.rate).toBe(30);
    expect(second.chapters[1].settings).toEqual(choices);
    expect(second.chapters[3].settings?.rate).toBe(25);
    expect(() => rememberChapterSettings(second, 'missing', choices)).toThrow(/章节/);
  });
});
