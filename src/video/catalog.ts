import type { Asset, Lesson, RenderPlan, Scene, TeachingObject } from '../shared/schema';
import catalogImage from './catalog-image.json';

export const waveComponentCode = `const cy = height / 2;
const points = Array.from({length: 180}, (_, i) => {
  const x = 24 + i * (width - 48) / 179;
  return x.toFixed(2) + ',' + (cy - Math.sin(i / 18 - frame / fps * 2) * 70).toFixed(2);
}).join(' ');
return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 '+width+' '+height+'">'
  + '<line x1="20" y1="'+cy+'" x2="'+(width-20)+'" y2="'+cy+'" stroke="'+theme.muted+'" stroke-width="2"/>'
  + '<polyline points="'+points+'" fill="none" stroke="'+theme.accent+'" stroke-width="5"/>'
  + '<text x="24" y="32" fill="'+theme.text+'" font-size="26">波形随时间向前传播</text></svg>';`;

export const orbitComponentCode = `const x=width/2, y=height/2+12, radius=92, angle=frame/fps*1.5;
const px=x+Math.cos(angle)*radius, py=y+Math.sin(angle)*radius;
return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 '+width+' '+height+'">'
+ '<circle cx="'+x+'" cy="'+y+'" r="'+radius+'" fill="none" stroke="'+theme.muted+'" stroke-width="2" stroke-dasharray="6 6"/>'
+ '<line x1="'+x+'" y1="'+y+'" x2="'+px+'" y2="'+py+'" stroke="'+theme.accent+'" stroke-width="3"/>'
+ '<circle cx="'+x+'" cy="'+y+'" r="16" fill="'+theme.text+'"/>'
+ '<circle cx="'+px+'" cy="'+py+'" r="11" fill="'+theme.accent+'"/>'
+ '<text x="24" y="32" fill="'+theme.text+'" font-size="26">匀速圆周运动：半径保持不变</text></svg>';`;

export const barsComponentCode = `const values=[30,60,45], labels=['A','B','C'];
const eased=1-Math.pow(1-Math.min(1,progress*2),3);
const bars=values.map((value,i)=>{
  const x=width*0.18+i*width*0.25, h=value*2.5*eased;
  return '<rect x="'+x+'" y="'+(230-h)+'" width="'+(width*0.13)+'" height="'+h+'" rx="6" fill="'+theme.accent+'"/>'
    +'<text x="'+x+'" y="'+(218-h)+'" fill="'+theme.text+'" font-size="24">'+Math.round(value*eased)+'</text>'
    +'<text x="'+x+'" y="265" fill="'+theme.muted+'" font-size="24">'+labels[i]+'</text>';
}).join('');
return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 '+width+' '+height+'">'+bars+'</svg>';`;

const image: Asset = { id: '00000000-0000-4000-8000-000000000001', name: '组件预览示例.png', mime: 'image/png', url: catalogImage.url, hash: 'catalog-image-v1', width: 640, height: 320 };
export interface ComponentExample { id: string; title: string; description: string; kind: 'preset' | 'creative'; plan: RenderPlan; assets: Asset[] }
const object = (type: TeachingObject['type'], content: string, id: string = type): TeachingObject => ({ id, type, content, language: type === 'code' ? 'python' : '' });
function example(id: string, title: string, description: string, layout: Scene['layout'], objects: TeachingObject[], kind: ComponentExample['kind'] = 'preset'): ComponentExample {
  const scene: Scene = { id, title, chapter: '组件预览', layout, sourceBlockIds: ['catalog'], objects, narration: [{ id: 'demo-narration', text: description, showObjectIds: objects.map(item => item.id), focusObjectId: objects[0].id }] };
  const plan: RenderPlan = { schemaVersion: '0.1', revision: 1, title, fps: 30, width: 1280, height: 720, theme: 'sage', totalFrames: 180, previewMode: 'draft', scenes: [{ scene, startFrame: 0, durationFrames: 180, utterances: [{ utteranceId: 'demo-narration', url: '', durationSeconds: 6, boundaries: [{ kind: 'utterance', text: description, startSeconds: 0, endSeconds: 6 }], cacheHit: false, hash: '', estimated: true, startFrame: 0, durationFrames: 180 }] }] };
  return { id, title, description, kind, plan, assets: objects.some(item => item.type === 'image') ? [image] : [] };
}

export const componentCatalog: ComponentExample[] = [
  example('text', '文字与要点', '逐步呈现产品特点、观点和重点信息', 'content', [object('text', '**把团队进展放在一起**\n\n- 集中查看本周事项\n- 标记负责人和下一步行动')]),
  example('code', '代码快照', '呈现代码与讲解，保留缩进与换行', 'code', [object('code', 'balance = 1000\nfor year in range(3):\n    balance *= 1.05\n    print(round(balance, 2))')]),
  example('formula', '数学公式', '使用 LaTeX 显示公式、符号和推导', 'content', [object('formula', 'A = P(1+r)^n')]),
  example('table', '数据表格', '用清晰的行列呈现统计、对比与进展', 'content', [object('table', '| 项目 | 本周状态 |\n| --- | --- |\n| 首页设计 | 已完成 |\n| 用户访谈 | 进行中 |\n| 新版发布 | 下周开始 |')]),
  example('image', '图片与标注', '展示截图、照片或插图，并突出相关区域', 'content', [{ ...object('image', image.id), imagePresentation: { fit: 'contain', caption: 'B 的数值大于 A', region: null, highlight: { x: 0.56, y: 0.1, width: 0.2, height: 0.69 } } }]),
  example('diagram', '分步关系', '用文字顺序表达过程与关系', 'diagram', [object('diagram', '① 写入文稿与图片\n\n② 编排画面与旁白\n\n③ 配音并生成预览')]),
  example('layout-title', '开场标题', '呈现主题、引入问题或开启一段故事', 'title', [object('text', '**夜班渡船**\n\n最后一班船靠岸时，码头还亮着一盏灯。')]),
  example('layout-compare', '双栏对比', '并排呈现两种概念、观点或方法', 'compare', [object('text', '**单利**\n\n每期按初始本金计算。', 'left'), object('text', '**复利**\n\n每期按累计金额计算。', 'right')]),
  example('layout-summary', '收尾与行动', '呈现结论、下一步行动或故事尾声', 'summary', [object('text', '**下一步，开始你的项目。**\n\n写下内容 · 加入图片 · 生成预览')]),
  example('custom-wave', '动态波形', 'AI 代码按帧计算曲线与传播过程', 'content', [object('custom', waveComponentCode)], 'creative'),
  example('custom-orbit', '运动示意', 'AI 代码计算位置，呈现连续运动与关系', 'content', [object('custom', orbitComponentCode)], 'creative'),
  example('custom-bars', '动态数据图', 'AI 代码绘制图表，并控制数值与入场动画', 'content', [object('custom', barsComponentCode)], 'creative'),
];

export function catalogLesson(example: ComponentExample): Lesson { return { schemaVersion: '0.1', title: example.title, objectives: [example.description], scenes: example.plan.scenes.map(item => item.scene) }; }
