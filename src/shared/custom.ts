import { parse } from 'acorn';

/** Syntax checks are diagnostics; the isolated VM and SVG allowlist enforce execution boundaries. */
export function validateCustomCode(source: string): string | null {
  if (!source.trim() || source.length > 12000) return '自定义组件代码必须为 1–12000 字符';
  try { parse(`function draw(frame,fps,width,height,progress,theme) {\n"use strict";\n${source}\n}`, { ecmaVersion: 2023 }); }
  catch (error) { return `自定义组件 JavaScript 语法错误：${error instanceof Error ? error.message : '无法解析'}`; }
  return null;
}

export const CUSTOM_COMPONENT_API = `custom 对象的 content 是 JavaScript 函数体（不是 Markdown 代码围栏、React/JSX、完整函数或 HTML 页面）。
已提供 frame（当前对象显示后的帧数）、fps、width=1104（compare时520）、height=286、progress（当前对象0..1）、theme={background,surface,text,muted,accent}。
必须同步 return 一个完整 SVG 字符串，根节点 xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1104 286"；也可用 width/height 拼接适配视口。
可以用普通 JavaScript、数组、循环、Math 计算曲线/示意/模拟；只用 frame/progress 驱动动画。禁止 DOM、网络、import、React、CSS动画、SMIL、外部资源。Date 不可用，Math.random 固定种子。
SVG标签可用 svg,g,rect,circle,ellipse,line,path,polyline,polygon,text,tspan,defs,linearGradient,radialGradient,stop,clipPath。用属性设置颜色和字体，不用 style。文字至少24px，画面留16px安全边距。
允许普通几何、路径、字体、变换、渐变和clip-path属性；禁止事件、href、image、foreignObject、script。引用素材使用独立 image 对象。
色值使用十六进制、普通颜色名、rgb/rgba/hsl/hsla 数值；不使用 CSS 变量、转义或注释。渐变和裁剪仅用 url(#id) 引用本 SVG 中的定义，id 以字母开头且不可重复。
每个custom对象独占一个场景或compare一列，代码<=12000字符，输出<=100000字符，节点<=2000。计算受时间和内存限制。
视觉设计先确定要传达的信息、实体、关系、状态或情绪；静态图解可以直接保留，不要求每个组件都动，也不要仅将段落文字包进SVG。
动画应服务于信息表达、叙事、情绪或构图，并有具体作用：例如代码求值逐步替换子表达式、变量重新绑定时改变连线、图表随数据变化、推导时高亮当前步骤，也可以通过有意图的揭示、节奏或构图变化建立叙事和氛围。按内容节奏用 progress 分阶段推进，完成后停留在结果，给观众阅读时间；只有内容本身是周期过程时才循环。
禁止为凑动态添加无语义的移动小球、沿线游走圆点、绕圈、漂浮、脉冲或进度装饰。移动圆形仅在确实表示物体、粒子或数据实体时使用，其身份和运动含义须由画面语境、标签、图例或旁白说明；数据流优先移动带实际值的标签，不能用同一颗匿名小球替代不同概念。运动路径必须符合图中关系，不能穿过无关卡片。
返回代码前检查：这段运动是否传递信息、推动叙事、塑造明确的氛围或组织注意力？若都没有，去掉运动并保留清晰画面。`;
