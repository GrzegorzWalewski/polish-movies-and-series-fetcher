/**
 * Generic "packed player page" resolver for the filemoon / savefiles /
 * luluvdo / bigwarp family: fetch the embed page, unpack P.A.C.K.E.R. if
 * present, then take the first direct m3u8/mp4 URL (commonly inside
 * `file: "…"`, `sources: [...]` or `src:` setups).
 *
 * (byse has its own resolver — SPA + PoW captcha, see byse.ts)
 */

import { fetchEmbedText, type ResolvedMedia } from './index.js';
import { unpackPacker, findMediaUrl } from './packer.js';

const GENERIC_HOSTS = [
  'filemoon.sx', 'filemoon.to', 'filemoon.nl', 'moonplayer.com',
  'savefiles.com', 'savefiles.in',
  'luluvdo.com', 'luluvdo.ru', 'd000d.com',
  'bigwarp.io', 'bigwarp.cc',
  'strmup.to', 'strmup.net',
  'fsst.online',
];

export const genericPackerEmbedHosts = [...GENERIC_HOSTS];

function matchesHost(host: string): boolean {
  return GENERIC_HOSTS.includes(host);
}

export async function resolveGenericPacker(
  url: string,
  timeoutMs: number
): Promise<ResolvedMedia | null> {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!matchesHost(host)) return null;

  const page = await fetchEmbedText(url, {
    headers: { Referer: url },
    timeoutMs,
  });
  if (!page || !page.ok) return null;

  const unpacked = page.text.includes('eval(function(p,a,c,k,')
    ? unpackPacker(page.text)
    : page.text;

  const media = findMediaUrl(unpacked);
  if (media) {
    return { url: media, headers: { Referer: url } };
  }
  return null;
}
