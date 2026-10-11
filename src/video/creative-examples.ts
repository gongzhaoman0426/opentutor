/** Original motion studies for the component gallery, driven only by narration cues. */
export const formStudyCode = `const gather = anim.tween(cues.gather, 1.8, 0, 'outQuint');
const fold = anim.tween(cues.fold, 2.0, 0, 'inOutCubic');
const resolve = anim.tween(cues.resolve, 1.4, 0, 'outQuint');
const mix = anim.lerp;
const unit = Math.min(width / 1280, height / 720);
const cx = mix(width * 0.50, width * 0.73, resolve);
const cy = height * 0.46;
const size = Math.min(width * 0.34, height * 0.35) * mix(1, 0.82, resolve);
let pieces = '';
for (let i = 0; i < 12; i++) {
  const local = anim.tween(cues.gather, 1.25, i * 0.055, 'outQuint');
  const turn = mix(-1.2 + i * 0.018, i * Math.PI / 6 - Math.PI / 2, local) + fold * 0.42 - resolve * 0.18;
  const start = [width * (0.24 + i * 0.037), height * (0.63 + Math.sin(i/11*Math.PI)*0.10)];
  const center = anim.pointOnBezier(start, [start[0], cy + size*0.32], [cx + Math.cos(i)*size*0.18, cy-size*0.18], [cx,cy], local);
  const before = [[0.31,-0.035],[0.98,-0.035],[0.98,0.035],[0.31,0.035]];
  const after = [[0.12,0],[0.80,-0.15],[1,0.14],[0.36,0.31]];
  const points = before.map((point, j) => {
    const x = mix(point[0], after[j][0], fold) * size;
    const y = mix(point[1], after[j][1], fold) * size;
    return (center[0] + x * Math.cos(turn) - y * Math.sin(turn)).toFixed(2) + ',' + (center[1] + x * Math.sin(turn) + y * Math.cos(turn)).toFixed(2);
  });
  pieces += '<polygon points="' + points.join(' ') + '" fill="' + (i % 3 === 0 ? theme.text : theme.accent) + '" fill-opacity="' + (i % 3 === 2 ? 0.56 : 1) + '"/>';
}
const left = width * 0.07, font = Math.max(24, 82 * unit);
const ruleWidth = width * 0.16 * gather;
const label = cues.resolve.started ? '03 / COMPOSITION' : cues.fold.started ? '02 / TRANSFORMATION' : '01 / RHYTHM';
const headline = cues.resolve.started ? '<g clip-path="url(#headline)"><text x="' + left + '" y="' + (height * 0.41 + (1-resolve)*font) + '" fill="' + theme.text + '" font-family="sans-serif" font-size="' + font + '" font-weight="750" letter-spacing="-3">Same parts.</text><text x="' + left + '" y="' + (height * 0.41 + font * 1.14 + (1-resolve)*font) + '" fill="' + theme.text + '" font-family="sans-serif" font-size="' + font + '" font-weight="750" letter-spacing="-3">New form.</text></g>' : '';
return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + width + ' ' + height + '">'
  + '<defs><clipPath id="headline"><rect x="' + left + '" y="' + height * 0.27 + '" width="' + width * 0.50 + '" height="' + font * 2.9 + '"/></clipPath></defs>'
  + '<rect x="0" y="0" width="' + width + '" height="' + height + '" fill="' + theme.background + '"/>'
  + '<text x="' + left + '" y="' + height * 0.13 + '" fill="' + theme.muted + '" font-family="sans-serif" font-size="' + Math.max(24, 24*unit) + '" letter-spacing="4">FORM STUDY</text>'
  + pieces + headline
  + '<line x1="' + left + '" y1="' + height * 0.80 + '" x2="' + (left + ruleWidth) + '" y2="' + height * 0.80 + '" stroke="' + theme.accent + '" stroke-width="2"/>'
  + '<text x="' + left + '" y="' + height * 0.855 + '" fill="' + theme.muted + '" font-family="sans-serif" font-size="' + Math.max(24, 24*unit) + '" letter-spacing="2">' + label + '</text></svg>';`;

