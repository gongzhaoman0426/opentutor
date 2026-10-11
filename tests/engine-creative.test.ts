import { describe, expect, it } from 'vitest';
import { compileLesson, regenerateScene, generationProfile, type JsonRunner } from '../src/engine/codex';
import { defaultSettings, type Lesson } from '../src/shared/schema';
import { parseSource } from '../src/shared/source';
import { buildRenderPlan } from '../src/video/timeline';
import { validateCustomLesson } from '../src/engine/custom-validation';
import { mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const markdown = '用圆周运动说明运动方向持续变化。';
const source = parseSource(markdown);
const drawing = 'const angle=cues.orbit.progress*2*Math.PI;const x=width/2+90*Math.cos(angle);const y=height/2+90*Math.sin(angle);return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"><circle cx="${width/2}" cy="${height/2}" r="90" fill="none" stroke="${theme.muted}" stroke-width="2"/><circle cx="${x}" cy="${y}" r="16" fill="${theme.accent}"/></svg>`;';
const palette = { background: '#101d30', surface: '#152840', text: '#ffffff', muted: '#c0d8ef', accent: '#00ccff' };
function lesson(content = drawing, type: 'custom' | 'text' = 'custom'): Lesson {
  return { schemaVersion: '0.1', title: '圆周运动', objectives: ['理解运动方向'], scenes: [{ id: 's1', title: '观察运动方向', chapter: '运动', sourceBlockIds: source.blocks.map(b => b.id), layout: 'content', objects: [{ id: 'o1', type, content, language: type === 'custom' ? 'javascript' : '', ...(type === 'custom' ? { motion: { version: 'narration-v1', cues: [{ id: 'orbit', utteranceId: 'u1' }] } as const } : {}) }], narration: [{ id: 'u1', text: '观察沿圆周运动的点，运动方向持续变化。', showObjectIds: ['o1'], focusObjectId: 'o1' }] }] };
}

describe('creative model and actual SVG code generation', () => {
  it('keeps crafted art direction in initial generation, repair and single-scene regeneration without imposing it on stable mode', async () => {
    const prompts: string[] = [];
    await compileLesson(markdown, { ...defaultSettings, creationMode: 'creative' }, [], { runner: async prompt => {
      prompts.push(prompt);
      return JSON.stringify(lesson(prompts.length === 1 ? 'throw new Error("repair geometry")' : drawing));
    } });
    expect(prompts).toHaveLength(2);
    await regenerateScene(lesson(), 's1', '让图形重组更连贯', source, { ...defaultSettings, creationMode: 'creative' }, [], { runner: async prompt => { prompts.push(prompt); return JSON.stringify(lesson().scenes[0]); } });
    for (const prompt of prompts) {
      expect(prompt).toContain('CRAFTED MOTION DESIGN');
      expect(prompt).toContain('The author\'s brief takes precedence');
      expect(prompt).toContain('keep it in one custom component across several narration cues');
      expect(prompt).toContain('before its own cue.started');
      expect(prompt).toContain('transition midpoint and settled frame');
      expect(prompt).toContain('hard 12000-character limit');
      expect(prompt).not.toContain('usually below 3000 characters');
    }
    expect(prompts[1]).toContain('Fix the failing geometry or API usage locally');
    await compileLesson(markdown, defaultSettings, [], { runner: async prompt => {
      expect(prompt).not.toContain('CRAFTED MOTION DESIGN');
      return JSON.stringify(lesson('方向持续改变。', 'text'));
    } });
    expect(JSON.parse(await generationProfile('test-model')).version).toBe('director-crafted-motion-v14');
  });
  it('scopes compiler caches by model/style/mode/course while reusing IR for voice-only changes', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'opentutor-style-cache-'));
    try {
      let calls = 0;
      const runner: JsonRunner = async prompt => {
        calls++;
        const payload = JSON.parse(prompt.split('VIDEO_DATA=')[1]);
        return JSON.stringify({ ...lesson('教学结论。', 'text'), ...(payload.settings.stylePrompt ? { palette } : {}) });
      };
      const options = { source, runner, ownerProjectId: 'course-a', cacheDirectory: (name = 'cache') => { const target = path.join(directory, name); mkdirSync(target, { recursive: true }); return target; } };
      const settings = { ...defaultSettings, model: 'model-a' };
      await compileLesson(markdown, settings, [], options);
      await compileLesson(markdown, { ...settings, voice: 'zh-CN-YunxiNeural', rate: 12 }, [], options);
      expect(calls).toBe(1);
      const styled = { ...settings, stylePrompt: '夜空蓝风格' };
      await compileLesson(markdown, styled, [], options); expect(calls).toBe(2);
      const changedModel = { ...styled, model: 'model-b' };
      await compileLesson(markdown, changedModel, [], options); expect(calls).toBe(3);
      await compileLesson(markdown, { ...changedModel, creationMode: 'creative' }, [], options); expect(calls).toBe(4);
      await compileLesson(markdown, { ...changedModel, creationMode: 'creative' }, [], { ...options, ownerProjectId: 'course-b' }); expect(calls).toBe(5);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('plans full-canvas visuals for the selected subtitle policy and separates their cached compositions', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'opentutor-subtitle-cache-'));
    try {
      const policies: boolean[] = [];
      const runner: JsonRunner = async prompt => {
        const payload = JSON.parse(prompt.split('VIDEO_DATA=')[1]);
        policies.push(payload.settings.burnSubtitles);
        expect(prompt).toContain('FULL-FRAME COMPOSITION');
        expect(prompt).toContain('1280 x 720');
        expect(prompt).toContain('Preserve the original pixels and transparency');
        expect(prompt).toContain('fit=contain');
        expect(prompt).toContain('viewBox 用字符串拼接');
        expect(prompt).not.toContain('360px content area');
        expect(prompt).not.toContain('height=286');
        expect(prompt).not.toContain('固定高度286');
        if (payload.settings.burnSubtitles) {
          expect(prompt).toContain('SUBTITLES ENABLED');
          expect(prompt).toContain('bottom 80 logical pixels');
        } else {
          expect(prompt).toContain('SUBTITLES DISABLED');
          expect(prompt).toContain('Spoken narration and its timing cues are still required');
          expect(prompt).not.toContain('bottom 80 logical pixels');
        }
        return JSON.stringify(lesson('方向持续改变。', 'text'));
      };
      const options = { source, runner, ownerProjectId: 'subtitle-course', cacheDirectory: (name = 'cache') => { const target = path.join(directory, name); mkdirSync(target, { recursive: true }); return target; } };
      const settings = { ...defaultSettings, creationMode: 'creative' as const, burnSubtitles: true };
      await compileLesson(markdown, settings, [], options);
      await compileLesson(markdown, { ...settings, burnSubtitles: false }, [], options);
      await compileLesson(markdown, { ...settings, burnSubtitles: false, voice: 'zh-CN-YunxiNeural', rate: 12 }, [], options);
      expect(policies).toEqual([true, false]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('executes custom validation at real full-frame or comparison dimensions and preserves legacy validation', async () => {
    const atSize = (width: number, height: number) => `if(width!==${width}||height!==${height}) throw new Error("Unexpected component viewport");${drawing}`;
    expect(await validateCustomLesson(lesson(atSize(1280, 720)))).toEqual([]);
    const compare = lesson(atSize(632, 720));
    compare.scenes[0].layout = 'compare';
    compare.scenes[0].objects.push({ ...compare.scenes[0].objects[0], id: 'o2' });
    expect(await validateCustomLesson(compare)).toEqual([]);
    const historical = lesson(atSize(1104, 286));
    expect(await validateCustomLesson(historical, 'legacy')).toEqual([]);
    expect(await validateCustomLesson(historical)).toEqual([expect.objectContaining({ code: 'CUSTOM_COMPONENT_INVALID', message: expect.stringContaining('Unexpected component viewport') })]);
  });
  it('repairs executable component errors inside the isolated VM instead of silently returning text', async () => {
    let calls = 0;
    const runner: JsonRunner = async (prompt, _schema, _signal, _event, _images, runOptions) => {
      calls++; expect(runOptions?.model).toBe('selected-chapter-model');
      expect(prompt).toContain('CREATIVE MODE');
      if (calls === 1) return JSON.stringify(lesson('while(true){}'));
      if (calls === 2) { expect(prompt).toContain('CUSTOM_COMPONENT_INVALID'); return JSON.stringify(lesson('改用文字说明。', 'text')); }
      expect(prompt).toContain('CUSTOM_REPAIR_DOWNGRADE'); return JSON.stringify(lesson());
    };
    const result = await compileLesson(markdown, { ...defaultSettings, model: 'selected-chapter-model', creationMode: 'creative' }, [], { source, runner });
    expect(calls).toBe(3);
    expect(result.lesson.scenes[0].objects[0].type).toBe('custom');
    expect(await validateCustomLesson(result.lesson)).toEqual([]);
  });
  it('stable schema excludes custom code and rejects a model that tries to introduce it', async () => {
    let calls = 0;
    const runner: JsonRunner = async (prompt, schema) => {
      calls++;
      const contract = schema as { properties: { scenes: { items: { properties: { objects: { items: { properties: { type: { enum: string[] } } } } } } } } };
      expect(contract.properties.scenes.items.properties.objects.items.properties.type.enum).not.toContain('custom');
      if (calls === 1) return JSON.stringify(lesson());
      expect(prompt).toContain('CUSTOM_MODE');
      expect(prompt).toContain('Remove any unsupported custom code');
      expect(prompt).not.toContain('Repair invalid custom code');
      return JSON.stringify(lesson('方向持续改变。', 'text'));
    };
    const result = await compileLesson(markdown, defaultSettings, [], { source, runner });
    expect(calls).toBe(2); expect(result.lesson.scenes[0].objects[0].type).toBe('text');
  });
  it('translates a style sentence into a real palette that reaches the render plan', async () => {
    let calls = 0;
    const runner: JsonRunner = async prompt => {
      calls++;
      if (calls === 1) return JSON.stringify({ ...lesson('文字说明。', 'text'), palette: null });
      expect(prompt).toContain('STYLE_NOT_APPLIED');
      return JSON.stringify({ ...lesson('文字说明。', 'text'), palette });
    };
    const result = await compileLesson(markdown, { ...defaultSettings, stylePrompt: '深蓝背景，霓虹蓝强调，白色正文。' }, [], { source, runner });
    expect(result.lesson.palette).toEqual(palette);
    const scene = result.lesson.scenes[0];
    const speech = new Map([[`${scene.id}:u1`, { url: '/api/artifacts/00000000-0000-4000-8000-000000000001', durationSeconds: 1, boundaries: [], hash: 'fixture', cacheHit: false }]]);
    expect(buildRenderPlan(result.lesson, defaultSettings, speech, 1).palette).toEqual(palette);
  });
  it('creative mode permits a genuinely simple text chapter without a component-count quota', async () => {
    const result = await compileLesson(markdown, { ...defaultSettings, creationMode: 'creative' }, [], { source, runner: async () => JSON.stringify(lesson('一句简短结论。', 'text')) });
    expect(result.lesson.scenes[0].objects[0].type).toBe('text');
  });
  it('uses the selected model for course overview and chapter directors while generating only target chapter', async () => {
    const chapters = [{ id: 'a', title: '运动', markdown }, { id: 'b', title: '后续', markdown: '这里是后续章节。' }];
    const target = parseSource('', [], [chapters[0]]); const context = parseSource('', [], chapters);
    const targetLesson = lesson('运动方向改变。', 'text'); targetLesson.scenes[0].sourceBlockIds = target.blocks.map(b => b.id);
    const calls: string[] = [];
    const runner: JsonRunner = async (prompt, _schema, _signal, _event, _images, runOptions) => {
      expect(runOptions?.model).toBe('selected-model');
      if (prompt.includes('PROJECT_DATA=')) { calls.push('overview'); return JSON.stringify({ summary: '先运动，再后续', objectives: ['理解'], chapters: chapters.map(c => ({ id: c.id, title: c.title, summary: c.markdown })) }); }
      calls.push('director'); const payload = JSON.parse(prompt.split('VIDEO_DATA=')[1]);
      expect(payload.sourceBlocks.every((block: { id: string }) => target.blocks.some(b => b.id === block.id))).toBe(true);
      expect(payload.projectOverview.chapters).toHaveLength(2);
      return JSON.stringify(targetLesson);
    };
    const result = await compileLesson(markdown, { ...defaultSettings, model: 'selected-model' }, [], { source: target, contextSource: context, lessonTitle: '运动', courseTitle: '全课', runner });
    expect(calls).toEqual(['overview', 'director']);
    expect(result.lesson.title).toBe(targetLesson.title);
    expect(target.chapters?.[0].title).toBe('运动');
    expect(result.lesson.scenes.every(scene => scene.chapterId === 'a')).toBe(true);
  });
});
