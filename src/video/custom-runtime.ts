import { newQuickJSWASMModuleFromVariant, type QuickJSWASMModule } from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-singlefile-browser-release-sync';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import type { Palette } from '../shared/schema';
import { CUSTOM_PRELUDE, validateCustomCode } from '../shared/custom';

let modulePromise: Promise<QuickJSWASMModule> | undefined;
export function loadCustomRuntime() { return modulePromise ??= newQuickJSWASMModuleFromVariant(variant); }
export interface CustomFrame { frame: number; fps: number; width: number; height: number; progress: number; theme: Palette }

const tags = new Set('svg g rect circle ellipse line path polyline polygon text tspan textPath defs use linearGradient radialGradient stop pattern clipPath mask filter feGaussianBlur feDropShadow feOffset feFlood feColorMatrix feComposite feBlend feMerge feMergeNode feTurbulence feComponentTransfer feFuncR feFuncG feFuncB feFuncA'.split(' '));
const attributes = new Set(('xmlns viewBox width height x y x1 y1 x2 y2 cx cy r rx ry d points fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset opacity transform font-size font-family font-weight font-style text-anchor dominant-baseline alignment-baseline letter-spacing dx dy id offset stop-color stop-opacity gradientUnits gradientTransform spreadMethod fx fy fr clip-path clipPathUnits preserveAspectRatio vector-effect paint-order pathLength startOffset '
  + 'filter mask href in in2 result stdDeviation flood-color flood-opacity values type baseFrequency numOctaves seed mode operator k1 k2 k3 k4 slope intercept amplitude exponent tableValues patternUnits patternContentUnits patternTransform maskUnits maskContentUnits filterUnits primitiveUnits color-interpolation-filters stitchTiles').split(' '));

