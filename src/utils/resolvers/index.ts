/**
 * Embed resolver layer: turns hoster embed URLs (voe, dood, cda, …) into
 * direct media URLs. Every failure path resolves to `null` — callers fall
 * back to the embed/page URL as an external link. Hosters rotate domains
 * and re-obfuscate constantly; resolvers are best-effort.
 */

import { resolveCda, cdaEmbedHosts } from './cda.js';
import { resolveVoe, voeEmbedHosts } from './voe.js';
import { resolveDood, doodEmbedHosts } from './dood.js';
import { resolveVidmoly, vidmolyEmbedHosts } from './vidmoly.js';
import { resolveVidoza, vidozaEmbedHosts } from './vidoza.js';
import { resolveGenericPacker, genericPackerEmbedHosts } from './generic-packer.js';
import { resolveByse, byseEmbedHosts } from './byse.js';
import { resolveStreamtape, streamtapeEmbedHosts } from './streamtape.js';
import { resolveOkru, okruEmbedHosts } from './okru.js';
import { resolveTvpVod, tvpVodEmbedHosts } from './tvpvod.js';

export interface ResolvedMedia {
  url: string;
  /** headers needed for playback (Referer/UA) — advisory, clients may ignore */
  headers?: Record<string, string>;
  quality?: string | null;
}

export type StreamUrlKind = 'direct' | 'embed' | 'page';

export interface EmbedResolver {
  resolve(url: string, timeoutMs: number): Promise<ResolvedMedia | null>;
}

const DIRECT_MEDIA_RE = /\.(m3u8|mpd|mp4|mkv|avi|webm|ts)(\?|#|$)/i;

function isDirectMediaUrl(url: string): boolean {
  return DIRECT_MEDIA_RE.test(url);
}

/**
 * Classify a provider-returned stream URL: playable media → 'direct',
 * known hoster embed → 'embed' (resolver may turn it into 'direct'),
 * everything else (site page, player page) → 'page'.
 */
export function classifyStreamUrl(url: string): StreamUrlKind {
  if (isDirectMediaUrl(url)) return 'direct';

  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 'page';
  }
  for (const entry of embedRegistry) {
    if (entry.hosts.some((h) => hostMatches(host, h))) return 'embed';
  }
  return 'page';
}

function hostMatches(host: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) {
    return host.endsWith(pattern.slice(1)) || host === pattern.slice(2);
  }
  if (pattern.endsWith('*')) {
    return host.startsWith(pattern.slice(0, -1));
  }
  return host === pattern;
}

const embedRegistry: { hosts: string[]; resolver: EmbedResolver }[] = [
  { hosts: cdaEmbedHosts, resolver: { resolve: resolveCda } },
  { hosts: voeEmbedHosts, resolver: { resolve: resolveVoe } },
  { hosts: doodEmbedHosts, resolver: { resolve: resolveDood } },
  { hosts: vidmolyEmbedHosts, resolver: { resolve: resolveVidmoly } },
  { hosts: vidozaEmbedHosts, resolver: { resolve: resolveVidoza } },
  { hosts: genericPackerEmbedHosts, resolver: { resolve: resolveGenericPacker } },
  { hosts: byseEmbedHosts, resolver: { resolve: resolveByse } },
  { hosts: streamtapeEmbedHosts, resolver: { resolve: resolveStreamtape } },
  { hosts: okruEmbedHosts, resolver: { resolve: resolveOkru } },
  { hosts: tvpVodEmbedHosts, resolver: { resolve: resolveTvpVod } },
];

/**
 * Resolve an embed URL to direct media. Picks the resolver by hostname and
 * enforces an overall timeout. All failures → null (never throws).
 */
export async function resolveEmbed(
  url: string,
  timeoutMs = 15_000
): Promise<ResolvedMedia | null> {
  if (isDirectMediaUrl(url)) return null; // already direct, nothing to do

  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }

  const entry = embedRegistry.find((e) => e.hosts.some((h) => hostMatches(host, h)));
  if (!entry) return null;

  try {
    return await withTimeout(entry.resolver.resolve(url, timeoutMs), timeoutMs);
  } catch {
    return null;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('resolver timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/**
 * Plain fetch for embed pages — deliberately NOT fetchPage: embed hosts
 * behind Cloudflare can't be helped by solved cookies here (we only need
 * the page once), so any challenge/HTTP error simply yields null.
 */
export async function fetchEmbedText(
  url: string,
  opts: {
    headers?: Record<string, string>;
    timeoutMs?: number;
    method?: string;
    body?: string;
  }
): Promise<{ ok: boolean; status: number; text: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 12_000);
  try {
    const res = await fetch(url, {
      method: opts.method,
      body: opts.body,
      headers: {
        'User-Agent': DEFAULT_EMBED_UA,
        ...opts.headers,
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    return { ok: res.ok, status: res.status, text: await res.text() };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export const DEFAULT_EMBED_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
