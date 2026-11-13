/**
 * voe.sx (and rotating aliases) embed resolver.
 * Algorithm per ResolveURL's voesx plugin (reimplemented, also used by
 * film-docker): the page carries an obfuscated payload + a link to an
 * external script holding LUT substitution patterns:
 *   ROT13 → LUT strip → base64 → shift(-3) → reverse → base64 → JSON
 * The JSON's `source` field is the stream (m3u8/mp4).
 */

import { fetchEmbedText, type ResolvedMedia } from './index.js';

export const voeEmbedHosts = ['voe.sx', '*.voe-unblk.com', '*.voeunblk.com', '*.voeunblk.net'];

/** ROT13 on ASCII letters (self-inverse). */
function rot13(s: string): string {
  let out = '';
  for (const char of s) {
    let x = char.charCodeAt(0);
    if (x > 64 && x < 91) x = ((x - 52) % 26) + 65;
    else if (x > 96 && x < 123) x = ((x - 84) % 26) + 97;
    out += String.fromCharCode(x);
  }
  return out;
}

/**
 * Decode a voe payload given the LUT string from the external script.
 * Pure — exported for tests. Returns null on any structural failure.
 */
export function decodeVoePayload(ct: string, luts: string): { source?: string } | null {
  try {
    // LUT: ["xy", "ab", ...] — escape regex metachars inside each entry
    const patterns = luts
      .slice(2, -2)
      .split("','")
      .map((item) =>
        item
          .split('')
          .map((x) => ('.*+?^${}()|[]\\'.includes(x) ? `\\${x}` : x))
          .join('')
      );

    let txt = rot13(ct);
    for (const pattern of patterns) {
      txt = txt.replace(new RegExp(pattern, 'g'), '');
    }

    let decoded = Buffer.from(txt, 'base64').toString('utf-8');
    decoded = decoded
      .split('')
      .map((c) => String.fromCharCode(c.charCodeAt(0) - 3))
      .join('');
    const reversed = decoded.split('').reverse().join('');
    const final = Buffer.from(reversed, 'base64').toString('utf-8');
    return JSON.parse(final) as { source?: string };
  } catch {
    return null;
  }
}

const PAYLOAD_RE = /json">\["([^"]+)"\]<\/script>\s*<script\s*src="([^"]+)"/;
const LUTS_RE = /(\[(?:'\W{2}'[,\]]){1,9})/;

export async function resolveVoe(
  url: string,
  timeoutMs: number
): Promise<ResolvedMedia | null> {
  const headers = { Referer: url };
  let page = await fetchEmbedText(url, { headers, timeoutMs });
  if (!page || !page.ok) return null;

  // voe bounces through a JS redirect on first hit
  const redirect = /window\.location\.href\s*=\s*'([^']+)'/.exec(page.text)?.[1];
  if (redirect) {
    page = await fetchEmbedText(redirect, { headers, timeoutMs });
    if (!page || !page.ok) return null;
  }

  const m = PAYLOAD_RE.exec(page.text);
  if (m) {
    const scriptUrl = new URL(m[2], new URL(url).origin).href;
    const script = await fetchEmbedText(scriptUrl, { headers, timeoutMs });
    const luts = script && script.ok ? LUTS_RE.exec(script.text)?.[1] : undefined;
    if (luts) {
      const data = decodeVoePayload(m[1], luts);
      if (data?.source) {
        return { url: data.source, headers: { Referer: url } };
      }
    }
  }

  // fallback: plain base64 blob variant of the embed page
  for (const re of [
    /let\s+\w+\s*=\s*'([A-Za-z0-9+/=]+)'/,
    /var\s+\w+\s*=\s*'([A-Za-z0-9+/=]+)'/,
    /"source":\s*"([^"]+)"/,
    /atob\s*\(\s*['"]([A-Za-z0-9+/=]+)['"]\s*\)/,
  ]) {
    const fm = re.exec(page.text);
    if (!fm) continue;
    try {
      const decoded = Buffer.from(fm[1], 'base64').toString('utf-8');
      if (decoded.includes('.m3u8') || decoded.includes('.mp4')) {
        return { url: decoded, headers: { Referer: url } };
      }
      const parsed = JSON.parse(decoded) as { source?: string };
      if (parsed.source) return { url: parsed.source, headers: { Referer: url } };
    } catch {
      /* try next pattern */
    }
  }

  return null;
}
