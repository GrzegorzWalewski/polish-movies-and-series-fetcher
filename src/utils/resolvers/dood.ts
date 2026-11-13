/**
 * DoodStream family resolver (dood.*, vide0.net, dooood.com, …).
 * Algorithm (reimplemented from film-docker's extractor flow):
 *   1. /d/ watch URLs → /e/ embed
 *   2. embed page contains a /pass_md5/<...> path
 *   3. GET origin+path (with Referer) → base stream URL text
 *   4. final URL = <that text><10 random chars>?token=<last path segment>
 */

import { fetchEmbedText, type ResolvedMedia } from './index.js';

export const doodEmbedHosts = [
  'dood.la', 'dood.li', 'dood.yt', 'dood.re', 'dood.wf', 'dood.pm',
  'dood.so', 'dood.to', 'dood.watch', 'dood.cx', 'dood.ws', 'dood.pro',
  'vide0.net', 'dooood.com', 'ds2play.com', 'dsvplay.com', 'mydood.org',
];

const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

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

export async function resolveDood(
  url: string,
  timeoutMs: number
): Promise<ResolvedMedia | null> {
  const embedUrl = url.replace('/d/', '/e/');
  const headers = { Referer: url };

  const page = await fetchEmbedText(embedUrl, { headers, timeoutMs });
  if (!page || !page.ok) return null;

  const md5Path = extractMd5Path(page.text);
  if (!md5Path) return null;

  let origin: string;
  try {
    const u = new URL(embedUrl);
    origin = `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }

  const md5 = await fetchEmbedText(origin + md5Path, { headers, timeoutMs });
  if (!md5 || !md5.ok) return null;

  const streamBase = md5.text.trim();
  if (!/^https?:\/\//.test(streamBase)) return null;

  const token = md5Path.split('/').pop() ?? '';
  return { url: buildFinalUrl(streamBase, token), headers: { Referer: 'https://dood.la/' } };
}
