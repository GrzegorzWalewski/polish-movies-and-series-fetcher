/**
 * OK.ru (Odnoklassniki) embed resolver.
 *
 * The embed page carries the player config in the data-options attribute
 * (HTML-escaped JSON). flashvars.metadata (JSON object or nested JSON
 * string) holds hlsManifestUrl plus progressive videos[] entries named
 * mobile/lowest/low/sd/hd/full. Copyright-blocked videos render a stub
 * with copyrightsRestricted instead.
 */

import { fetchEmbedText, type ResolvedMedia } from './index.js';

export const okruEmbedHosts = ['ok.ru', 'www.ok.ru', 'm.ok.ru', 'odnoklassniki.ru'];

/** Parse data-options JSON and pull the best media URL (pure, for tests). */
export function extractOkruMediaUrl(html: string): { url: string; quality: string | null } | null {
  const raw = /data-options="([^"]+)"/.exec(html)?.[1];
  if (!raw) return null;
  let opts: {
    flashvars?: { metadata?: unknown };
  };
  try {
    opts = JSON.parse(
      raw.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    );
  } catch {
    return null;
  }
  let md: unknown = opts.flashvars?.metadata;
  if (typeof md === 'string') {
    try {
      md = JSON.parse(md);
    } catch {
      return null;
    }
  }
  const meta = md as {
    hlsManifestUrl?: string;
    videos?: { name?: string; url?: string; disallowed?: boolean }[];
  } | null;
  if (!meta) return null;

  if (meta.hlsManifestUrl) {
    return { url: meta.hlsManifestUrl, quality: null };
  }
  const PREFERENCE = ['full', 'highest', 'hd', 'high', 'sd', 'medium', 'low', 'lowest', 'mobile'];
  const vids = (meta.videos ?? []).filter((v) => !v.disallowed && v.url);
  if (vids.length === 0) return null;
  vids.sort(
    (a, b) =>
      (PREFERENCE.indexOf(a.name ?? '') + 1 || 99) - (PREFERENCE.indexOf(b.name ?? '') + 1 || 99)
  );
  return { url: vids[0].url!, quality: vids[0].name ?? null };
}

export async function resolveOkru(
  url: string,
  timeoutMs: number
): Promise<ResolvedMedia | null> {
  const page = await fetchEmbedText(url, { headers: { Referer: url }, timeoutMs });
  if (!page || !page.ok) return null;
  // copyright-stub pages look identical minus the player config
  if (page.text.includes('copyrightsRestricted')) return null;
  const media = extractOkruMediaUrl(page.text);
  if (!media) return null;
  return { url: media.url, quality: media.quality };
}
