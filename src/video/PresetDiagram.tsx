import React from 'react';
import { DIAGRAM_HEIGHT, diagramTextUnits, parseDiagram, type Diagram } from '../shared/diagram';
import type { Palette } from '../shared/schema';

type NodeBox = { node: Diagram['nodes'][number]; x: number; y: number; width: number; height: number; row: number; column: number };
type Point = { x: number; y: number };

function layoutNodes(diagram: Diagram, width: number): NodeBox[] {
  const columns = Math.min(width < 700 ? 2 : 3, diagram.nodes.length);
  const rows = Math.ceil(diagram.nodes.length / columns);
  const gapX = 132;
  const nodeWidth = Math.min(320, (width - 16 - (columns - 1) * gapX) / columns);
  const nodeHeight = rows === 3 ? 76 : rows === 2 ? 90 : 100;
  const gapY = rows === 3 ? 24 : 64;
  const left = (width - columns * nodeWidth - (columns - 1) * gapX) / 2;
  const top = (DIAGRAM_HEIGHT - rows * nodeHeight - (rows - 1) * gapY) / 2;
  return diagram.nodes.map((node, index) => {
    const row = Math.floor(index / columns);
    const column = row % 2 ? columns - 1 - index % columns : index % columns;
    return { node, x: left + column * (nodeWidth + gapX), y: top + row * (nodeHeight + gapY), width: nodeWidth, height: nodeHeight, row, column };
  });
}

function edgePoints(from: NodeBox, to: NodeBox, width: number, rows: number, reciprocal: boolean): Point[] {
  const a = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  const b = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
  if (from.row === to.row) {
    if (Math.abs(from.column - to.column) === 1) {
      const direction = Math.sign(b.x - a.x);
      const y = a.y - (reciprocal ? direction * 16 : 0);
      return [{ x: a.x + direction * (from.width / 2 + 4), y }, { x: b.x - direction * (to.width / 2 + 6), y }];
    }
    // Route over/under intervening cards instead of drawing through their labels.
    const direction = rows > 1 && from.row === 0 ? 1 : -1;
    const edgeY = a.y + direction * from.height / 2;
    const laneY = edgeY + direction * 24;
    return [{ x: a.x, y: edgeY + direction * 4 }, { x: a.x, y: laneY }, { x: b.x, y: laneY }, { x: b.x, y: edgeY + direction * 6 }];
  }
  if (reciprocal && from.column === to.column && Math.abs(from.row - to.row) === 1) {
    const laneX = from.column === 0 ? from.x + from.width + 66 : from.x - 66;
    return [{ x: a.x + Math.sign(laneX - a.x) * (from.width / 2 + 4), y: a.y }, { x: laneX, y: a.y }, { x: laneX, y: b.y }, { x: b.x + Math.sign(laneX - b.x) * (to.width / 2 + 6), y: b.y }];
  }
  if (Math.abs(from.row - to.row) > 1) {
    // The narrow layout has three rows; its center gutter keeps long links clear of middle-row cards.
    const laneX = width / 2;
    return [{ x: a.x + Math.sign(laneX - a.x) * (from.width / 2 + 4), y: a.y }, { x: laneX, y: a.y }, { x: laneX, y: b.y }, { x: b.x + Math.sign(laneX - b.x) * (to.width / 2 + 6), y: b.y }];
  }
  const direction = Math.sign(b.y - a.y);
  const start = { x: a.x, y: a.y + direction * (from.height / 2 + 4) };
  const end = { x: b.x, y: b.y - direction * (to.height / 2 + 6) };
  if (from.column === to.column) return [start, end];
  const laneY = (start.y + end.y) / 2;
  return [start, { x: start.x, y: laneY }, { x: end.x, y: laneY }, end];
}

function wrapLabel(text: string, units: number): string[] {
  const lines: string[] = []; let line = '';
  for (const character of text) {
    if (line && diagramTextUnits(line + character) > units) { lines.push(line); line = ''; }
    line += character;
  }
  if (line) lines.push(line);
  return lines;
}

