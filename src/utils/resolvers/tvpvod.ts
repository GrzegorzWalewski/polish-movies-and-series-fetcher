/**
 * TVP VOD (vod.tvp.pl) resolver — official Telewizja Polska catalog.
 *
 * URLs (from sitemap / provider output) end with the product id after the
 * last comma:
 *   /seriale,18/ranczo-odcinki,316445/odcinek-1,S00E01,<episodeId>
 *   /filmy-fabularne,136/<slug>,<movieId>
 *
 * Stream endpoint (Vue SPA's own API):
 *   GET /api/products/{id}?platform=ANDROID            -> details (existence/DRM check)
 *   GET /api/products/{id}/videos/playlist
 *       ?platform=BROWSER&videoType=MOVIE              -> {sources:{HLS:[{src}],DASH:[...]},drm,...}
 * The tokenized HLS master URL is playable bare (signed, ~1 day expiry).
 */

import { fetchEmbedText, type ResolvedMedia } from './index.js';

export const tvpVodEmbedHosts = ['vod.tvp.pl', 'www.vod.tvp.pl'];

/** Product id = trailing segment after the last comma (pure, for tests). */
export function extractTvpProductId(url: string): string | null {
  try {
    const path = new URL(url).pathname;
    const m = /,(\d+)$/.exec(path);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

export async function resolveTvpVod(
  url: string,
  timeoutMs: number
): Promise<ResolvedMedia | null> {
  const productId = extractTvpProductId(url);
  if (!productId) return null;
  const api = 'https://vod.tvp.pl/api';

  // existence check (also rejects premium/DRM-gated items cheaply)
  const detail = await fetchEmbedText(`${api}/products/${productId}?platform=ANDROID`, {
    timeoutMs,
  });
  if (!detail || !detail.ok) return null;

  const playlist = await fetchEmbedText(
    `${api}/products/${productId}/videos/playlist?platform=BROWSER&videoType=MOVIE`,
    { timeoutMs }
  );
  if (!playlist || !playlist.ok) return null;
  let data: { sources?: Record<string, { src?: string }[] | { src?: string }> };
  try {
    data = JSON.parse(playlist.text);
  } catch {
    return null;
  }
  const sources = data.sources;
  if (!sources) return null;
  const pick = (k: string): string | null => {
    const s = sources[k];
    if (Array.isArray(s)) return s[0]?.src ?? null;
    return (s as { src?: string } | undefined)?.src ?? null;
  };
  const src = pick('HLS') ?? pick('DASH');
  if (!src) return null;
  return { url: src };
}