export const perspectiveStudyCode = `const establish = anim.tween(cues.establish, 1.7, 0, 'outQuint');
const travel = anim.tween(cues.travel, 2.5, 0, 'inOutCubic');
const focus = anim.tween(cues.focus, 1.6, 0, 'outQuint');
const mix = anim.lerp;
const unit = Math.min(width / 1280, height / 720);
const lens = Math.min(width * 0.67, height * 0.96);
const cx = mix(width * 0.61, width * 0.73, focus);
const cy = height * 0.45;
const camera = travel * 2.6;
const yaw = mix(-0.28, 0, focus);
const decks = [0.6, 1.35, 2.25, 3.4, 4.8, 6.4];
let geometry = '';
for (let i = decks.length - 1; i >= 0; i--) {
  const depth = decks[i] + 2.2 - camera;
  const unfold = anim.tween(cues.establish, 1.1, (5-i)*0.07, 'outQuint');
  const halfW = mix(0.65, 0.43, focus), halfH = mix(0.48, 0.38, focus);
  const corners = [[-halfW,-halfH],[halfW,-halfH],[halfW,halfH],[-halfW,halfH]];
  const projected = corners.map(point => {
    const x = point[0] + (1-unfold) * (i % 2 ? 0.18 : -0.18);
    const y = point[1];
    const z = Math.max(0.15, depth + x * Math.sin(yaw));
    return [(cx + x * Math.cos(yaw) * lens / z * 2.2).toFixed(2), (cy + y * lens / z * 2.2).toFixed(2)];
  });
  const outline = projected.map(point => point.join(',')).join(' ');
  const visibility = anim.clamp((depth - 0.16) / 0.6) * mix(1, 0.25 + i * 0.11, focus);
  geometry += '<polygon points="' + outline + '" fill="' + theme.accent + '" fill-opacity="' + (0.045 * visibility) + '" stroke="' + (i % 2 ? theme.accent : theme.text) + '" stroke-opacity="' + (visibility * mix(0.22, 0.80, i/5)) + '" stroke-width="' + Math.max(1, (i === 5 ? 3 : 1.5) * unit) + '"/>';
  if (i === 5) {
    const reach = Math.min(width*0.11, height*0.16) * mix(0.70,1,travel);
    const innerX = cx + (1-focus)*width*0.018, innerY = cy;
    const q = anim.tween(cues.focus, 1.1, 0.15, 'inOutCubic');
    const mark = [[0,-1],[0.23,-0.23],[1,0],[0.23,0.23],[0,1],[-0.23,0.23],[-1,0],[-0.23,-0.23]].map(p => (innerX + p[0]*reach).toFixed(2) + ',' + (innerY + p[1]*reach*mix(0.65,1,q)).toFixed(2));
    geometry += '<polygon points="' + mark.join(' ') + '" fill="' + theme.accent + '"/>';
  }
}
const left = width * 0.07, font = Math.max(24, 90 * unit);
const label = cues.focus.started ? '03 / A CLOSER LOOK' : cues.travel.started ? '02 / MOVE THROUGH SPACE' : '01 / SET THE PERSPECTIVE';
const headline = cues.focus.started ? '<g clip-path="url(#words)"><text x="' + (left - (1-focus)*width*0.13) + '" y="' + height * 0.43 + '" fill="' + theme.text + '" font-family="sans-serif" font-size="' + font + '" font-weight="750" letter-spacing="-3">Look</text><text x="' + (left - (1-focus)*width*0.13) + '" y="' + (height * 0.43+font*1.08) + '" fill="' + theme.text + '" font-family="sans-serif" font-size="' + font + '" font-weight="750" letter-spacing="-3">closer.</text></g>' : '';
return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + width + ' ' + height + '">'
  + '<defs><clipPath id="stage"><rect x="' + width*0.04 + '" y="' + height*0.18 + '" width="' + width*0.92 + '" height="' + height*0.55 + '"/></clipPath><clipPath id="words"><rect x="' + left + '" y="' + height*0.28 + '" width="' + width*0.45 + '" height="' + font*2.3 + '"/></clipPath></defs>'
  + '<rect x="0" y="0" width="' + width + '" height="' + height + '" fill="' + theme.background + '"/>'
  + '<text x="' + left + '" y="' + height*0.13 + '" fill="' + theme.muted + '" font-family="sans-serif" font-size="' + Math.max(24,24*unit) + '" letter-spacing="4">PERSPECTIVE STUDY</text>'
  + '<g clip-path="url(#stage)">' + geometry + '</g>' + headline
  + '<line x1="' + left + '" y1="' + height*0.80 + '" x2="' + (left+width*0.16*establish) + '" y2="' + height*0.80 + '" stroke="' + theme.accent + '" stroke-width="2"/>'
  + '<text x="' + left + '" y="' + height*0.855 + '" fill="' + theme.muted + '" font-family="sans-serif" font-size="' + Math.max(24,24*unit) + '" letter-spacing="2">' + label + '</text></svg>';`;
