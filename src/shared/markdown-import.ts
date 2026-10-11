import type { Asset } from './schema';

export const MARKDOWN_IMPORT_LIMITS = {
  archiveBytes: 25 * 1024 * 1024,
  requestBytes: 26 * 1024 * 1024,
  expandedBytes: 150 * 1024 * 1024,
  entries: 1000,
  markdownBytes: 1200000,
  markdownCharacters: 300000,
  imageBytes: 15 * 1024 * 1024,
  images: 50,
} as const;

export interface MarkdownImportResult {
  markdown: string;
  assets: Asset[];
  /** Paths are relative to the ZIP archive, including its single root folder. */
  markdownPath: string;
  rootFolder: string;
}

/** Keep existing filename-based references unambiguous when adding ZIP assets. */
export function nameImportedAssets(existing: readonly Asset[], incoming: readonly Asset[]): Asset[] {
  const names = new Set(existing.map(asset => asset.name));
  return incoming.map(asset => {
    let name = asset.name;
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot).slice(0, 20) : '';
    for (let number = 2; names.has(name); number++) {
      const suffix = ` (${number})${extension}`;
      name = `${stem.slice(0, 200 - suffix.length)}${suffix}`;
    }
    names.add(name);
    return name === asset.name ? asset : { ...asset, name };
  });
}
