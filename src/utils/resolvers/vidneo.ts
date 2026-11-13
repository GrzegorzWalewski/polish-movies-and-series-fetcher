/**
 * Vidneo (vidneo.cc) embed resolver — hoster used by ekino/obejrzyj-style
 * sites.
 *
 * Embed pages are Next.js (RSC) shells; the player config rides in the
 * RSC payload with a RELATIVE HLS path:
 *   "src":"/hls/<id>/master.m3u8"  (plus title/durationSec/subtitleTracks)
 * The master playlist (multi-audio pol/eng, up to 720p+) plays bare —
 * no Referer needed. Quality is not in the manifest; scrape it from the
 * title when present ("…1080p…").
 */

import { fetchEmbedText, type ResolvedMedia } from './index.js';

export const vidneoEmbedHosts = ['vidneo.cc'];

/**
 * Pull the relative HLS path out of the RSC payload (pure, for tests).
 * The payload's quote escaping varies (plain `"src":"…"` in some builds,
 * `\"src\":\"…\"` inside `self.__next_f.push` string args) — match the
 * path itself, which is unambiguous.
 */
export function extractVidneoHlsPath(html: string): string | null {
  return /\/hls\/[^"\\\s]+\.m3u8/.exec(html)?.[0] ?? null;
}

/** e.g. "Obsession.2025.MULTi.1080p.WEB-DL…" → "1080p" (pure, for tests). */
export function qualityFromVidneoTitle(html: string): string | null {
  const title = /\\"title\\":\\"([^"\\]+)\\"/.exec(html)?.[1] ?? '';
  return /(\d{3,4})p/.exec(title)?.[0] ?? null;
}

export async function resolveVidneo(
  url: string,
  timeoutMs: number
): Promise<ResolvedMedia | null> {
  const page = await fetchEmbedText(url, { headers: { Referer: url }, timeoutMs });
  if (!page || !page.ok) return null;
  const path = extractVidneoHlsPath(page.text);
  if (!path) return null;
  const origin = new URL(url).origin;
  return {
    url: `${origin}${path}`,
    quality: qualityFromVidneoTitle(page.text),
  };
}
