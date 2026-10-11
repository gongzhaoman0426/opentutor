import { parse } from 'acorn';

/** Syntax checks are diagnostics; the isolated VM and SVG allowlist enforce execution boundaries. */
export function validateCustomCode(source: string): string | null {
  if (!source.trim() || source.length > 12000) return '自定义组件代码必须为 1–12000 字符';
  try { parse(`function draw(frame,fps,width,height,progress,theme) {\n"use strict";\n${source}\n}`, { ecmaVersion: 2023 }); }
  catch (error) { return `自定义组件 JavaScript 语法错误：${error instanceof Error ? error.message : '无法解析'}`; }
  return null;
}

/** Narration-bound code cannot fall back to a guessed whole-scene clock. */
export function validateNarrationCustomCode(source: string): string | null {
  const syntax = validateCustomCode(source);
  if (syntax) return syntax;
  let tree: ReturnType<typeof parse>;
  try { tree = parse(`function draw(fps,width,height,theme,cues) {\n${source}\n}`, { ecmaVersion: 2023 }); }
  catch (error) { return `旁白同步组件 JavaScript 语法错误：${error instanceof Error ? error.message : '无法解析'}`; }
  let invalid: string | undefined;
  type Node = { type: string; name?: string; [key: string]: unknown };
  function visit(node: Node, parent?: Node, key?: string) {
    if (node.type === 'Identifier' && ['frame', 'progress'].includes(node.name || '')) {
      const property = key === 'property' && parent?.type === 'MemberExpression' && !parent.computed;
      const literalKey = key === 'key' && ['Property', 'MethodDefinition'].includes(parent?.type || '') && !parent?.computed && !parent?.shorthand;
      if (!property && !literalKey) invalid = node.name;
    }
    for (const [childKey, value] of Object.entries(node)) {
      if (Array.isArray(value)) for (const child of value) { if (child && typeof child === 'object' && 'type' in child) visit(child as Node, node, childKey); }
      else if (value && typeof value === 'object' && 'type' in value) visit(value as Node, node, childKey);
    }
  }
  visit(tree as unknown as Node);
  return invalid ? `旁白同步组件不能使用独立的 ${invalid} 时钟；用 cues.<动作ID>.started 触发语义状态，再用该 cue 的 frame/progress 做过渡。` : null;
}

