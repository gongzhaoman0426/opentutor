import type { Asset, Lesson, RenderPlan, Scene, TeachingObject } from '../shared/schema';
import catalogImage from './catalog-image.json';
import { DIAGRAM_LANGUAGE } from '../shared/diagram';
import { formStudyCode, perspectiveStudyCode } from './creative-examples';

export const waveComponentCode = `const cue = cues.demo;
const elapsed = cue.started ? cue.frame / fps : 0;
const inset = width * 0.06, cy = height * 0.55, amplitude = height * 0.26;
const fontSize = Math.max(24, Math.min(36, width * 0.034, height * 0.055));
const points = Array.from({length: 180}, (_, i) => {
  const x = inset + i * (width - 2 * inset) / 179;
  return x.toFixed(2) + ',' + (cy - Math.sin(i / 18 - elapsed * 2) * amplitude).toFixed(2);
}).join(' ');
return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 '+width+' '+height+'">'
  + '<line x1="'+inset+'" y1="'+cy+'" x2="'+(width-inset)+'" y2="'+cy+'" stroke="'+theme.muted+'" stroke-width="2"/>'
  + '<polyline points="'+points+'" fill="none" stroke="'+theme.accent+'" stroke-width="5"/>'
  + '<text x="'+inset+'" y="'+(height*0.14)+'" fill="'+theme.text+'" font-size="'+fontSize+'">波形随时间向前传播</text></svg>';`;

export const orbitComponentCode = `const cue = cues.demo;
const elapsed = cue.started ? cue.frame / fps : 0;
const x=width/2, y=height*0.55, radius=Math.min(width*0.32,height*0.28), angle=elapsed*1.5;
const fontSize=Math.max(24,Math.min(36,width*0.034,height*0.055));
const centerRadius=Math.max(9,Math.min(18,radius*0.09)), pointRadius=Math.max(7,Math.min(14,radius*0.07));
const px=x+Math.cos(angle)*radius, py=y+Math.sin(angle)*radius;
return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 '+width+' '+height+'">'
+ '<circle cx="'+x+'" cy="'+y+'" r="'+radius+'" fill="none" stroke="'+theme.muted+'" stroke-width="2" stroke-dasharray="6 6"/>'
+ '<line x1="'+x+'" y1="'+y+'" x2="'+px+'" y2="'+py+'" stroke="'+theme.accent+'" stroke-width="3"/>'
+ '<circle cx="'+x+'" cy="'+y+'" r="'+centerRadius+'" fill="'+theme.text+'"/>'
+ '<circle cx="'+px+'" cy="'+py+'" r="'+pointRadius+'" fill="'+theme.accent+'"/>'
+ '<text x="'+(width*0.06)+'" y="'+(height*0.14)+'" fill="'+theme.text+'" font-size="'+fontSize+'">匀速圆周运动：半径保持不变</text></svg>';`;

export const barsComponentCode = `const values=[30,60,45], labels=['A','B','C'];
const cue=cues.demo;
const eased=cue.started ? 1-Math.pow(1-Math.min(1,cue.progress*2),3) : 0;
const baseline=height*0.83, plotHeight=height*0.60;
const fontSize=Math.max(24,Math.min(36,width*0.034,height*0.055));
const bars=values.map((value,i)=>{
  const x=width*0.15+i*width*0.25, h=value/60*plotHeight*eased, barWidth=width*0.20;
  return '<rect x="'+x+'" y="'+(baseline-h)+'" width="'+barWidth+'" height="'+h+'" rx="6" fill="'+theme.accent+'"/>'
    +'<text x="'+(x+barWidth/2)+'" y="'+(baseline-h-fontSize*0.45)+'" fill="'+theme.text+'" font-size="'+fontSize+'" text-anchor="middle">'+Math.round(value*eased)+'</text>'
    +'<text x="'+(x+barWidth/2)+'" y="'+(baseline+fontSize*1.35)+'" fill="'+theme.muted+'" font-size="'+fontSize+'" text-anchor="middle">'+labels[i]+'</text>';
}).join('');
return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 '+width+' '+height+'">'+bars+'</svg>';`;

const image: Asset = { id: '00000000-0000-4000-8000-000000000001', name: '组件预览示例.png', mime: 'image/png', url: catalogImage.url, hash: 'catalog-image-v1', width: 640, height: 320 };
export interface ComponentExample { id: string; title: string; description: string; kind: 'preset' | 'creative'; plan: RenderPlan; assets: Asset[] }
const object = (type: TeachingObject['type'], content: string, id: string = type): TeachingObject => ({ id, type, content, language: type === 'code' ? 'python' : type === 'custom' ? 'javascript' : '', ...(type === 'custom' ? { motion: { version: 'narration-v1', cues: [{ id: 'demo', utteranceId: 'demo-narration' }] } } : {}) });
function example(id: string, title: string, description: string, layout: Scene['layout'], objects: TeachingObject[], kind: ComponentExample['kind'] = 'preset'): ComponentExample {
  const scene: Scene = { id, title, chapter: '组件预览', layout, sourceBlockIds: ['catalog'], objects, narration: [{ id: 'demo-narration', text: description, showObjectIds: objects.map(item => item.id), focusObjectId: objects[0].id }] };
  const plan: RenderPlan = { schemaVersion: '0.1', layoutVersion: 'full-frame', burnSubtitles: false, revision: 1, title, fps: 30, width: 1280, height: 720, theme: 'sage', totalFrames: 180, previewMode: 'draft', scenes: [{ scene, startFrame: 0, durationFrames: 180, utterances: [{ utteranceId: 'demo-narration', url: '', durationSeconds: 6, boundaries: [{ kind: 'utterance', text: description, startSeconds: 0, endSeconds: 6 }], cacheHit: false, hash: '', estimated: true, startFrame: 0, durationFrames: 180 }] }] };
  return { id, title, description, kind, plan, assets: objects.some(item => item.type === 'image') ? [image] : [] };
}

