/**
 * Streamtape embed resolver (streamtape.com/to/net + rotating mirrors).
 *
 * The embed page builds the video URL client-side. Extraction order:
 *   1. server-rendered <div id="ideoolink">URL</div>
 *   2. JS: innerHTML = 'BASE' + (robot('TRAILING')).substring(N)[.substring(M)]
 *      or robot("BASE","TRAILING").substring(N) — final = https:BASE+truncated
 *   3. page split on the /e/<videoId> — 10th chunk after it starts with the
 *      query params for a /get_video?id=<videoId><params> redirect
 *
 * Algorithm reimplemented from film-docker's extractor (no license, clean
 * rewrite). Live domains rotate; matched by prefix.
 */

import { fetchEmbedText, type ResolvedMedia } from './index.js';

export const streamtapeEmbedHosts = [
  'streamtape*',
  'streamadblocker*',
  'tapewithadblocker.org',
  'stape*',
  'strcloud*',
];

export function extractStreamtapeId(url: string): string | null {
  try {
    return /\/e\/([^/?#]+)/.exec(new URL(url).pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Method 1: server-rendered ideoolink div. */
export function extractIdeoolink(html: string): string | null {
  const m = /<div id=['"]ideoolink['"][^>]*>([^<]+)<\/div>/.exec(html)?.[1];
  if (!m) return null;
  if (m.startsWith('//')) return `https:${m}`;
  if (m.startsWith('/')) return `https:/${m}`;
  return m;
}

interface RobotMatch {
  base: string;
  trailing: string;
  substr1: number;
  substr2: number;
}

/**
 * Method 2 helpers: parse the JS construction, then assemble.
 *   'BASE' + (robot('TRAILING')).substring(N).substring(M)
 */
export function parseRobotConstruction(html: string): RobotMatch | null {
  // innerHTML assignment form
  const inner =
    /getElementById\(['"]ideoolink['"]\)\.innerHTML\s*=\s*['"]([^'"]+)['"];?\s*(?:robot\()?['"]([^'"]+)['"]\)?\.substring\((\d+)\)(?:\.substring\((\d+)\))?/.exec(
      html
    );
  if (inner) {
    return {
      base: inner[1],
      trailing: inner[2],
      substr1: parseInt(inner[3], 10),
      substr2: inner[4] ? parseInt(inner[4], 10) : 0,
    };
  }
  // standalone robot(...) form
  const robot =
    /robot\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)\.substring\((\d+)\)(?:\.substring\((\d+)\))?/.exec(
      html
    );
  if (robot) {
    return {
      base: robot[1],
      trailing: robot[2],
      substr1: parseInt(robot[3], 10),
      substr2: robot[4] ? parseInt(robot[4], 10) : 0,
    };
  }
  return null;
}

export function assembleRobotUrl(m: RobotMatch): string {
  let params = m.trailing.substring(m.substr1);
  if (m.substr2 > 0) params = params.substring(m.substr2);
  const base = m.base.startsWith('http') ? m.base : `https:${m.base}`;
  return `${base}${params}`;
}

/** Method 3: query params buried in the 10th chunk after the video id. */
export function extractGetVideoParams(html: string, videoId: string): string | null {
  const parts = html.split(videoId);
  if (parts.length < 11) return null;
  const params = /^([^']*)/.exec(parts[10])?.[1];
  return params && params.length > 0 ? params : null;
}

export async function resolveStreamtape(
  url: string,
  timeoutMs: number
): Promise<ResolvedMedia | null> {
  const videoId = extractStreamtapeId(url);
  if (!videoId) return null;

  const page = await fetchEmbedText(url, { headers: { Referer: url }, timeoutMs });
  if (!page || !page.ok) return null;
  const html = page.text;

  // 1. server-rendered link
  const direct = extractIdeoolink(html);
  if (direct) return { url: direct, headers: { Referer: 'https://streamtape.com/' } };

  // 2. JS-constructed link
  const robot = parseRobotConstruction(html);
  if (robot) return { url: assembleRobotUrl(robot), headers: { Referer: 'https://streamtape.com/' } };

  // 3. split-based get_video redirect
  const params = extractGetVideoParams(html, videoId);
  if (params) {
    const getVideoUrl = `https://streamtape.com/get_video?id=${videoId}${params}`;
    try {
      const res = await fetch(getVideoUrl, {
        headers: { 'User-Agent': DEFAULT_ST_UA, Referer: url },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      // undici exposes the final (post-redirect) URL
      const finalUrl = res.url !== getVideoUrl ? res.url : null;
      if (finalUrl && res.ok) {
        return { url: finalUrl, headers: { Referer: 'https://streamtape.com/' } };
      }
    } catch {
      return null;
    }
  }
  return null;
}

const DEFAULT_ST_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