export function PresetDiagram({ content, width, scale, palette }: { content: string; width: number; scale: number; palette: Palette }) {
  const result = React.useMemo(() => {
    try { return { diagram: parseDiagram(content), error: '' }; }
    catch (error) { return { diagram: null, error: error instanceof Error ? error.message : '图解数据无效' }; }
  }, [content]);
  if (!result.diagram) return <div role="alert" style={{ height: DIAGRAM_HEIGHT * scale, color: palette.text, padding: 16 * scale, fontSize: 20 * scale }}>图解无法显示：{result.error}</div>;
  const diagram = result.diagram;
  const boxes = layoutNodes(diagram, width);
  const byId = new Map(boxes.map(box => [box.node.id, box]));
  const rows = Math.max(...boxes.map(box => box.row)) + 1;
  const compact = width < 700;
  const labelSize = compact ? 20 : 24;
  const detailSize = compact ? 16 : 18;
  const edgeSize = compact ? 16 : 18;
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${width} ${DIAGRAM_HEIGHT}`} width={width * scale} height={DIAGRAM_HEIGHT * scale} role="img" aria-label={`关系图：${diagram.nodes.map(node => node.label).join('、')}`} style={{ display: 'block', maxWidth: '100%' }}>
    {diagram.edges.map((edge, index) => {
      const reciprocal = diagram.edges.some(other => other.from === edge.to && other.to === edge.from);
      const points = edgePoints(byId.get(edge.from)!, byId.get(edge.to)!, width, rows, reciprocal);
      const end = points.at(-1)!; const before = points.at(-2)!;
      const angle = Math.atan2(end.y - before.y, end.x - before.x);
      const arrow = [end, { x: end.x - 9 * Math.cos(angle) + 4.5 * Math.sin(angle), y: end.y - 9 * Math.sin(angle) - 4.5 * Math.cos(angle) }, { x: end.x - 9 * Math.cos(angle) - 4.5 * Math.sin(angle), y: end.y - 9 * Math.sin(angle) + 4.5 * Math.cos(angle) }];
      const middle = Math.floor((points.length - 1) / 2);
      const startLabel = points[middle]; const endLabel = points[middle + 1];
      const labelWidth = edge.label ? diagramTextUnits(edge.label) * edgeSize + 10 : 0;
      let labelX = (startLabel.x + endLabel.x) / 2;
      let labelY = (startLabel.y + endLabel.y) / 2;
      if (points.length === 4 && startLabel.x === endLabel.x) labelY = startLabel.y + (endLabel.y - startLabel.y) / 4;
      else if (points.length === 4 && reciprocal) labelX = startLabel.x + (endLabel.x - startLabel.x) * 0.3;
      if (points.length === 2) {
        if (startLabel.y === endLabel.y) labelY += (reciprocal && endLabel.x < startLabel.x ? 1 : -1) * (edgeSize / 2 + 7);
        else labelX += (labelX + labelWidth + 10 < width ? 1 : -1) * (labelWidth / 2 + 8);
      }
      return <g key={`${edge.from}-${edge.to}`} data-diagram-edge={index}>
        <polyline points={points.map(point => `${point.x},${point.y}`).join(' ')} fill="none" stroke={palette.accent} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
        <polygon points={arrow.map(point => `${point.x},${point.y}`).join(' ')} fill={palette.accent} />
        {edge.label && <g><rect x={labelX - labelWidth / 2} y={labelY - edgeSize / 2 - 2} width={labelWidth} height={edgeSize + 4} rx={3} fill={palette.surface} /><text x={labelX} y={labelY} textAnchor="middle" dominantBaseline="central" fontSize={edgeSize} fill={palette.text}>{edge.label}</text></g>}
      </g>;
    })}
    {boxes.map(box => {
      const lines = wrapLabel(box.node.label, (box.width - 24) / labelSize);
      const lineHeight = labelSize + 2;
      const blockHeight = lines.length * lineHeight + (box.node.detail ? detailSize + 4 : 0);
      const labelTop = box.y + (box.height - blockHeight) / 2;
      const centerX = box.x + box.width / 2;
      return <g key={box.node.id} data-diagram-node={box.node.id}>
        <rect x={box.x} y={box.y} width={box.width} height={box.height} rx={10} fill={palette.background} stroke={palette.accent} strokeWidth={1.5} />
        {lines.map((line, index) => <text key={index} x={centerX} y={labelTop + lineHeight * (index + 0.5)} textAnchor="middle" dominantBaseline="central" fontSize={labelSize} fontWeight={650} fill={palette.text}>{line}</text>)}
        {box.node.detail && <text x={centerX} y={labelTop + lines.length * lineHeight + 4 + detailSize / 2} textAnchor="middle" dominantBaseline="central" fontSize={detailSize} fill={palette.muted}>{box.node.detail}</text>}
      </g>;
    })}
  </svg>;
}
