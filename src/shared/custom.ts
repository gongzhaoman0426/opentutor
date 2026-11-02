import { parse } from 'acorn';

export const CUSTOM_CODE_LIMIT = 20000;
/** Drawing surface in 1280-wide base units; the renderer scales it with the video resolution. */
export function customBox(layout: string): { width: number; height: number } {
  return layout === 'canvas' ? { width: 1280, height: 720 } : { width: layout === 'compare' ? 520 : 1104, height: 286 };
}

/** Syntax checks are diagnostics; the isolated VM and SVG allowlist enforce execution boundaries. */
export function validateCustomCode(source: string): string | null {
  if (!source.trim() || source.length > CUSTOM_CODE_LIMIT) return '自定义组件代码必须为 1–20000 字符';
  try { parse(`function draw() {\n"use strict";\n${source}\n}`, { ecmaVersion: 2023 }); }
  catch (error) { return `自定义组件 JavaScript 语法错误：${error instanceof Error ? error.message : '无法解析'}`; }
  return null;
}


/**
 * Deterministic helpers injected at the top level of the sandbox. They are plain `const`s outside the user's
 * function, so generated code may shadow any of them (e.g. declare its own `clamp`) without a redeclaration error.
 */
export const CUSTOM_PRELUDE = `
const clamp=(v,a=0,b=1)=>Math.min(b,Math.max(a,v));
const lerp=(a,b,t)=>a+(b-a)*t;
const range=(t,a,b)=>clamp((t-a)/((b-a)||1));
const ease={linear:t=>clamp(t),inQuad:t=>clamp(t)**2,outQuad:t=>1-(1-clamp(t))**2,inOutQuad:t=>{t=clamp(t);return t<.5?2*t*t:1-(-2*t+2)**2/2},outCubic:t=>1-(1-clamp(t))**3,inOutCubic:t=>{t=clamp(t);return t<.5?4*t*t*t:1-(-2*t+2)**3/2},outQuart:t=>1-(1-clamp(t))**4,outExpo:t=>{t=clamp(t);return t>=1?1:1-2**(-10*t)},inOutSine:t=>-(Math.cos(Math.PI*clamp(t))-1)/2,outBack:(t,s=1.70158)=>{t=clamp(t)-1;return 1+(s+1)*t**3+s*t**2},outElastic:t=>{t=clamp(t);return t===0||t===1?t:2**(-10*t)*Math.sin((t*10-.75)*2*Math.PI/3)+1},spring:(t,damping=.6)=>{t=clamp(t);return 1-Math.exp(-6*t*(1-damping*.5))*Math.cos(12*t*damping)}};
const stagger=(i,n,t,spread=.5)=>range(t,i/Math.max(1,n)*spread,i/Math.max(1,n)*spread+(1-spread));
const hex=c=>{c=String(c).replace('#','');if(c.length===3)c=c.split('').map(x=>x+x).join('');return[0,2,4].map(i=>parseInt(c.slice(i,i+2),16)||0)};
const mix=(a,b,t)=>{const x=hex(a),y=hex(b);return'#'+x.map((v,i)=>Math.round(lerp(v,y[i],clamp(t))).toString(16).padStart(2,'0')).join('')};
const alpha=(c,a)=>{const x=hex(c);return'rgba('+x[0]+','+x[1]+','+x[2]+','+clamp(a).toFixed(3)+')'};
const noise=(x,y=0,seed=0)=>{const h=(i,j)=>{let n=Math.imul(i*374761393+j*668265263+seed*2147483647|0,1274126177);n=(n^n>>>13)>>>0;return(Math.imul(n,1103515245)>>>0)/4294967295*2-1};const i=Math.floor(x),j=Math.floor(y),u=x-i,v=y-j,f=t=>t*t*(3-2*t);return lerp(lerp(h(i,j),h(i+1,j),f(u)),lerp(h(i,j+1),h(i+1,j+1),f(u)),f(v))};
const polar=(cx,cy,r,deg)=>[cx+r*Math.sin(deg*Math.PI/180),cy-r*Math.cos(deg*Math.PI/180)];
const arc=(cx,cy,r,a0,a1)=>{const p=polar(cx,cy,r,a0),q=polar(cx,cy,r,a1);return'M'+p[0].toFixed(2)+' '+p[1].toFixed(2)+'A'+r+' '+r+' 0 '+(Math.abs(a1-a0)>180?1:0)+' '+(a1>a0?1:0)+' '+q[0].toFixed(2)+' '+q[1].toFixed(2)};
const smoothPath=(pts,k=.5)=>{if(pts.length<2)return'';let d='M'+pts[0][0].toFixed(2)+' '+pts[0][1].toFixed(2);for(let i=0;i<pts.length-1;i++){const p0=pts[i-1]||pts[i],p1=pts[i],p2=pts[i+1],p3=pts[i+2]||p2;d+='C'+(p1[0]+(p2[0]-p0[0])*k/3).toFixed(2)+' '+(p1[1]+(p2[1]-p0[1])*k/3).toFixed(2)+' '+(p2[0]-(p3[0]-p1[0])*k/3).toFixed(2)+' '+(p2[1]-(p3[1]-p1[1])*k/3).toFixed(2)+' '+p2[0].toFixed(2)+' '+p2[1].toFixed(2)}return d};
const fmt=(n,d=0)=>Number(n).toFixed(d).replace(/\\B(?=(\\d{3})+(?!\\d))/g,',');
const svg=(inner,w=width,h=height)=>'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 '+w+' '+h+'">'+inner+'</svg>';
const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
`;

