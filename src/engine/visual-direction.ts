import type { Diagnostic, Lesson, Scene, SourceBlock } from '../shared/schema';

export const SELF_CONTAINED_VISUALS = `SELF-CONTAINED VISUALS (applies to planning, generation and repair):
The viewer watches THIS video, not the source book or web page. Preserve the meaning, facts and worked examples; do not copy source-page navigation, embedded-player instructions or absent figure references as narration. Full coverage does NOT require repeating those delivery instructions. Convert them into an actual on-screen demonstration, retaining the sourceBlockIds.
Narrate the demonstrated content directly: say what the visible entities do, not "the book's interactive diagram supports...", "according to the original text we fill in..." or a description of how the source website presents it. Omit incidental embedded-viewer names, links, button labels and their authors when they only describe the source page's delivery mechanism; they are not substantive content to preserve in full mode. Preserve them only when operating or discussing that tool is itself the author's subject. A newly drawn schematic is THIS video's schematic, never the unseen source figure. Label illustrative additions on screen as 示意/简化示例 without narrating the adaptation process.
Whenever understanding depends on structure, relationships, execution state, a process, spatial arrangement, comparison or a calculation, actively construct the required visual even if no image was supplied. This applies across subjects and video purposes, not only programming or teaching. Do not merely say that a diagram exists, tell viewers to inspect the book, or substitute a paragraph describing the missing picture. In creative mode draw the entities, labeled links, values and meaningful states with custom SVG. In stable mode use the predefined diagram-json component, code snapshots, tables or formulas as appropriate. Text-only scenes remain appropriate for content that needs no visual demonstration; there is no custom-component quota.
Use source code and context to derive consistent visible states. For example, a source explaining square(x), mul(x,x) and square(-2) can become a code/stack/binding diagram showing the call, x=-2 and return 4, rather than directions to click Edit this code in the book's embedded viewer. Show successive discrete states in separate scenes when that makes narration synchronization reliable. Do not claim a value or result before that state is visible. Every narrated visual must be present in that utterance's showObjectIds. Drawings must show the concept itself, not paragraphs enclosed in an SVG rectangle or decorative moving dots.
If source details are insufficient, introduce the smallest clearly labeled illustrative example (示意 or 简化示例), consistent with the stated concept; do not claim to reproduce an unseen original figure. Never fabricate missing empirical values, measured charts, quotations, actual screenshots, historical evidence or product UI details. For missing evidence, state the limitation without inventing it; a labeled conceptual schematic may explain relationships, not supply fake evidence. Supplied source images still MUST appear as original image objects; drawings can supplement them, not replace them.
Distinguish obsolete source navigation from a genuine software-operation tutorial: the latter may explain buttons and clicks when the relevant interface is actually visible in an original image or an explicitly labeled schematic. Do not turn a noninteractive video into instructions to click invisible controls. Before returning JSON, check that each visual promise has a meaningful graphic, each named state agrees with it, and the video can be followed without opening the source page.`;

const graphName = '(?:环境图|流程图|结构图|关系图|调用栈图|状态图|示意图|下图|这张图|这幅图|此图|图中|diagram|flowchart)';
const visualPromise = new RegExp(`(?:看|观察|展示|演示|画出|绘制|跟踪|查看|参见|对照|see|look at|observe|shown in).{0,18}${graphName}|${graphName}(?:中|上|里|所|清楚地|直观地|\\s){0,4}(?:展示|显示|表示|如下|可见|右侧|左侧|shows|illustrates)|如(?:下)?图所示`, 'iu');
const sourceDependency = /(?:书中|原文|教材|原网页|文中的).{0,20}(?:环境图|交互式.{0,6}图|下图|示意图|流程图)|(?:点击|单击|click).{0,12}(?:Edit this code|Next|下一步).{0,24}(?:查看|执行|运行|load|run)/iu;
const sourceGraphicReference = /(?:书中|原文|教材|原网页|文中|手册中|本书中)(?:的|中的|所示的|所示)?(?:交互式(?:的)?)?(?:环境图|流程图|结构图|关系图|示意图|图示|图表|插图)/iu;
const sourceGraphicSubject = new RegExp(`^\\s*${sourceGraphicReference.source}\\s*$`, 'iu');
const unavailableVisual = /(?:没(?:有)?|未|不|无法|不能|缺少|缺乏|尚未).{0,10}(?:提供|展示|显示|绘制|画出|复原|恢复|还原|观察|查看|获取|看到|给出|确定)|(?:diagram|figure|chart).{0,15}(?:unavailable|missing|not provided)|(?:cannot|can't|do not|don't).{0,15}(?:show|see|reconstruct|view)/iu;

