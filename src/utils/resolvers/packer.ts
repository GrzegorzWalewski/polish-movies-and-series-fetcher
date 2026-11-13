/**
 * P.A.C.K.E.R. (Dean Edwards' packer) unpacker for packed JS blobs of the form
 * `eval(function(p,a,c,k,e,...){...}('packed',radix,count,'a|b|c'.split('|'),0,{}))`.
 *
 * Adapted from patrrwoj89/plug (MIT): cf/src/index.ts `unpackPacker` +
 * cf/src/jsunpacker.ts. Pure functions, no network.
 */

const PACKED_RE =
  /eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*[^)]+\s*\)\s*\{[\s\S]*?while\s*\([^)]*\)[\s\S]*?return\s+p[\s\S]*?\}\s*\(\s*(['"])((?:\\.|[^'"])*)\1\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(['"])((?:\\.|[^'"])*)\5\.split\(['"]\|['"]\)\s*,\s*\d+\s*,\s*\{\}\s*\)\s*\)/;

/**
 * Base62-ish token encoding packer uses (0-9, a-z, A-Z) — same alphabet as
 * plug's intToToken.
 */
export function intToToken(value: number, radix: number): string {
  if (value < radix) return charFor(value);
  let v = value;
  let result = '';
  while (v > 0) {
    result = charFor(v % radix) + result;
    v = Math.floor(v / radix);
  }
  return result;
}

function charFor(value: number): string {
  if (value < 10) return String.fromCharCode('0'.charCodeAt(0) + value);
  if (value < 36) return String.fromCharCode('a'.charCodeAt(0) + (value - 10));
  if (value < 62) return String.fromCharCode('A'.charCodeAt(0) + (value - 36));
  return '?';
}

function escapeRegex(s: string): string {
  return s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

/** Replace token i with keywords[i], counting down so 10→"a" before 1→"1". */
function unpack(packed: string, radix: number, count: number, keywords: string[]): string {
  if (radix < 2 || radix > 62) return packed;
  let result = packed;
  for (let i = count - 1; i >= 0; i--) {
    const keyword = keywords[i];
    if (!keyword) continue;
    const token = intToToken(i, radix);
    result = result.replace(new RegExp(`\\b${escapeRegex(token)}\\b`, 'g'), keyword);
  }
  return result;
}

/**
 * Unpack the first packed blob found in `js`. Returns the unpacked code,
 * or the input unchanged when nothing matches (never throws).
 */
export function unpackPacker(js: string): string {
  const match = PACKED_RE.exec(js);
  if (!match) return js;
  const packed = match[2];
  const radix = Number(match[3]);
  const count = Number(match[4]);
  const dict = match[6].split('|');
  return unpack(packed, radix, count, dict);
}

const MEDIA_RE =
  /(https?:\/\/[^\s"'<>]+\.(?:mp4|m3u8|mpd|webm|mkv))(?:\?[^\s"'<>]*)?/i;

/** First direct media URL (m3u8/mp4/…) in the text, or null. */
export function findMediaUrl(text: string): string | null {
  return MEDIA_RE.exec(text)?.[0] ?? null;
}