export const CUSTOM_COMPONENT_API = `custom 对象的 content 是 JavaScript 函数体（不是 Markdown 代码围栏、React/JSX、完整函数或 HTML 页面）。
NARRATION-BOUND MOTION：每个新 custom 对象都必须设置 motion={"version":"narration-v1","cues":[{"id":"reveal","utteranceId":"u_reveal"}]}，静态组件也绑定首次展示它的旁白；其他对象 motion=null。这里的 ID 仅说明接口，实际名称按内容选择。cue 的 id 是以字母开头的ASCII字母数字下划线短横线，不能使用原型/构造器等保留名称；按旁白顺序排列，1–16个，不重复，同一对象每句最多一个cue。引用本场景真实 narration ID，且该句 showObjectIds 必须包含此对象。
已提供 fps、width、height、theme={background,surface,text,muted,accent}、cues。width/height 是组件当前实际可用画布的逻辑像素；独占场景时为1280×720，compare或混排时由布局分配。必须按传入尺寸构图，不能假定固定的窄正文区域。没有独立的 frame 或 progress 全场景时钟，直接使用它们会校验失败。
每个 cues.<id>={started,active,completed,frame,durationFrames,progress} 由该句真实TTS起止时间驱动。未来的cue始终 started=false、active=false、completed=false、frame=0、progress=0；开口后 started=true；本句结束后 completed=true，局部frame/progress停在终点，started仍为true。每次绘制根据当前播放位置直接计算，拖动/暂停/导出一致。
可选纯函数助手 anim：clamp(value,min=0,max=1)；lerp(from,to,t)（t不截断，允许回弹）；ease(t,name='outCubic')（t截到0–1，支持linear/outCubic/inOutCubic/outQuint/backOut）；tween(cue,seconds,delay=0,easing='outCubic')；pointOnBezier(p0,p1,p2,p3,t)（四个点为[x,y]，t截到0–1，返回[x,y]）。例如 const p=anim.tween(cues.reveal,0.7,0.1,'outCubic'); const x=anim.lerp(-40,0,p);。tween只使用此cue的frame/fps，未来cue返回0，结束返回1；seconds>0且delay>=0，若delay+seconds超过该句时长则整体等比压缩，保证短句也达到终态。延迟可安排同一句内的同一语义动作的层次，不可代替后续旁白的cue。backOut有轻微超调，适合位置和缩放；透明度请用anim.clamp(p)。非法参数会报可修复错误。助手可选，现有手写插值仍兼容。
需要与旁白同步的信息揭示或语义状态变化，分别绑定直接引入它的短 narration；不要将一大段中后面才出现的信息绑定到整段起点。先规划旁白ID和对应动作，再写图形代码。连续位移、渐变或氛围运动可在相关旁白的已触发cue内展开，不要求为每个插值帧或每次循环增加解说。
语义状态切换必须由对应cue.started触发，例如 const revealed=cues.reveal.started; 然后根据 revealed 选择揭示前后的画面。绑定该句的信息揭示或语义状态不能借其他cue的进度提前展示；不承担该揭示的场景铺陈或氛围构图按创作意图安排。渐变/位移可以在 started 后用 Math.min(1,cues.reveal.frame/(fps*0.4)) 做短过渡；0.4秒仅是接口示例，节奏按内容和创作要求决定。不要以别的cue进度或累计时长推算未来cue；不要用缺失cue的fallback提前展示信息。此契约对齐旁白段开口，不提供句内逐词时间；有先后语义变化就拆短旁白段或场景。
必须同步 return 一个完整 SVG 字符串，根节点 xmlns="http://www.w3.org/2000/svg"，viewBox 用字符串拼接设置为 "0 0 " + width + " " + height，适配实际视口。组件可以覆盖整个画布，不需要重画固定的外框、章节栏或字幕栏。
可以用普通 JavaScript、数组、循环、Math 计算曲线/示意/模拟；只用已触发cue的局部时间驱动动画。禁止 DOM、网络、import、React、CSS动画、SMIL、外部资源。Date 不可用，Math.random 固定种子。
SVG标签可用 svg,g,rect,circle,ellipse,line,path,polyline,polygon,text,tspan,defs,linearGradient,radialGradient,stop,clipPath。用属性设置颜色和字体，不用 style。文字至少24px，画面留16px安全边距。
允许普通几何、路径、字体、变换、渐变和clip-path属性；禁止事件、href、image、foreignObject、script。引用素材使用独立 image 对象。
允许有限正数pathLength属性，例如pathLength="1" stroke-dasharray="1" stroke-dashoffset="..."，用1-anim.tween(cues.draw,0.8)计算描边偏移。镜头推进和视差可通过嵌套g的translate/scale变换表现；这些属性仍由cue驱动，不使用独立动画时钟。
色值使用十六进制、普通颜色名、rgb/rgba/hsl/hsla 数值；不使用 CSS 变量、转义或注释。渐变和裁剪仅用 url(#id) 引用本 SVG 中的定义，id 以字母开头且不可重复。
每个custom对象独占一个场景或compare一列，代码<=12000字符，输出<=100000字符，节点<=2000。计算受时间和内存限制。
视觉设计由文稿、受众和创作要求决定；可采用静态构图、图解、插画、信息图、有意设计的文字排版或抽象画面，不预设某一种题材或表现形式。文字主导的构图可以成立，但承诺展示图形关系时不能仅用段落文字代替。
动画可服务于信息、叙事、情绪、节奏或注意力组织。与旁白相关的信息变化按对应cue推进，并给观众足够的阅读时间；其余连续运动在已触发cue的局部时间内计算。循环只在内容或明确创作意图需要时使用，cue结束后保留合理的静态终态。并非每个视频都需要动画、图解、解释步骤或结果总结。
不要默认套用同一移动圆点、漂浮、脉冲或进度装饰来填满所有题材；形状与运动应服从具体构图。代表对象、数据或关系时，要让所指及变化清楚，路径符合关系；用于抽象、情绪或氛围表达时，不必强行赋予几何图形实体身份或添加解说标签，但须符合创作要求且不冒充事实信息。
返回代码前检查：这段运动是否传递信息、推动叙事、塑造明确的氛围或组织注意力？若都没有，去掉运动并保留清晰画面。`;
