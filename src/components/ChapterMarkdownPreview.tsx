'use client';

import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { ImagePlus } from 'lucide-react';
import { useMemo } from 'react';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import type { Root } from 'mdast';
import type { Asset, Chapter } from '@/shared/schema';

const assetId = /^asset:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
export function ChapterMarkdownPreview({ markdown, assets, chapters = [] }: { markdown: string; assets: Asset[]; chapters?: Chapter[] }) {
  const resolvedMarkdown = useMemo(() => {
    const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
    const local = parser.parse(markdown) as Root;
    const identifiers = new Set(local.children.filter(node => node.type === 'definition').map(node => node.identifier.toLowerCase()));
    const fallback: string[] = [];
    for (const chapter of chapters) {
      const document = parser.parse(chapter.markdown) as Root;
      for (const node of document.children) if (node.type === 'definition' && !identifiers.has(node.identifier.toLowerCase())) {
        identifiers.add(node.identifier.toLowerCase());
        fallback.push(chapter.markdown.slice(node.position?.start.offset ?? 0, node.position?.end.offset ?? 0));
      }
    }
    return `${markdown}\n\n${fallback.join('\n\n')}`;
  }, [markdown, chapters]);
  if (!markdown.trim()) return <div className="chapter-empty-reading"><p>在左侧开始编写文稿。</p><span>标题、列表、代码、公式和图片会在这里即时呈现。</span></div>;
  return <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[[rehypeKatex, { throwOnError: false, trust: false }]]} urlTransform={(url, key) => key === 'src' && assetId.test(url) ? url : defaultUrlTransform(url)} components={{
    a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
    img: ({ src, alt }) => {
      const raw = typeof src === 'string' ? src : ''; const id = raw.match(assetId)?.[1];
      let name = raw.replace(/^\.\//, ''); try { name = decodeURIComponent(name); } catch {}
      const direct = /^https?:\/\//i.test(raw) ? [] : assets.filter(value => value.id === (id || name) || value.url === raw);
      const named = /^https?:\/\//i.test(raw) ? [] : assets.filter(value => value.name === name);
      const matches = direct.length ? direct : named.length ? named : /^https?:\/\//i.test(raw) ? [] : assets.filter(value => value.name === name.split('/').at(-1));
      const asset = matches.length === 1 ? matches[0] : null;
      return asset ? <span className="chapter-markdown-image"><img src={asset.url} alt={alt || asset.name} />{alt && <span className="chapter-image-caption">{alt}</span>}</span> : <span className="missing-asset"><ImagePlus size={16} />{matches.length > 1 ? `图片名称不唯一：${alt || raw}。请从素材库重新插入。` : `图片未找到：${alt || raw || '请重新插入素材'}`}</span>;
    },
  }}>{resolvedMarkdown}</ReactMarkdown>;
}
