import { newQuickJSWASMModuleFromVariant, type QuickJSWASMModule } from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-singlefile-browser-release-sync';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import type { Palette } from '../shared/schema';
import { validateCustomCode } from '../shared/custom';

let modulePromise: Promise<QuickJSWASMModule> | undefined;
export function loadCustomRuntime() { return modulePromise ??= newQuickJSWASMModuleFromVariant(variant); }
export interface CustomFrame { frame: number; fps: number; width: number; height: number; progress: number; theme: Palette }

const tags = new Set('svg g rect circle ellipse line path polyline polygon text tspan defs linearGradient radialGradient stop clipPath'.split(' '));
const attributes = new Set('xmlns viewBox width height x y x1 y1 x2 y2 cx cy r rx ry d points fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-dasharray stroke-dashoffset opacity transform font-size font-family font-weight font-style text-anchor dominant-baseline alignment-baseline letter-spacing dx dy id offset stop-color stop-opacity gradientUnits gradientTransform spreadMethod fx fy fr clip-path clipPathUnits preserveAspectRatio vector-effect'.split(' '));

const fragment = /^url\(#([A-Za-z][\w-]*)\)$/;
const paint = /^(?:#[\da-f]{3,4}|#[\da-f]{6}|#[\da-f]{8}|[a-z]+|(?:rgb|rgba|hsl|hsla)\([\d\s.,%+\-/]+\))$/i;

export function validateSvg(svg: string, idPrefix = ''): string {
  if (svg.length > 100000 || /<!|<\?/.test(svg)) throw new Error('SVG 太大或包含不支持的文档声明');
  const document = new DOMParser({ onError: (level, message) => { throw new Error(`SVG ${level}: ${message}`); } }).parseFromString(svg, 'image/svg+xml');
  const root = document.documentElement;
  if (!root || root.tagName !== 'svg' || root.namespaceURI !== 'http://www.w3.org/2000/svg') throw new Error('组件必须返回带 SVG xmlns 的完整 svg 根节点');
  let count = 0;
  const ids = new Map<string, typeof root>();
  const references: { node: typeof root; attribute: string; id: string }[] = [];
  const visit = (node: typeof root) => {
    if (++count > 2000) throw new Error('SVG 节点超过 2000 个');
    if (!tags.has(node.tagName) || node.namespaceURI !== root.namespaceURI) throw new Error(`SVG 标签不支持：${node.tagName}`);
    for (let i = 0; i < node.attributes.length; i++) {
      const attr = node.attributes.item(i)!;
      if (!attributes.has(attr.name)) throw new Error(`SVG 属性不支持：${attr.name}`);
      if (/[\\\u0000-\u001f\u007f]|\/\*|\*\//.test(attr.value)) throw new Error('SVG 属性不能包含 CSS 转义、控制字符或注释');
      if (attr.name === 'xmlns' && attr.value !== 'http://www.w3.org/2000/svg') throw new Error('SVG 命名空间无效');
      const reference = fragment.exec(attr.value);
      if (['fill', 'stroke', 'stop-color'].includes(attr.name) && !paint.test(attr.value) && !reference) throw new Error('SVG 颜色必须是色值或内部渐变');
      if (attr.name === 'clip-path' && attr.value !== 'none' && !reference) throw new Error('SVG 裁剪必须引用内部路径');
      if (/url\s*\(/i.test(attr.value) && (!reference || !['fill', 'stroke', 'clip-path'].includes(attr.name))) throw new Error('SVG 仅允许引用内部渐变和裁剪路径');
      if (/(?:javascript|data|https?|file):|[<>]/i.test(attr.value) && attr.name !== 'xmlns') throw new Error('SVG 属性包含不允许的内容');
      if (attr.name === 'id') {
        if (!/^[A-Za-z][\w-]*$/.test(attr.value) || ids.has(attr.value)) throw new Error('SVG id 必须有效且不能重复');
        ids.set(attr.value, node);
      }
      if (reference) references.push({ node, attribute: attr.name, id: reference[1] });
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
  for (const reference of references) {
    const target = ids.get(reference.id);
    const allowed = reference.attribute === 'clip-path' ? ['clipPath'] : ['linearGradient', 'radialGradient'];
    if (!target || !allowed.includes(target.tagName)) throw new Error('SVG 引用必须指向本组件的渐变或裁剪路径');
    reference.node.setAttribute(reference.attribute, `url(#${idPrefix}${reference.id})`);
  }
  for (const [id, node] of ids) node.setAttribute('id', `${idPrefix}${id}`);
  if (!root.hasAttribute('font-family')) root.setAttribute('font-family', 'PingFang SC, Noto Sans CJK SC, Microsoft YaHei, Arial, sans-serif');
  root.setAttribute('width', '100%'); root.setAttribute('height', '100%');
  return new XMLSerializer().serializeToString(root);
}

export function renderCustomFrame(runtime: QuickJSWASMModule, code: string, input: CustomFrame, idPrefix = ''): string {
  const syntax = validateCustomCode(code);
  if (syntax) throw new Error(syntax);
  const vm = runtime.newContext();
  vm.runtime.setMemoryLimit(8 * 1024 * 1024);
  vm.runtime.setMaxStackSize(256 * 1024);
  const deadline = Date.now() + 40;
  let cycles = 0;
  vm.runtime.setInterruptHandler(() => ++cycles > 800 || Date.now() > deadline);
  try {
    // No host objects or functions are injected. Each frame starts with a fresh heap.
    const result = vm.evalCode(`"use strict";\nObject.defineProperty(globalThis, 'Date', {value: undefined});\nlet __seed = 1729; Math.random = () => ((__seed = (__seed * 1664525 + 1013904223) >>> 0) / 4294967296);\nconst input = ${JSON.stringify(input)};\n(function({frame,fps,width,height,progress,theme}) {\n${code}\n})(input);`, 'component.js');
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