function motionStudy(id: string, title: string, description: string, content: string, beats: [string, string][]): ComponentExample {
  const durationFrames = 96;
  const graphic: TeachingObject = { id: 'graphic', type: 'custom', content, language: 'javascript', motion: { version: 'narration-v1', cues: beats.map(([cue]) => ({ id: cue, utteranceId: `narration-${cue}` })) } };
  const scene: Scene = { id, title, chapter: 'Motion design studies', layout: 'content', sourceBlockIds: ['catalog'], objects: [graphic], narration: beats.map(([cue, text]) => ({ id: `narration-${cue}`, text, showObjectIds: ['graphic'], focusObjectId: 'graphic' })) };
  const plan: RenderPlan = { schemaVersion: '0.1', layoutVersion: 'full-frame', burnSubtitles: false, revision: 1, title, fps: 30, width: 1280, height: 720, theme: 'sage', totalFrames: durationFrames * beats.length, previewMode: 'draft', scenes: [{ scene, startFrame: 0, durationFrames: durationFrames * beats.length, utterances: scene.narration.map((unit, index) => ({ utteranceId: unit.id, url: '', durationSeconds: durationFrames / 30, boundaries: [{ kind: 'utterance', text: unit.text, startSeconds: 0, endSeconds: durationFrames / 30 }], cacheHit: false, hash: '', estimated: true, startFrame: index * durationFrames, durationFrames })) }] };
  return { id, title, description, kind: 'creative', plan, assets: [] };
}

export const componentCatalog: ComponentExample[] = [
  example('text', '文字与要点', '逐步呈现产品特点、观点和重点信息', 'content', [object('text', '**把团队进展放在一起**\n\n- 集中查看本周事项\n- 标记负责人和下一步行动')]),
  example('code', '代码快照', '呈现代码与讲解，保留缩进与换行', 'code', [object('code', 'balance = 1000\nfor year in range(3):\n    balance *= 1.05\n    print(round(balance, 2))')]),
  example('formula', '数学公式', '使用 LaTeX 显示公式、符号和推导', 'content', [object('formula', 'A = P(1+r)^n')]),
  example('table', '数据表格', '用清晰的行列呈现统计、对比与进展', 'content', [object('table', '| 项目 | 本周状态 |\n| --- | --- |\n| 首页设计 | 已完成 |\n| 用户访谈 | 进行中 |\n| 新版发布 | 下周开始 |')]),
  example('image', '图片与标注', '展示截图、照片或插图，并突出相关区域', 'content', [{ ...object('image', image.id), imagePresentation: { fit: 'contain', caption: 'B 的数值大于 A', region: null, highlight: { x: 0.56, y: 0.1, width: 0.2, height: 0.69 } } }]),
  example('diagram', '节点与关系图', '用节点和箭头表达流程、概念关系与名称绑定', 'diagram', [{ ...object('diagram', JSON.stringify({ nodes: [{ id: 'source', label: '文稿与图片' }, { id: 'plan', label: '画面与旁白' }, { id: 'preview', label: '可播放视频' }], edges: [{ from: 'source', to: 'plan', label: '编排' }, { from: 'plan', to: 'preview', label: '配音对齐' }] })), language: DIAGRAM_LANGUAGE }]),
  example('layout-title', '开场标题', '呈现主题、引入问题或开启一段故事', 'title', [object('text', '**夜班渡船**\n\n最后一班船靠岸时，码头还亮着一盏灯。')]),
  example('layout-compare', '双栏对比', '并排呈现两种概念、观点或方法', 'compare', [object('text', '**单利**\n\n每期按初始本金计算。', 'left'), object('text', '**复利**\n\n每期按累计金额计算。', 'right')]),
  example('layout-summary', '收尾与行动', '呈现结论、下一步行动或故事尾声', 'summary', [object('text', '**下一步，开始你的项目。**\n\n写下内容 · 加入图片 · 生成预览')]),
  example('custom-wave', '动态波形', 'AI 代码按帧计算曲线与传播过程', 'content', [object('custom', waveComponentCode)], 'creative'),
  example('custom-orbit', '运动示意', 'AI 代码计算位置，呈现连续运动与关系', 'content', [object('custom', orbitComponentCode)], 'creative'),
  example('custom-bars', '动态数据图', 'AI 代码绘制图表，并控制数值与入场动画', 'content', [object('custom', barsComponentCode)], 'creative'),
  motionStudy('custom-form-study', '形态重组', '保持同一组图形的连续性，用错峰、形变与构图转场形成完整段落', formStudyCode, [
    ['gather', 'Independent pieces establish a rhythm.'],
    ['fold', 'The same pieces fold into a shared form.'],
    ['resolve', 'Same parts. New form. A composition with room to breathe.'],
  ]),
  motionStudy('custom-perspective-study', '空间镜头', '通过真实透视计算、分层视差与镜头推进，将注意力收束到主体', perspectiveStudyCode, [
    ['establish', 'Layers of space establish a perspective.'],
    ['travel', 'Move through the layers to change the point of view.'],
    ['focus', 'Look closer. Bring the subject into focus.'],
  ]),
];

export function catalogLesson(example: ComponentExample): Lesson { return { schemaVersion: '0.1', title: example.title, objectives: [example.description], scenes: example.plan.scenes.map(item => item.scene) }; }