export const CUSTOM_COMPONENT_API = `custom 对象的 content 是 JavaScript 函数体（不是 Markdown 代码围栏、React/JSX、完整函数或 HTML 页面）。
【画布】layout=canvas 时对象铺满整个画面：width=1280，height=720（底部 80 单位留给字幕，重要内容放在 y<640），可叠加至多 4 个 custom 图层；canvas 场景不显示标题栏，场景标题、正文和视觉要全部由你绘制。其他布局：width=1104（compare 每列 520）、height=286，作为场景中的一块图形。
【输入变量】frame（对象显示后的帧数）、fps、time（秒，=frame/fps）、width、height、progress（对象存在期间 0..1）、theme={background,surface,text,muted,accent}。
【内置工具，无需声明；你自己声明同名变量也可以】clamp(v,a=0,b=1)、lerp(a,b,t)、range(t,a,b)（把 t 在 [a,b] 内归一化到 0..1）、ease.{linear,inQuad,outQuad,inOutQuad,outCubic,inOutCubic,outQuart,outExpo,inOutSine,outBack,outElastic,spring}(t)、stagger(i,n,t,spread=.5)（第 i 项的错峰进度 0..1）、mix(hexA,hexB,t)→十六进制色、alpha(hex,a)→rgba()、noise(x,y=0,seed=0)→-1..1 的平滑噪声、polar(cx,cy,r,deg)→[x,y]（0°在正上方，顺时针）、arc(cx,cy,r,a0,a1)→圆弧 path d、smoothPath(points,k=.5)→平滑曲线 path d、fmt(n,decimals)→千分位数字、esc(text)→XML 转义（文字里有 & < > 时必须转义）。
【输出】必须同步 return 一个完整 SVG 字符串，根节点 xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}"。普通 JavaScript、数组、循环、Math 均可；动画只用 frame/time/progress 驱动，Date 不可用，Math.random 为固定种子。禁止 DOM、网络、import、React、CSS 动画、SMIL、外部资源。
【SVG 白名单】标签：svg,g,rect,circle,ellipse,line,path,polyline,polygon,text,tspan,textPath,defs,use,linearGradient,radialGradient,stop,pattern,clipPath,mask,filter,feGaussianBlur,feDropShadow,feOffset,feFlood,feColorMatrix,feComposite,feBlend,feMerge,feMergeNode,feTurbulence,feComponentTransfer,feFuncR,feFuncG,feFuncB,feFuncA。用属性设置样式，不用 style；禁止事件、image、foreignObject、script、外链 href（use/textPath 只能写 href="#本SVG内的id"）。
渐变、图案、裁剪、蒙版、滤镜只能用 url(#id) 引用本 SVG 内定义，id 以字母开头且不重复。fill/stroke 可引用渐变或 pattern，clip-path 引用 clipPath，mask 引用 mask，filter 引用 filter。滤镜用于发光（feGaussianBlur+feMerge）、投影（feDropShadow）、噪点质感（feTurbulence）；stdDeviation≤60。注意：水平/垂直线（包围盒高或宽为 0）上的渐变必须写 gradientUnits="userSpaceOnUse" 并给出坐标，否则不会显示。绘线动画可用 pathLength="1" stroke-dasharray="1" stroke-dashoffset="{1-进度}"。色值使用十六进制、普通颜色名、rgb/rgba/hsl/hsla 数值，不用 CSS 变量、转义或注释。
【限额】代码≤20000字符，输出≤300000字符，节点≤6000（use≤300，filter≤8，feTurbulence≤3），单帧执行时间和内存有限；文字至少 24px，画面留 16px 安全边距。
【设计】先确定要传达的信息、实体、关系、状态或情绪，再决定构图：层级清晰的标题/主体/注释，统一间距，对比度充足，使用 theme 配色并用 mix/alpha 派生层次色，而不是堆满纯色块。优先做有质感的画面：渐变、柔和阴影与发光、圆角卡片、细线网格、适度的噪点或景深；入场用 ease.outCubic/outBack 与 stagger 错峰，数字用 progress 计数，线条用绘线动画，完成后停留在结果，给观众阅读时间。
【动效原则】每一段运动都应传达信息、推动叙事、塑造氛围或组织注意力：数据随时间变化、步骤依次点亮、对象沿真实关系移动、镜头式推拉与视差揭示。canvas 场景允许低对比度的氛围层（缓慢漂移的渐变光斑、网格或噪点）来营造质感，但必须不干扰文字，且不能代替内容。移动的圆点仅当它代表真实实体，并由标签或旁白说明；不要用同一颗匿名小球代替不同概念，运动路径不得穿过无关元素。静态图解同样有效，不要为动而动。返回代码前自查：画面是否一眼能看懂？文字是否清晰？动效是否有作用？`;

