import { SettingsSchema, type Chapter, type GenerationSettings, type Project } from './schema';
import { getProjectChapters } from './chapters';

type SettingsSource = Pick<Project, 'settings' | 'markdown' | 'chapters' | 'chapterVideos' | 'chapterJobs'>;

/** Save the current chapter's choice and use it for subsequent, unconfigured chapters. */
export function rememberChapterSettings(project: SettingsSource, chapterId: string, value: GenerationSettings) {
  const chapters = getProjectChapters(project);
  const target = chapters.findIndex(chapter => chapter.id === chapterId);
  if (target < 0) throw new Error('章节不存在或已删除');
  const settings = SettingsSchema.parse(value);
  const previous = SettingsSchema.parse(project.settings);
  return {
    settings,
    chapters: chapters.map((chapter, index) => {
      if (chapter.id === chapterId) return { ...chapter, settings: { ...settings } };
      if (chapter.settings) return chapter;
      const job = project.chapterJobs?.[chapter.id];
      const started = job && ['queued', 'running', 'cancelling'].includes(job.status);
      // Pin existing work before changing the default so its source fingerprint stays valid.
      if (index < target || project.chapterVideos?.[chapter.id] || started) return { ...chapter, settings: { ...previous } };
      return chapter;
    }),
  };
}

/** Keep server-pinned settings when edits made during a save must be sent again. */
export function mergeProtectedChapterSettings(local: Chapter[], submitted: Chapter[], saved: Chapter[]): Chapter[] {
  const before = new Map(submitted.map(chapter => [chapter.id, chapter]));
  const after = new Map(saved.map(chapter => [chapter.id, chapter]));
  return local.map(chapter => {
    const sent = before.get(chapter.id);
    const settings = after.get(chapter.id)?.settings;
    return !chapter.settings && sent && !sent.settings && settings ? { ...chapter, settings } : chapter;
  });
}
