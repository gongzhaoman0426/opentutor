import { z } from 'zod';

/**
 * Data-visualization objects (`type: 'viz'`). `content` holds this JSON as text. They are rendered by trusted React
 * code, so they are available in stable mode too: no model-written JavaScript is executed.
 */
const Label = z.string().min(1).max(40);
const Short = z.string().max(24);
const Num = z.number().finite().min(-1e12).max(1e12);
const Title = z.string().max(60).optional();
const Unit = z.string().max(10).optional();

export const VizSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('bar'), title: Title, unit: Unit, items: z.array(z.object({ label: Label, value: Num, highlight: z.boolean().optional() })).min(1).max(8) }),
  z.object({ kind: z.literal('line'), title: Title, unit: Unit, labels: z.array(Label).min(2).max(12), series: z.array(z.object({ name: Label, values: z.array(Num).min(2).max(12) })).min(1).max(3) })
    .refine(spec => spec.series.every(series => series.values.length === spec.labels.length), 'series.values 的长度必须等于 labels'),
  z.object({ kind: z.literal('donut'), title: Title, unit: Unit, items: z.array(z.object({ label: Label, value: Num.min(0) })).min(2).max(6) })
    .refine(spec => spec.items.some(item => item.value > 0), '至少一项大于 0'),
  z.object({ kind: z.literal('stat'), items: z.array(z.object({ label: Label, value: Num, prefix: z.string().max(6).optional(), suffix: z.string().max(8).optional(), decimals: z.number().int().min(0).max(2).optional(), note: z.string().max(40).optional() })).min(1).max(4) }),
  z.object({ kind: z.literal('timeline'), title: Title, items: z.array(z.object({ label: Short.min(1), detail: z.string().max(60).optional() })).min(2).max(7) }),
  z.object({ kind: z.literal('flow'), title: Title, items: z.array(z.object({ label: Short.min(1), detail: z.string().max(60).optional() })).min(2).max(7) }),
]);
export type VizSpec = z.infer<typeof VizSchema>;

export function parseViz(content: string): { spec: VizSpec } | { error: string } {
  let json: unknown;
  try { json = JSON.parse(content); } catch { return { error: 'viz.content 必须是 JSON 文本' }; }
  const result = VizSchema.safeParse(json);
  return result.success ? { spec: result.data } : { error: `viz 图表格式无效：${result.error.issues.slice(0, 3).map(issue => `${issue.path.join('.') || '根'}: ${issue.message}`).join('；')}` };
}

export const VIZ_API = `viz 对象（任何模式可用）的 content 是一段 JSON 文本，由程序渲染为带动画的图表，数据请直接取自素材，不得编造：
{"kind":"bar","title":"可选标题","unit":"%","items":[{"label":"A","value":42,"highlight":true},…]}（1–8 项，柱状图，数值计数）
{"kind":"line","title":"…","unit":"…","labels":["1月","2月",…],"series":[{"name":"销量","values":[…]}]}（2–12 个点，最多 3 条线，逐段绘线）
{"kind":"donut","title":"…","unit":"%","items":[{"label":"…","value":40},…]}（2–6 项占比环形图）
{"kind":"stat","items":[{"label":"用户","value":12800,"suffix":"+","prefix":"","decimals":0,"note":"较上月 +12%"}]}（1–4 个大数字，数字滚动）
{"kind":"timeline","title":"…","items":[{"label":"2019","detail":"…"},…]}（2–7 个节点，依次点亮）
{"kind":"flow","title":"…","items":[{"label":"采集","detail":"…"},…]}（2–7 个步骤，箭头依次连接）
label ≤40 字（timeline/flow ≤24），detail ≤60 字。一个 viz 独占一个场景或 compare 的一列，并配合旁白逐项讲解。`;
