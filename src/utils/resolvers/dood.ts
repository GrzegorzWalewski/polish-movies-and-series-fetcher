/**
 * DoodStream family resolver (dood.*, vide0.net, dooood.com, …).
 * Algorithm (reimplemented from film-docker's extractor flow):
 *   1. /d/ watch URLs → /e/ embed
 *   2. embed page contains a /pass_md5/<...> path
 *   3. GET origin+path (with Referer) → base stream URL text
 *   4. final URL = <that text><10 random chars>?token=<last path segment>
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fetchEmbedText, type ResolvedMedia } from './index.js';

const execFileAsync = promisify(execFile);

export const doodEmbedHosts = [
  'dood.la', 'dood.li', 'dood.yt', 'dood.re', 'dood.wf', 'dood.pm',
  'dood.so', 'dood.to', 'dood.watch', 'dood.cx', 'dood.ws', 'dood.pro',
  'vide0.net', 'dooood.com', 'ds2play.com', 'dsvplay.com', 'mydood.org',
  // DoodStream-family alias fronts (maxvod iframe rows land here via
  // myvidplay.com → playmogo.com redirects)
  'myvidplay.com', 'playmogo.com',
];

const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

// Chrome UA — dood's Cloudflare front scores client TLS+UA: node's TLS
// fingerprint 403s with ANY UA header but curl (Schannel/OpenSSL) passes
// with this one (verified 2026-11-17).
const CURL_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Pure — exported for tests. */
export function extractMd5Path(html: string): string | null {
  return /\/pass_md5\/[^']*/.exec(html)?.[0] ?? null;
}

/** Pure — exported for tests. */
export function buildFinalUrl(streamBase: string, token: string): string {
  let hash = '';
  for (let i = 0; i < 10; i++) {
    hash += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return `${streamBase}${hash}?token=${token}`;
}

/** Pure — split curl's `-w` trailer into {body, finalUrl}. */
export function parseCurlOutput(stdout: string): {
  body: string;
  finalUrl: string | null;
} {
  const sep = stdout.lastIndexOf('\n@@');
  if (sep === -1) return { body: stdout, finalUrl: null };
  return {
    body: stdout.slice(0, sep),
    finalUrl: stdout.slice(sep + 3) || null,
  };
}

/**
 * curl child-process fallback for the two dood metadata fetches. The dood
 * Cloudflare front 403s node's TLS fingerprint (embed + /pass_md5/ only —
 * the video CDN itself serves node fine), while plain curl with a Chrome UA
 * passes. Only used when the in-process fetch misses; a missing curl binary
 * yields null and the row stays external as before.
 */
async function fetchViaCurl(
  url: string,
  referer: string | undefined,
  timeoutMs: number
): Promise<{ body: string; finalUrl: string | null } | null> {
  const args = [
    '-s', '-L',
    '--max-time', String(Math.max(1, Math.ceil(timeoutMs / 1000))),
    '-A', CURL_UA,
    '-w', '\n@@%{url_effective}',
  ];
  if (referer) args.push('-H', `Referer: ${referer}`);
  args.push(url);
  try {
    const { stdout } = await execFileAsync('curl', args, {
      timeout: timeoutMs + 5000,
      maxBuffer: 5 * 1024 * 1024,
    });
    const out = parseCurlOutput(stdout);
    return out.body ? out : null;
  } catch {
    return null;
  }
}

export async function resolveDood(
  url: string,
  timeoutMs: number
): Promise<ResolvedMedia | null> {
  const embedUrl = url.replace('/d/', '/e/');
  const headers = { Referer: url };

  let page = await fetchEmbedText(embedUrl, { headers, timeoutMs });
  let embedText = page && page.ok ? page.text : null;
  let embedFinalUrl = page?.url ?? embedUrl;
  if (!embedText || !extractMd5Path(embedText)) {
    // CF wall (or dead embed) — curl fallback before giving up
    const via = await fetchViaCurl(embedUrl, url, timeoutMs);
    if (!via) return null;
    embedText = via.body;
    embedFinalUrl = via.finalUrl ?? embedUrl;
    if (!extractMd5Path(embedText)) return null;
  }

  const md5Path = extractMd5Path(embedText)!;

  let origin: string;
  try {
    // alias domains 301 between each other (myvidplay → playmogo) — the
    // /pass_md5/ call must go against the FINAL origin, not the input one
    const u = new URL(embedFinalUrl);
    origin = `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }

  const md5 = await fetchEmbedText(origin + md5Path, { headers, timeoutMs });
  let streamBase = md5 && md5.ok ? md5.text.trim() : null;
  if (!streamBase || !/^https?:\/\//.test(streamBase)) {
    const via = await fetchViaCurl(origin + md5Path, embedFinalUrl, timeoutMs);
    streamBase = via?.body.trim() ?? '';
  }
  if (!/^https?:\/\//.test(streamBase)) return null;

  const token = md5Path.split('/').pop() ?? '';
  return { url: buildFinalUrl(streamBase, token), headers: { Referer: 'https://dood.la/' } };
}