function affirmativeClauses(text: string): string[] {
  // Scope a limitation to its clause; "no source image, but look at this diagram"
  // still promises a graphic in the second clause and must not bypass the check.
  const clauses = text.split(/[，,。；;！？!?\n]|但是|不过|然而|但|而是|所以|因此|\bbut\b/iu).filter(clause => clause.trim());
  return clauses.filter((clause, index) => !unavailableVisual.test(clause)
    && !(sourceGraphicSubject.test(clause) && unavailableVisual.test(clauses[index + 1] || '')));
}
const hasDanglingPromise = (text: string) => affirmativeClauses(text).some(clause => visualPromise.test(clause) || sourceDependency.test(clause));

function isGraphic(object: Scene['objects'][number]) {
  return object.type === 'custom' || object.type === 'image' || (object.type === 'diagram' && object.language === 'diagram-json');
}

// This deliberately checks only explicit, dangling visual promises. It cannot prove a
// diagram's semantics. Keep it out of shared validation so historical exports still work.
export function validateSelfContainedVisuals(lesson: Lesson, onlySceneId?: string): Diagnostic[] {
  const issues: Diagnostic[] = [];
  for (const scene of lesson.scenes) {
    if (onlySceneId && scene.id !== onlySceneId) continue;
    const hasShownGraphic = scene.narration.some(unit => scene.objects.some(object => unit.showObjectIds.includes(object.id) && isGraphic(object)));
    if (hasDanglingPromise(scene.title) && !hasShownGraphic) {
      issues.push({ code: 'MISSING_VISUAL_DEMONSTRATION', severity: 'error', sceneId: scene.id, message: `场景“${scene.title}”承诺图示演示，却只有文字。请依据来源实际绘制图形：创作模式使用 custom SVG，稳定模式使用 diagram-json 预设图。不要只删除图示措辞来回避演示。` });
      continue;
    }
    for (const unit of scene.narration) {
      const visible = scene.objects.filter(object => unit.showObjectIds.includes(object.id));
      const prose = [unit.text, ...visible.filter(object => object.type === 'text' || (object.type === 'diagram' && object.language !== 'diagram-json')).map(object => object.content)].join('\n');
      if (!visible.some(object => object.type === 'image') && affirmativeClauses(prose).some(clause => sourceGraphicReference.test(clause))) {
        issues.push({ code: 'SOURCE_PAGE_LEAK', severity: 'error', sceneId: scene.id, message: `旁白 ${unit.id} 仍在介绍书中或原网页的图，但当前没有展示该原图。请直接讲本视频已绘制的实体、关系和变化，省略仅介绍原页面展示方式的工具名称、按钮及作者旁支；不要把自绘图声称为未提供的原图，也不要旁白讲述“根据原文补全”的改编过程。` });
        continue;
      }
      if (!visible.some(isGraphic) && hasDanglingPromise(prose)) {
        issues.push({ code: 'MISSING_VISUAL_DEMONSTRATION', severity: 'error', sceneId: scene.id, message: `旁白 ${unit.id} 依赖未展示的图示或原文交互。请根据来源画出所需关系或状态，把实际图形加入该句 showObjectIds，并将书中/网页操作说明改为与当前画面一致的演示。缺少事实证据时明确限制，勿伪造原图。` });
      }
    }
  }
  return issues;
}

// A small read-only context prevents a split batch from losing the nearby program
// that its prose refers to. It never expands coverage targets or model token budgets unboundedly.
export function nearbyCodeContext(chapterBlocks: SourceBlock[], target: SourceBlock[]) {
  const targetIds = new Set(target.map(block => block.id));
  const indices = chapterBlocks.flatMap((block, index) => targetIds.has(block.id) ? [index] : []);
  if (!indices.length) return [];
  const first = Math.min(...indices), last = Math.max(...indices);
  const candidates = chapterBlocks.map((block, index) => ({ block, index, distance: index < first ? first - index : index - last }))
    .filter(({ block, distance }) => block.type === 'code' && !targetIds.has(block.id) && distance > 0 && distance <= 12)
    .sort((a, b) => a.distance - b.distance || a.index - b.index);
  let remaining = 2000;
  const selected: typeof candidates = [];
  for (const candidate of candidates) {
    if (candidate.block.markdown.length > Math.min(1400, remaining)) continue;
    selected.push(candidate); remaining -= candidate.block.markdown.length;
    if (selected.length === 2) break;
  }
  return selected.sort((a, b) => a.index - b.index).map(({ block, index }) => ({ content: block.markdown, position: index < first ? 'before' : 'after', contextOnly: true }));
}