const fragment = /^url\(#([A-Za-z][\w-]*)\)$/;
const hrefTarget = /^#([A-Za-z][\w-]*)$/;
const paint = /^(?:#[\da-f]{3,4}|#[\da-f]{6}|#[\da-f]{8}|[a-z]+|(?:rgb|rgba|hsl|hsla)\([\d\s.,%+\-/]+\))$/i;
const keyword = /^[A-Za-z]+$/;
const numbers = /^[\d\s.,+\-eE]+$/;
const filterInput = /^(?:SourceGraphic|SourceAlpha|[A-Za-z][\w-]*)$/;
/** Which internal definitions each reference-capable attribute may point to. */
const referenceTargets: Record<string, string[]> = { fill: ['linearGradient', 'radialGradient', 'pattern'], stroke: ['linearGradient', 'radialGradient', 'pattern'], 'clip-path': ['clipPath'], mask: ['mask'], filter: ['filter'] };
const limits: Record<string, number> = { use: 300, filter: 8, feTurbulence: 3, feGaussianBlur: 24, feDropShadow: 24 };
export const MAX_SVG_NODES = 6000;
export const MAX_SVG_CHARS = 300000;

export function validateSvg(svg: string, idPrefix = ''): string {
  if (svg.length > MAX_SVG_CHARS || /<!|<\?/.test(svg)) throw new Error('SVG 太大或包含不支持的文档声明');
  const document = new DOMParser({ onError: (level, message) => { throw new Error(`SVG ${level}: ${message}`); } }).parseFromString(svg, 'image/svg+xml');
  const root = document.documentElement;
  if (!root || root.tagName !== 'svg' || root.namespaceURI !== 'http://www.w3.org/2000/svg') throw new Error('组件必须返回带 SVG xmlns 的完整 svg 根节点');
  let count = 0;
  const counts = new Map<string, number>();
  const ids = new Map<string, typeof root>();
  const references: { node: typeof root; attribute: string; id: string; kind: 'url' | 'href' }[] = [];
  const visit = (node: typeof root) => {
    if (++count > MAX_SVG_NODES) throw new Error(`SVG 节点超过 ${MAX_SVG_NODES} 个`);
    if (!tags.has(node.tagName) || node.namespaceURI !== root.namespaceURI) throw new Error(`SVG 标签不支持：${node.tagName}`);
    const used = (counts.get(node.tagName) ?? 0) + 1; counts.set(node.tagName, used);
    if (limits[node.tagName] && used > limits[node.tagName]) throw new Error(`SVG 中 ${node.tagName} 最多 ${limits[node.tagName]} 个`);
    for (let i = 0; i < node.attributes.length; i++) {
      const attr = node.attributes.item(i)!;
      const { name, value } = attr;
      if (!attributes.has(name)) throw new Error(`SVG 属性不支持：${name}`);
      if (/[\\\u0000-\u001f\u007f]|\/\*|\*\//.test(value)) throw new Error('SVG 属性不能包含 CSS 转义、控制字符或注释');
      if (name === 'xmlns' && value !== 'http://www.w3.org/2000/svg') throw new Error('SVG 命名空间无效');
      const reference = fragment.exec(value);
      if (['fill', 'stroke', 'stop-color', 'flood-color'].includes(name) && !paint.test(value) && !(reference && referenceTargets[name])) throw new Error('SVG 颜色必须是色值或内部渐变/图案');
      if (['clip-path', 'mask', 'filter'].includes(name) && value !== 'none' && !reference) throw new Error(`SVG ${name} 必须引用本 SVG 内的定义`);
      if (/url\s*\(/i.test(value) && (!reference || !referenceTargets[name])) throw new Error('SVG 仅允许引用内部渐变、图案、裁剪、蒙版和滤镜');
      if (name === 'href') {
        const target = hrefTarget.exec(value);
        if (!target || !['use', 'textPath'].includes(node.tagName)) throw new Error('href 只能用于 use/textPath，且必须指向本 SVG 内的 #id');
        references.push({ node, attribute: name, id: target[1], kind: 'href' });
      }
      if (name === 'stdDeviation' && !(numbers.test(value) && value.trim().split(/[\s,]+/).every(part => Number(part) >= 0 && Number(part) <= 60))) throw new Error('stdDeviation 必须是 0–60 的数字');
      if (name === 'numOctaves' && !(Number(value) >= 1 && Number(value) <= 4)) throw new Error('numOctaves 必须在 1–4 之间');
      if (['type', 'mode', 'operator'].includes(name) && !keyword.test(value)) throw new Error(`SVG ${name} 值无效`);
      if (['values', 'baseFrequency', 'tableValues'].includes(name) && !numbers.test(value)) throw new Error(`SVG ${name} 只能包含数字`);
      if (['in', 'in2', 'result'].includes(name) && !filterInput.test(value)) throw new Error(`SVG ${name} 值无效`);
      if (/(?:javascript|data|https?|file):|[<>]/i.test(value) && name !== 'xmlns') throw new Error('SVG 属性包含不允许的内容');
      if (name === 'id') {
        if (!/^[A-Za-z][\w-]*$/.test(value) || ids.has(value)) throw new Error('SVG id 必须有效且不能重复');
        ids.set(value, node);
      }
      if (reference && referenceTargets[name]) references.push({ node, attribute: name, id: reference[1], kind: 'url' });
    }
    for (let i = 0; i < node.childNodes.length; i++) {
      const child = node.childNodes.item(i)!;
      if (child.nodeType === 1) visit(child as typeof root);
      else if (![3, 4].includes(child.nodeType)) throw new Error('SVG 包含不支持的节点');
    }
  };
  for (let i = 0; i < document.childNodes.length; i++) {
    const node = document.childNodes.item(i)!;
    if (node !== root && !(node.nodeType === 3 && !node.nodeValue?.trim())) throw new Error('SVG 只能有一个根节点');
  }
  visit(root);
  if (idPrefix && !/^[A-Za-z][\w-]*$/.test(idPrefix)) throw new Error('SVG 实例标识无效');
  const containsUse = (node: typeof root): boolean => node.tagName === 'use' || Array.from({ length: node.childNodes.length }, (_, i) => node.childNodes.item(i)!).some(child => child.nodeType === 1 && containsUse(child as typeof root));
  for (const reference of references) {
    const target = ids.get(reference.id);
    if (!target) throw new Error('SVG 引用必须指向本组件内已定义的 id');
    if (reference.kind === 'url') {
      if (!referenceTargets[reference.attribute].includes(target.tagName)) throw new Error(`SVG ${reference.attribute} 引用了不匹配的定义（${target.tagName}）`);
      reference.node.setAttribute(reference.attribute, `url(#${idPrefix}${reference.id})`);
    } else {
      // use may not clone another use or a container that holds one: no amplification, no cycles.
      if (reference.node.tagName === 'textPath' ? target.tagName !== 'path' : ['svg', 'defs', 'use', 'filter', 'mask', 'pattern', 'clipPath', 'linearGradient', 'radialGradient'].includes(target.tagName) || containsUse(target)) throw new Error('use 只能复制本 SVG 内的图形或分组（不能嵌套 use），textPath 只能引用 path');
      reference.node.setAttribute('href', `#${idPrefix}${reference.id}`);
    }
  }
  for (const [id, node] of ids) node.setAttribute('id', `${idPrefix}${id}`);
  if (!root.hasAttribute('font-family')) root.setAttribute('font-family', 'PingFang SC, Noto Sans CJK SC, Microsoft YaHei, Arial, sans-serif');
  root.setAttribute('width', '100%'); root.setAttribute('height', '100%');
  return new XMLSerializer().serializeToString(root);
}

export const CUSTOM_LIMITS = { memoryBytes: 32 * 1024 * 1024, stackBytes: 512 * 1024, milliseconds: 150, interrupts: 6000 } as const;

export function renderCustomFrame(runtime: QuickJSWASMModule, code: string, input: CustomFrame, idPrefix = ''): string {
  const syntax = validateCustomCode(code);
  if (syntax) throw new Error(syntax);
  const vm = runtime.newContext();
  vm.runtime.setMemoryLimit(CUSTOM_LIMITS.memoryBytes);
  vm.runtime.setMaxStackSize(CUSTOM_LIMITS.stackBytes);
  const deadline = Date.now() + CUSTOM_LIMITS.milliseconds;
  let cycles = 0;
  vm.runtime.setInterruptHandler(() => ++cycles > CUSTOM_LIMITS.interrupts || Date.now() > deadline);
  try {
    // No host objects or functions are injected. Each frame starts with a fresh heap. The helpers live at the
    // script's top level, so the generated function body can freely shadow any of them.
    const script = `"use strict";\nObject.defineProperty(globalThis, 'Date', {value: undefined});\nlet __seed = 1729; Math.random = () => ((__seed = (__seed * 1664525 + 1013904223) >>> 0) / 4294967296);\nconst __input = ${JSON.stringify(input)};\nconst {frame, fps, width, height, progress, theme} = __input;\nconst time = frame / fps;\n${CUSTOM_PRELUDE}\n(function() {\n${code}\n})();`;
    const result = vm.evalCode(script, 'component.js');
    if (result.error) {
      const value = vm.dump(result.error); result.error.dispose();
      throw new Error(`组件执行失败：${value?.message || 'JavaScript 错误'}`);
    }
    try {
      if (vm.typeof(result.value) !== 'string') throw new Error('组件必须同步返回 SVG 字符串');
      return validateSvg(vm.getString(result.value), idPrefix);
    } finally { result.value.dispose(); }
  } finally { vm.dispose(); }
}
