/**
 * Vidoza resolver (vidoza.net, videzz.net): player JS carries
 * `file: "<url>"` + `res: "<quality>"` (or a plain <source> tag).
 * Algorithm reimplemented from film-docker's extractor flow.
 */

import { fetchEmbedText, type ResolvedMedia } from './index.js';

export const vidozaEmbedHosts = ['vidoza.net', 'videzz.net'];

interface Extracted {
  url: string;
  quality: string | null;
}

/** Pure — exported for tests. `file/src` + `res/label` pairs from player JS. */
export function extractFromJs(html: string): Extracted[] {
  const out: Extracted[] = [];
  const re =
    /["']?\s*(?:file|src)\s*["']?\s*[:=]\s*["'](https?:\/\/[^"']+)["'](?:[^}>\]]+)["']?\s*(?:res|label)\s*["']?\s*[:=]\s*["']?([^"',\s]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (/\.(mp4|m3u8)/.test(m[1]) || m[1].includes('/video/')) {
      out.push({ url: m[1], quality: m[2] });
    }
  }
  const qualityNum = (q: string | null): number => parseInt(q ?? '', 10) || 0;
  return out.sort((a, b) => qualityNum(b.quality) - qualityNum(a.quality));
}

/** Pure — exported for tests. Promotes scheme-relative "//host/…" URLs. */
export function fixUrl(url: string): string {
  return url.startsWith('//') ? `https:${url}` : url;
}

function firstSourceTag(html: string): string | null {
  return /<source[^>]+src=["']([^"']+)["']/i.exec(html)?.[1] ?? null;
}

export async function resolveVidoza(
  url: string,
  timeoutMs: number
): Promise<ResolvedMedia | null> {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  if (!host.endsWith('vidoza.net') && !host.endsWith('videzz.net')) return null;

  const page = await fetchEmbedText(url, {
    headers: { Referer: 'https://vidoza.net/' },
    timeoutMs,
  });
  if (!page || !page.ok) return null;

  const js = extractFromJs(page.text);
  if (js.length > 0) {
    return { url: fixUrl(js[0].url), headers: { Referer: 'https://vidoza.net/' }, quality: js[0].quality };
  }

  const src = firstSourceTag(page.text);
  if (src && /^(https?:)?\/\//.test(src)) {
    return { url: fixUrl(src), headers: { Referer: 'https://vidoza.net/' } };
  }

  return null;
}
