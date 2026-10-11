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
NARRATION-BOUND MOTION：每个新 custom 对象都必须设置 motion={"version":"narration-v1","cues":[{"id":"result","utteranceId":"u_result"}]}，静态组件也绑定首次展示它的旁白；其他对象 motion=null。cue 的 id 是以字母开头的ASCII字母数字下划线短横线，不能使用原型/构造器等保留名称；按旁白顺序排列，1–16个，不重复，同一对象每句最多一个cue。引用本场景真实 narration ID，且该句 showObjectIds 必须包含此对象。
已提供 fps、width=1104（compare时520）、height=286、theme={background,surface,text,muted,accent}、cues。没有独立的 frame 或 progress 全场景时钟，直接使用它们会校验失败。
每个 cues.<id>={started,active,completed,frame,durationFrames,progress} 由该句真实TTS起止时间驱动。未来的cue始终 started=false、active=false、completed=false、frame=0、progress=0；开口后 started=true；本句结束后 completed=true，局部frame/progress停在终点，started仍为true。每次绘制根据当前播放位置直接计算，拖动/暂停/导出一致。
一个语义状态变化对应一段独立 narration，动作绑定直接讲述它的那一段；不要把动作放在一大段讲解的第三句话再绑定该段起点。先规划旁白ID和动作，再写图形代码。例：u_context讲查找名称，u_result单独讲“负二乘以负二，得到四”，result cue只引用u_result。
状态切换必须由对应cue.started触发，例如 const result=cues.result.started; 然后 result ? '返回4' : '等待求值'。结果、局部帧、新绑定、下一步高亮在对应cue开始前不得出现。渐变/位移可以在 started 后用 Math.min(1,cues.result.frame/(fps*0.4)) 做0.4秒短过渡。不要以别的cue进度或累计时长推算未来cue；不要用缺失cue的fallback提前展示结果。此契约对齐旁白段开口，不提供句内逐词时间；有先后动作就拆短语义段或场景。
必须同步 return 一个完整 SVG 字符串，根节点 xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1104 286"；也可用 width/height 拼接适配视口。
可以用普通 JavaScript、数组、循环、Math 计算曲线/示意/模拟；只用已触发cue的局部时间驱动动画。禁止 DOM、网络、import、React、CSS动画、SMIL、外部资源。Date 不可用，Math.random 固定种子。
SVG标签可用 svg,g,rect,circle,ellipse,line,path,polyline,polygon,text,tspan,defs,linearGradient,radialGradient,stop,clipPath。用属性设置颜色和字体，不用 style。文字至少24px，画面留16px安全边距。
允许普通几何、路径、字体、变换、渐变和clip-path属性；禁止事件、href、image、foreignObject、script。引用素材使用独立 image 对象。
色值使用十六进制、普通颜色名、rgb/rgba/hsl/hsla 数值；不使用 CSS 变量、转义或注释。渐变和裁剪仅用 url(#id) 引用本 SVG 中的定义，id 以字母开头且不可重复。
每个custom对象独占一个场景或compare一列，代码<=12000字符，输出<=100000字符，节点<=2000。计算受时间和内存限制。
视觉设计先确定要传达的信息、实体、关系、状态或情绪；静态图解可以直接保留，不要求每个组件都动，也不要仅将段落文字包进SVG。
动画应服务于信息表达、叙事、情绪或构图，并有具体作用：例如代码求值逐步替换子表达式、变量重新绑定时改变连线、图表随数据变化、推导时高亮当前步骤，也可以通过有意图的揭示、节奏或构图变化建立叙事和氛围。按对应旁白cue分阶段推进，完成后停留在结果，给观众阅读时间；只有内容本身是周期过程时才在已触发的cue中循环。
禁止为凑动态添加无语义的移动小球、沿线游走圆点、绕圈、漂浮、脉冲或进度装饰。移动圆形仅在确实表示物体、粒子或数据实体时使用，其身份和运动含义须由画面语境、标签、图例或旁白说明；数据流优先移动带实际值的标签，不能用同一颗匿名小球替代不同概念。运动路径必须符合图中关系，不能穿过无关卡片。
返回代码前检查：这段运动是否传递信息、推动叙事、塑造明确的氛围或组织注意力？若都没有，去掉运动并保留清晰画面。`;
