import React from 'react';
import type { Palette } from '../shared/schema';
import { clamp, easeOutBack, easeOutCubic, mixColor, range, stagger, withAlpha, wrapText } from '../shared/motion';
import type { VizSpec } from '../shared/viz';

type Props = { spec: VizSpec; frame: number; fps: number; width: number; height: number; scale: number; palette: Palette };
const number = (value: number, decimals = 0) => value.toFixed(decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

export function VizGraphic({ spec, frame, fps, width, height, scale, palette }: Props) {
  const t = Math.max(0, frame) / fps;
  const content = (() => {
    switch (spec.kind) {
      case 'bar': return <Bars spec={spec} t={t} width={width} height={height} palette={palette} />;
      case 'line': return <Lines spec={spec} t={t} width={width} height={height} palette={palette} />;
      case 'donut': return <Donut spec={spec} t={t} width={width} height={height} palette={palette} />;
      case 'stat': return <Stats spec={spec} t={t} width={width} height={height} palette={palette} />;
      case 'timeline': return <Timeline spec={spec} t={t} width={width} height={height} palette={palette} />;
      case 'flow': return <Flow spec={spec} t={t} width={width} height={height} palette={palette} />;
    }
  })();
  return <svg role="img" aria-label={`${spec.kind} 图表`} viewBox={`0 0 ${width} ${height}`} width={width * scale} height={height * scale} style={{ display: 'block', fontFamily: 'inherit' }}>{content}</svg>;
}

type Part<S extends VizSpec['kind']> = { spec: Extract<VizSpec, { kind: S }>; t: number; width: number; height: number; palette: Palette };
const Title = ({ text, palette }: { text?: string; palette: Palette }) => text ? <text x={24} y={30} fontSize={22} fill={palette.muted} fontWeight={600}>{text}</text> : null;
const seriesColors = (palette: Palette) => [palette.accent, mixColor(palette.accent, palette.text, 0.55), mixColor(palette.accent, palette.muted, 0.7)];

function Bars({ spec, t, width, height, palette }: Part<'bar'>) {
  const top = spec.title ? 52 : 28, base = height - 44, plot = base - top;
  const values = spec.items.map(item => item.value);
  const hi = Math.max(0, ...values), lo = Math.min(0, ...values), span = hi - lo || 1;
  const y = (v: number) => top + ((hi - v) / span) * plot;
  const slot = (width - 48) / spec.items.length, bw = Math.min(132, slot * 0.62);
  const anyHighlight = spec.items.some(item => item.highlight);
  return <g>
    <defs><filter id="viz-glow" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="8" /></filter></defs>
    <Title text={spec.title} palette={palette} />
    <line x1={24} x2={width - 24} y1={y(0)} y2={y(0)} stroke={withAlpha(palette.muted, 0.5)} strokeWidth={2} />
    {spec.items.map((item, i) => {
      const grow = easeOutBack(stagger(i, spec.items.length, t / 1.5, 0.6));
      const x = 24 + i * slot + (slot - bw) / 2, yv = lerp0(y(0), y(item.value), grow);
      const top1 = Math.min(y(0), yv), h = Math.abs(yv - y(0));
      const fill = anyHighlight && !item.highlight ? mixColor(palette.accent, palette.surface, 0.5) : palette.accent;
      const unitLabel = `${number(item.value * clamp(grow), Number.isInteger(item.value) ? 0 : 1)}${spec.unit ?? ''}`;
      return <g key={i}>
        {h > 2 && <rect x={x} y={top1} width={bw} height={h} rx={10} fill={fill} opacity={0.32} filter="url(#viz-glow)" />}
        <rect x={x} y={top1} width={bw} height={Math.max(h, 0)} rx={10} fill={fill} />
        <text x={x + bw / 2} y={(item.value >= 0 ? top1 : top1 + h) + (item.value >= 0 ? -10 : 28)} textAnchor="middle" fontSize={26} fontWeight={700} fill={palette.text}>{unitLabel}</text>
        {wrapText(item.label, Math.max(3, slot / 22), 1).map(line => <text key={line} x={x + bw / 2} y={height - 14} textAnchor="middle" fontSize={21} fill={palette.muted}>{line}</text>)}
      </g>;
    })}
  </g>;
}
const lerp0 = (a: number, b: number, t: number) => a + (b - a) * t;

function Lines({ spec, t, width, height, palette }: Part<'line'>) {
  const left = 64, right = width - 28, top = spec.title ? 56 : 32, base = height - 44, plot = base - top;
  const all = spec.series.flatMap(series => series.values);
  const hi = Math.max(...all), lo = Math.min(0, ...all), span = hi - lo || 1;
  const xAt = (i: number) => left + (i / (spec.labels.length - 1)) * (right - left);
  const yAt = (v: number) => top + ((hi - v) / span) * plot;
  const colors = seriesColors(palette);
  const step = Math.max(1, Math.ceil(spec.labels.length / (width > 800 ? 8 : 4)));
  return <g>
    <Title text={spec.title} palette={palette} />
    {[0, 0.5, 1].map(f => <g key={f}><line x1={left} x2={right} y1={top + plot * f} y2={top + plot * f} stroke={withAlpha(palette.muted, 0.28)} strokeWidth={1.5} /><text x={left - 10} y={top + plot * f + 7} textAnchor="end" fontSize={18} fill={palette.muted}>{number(hi - span * f, 0)}</text></g>)}
    {spec.labels.map((label, i) => i % step === 0 && <text key={i} x={xAt(i)} y={height - 14} textAnchor="middle" fontSize={20} fill={palette.muted}>{wrapText(label, 5, 1)[0]}</text>)}
    {spec.series.map((series, s) => {
      const points = series.values.map((v, i) => [xAt(i), yAt(v)] as const);
      const d = points.map(([x, y], i) => {
        if (!i) return `M${x.toFixed(1)} ${y.toFixed(1)}`;
        const [px, py] = points[i - 1]; const mx = (px + x) / 2;
        return `C${mx.toFixed(1)} ${py.toFixed(1)} ${mx.toFixed(1)} ${y.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)}`;
      }).join('');
      const draw = easeOutCubic(range(t, s * 0.35, s * 0.35 + 1.6));
      const last = points.at(-1)!;
      return <g key={s}>
        <path d={d} fill="none" stroke={colors[s]} strokeWidth={5} strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray={1} strokeDashoffset={1 - draw} />
        {points.map(([x, y], i) => draw >= i / (points.length - 1) - 0.001 && <circle key={i} cx={x} cy={y} r={i === points.length - 1 ? 8 : 5} fill={palette.surface} stroke={colors[s]} strokeWidth={3} />)}
        {draw > 0.98 && <text x={Math.min(last[0], right - 6)} y={last[1] - 14} textAnchor="end" fontSize={22} fontWeight={700} fill={palette.text}>{number(series.values.at(-1)!, 0)}{spec.unit ?? ''}</text>}
      </g>;
    })}
    {spec.series.length > 1 && spec.series.map((series, s) => <g key={s} transform={`translate(${right - 150 * (spec.series.length - s)} 20)`}><rect width={16} height={16} rx={4} fill={colors[s]} /><text x={24} y={14} fontSize={19} fill={palette.muted}>{series.name}</text></g>)}
  </g>;
}

function Donut({ spec, t, width, height, palette }: Part<'donut'>) {
  const total = spec.items.reduce((sum, item) => sum + item.value, 0) || 1;
  const cx = width > 800 ? 210 : width * 0.3, cy = height / 2 + (spec.title ? 10 : 0), radius = Math.min(height * 0.34, 96), thickness = 34;
  const sweep = easeOutCubic(range(t, 0, 1.4)) * 360;
  const [accentH] = hslOf(palette.accent);
  const colors = spec.items.map((_, i) => i === 0 ? palette.accent : `hsl(${(accentH + i * 47) % 360} 52% ${hslOf(palette.accent)[2] > 55 ? 40 : 62}%)`);
  let start = 0;
  return <g>
    <Title text={spec.title} palette={palette} />
    <circle cx={cx} cy={cy} r={radius} fill="none" stroke={withAlpha(palette.muted, 0.18)} strokeWidth={thickness} />
    {spec.items.map((item, i) => {
      const from = (start / total) * 360; start += item.value; const to = (start / total) * 360;
      const end = Math.min(to, sweep); if (end <= from + 0.01) return null;
      return <path key={i} d={arcPath(cx, cy, radius, from + 0.6, Math.max(from + 0.7, end - 0.6))} fill="none" stroke={colors[i]} strokeWidth={thickness} />;
    })}
    <text x={cx} y={cy + 4} textAnchor="middle" fontSize={32} fontWeight={700} fill={palette.text}>{number(total * easeOutCubic(range(t, 0, 1.4)), Number.isInteger(total) ? 0 : 1)}{spec.unit ?? ''}</text>
    <text x={cx} y={cy + 30} textAnchor="middle" fontSize={18} fill={palette.muted}>合计</text>
    {spec.items.map((item, i) => {
      const appear = easeOutCubic(range(t, 0.3 + i * 0.18, 0.8 + i * 0.18));
      const legendX = cx + radius + thickness + 40, rowY = cy - (spec.items.length - 1) * 21 + i * 42;
      return <g key={i} opacity={appear} transform={`translate(${(1 - appear) * 14} 0)`}><rect x={legendX} y={rowY - 16} width={18} height={18} rx={5} fill={colors[i]} /><text x={legendX + 28} y={rowY} fontSize={23} fill={palette.text}>{wrapText(item.label, width > 800 ? 14 : 6, 1)[0]}</text><text x={width - 28} y={rowY} fontSize={23} fontWeight={700} textAnchor="end" fill={palette.text}>{Math.round((item.value / total) * 100)}%</text></g>;
    })}
  </g>;
}
function arcPath(cx: number, cy: number, r: number, a0: number, a1: number) {
  const p = (deg: number) => [cx + r * Math.sin((deg * Math.PI) / 180), cy - r * Math.cos((deg * Math.PI) / 180)];
  const [x0, y0] = p(a0), [x1, y1] = p(a1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}
function hslOf(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, d ? d / (1 - Math.abs(2 * l - 1)) * 100 : 0, l * 100];
}

function Stats({ spec, t, width, height, palette }: Part<'stat'>) {
  const n = spec.items.length, slot = (width - 48) / n;
  const size = width < 700 ? (n > 1 ? 40 : 64) : n > 2 ? 64 : 80;
  return <g>
    {spec.items.map((item, i) => {
      const local = stagger(i, n, t / 1.5, 0.5), shown = easeOutCubic(local), x = 24 + slot * i + slot / 2;
      const value = number(item.value * shown, item.decimals ?? 0);
      return <g key={i} opacity={clamp(local * 3)} transform={`translate(0 ${(1 - easeOutCubic(local)) * 18})`}>
        {i > 0 && <line x1={24 + slot * i} x2={24 + slot * i} y1={height * 0.2} y2={height * 0.8} stroke={withAlpha(palette.muted, 0.3)} strokeWidth={2} />}
        <text x={x} y={height / 2 + size * 0.1} textAnchor="middle" fontSize={size} fontWeight={800} fill={palette.accent}>{item.prefix ?? ''}{value}<tspan fontSize={size * 0.5}>{item.suffix ?? ''}</tspan></text>
        <text x={x} y={height / 2 + size * 0.1 + 38} textAnchor="middle" fontSize={25} fontWeight={600} fill={palette.text}>{wrapText(item.label, slot / 26, 1)[0]}</text>
        {item.note && <text x={x} y={height / 2 + size * 0.1 + 68} textAnchor="middle" fontSize={20} fill={palette.muted}>{wrapText(item.note, slot / 21, 1)[0]}</text>}
      </g>;
    })}
  </g>;
}

function Timeline({ spec, t, width, height, palette }: Part<'timeline'>) {
  const n = spec.items.length, left = 56, right = width - 56, lineY = height / 2 + (spec.title ? 14 : 4);
  const xAt = (i: number) => left + (i / (n - 1)) * (right - left);
  const slot = (right - left) / (n - 1);
  const progress = easeOutCubic(range(t, 0, 0.45 * n + 0.4));
  return <g>
    <Title text={spec.title} palette={palette} />
    <line x1={left} x2={right} y1={lineY} y2={lineY} stroke={withAlpha(palette.muted, 0.35)} strokeWidth={4} strokeLinecap="round" />
    <line x1={left} x2={left + (right - left) * progress} y1={lineY} y2={lineY} stroke={palette.accent} strokeWidth={6} strokeLinecap="round" />
    {spec.items.map((item, i) => {
      const a = easeOutBack(range(t, i * 0.4, i * 0.4 + 0.6)), up = i % 2 === 0;
      const lines = wrapText(item.label, Math.max(4, Math.min(slot * 1.7, 200) / 22), 2);
      const details = item.detail ? wrapText(item.detail, Math.max(5, Math.min(slot * 1.7, 200) / 18), 2) : [];
      const textY = up ? lineY - 36 - (lines.length - 1) * 26 - details.length * 22 : lineY + 52;
      return <g key={i} opacity={clamp(a)} transform={`translate(0 ${(1 - clamp(a)) * 10})`}>
        <circle cx={xAt(i)} cy={lineY} r={14 * Math.max(0.2, a)} fill={palette.surface} stroke={palette.accent} strokeWidth={5} />
        {lines.map((line, k) => <text key={k} x={xAt(i)} y={textY + k * 26} textAnchor="middle" fontSize={23} fontWeight={700} fill={palette.text}>{line}</text>)}
        {details.map((line, k) => <text key={`d${k}`} x={xAt(i)} y={textY + lines.length * 26 + k * 22 - 2} textAnchor="middle" fontSize={18} fill={palette.muted}>{line}</text>)}
      </g>;
    })}
  </g>;
}

function Flow({ spec, t, width, height, palette }: Part<'flow'>) {
  const n = spec.items.length;
  const perRow = width > 800 ? Math.min(n, 4) : Math.min(n, 2);
  const rows = Math.ceil(n / perRow), top = spec.title ? 44 : 10, gapX = 44, gapY = 22;
  const boxW = (width - 48 - gapX * (perRow - 1)) / perRow, boxH = Math.min(rows === 1 ? 150 : 116, (height - top - 8 - gapY * (rows - 1)) / rows);
  const offset = Math.max(0, (height - top - 8 - (boxH * rows + gapY * (rows - 1))) / 2);
  const pos = (i: number) => { const row = Math.floor(i / perRow), col = i % perRow; return { x: 24 + col * (boxW + gapX), y: top + offset + row * (boxH + gapY) }; };
  return <g>
    <Title text={spec.title} palette={palette} />
    {spec.items.map((item, i) => {
      const { x, y } = pos(i), a = easeOutCubic(range(t, i * 0.45, i * 0.45 + 0.55));
      const lines = wrapText(item.label, boxW / 25, 2), details = item.detail ? wrapText(item.detail, boxW / 19, boxH > 90 ? 2 : 1) : [];
      const arrow = i < n - 1 ? pos(i + 1) : null;
      const sameRow = arrow && arrow.y === y;
      const arrowA = easeOutCubic(range(t, i * 0.45 + 0.3, i * 0.45 + 0.85));
      return <g key={i}>
        <g opacity={a} transform={`translate(0 ${(1 - a) * 14})`}>
          <rect x={x} y={y} width={boxW} height={boxH} rx={14} fill={palette.surface} stroke={i === 0 ? palette.accent : withAlpha(palette.muted, 0.45)} strokeWidth={i === 0 ? 3 : 2} />
          <circle cx={x + 22} cy={y + 22} r={13} fill={palette.accent} /><text x={x + 22} y={y + 28} textAnchor="middle" fontSize={16} fontWeight={700} fill={palette.surface}>{i + 1}</text>
          {lines.map((line, k) => <text key={k} x={x + boxW / 2} y={y + boxH / 2 - (details.length ? 6 : -8) + k * 26 - (lines.length - 1) * 10} textAnchor="middle" fontSize={25} fontWeight={700} fill={palette.text}>{line}</text>)}
          {details.map((line, k) => <text key={`d${k}`} x={x + boxW / 2} y={y + boxH - 22 + k * 20 - (details.length - 1) * 20} textAnchor="middle" fontSize={19} fill={palette.muted}>{line}</text>)}
        </g>
        {arrow && <path d={sameRow ? `M${x + boxW + 6} ${y + boxH / 2}H${arrow.x - 8}` : `M${x + boxW / 2} ${y + boxH + 4}V${y + boxH + gapY / 2}H${arrow.x + boxW / 2}V${arrow.y - 6}`} fill="none" stroke={palette.accent} strokeWidth={4} strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray={1} strokeDashoffset={1 - arrowA} markerEnd={undefined} />}
        {arrow && sameRow && arrowA > 0.95 && <path d={`M${arrow.x - 18} ${y + boxH / 2 - 8}L${arrow.x - 6} ${y + boxH / 2}L${arrow.x - 18} ${y + boxH / 2 + 8}`} fill="none" stroke={palette.accent} strokeWidth={4} strokeLinecap="round" strokeLinejoin="round" />}
      </g>;
    })}
  </g>;
}
