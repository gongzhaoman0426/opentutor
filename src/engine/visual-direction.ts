import type { Diagnostic, Lesson, Scene, SourceBlock } from '../shared/schema';

export const SELF_CONTAINED_VISUALS = `SELF-CONTAINED VISUALS (applies to planning, generation and repair):
Adapt the material into a video that can be followed on its own, using the requested purpose, tone and audience. Explanations, reports, product presentations, stories, atmosphere and intentional text composition are all valid. Choose the form that serves the content; neither diagrams, demonstrations nor custom animation are required in every scene.
Preserve substantive information, examples, narrative events and relevant attribution. Source-page navigation, embedded-player controls and instructions to inspect absent material are delivery instructions, not automatically part of that substance. Full coverage does NOT require repeating those delivery instructions. When they merely point to content needed in this video, present that content here and retain its sourceBlockIds. Preserve references, tools, authors, links and actions when they are themselves relevant to the subject, a genuine procedure, a story or an intentional call to action. Distinguish a request to act in a named external destination from an instruction to click an invisible control in this video.
When the intended explanation or presentation depends on a visual relationship, structure, sequence, state, comparison or spatial arrangement, construct the needed visual even if no image was supplied. Do not replace a promised visual with prose saying it exists elsewhere. Creative mode can use custom SVG for a diagram, illustration, composition or motion graphic; stable mode uses suitable predefined components. Draw the required information or scene from the supplied content and context. Text, quotations and typography can be the intended visual treatment; they cannot stand in for a missing graphic when the narration explicitly asks viewers to examine that graphic.
Keep explicit references to the current picture and its changes consistent with what is visible at that moment. Objects referred to as visible must be included in that utterance's showObjectIds. Coordinate narrated visual changes with the relevant narration units; choose separate states or scenes when helpful. Narrative anticipation, recollection, suspense and mood may follow the creative intent without forcing every spoken event to be illustrated immediately.
Distinguish supplied evidence from a newly created representation. Derive relationships and states only when the supplied facts support them. If an illustration needs details not supplied, use a clearly identified conceptual example only when it serves the purpose, and label it appropriately in the video's language. Never claim that a new drawing reproduces an unseen original image, measured chart, screenshot or historical record, and never invent missing empirical values, quotations or product functionality. Explain a material evidence limitation when needed. Fictional or imaginative scenes may remain fictional without labeling every artistic choice as a factual reconstruction. Supplied source images still MUST appear as original image objects; additional drawings can supplement them, not replace them.
Before returning JSON, check that explicit visual promises are fulfilled, source references retain their intended meaning, and incidental source-page delivery instructions have not become dependencies for watching this video.`;

const graphName = '(?:环境图|流程图|结构图|关系图|调用栈图|状态图|示意图|下图|这张图|这幅图|此图|图中|diagram|flowchart)';
const visualPromise = new RegExp(`^(?:\\s*(?:请|现在|接下来|首先|然后|我们|一起|大家|这里|逐行|逐步|再|let's|let us|we|now|please))*\\s*(?:看|观察|展示|演示|画出|绘制|跟踪|查看|参见|对照|see|look at|observe|shown in).{0,18}${graphName}|^\\s*${graphName}(?:中|上|里|所|清楚地|直观地|\\s){0,4}(?:展示|显示|表示|如下|可见|右侧|左侧|shows|illustrates)|如(?:下)?图所示`, 'iu');
const sourceGraphicReference = /(?:书中|原文|教材|原网页|文中|手册中|本书中)(?:的|中的|所示的|所示)?(?:交互式(?:的)?)?(?:环境图|流程图|结构图|关系图|示意图|图示|图表|插图)/iu;
const sourceGraphicSubject = new RegExp(`^\\s*${sourceGraphicReference.source}\\s*$`, 'iu');
// Mentioning a source image can be legitimate attribution, criticism or a story
// event. Only a viewer instruction or a source-container interaction description
// establishes the dependency checked here; the figure's name alone does not.
const sourceViewingInstruction = /^(?:\s*(?:请|现在|接下来|首先|然后|我们|一起|大家|观众可以|你可以|您可以|再))*\s*(?:看|查看|观察|参见|对照|打开|回到|切换到)/iu;
const sourceInteractionDescription = /(?:支持|可以|能够|允许|可|能).{0,16}(?:点击|单击|拖动|缩放|切换|播放|输入|选择|筛选|执行|运行|加载|载入|编辑)|(?:是|属于)(?:一个|一幅|一张|个)?(?:可交互|交互式|可点击|可拖动)/iu;
const unavailableVisual = /(?:没(?:有)?|未|不|无法|不能|缺少|缺乏|尚未).{0,10}(?:提供|展示|显示|绘制|画出|复原|恢复|还原|观察|查看|获取|看到|给出|确定)|(?:diagram|figure|chart).{0,15}(?:unavailable|missing|not provided)|(?:cannot|can't|do not|don't).{0,15}(?:show|see|reconstruct|view)/iu;

function affirmativeClauses(text: string): string[] {
  // Scope a limitation to its clause; "no source image, but look at this diagram"
  // still promises a graphic in the second clause and must not bypass the check.
  const clauses = text.split(/[，,。；;！？!?\n]|但是|不过|然而|但|而是|所以|因此|\bbut\b/iu).filter(clause => clause.trim());
  return clauses.filter((clause, index) => !unavailableVisual.test(clause)
    && !(sourceGraphicSubject.test(clause) && unavailableVisual.test(clauses[index + 1] || '')));
}
const hasSourcePageDependency = (text: string) => affirmativeClauses(text).some(clause => sourceGraphicReference.test(clause) && sourceViewingInstruction.test(clause));
const hasSourceInteractionReference = (text: string) => affirmativeClauses(text).some(clause => sourceGraphicReference.test(clause) && sourceInteractionDescription.test(clause));
const hasDanglingPromise = (text: string) => affirmativeClauses(text).some(clause => visualPromise.test(clause)) || hasSourcePageDependency(text);

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
      if (!visible.some(object => object.type === 'image') && hasSourcePageDependency(prose)) {
        issues.push({ code: 'SOURCE_PAGE_LEAK', severity: 'error', sceneId: scene.id, message: `旁白 ${unit.id} 要求查看未展示的来源图，或依赖原载体的交互操作。请在视频中实际呈现所需内容，并使画面指代一致；新绘制的图不能声称是未提供的原图。保留与主题有关的引用、评论、叙事与明确的外部行动指引，省略只用于原页面展示内容的操作说明。` });
        continue;
      }
      if (!visible.some(object => object.type === 'image') && hasSourceInteractionReference(prose)) {
        issues.push({ code: 'SOURCE_REFERENCE_REVIEW', severity: 'warning', sceneId: scene.id, message: `旁白 ${unit.id} 提及来源图的交互功能。请确认这属于当前主题、评论或叙事；若只是原页面展示内容的操作说明，应改为本视频中的实际呈现。此提示不要求提供原图，也不阻止生成。` });
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