/** Reference implementations shown to the model. Every example is executed by the unit tests. */
export const CUSTOM_EXAMPLES = [
  { layout: 'content', title: '数据柱状图：错峰生长、发光、数字计数', code: `const data=[{l:'Q1',v:42},{l:'Q2',v:68},{l:'Q3',v:55},{l:'Q4',v:91}];
const base=height-56, bw=130, gap=(width-48-bw*data.length)/(data.length-1);
let out='<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="'+theme.accent+'"/><stop offset="1" stop-color="'+mix(theme.accent,theme.background,0.55)+'"/></linearGradient><filter id="glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="7"/></filter></defs>';
data.forEach((d,i)=>{
  const t=ease.outBack(stagger(i,data.length,time/1.4,0.6));
  const x=24+i*(bw+gap), h=(d.v/100)*(base-48)*t, y=base-h;
  out+='<rect x="'+x+'" y="'+y+'" width="'+bw+'" height="'+h+'" rx="12" fill="'+theme.accent+'" opacity="0.35" filter="url(#glow)"/>'
    +'<rect x="'+x+'" y="'+y+'" width="'+bw+'" height="'+h+'" rx="12" fill="url(#g)"/>'
    +'<text x="'+(x+bw/2)+'" y="'+(y-12)+'" fill="'+theme.text+'" font-size="30" font-weight="700" text-anchor="middle">'+Math.round(d.v*clamp(t))+'</text>'
    +'<text x="'+(x+bw/2)+'" y="'+(height-16)+'" fill="'+theme.muted+'" font-size="24" text-anchor="middle">'+esc(d.l)+'</text>';
});
return svg(out);` },
  { layout: 'canvas', title: '全屏开场：氛围光斑、标题错峰入场、绘线强调', code: `const T=time, reveal=(a,b)=>ease.outCubic(range(T,a,b));
let out='<defs><filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="46"/></filter><linearGradient id="rule" gradientUnits="userSpaceOnUse" x1="96" y1="0" x2="560" y2="0"><stop offset="0" stop-color="'+theme.accent+'"/><stop offset="1" stop-color="'+theme.accent+'" stop-opacity="0"/></linearGradient></defs>';
for(let i=0;i<3;i++){
  const cx=260+i*380+noise(T*0.25,i*7)*90, cy=250+noise(T*0.2,i*3+11)*70+(i%2)*160;
  out+='<circle cx="'+cx+'" cy="'+cy+'" r="'+(170+i*30)+'" fill="'+mix(theme.accent,theme.surface,i*0.3)+'" opacity="'+(0.4*reveal(0,1.2))+'" filter="url(#soft)"/>';
}
const lines=[['把想法讲清楚',84,theme.text,0.3],['一份文稿，一个视频',40,theme.muted,0.7]];
lines.forEach((l,i)=>{ const r=reveal(l[3],l[3]+0.8);
  out+='<text x="96" y="'+(330+i*84+(1-r)*26)+'" font-size="'+l[1]+'" font-weight="'+(i?400:700)+'" fill="'+l[2]+'" opacity="'+r+'">'+esc(l[0])+'</text>'; });
out+='<path d="M96 462 H560" stroke="url(#rule)" stroke-width="6" stroke-linecap="round" fill="none" pathLength="1" stroke-dasharray="1" stroke-dashoffset="'+(1-reveal(0.5,1.5))+'"/>';
return svg(out);` },
];
