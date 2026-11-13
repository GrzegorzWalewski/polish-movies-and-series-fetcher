/**
 * MaxVOD (maxvod.tv) player resolver.
 *
 * The provider emits stable /player/play/<uuid> URLs. They 302 to a signed
 * expiring MP4 on an IP-host CDN — but ONLY when a same-site Referer is
 * sent (otherwise 302 → /login), and the signed URL itself requires that
 * Referer (bare requests get 403). The resolver captures the redirect
 * Location server-side (no body read — it's the video itself) and returns
 * it together with the required Referer header (Stremio desktop honors
 * per-stream `headers`).
 */

import type { ResolvedMedia } from './index.js';
import { DEFAULT_EMBED_UA } from './index.js';

export const maxvodEmbedHosts = ['maxvod.tv'];

const SITE_REFERER = 'https://maxvod.tv/';

export async function resolveMaxvod(
  url: string,
  timeoutMs: number
): Promise<ResolvedMedia | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': DEFAULT_EMBED_UA, Referer: SITE_REFERER },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    // drain + close without downloading the body
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    if (res.status < 300 || res.status >= 400) return null;
    const loc = res.headers.get('location');
    if (!loc) return null;
    const target = loc.startsWith('http') ? loc : new URL(loc, url).toString();
    if (/maxvod\.tv\/login/.test(target)) return null;

    // "player z reklamami" twins 302 to an embed page (vidara.to & co) —
    // only accept targets that actually serve media (ranged probe, headers only)
    const probe = await fetch(target, {
      headers: {
        'User-Agent': DEFAULT_EMBED_UA,
        Referer: SITE_REFERER,
        Range: 'bytes=0-1',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(Math.min(timeoutMs, 8_000)),
    });
    try {
      await probe.body?.cancel();
    } catch {
      /* ignore */
    }
    const ct = probe.headers.get('content-type') ?? '';
    if (
      !/^video\//i.test(ct) &&
      !/^application\/(vnd\.apple\.mpegurl|x-mpegurl|octet-stream)/i.test(ct)
    ) {
      return null;
    }
    return { url: target, headers: { Referer: SITE_REFERER } };
  } catch {
    return null;
  }
}
