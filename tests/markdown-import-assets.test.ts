import { describe, expect, it } from 'vitest';
import { nameImportedAssets } from '../src/shared/markdown-import';
import { parseSource } from '../src/shared/source';
import { getChapterSourceKey } from '../src/shared/chapters';
import { defaultSettings, type Asset } from '../src/shared/schema';

const asset = (id: number, name: string): Asset => ({ id: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`, name, mime: 'image/png', url: `/api/artifacts/${id}`, hash: String(id), width: id, height: id });

describe('ZIP assets added to an existing project', () => {
  it('keeps other chapters using filename references valid and their video source unchanged', () => {
    const original = asset(1, 'same.png');
    const incoming = [asset(2, 'same.png'), asset(3, 'same.png'), asset(4, 'same (2).png')];
    const added = nameImportedAssets([original], incoming);
    const chapter = { id: 'first', title: '保留章节', markdown: '![原图](same.png)' };
    const project = { ...chapter, chapters: [chapter], assets: [original], settings: defaultSettings };
    const combined = [...project.assets, ...added];
    expect(new Set(combined.map(value => value.name)).size).toBe(4);
    expect(parseSource(chapter.markdown, combined).imageOccurrences?.[0].assetId).toBe(original.id);
    expect(parseSource(chapter.markdown, combined).diagnostics).toEqual([]);
    expect(getChapterSourceKey({ ...project, assets: combined }, chapter)).toBe(getChapterSourceKey(project, chapter));
    for (const item of added) expect(parseSource(`![导入](asset://${item.id})`, combined).imageOccurrences?.[0].assetId).toBe(item.id);
    expect(incoming.map(value => value.name)).toEqual(['same.png', 'same.png', 'same (2).png']);
  });
  it('keeps unique filenames and caps renamed display names to the asset schema limit', () => {
    const name = `${'图'.repeat(196)}.png`;
    const result = nameImportedAssets([asset(1, name)], [asset(2, name), asset(3, 'cover.png')]);
    expect(result[0].name.length).toBeLessThanOrEqual(200);
    expect(result[0].name).toMatch(/ \(2\)\.png$/);
    expect(result[1].name).toBe('cover.png');
  });
});
