/**
 * VidMoLy resolver (vidmoly.me/.to/.net): embed page has a JWPlayer-style
 * `sources: [{file: "<master m3u8>"}]`; optionally pick the highest-bandwidth
 * variant from the master playlist. Algorithm reimplemented from film-docker.
 */

import { fetchEmbedText, type ResolvedMedia } from './index.js';

export const vidmolyEmbedHosts = ['vidmoly.me', 'vidmoly.to', 'vidmoly.net'];

/** Pure — exported for tests. */
export function extractHlsUrl(html: string): string | null {
  return /sources\s*:\s*\[\{file:\s*"([^"]+)"/.exec(html)?.[1] ?? null;
}

interface Variant {
  bandwidth: number;
  url: string;
}

/** Pure — exported for tests. Highest-bandwidth variant, or masterUrl as-is. */
export function selectBestVariant(playlistText: string, masterUrl: string): string {
  const variants: Variant[] = [];
  const re = /#EXT-X-STREAM-INF:.*?BANDWIDTH=(\d+).*?[\r\n]+([^\r\n]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(playlistText)) !== null) {
    let url = m[2].trim();
    if (!url.startsWith('http')) {
      url = masterUrl.substring(0, masterUrl.lastIndexOf('/') + 1) + url;
    }
    variants.push({ bandwidth: Number(m[1]), url });
  }
  if (variants.length === 0) return masterUrl;
  variants.sort((a, b) => b.bandwidth - a.bandwidth);
  return variants[0].url;
}

export async function resolveVidmoly(
  url: string,
  timeoutMs: number
): Promise<ResolvedMedia | null> {
  const headers = { Referer: 'https://vidmoly.me/' };
  const page = await fetchEmbedText(url, { headers, timeoutMs });
  if (!page || !page.ok) return null;

  const masterUrl = extractHlsUrl(page.text);
  if (!masterUrl || !masterUrl.startsWith('http')) return null;

  // Master playlist may be multi-variant — upgrade to the best one
  let best = masterUrl;
  try {
    const playlist = await fetchEmbedText(masterUrl, {
      headers: { Referer: url },
      timeoutMs,
    });
    if (playlist && playlist.ok && playlist.text.includes('#EXT-X-STREAM-INF')) {
      best = selectBestVariant(playlist.text, masterUrl);
    }
  } catch {
    /* master URL is fine as-is */
  }

  return { url: best, headers: { Referer: 'https://vidmoly.to/' } };
}
