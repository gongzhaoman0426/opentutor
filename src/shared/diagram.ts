import { z } from 'zod';

export const DIAGRAM_LANGUAGE = 'diagram-json';
export const DIAGRAM_HEIGHT = 286;

export function diagramTextUnits(text: string): number {
  return [...text].reduce((units, character) => units + (/[^\x00-\x7F]/.test(character) ? 1 : 0.55), 0);
}

const plainText = (units: number, name: string) => z.string().trim().min(1, `${name}不能为空`).max(80, `${name}过长`)
  .refine(text => !/[\u0000-\u001f\u007f]/.test(text), `${name}只能使用单行文字`)
  .refine(text => !/<\/?[a-z][^>]*>|<!|<\?/i.test(text), `${name}不能包含 HTML 或 SVG 标记`)
  .refine(text => diagramTextUnits(text) <= units, `${name}最多 ${units} 个汉字或约 ${Math.floor(units / 0.55)} 个英文字符，请使用短标签`);
const nodeId = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,31}$/, '节点 ID 应以英文字母开头，只含字母、数字、下划线或短横线，最多32字符');

export const DiagramSchema = z.object({
  nodes: z.array(z.object({ id: nodeId, label: plainText(12, '节点标签'), detail: plainText(10, '节点说明').optional() }).strict()).min(1, '图解至少需要一个节点').max(6, '单个图解最多6个节点'),
  edges: z.array(z.object({ from: nodeId, to: nodeId, label: plainText(6, '连线标签').optional() }).strict()).max(8, '单个图解最多8条连线'),
}).strict().superRefine((diagram, context) => {
  const ids = new Set<string>();
  for (const [index, node] of diagram.nodes.entries()) {
    if (ids.has(node.id)) context.addIssue({ code: 'custom', path: ['nodes', index, 'id'], message: '节点 ID 不能重复' });
    ids.add(node.id);
  }
  const connections = new Set<string>();
  for (const [index, edge] of diagram.edges.entries()) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) context.addIssue({ code: 'custom', path: ['edges', index], message: '连线必须引用本图中存在的节点 ID' });
    if (edge.from === edge.to) context.addIssue({ code: 'custom', path: ['edges', index], message: '请将自身循环拆成不同状态节点' });
    const connection = `${edge.from}:${edge.to}`;
    if (connections.has(connection)) context.addIssue({ code: 'custom', path: ['edges', index], message: '同方向连线不能重复' });
    connections.add(connection);
  }
});
export type Diagram = z.infer<typeof DiagramSchema>;

export function parseDiagram(content: string): Diagram {
  if (content.length > 6000) throw new Error('图解 JSON 最多6,000字符');
  let value: unknown;
  try { value = JSON.parse(content); }
  catch { throw new Error('图解内容必须是 JSON 对象，不能使用 Markdown、原始 SVG 或代码'); }
  const result = DiagramSchema.safeParse(value);
  if (!result.success) throw new Error(`图解数据无效：${result.error.issues.slice(0, 3).map(issue => `${issue.path.join('.') || 'diagram'} ${issue.message}`).join('；')}`);
  return result.data;
}

export function validateDiagram(content: string): string | null {
  try { parseDiagram(content); return null; }
  catch (error) { return error instanceof Error ? error.message : '图解数据无效'; }
}

export const DIAGRAM_COMPONENT_API = `
预设图解对象：type="diagram", language="diagram-json", content 是 JSON 字符串（不是 SVG、HTML、Markdown 或 JavaScript）。
数据格式：{"nodes":[{"id":"itemA","label":"要素甲","detail":"可选短说明"},{"id":"itemB","label":"要素乙"}],"edges":[{"from":"itemA","to":"itemB","label":"关系"}]}。示例只是字段格式；节点名称、关系和图的用途应由当前素材决定，不照搬示例。
只接受 nodes / edges 及示例中的字段；节点 1–6 个，连线 0–8 条。ID 以英文字母开头，只含字母数字下划线短横线，最多32字符；ID 唯一，连线引用本图节点，禁止自身连线和重复同向连线。
节点 label 最多12个汉字（约21英文字符），可选 detail 最多10个汉字（约18英文字符），可选连线 label 最多6个汉字（约10英文字符）。都是单行纯文字，不能嵌入标签、样式、资源链接字段或代码。
系统负责绘制卡片、文字、有向箭头和主题色，并将图解保持比例放入实际可用画布；独占场景时使用完整视频区域。节点数组顺序决定蛇形排列：全幅最多3列、compare列内最多2列；按阅读顺序组织节点并减少连线交叉，复杂关系拆成多个图解。一个图解独占场景，或占 compare 的一列。
当内容适合用节点和连线呈现时，可用它表达结构、关系、阶段、顺序或因果；连线含义必须由来源内容或明确的虚构/示例设定支持。不要把所有内容都改写成流程图。稳定模式和创意模式都支持，静态图即可，不需要自定义代码或装饰性动画。`;
