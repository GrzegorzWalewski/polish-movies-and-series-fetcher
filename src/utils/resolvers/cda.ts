/**
 * cda.pl embed resolver: any cda URL → ebd.cda.pl/620x368/<id> embed page →
 * player_data → direct mp4 (decoded file) or HLS (manifest_apple).
 * Reuses the provider's parsePlayerData/decodeCdaFile.
 * Algorithm per e2iplayer's parserCDA (GPL — reimplemented).
 */

import { parsePlayerData, decodeCdaFile } from '../../providers/cda.js';
import { fetchEmbedText, type ResolvedMedia } from './index.js';

export const cdaEmbedHosts = ['*.cda.pl'];

const PLAYER_UA =
  'Mozilla/5.0 (PlayStation 4 4.71) AppleWebKit/601.2 (KHTML, like Gecko)';

/**
 * Extract the numeric/alphanumeric video id from any cda URL shape:
 * /video/<id>, ebd.cda.pl/620x368/<id>, vfilm?wersja=… variants.
 */
export function normalizeCdaId(url: string): string | null {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith('cda.pl')) return null;
    const pathId = /\/(?:video|embed)\/([0-9a-z]+)(?:\.html?)?$/i.exec(u.pathname)?.[1];
    if (pathId) return pathId;
    const ebdId = /\/\d+x\d+\/([0-9a-z]+)$/i.exec(u.pathname)?.[1];
    if (ebdId) return ebdId;
  } catch {
    /* fall through */
  }
  return null;
}

export async function resolveCda(
  url: string,
  timeoutMs: number
): Promise<ResolvedMedia | null> {
  // direct CDN mp4/HLS URLs (vwawNNN.cda.pl/…) also sit under *.cda.pl —
  // they're already playable, don't re-resolve them through the embed page
  if (/\.(mp4|m3u8|mpd)(\?|#|$)/i.test(url)) return null;
  const id = normalizeCdaId(url);
  if (!id) return null;

  const embedUrl = `https://ebd.cda.pl/620x368/${id}`;
  const headers = { 'User-Agent': PLAYER_UA, Referer: 'https://www.cda.pl/' };

  // Prefer the hd variant when the player offers one (one extra fetch).
  const base = await fetchEmbedText(embedUrl, { headers, timeoutMs });
  if (!base || !base.ok) return null;
  const baseVideo = parsePlayerData(base.text);
  if (!baseVideo) return null;
  if (baseVideo.manifest_drm_proxy || baseVideo.manifest_drm_header) return null;

  if (baseVideo.qualities && baseVideo.qualities['hd']) {
    const hd = await fetchEmbedText(
      `${embedUrl}/vfilm?wersja=hd&a=1&t=0`,
      { headers, timeoutMs }
    );
    const hdVideo = hd && hd.ok ? parsePlayerData(hd.text) : null;
    if (hdVideo?.file) {
      return { url: decodeCdaFile(hdVideo.file), headers, quality: '1080p' };
    }
  }

  if (baseVideo.file) {
    return {
      url: decodeCdaFile(baseVideo.file),
      headers,
      quality: cdaQuality(baseVideo.quality),
    };
  }

  if (baseVideo.manifest_apple) {
    return { url: baseVideo.manifest_apple, headers, quality: cdaQuality(baseVideo.quality) };
  }

  return null;
}

function cdaQuality(code: string | undefined): string | null {
  if (!code) return null;
  const map: Record<string, string> = { vl: '360p', lq: '480p', sd: '720p', hd: '1080p' };
  return map[code] ?? code;
}
