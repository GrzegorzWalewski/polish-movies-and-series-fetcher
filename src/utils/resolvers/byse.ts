/**
 * Byse embed resolver (byse.sx + rotating domains, used by bajeczki24.pl).
 *
 * The embed page is an SPA shell; the media URL requires:
 *   1. POST /api/videos/<code>/embed/captcha        -> pow_nonce/pow_difficulty/pow_token
 *   2. proof-of-work: find i where the custom 256-bit hash of
 *      "<nonce>:<i>" has >= difficulty leading zero BITS
 *   3. POST /api/videos/<code>/embed/captcha/verify -> access token
 *   4. POST /api/videos/<code>/embed/playback (X-Captcha-Token + dummy
 *      fingerprint; attestation is not enforced server-side)
 *      -> AES-GCM payload {key_parts, version, iv, payload}
 *      key = concat(b64url(key_parts[version-1]), b64url(key_parts[31-version-1]))
 *   5. decrypted JSON .sources[].url = signed m3u8/mp4 (valid ~3h, no
 *      cookies or Referer needed)
 *
 * Hash + flow reverse-engineered from the byse frontend bundle
 * (2026-11-13, live-verified against a bajeczki24 embed).
 */

import { fetchEmbedText, type ResolvedMedia } from './index.js';

export const byseEmbedHosts = ['byse*', 'mfw09.org']; // mfw09.org = ekino's byse frontend

/** byse-family API hosts (rotating byseNN domains + ekino's mfw09 frontend) */
export function isByseHost(host: string): boolean {
  return host.startsWith('byse') || host === 'mfw09.org';
}

// ---- custom 256-bit hash (reimplementation of the bundle's gr()) ----

const S = 512;
const MASK = S - 1;
const ROUNDS = 2;
const LR = 2654435761; // 0x9e3779b1
const HR = 2246822519; // 0x85ebca77

const rotl = (x: number, e: number): number => ((x << e) | (x >>> (32 - e))) >>> 0;
const imulz = (x: number, e: number): number => Math.imul(x, e) >>> 0;

function mix(s: Uint32Array): void {
  s[0] = (s[0] + s[1]) >>> 0;
  s[3] = rotl(s[3] ^ s[0], 16);
  s[2] = (s[2] + s[3]) >>> 0;
  s[1] = rotl(s[1] ^ s[2], 12);
  s[0] = (s[0] + s[1]) >>> 0;
  s[3] = rotl(s[3] ^ s[0], 8);
  s[2] = (s[2] + s[3]) >>> 0;
  s[1] = rotl(s[1] ^ s[2], 7);
}

/** 8-word (256-bit) digest. Pure — exported for tests. */
export function customHash256(bytes: Uint8Array): Uint32Array {
  const e = new Uint32Array([1779033703, 3144134277, 1013904242, 2773480762]);
  for (let i = 0; i < bytes.length; i++) {
    e[0] = (e[0] + bytes[i]) >>> 0;
    e[0] = rotl(e[0], 7);
    mix(e);
  }
  for (let i = 0; i < 8; i++) mix(e);
  const r = new Uint32Array(S);
  for (let i = 0; i < S; i++) {
    mix(e);
    r[i] = (e[0] ^ e[2]) >>> 0;
  }
  for (let i = 0; i < ROUNDS; i++) {
    for (let j = 0; j < S; j++) {
      const a = r[j] & MASK;
      let c = (r[j] + r[a]) >>> 0;
      c = rotl(c, 13);
      c = (c ^ imulz(r[(j + 1) & MASK], LR)) >>> 0;
      r[j] = c;
      e[0] = (e[0] ^ c) >>> 0;
      mix(e);
    }
  }
  const n = new Uint32Array(8);
  const o = S / 8;
  for (let i = 0; i < 8; i++) {
    mix(e);
    let v = e[0];
    const base = i * o;
    for (let c = 0; c < o; c++) {
      const d = r[base + c];
      v = (v + d) >>> 0;
      v = rotl(v, 5);
      v = (v ^ imulz(d, HR)) >>> 0;
    }
    n[i] = (v ^ e[2]) >>> 0;
  }
  return n;
}

/** Leading zero bits of the digest. Pure — exported for tests. */
export function leadingZeroBits(digest: Uint32Array): number {
  let total = 0;
  for (let i = 0; i < digest.length; i++) {
    const w = digest[i];
    if (w === 0) {
      total += 32;
      continue;
    }
    return total + Math.clz32(w);
  }
  return total;
}

function bytesOf(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 255;
  return out;
}

/** Smallest i with >= difficulty leading zero bits, or null on timeout.
 * ASYNC + yielding: each 1024-hash batch yields to the event loop
 * (setImmediate) so concurrent solves, timers and pending I/O progress —
 * the previous fully-synchronous loop blocked the whole process for up to
 * timeoutMs per solve, starving every parallel embed resolution (on the
 * 4-core server several concurrent byse embeds froze the resolve stage and
 * nearly all embeds degraded to external links). */
export async function solvePow(
  nonce: string,
  difficulty: number,
  timeoutMs = 15_000
): Promise<string | null> {
  if (difficulty <= 0) return '0';
  const prefix = `${nonce}:`;
  const start = Date.now();
  let i = 0;
  for (;;) {
    for (let c = 0; c < 1024; c++) {
      if (leadingZeroBits(customHash256(bytesOf(prefix + i))) >= difficulty) {
        return String(i);
      }
      i++;
    }
    if (Date.now() - start > timeoutMs) return null;
    await new Promise((r) => setImmediate(r));
  }
}

// ---- playback payload decryption ----

function b64urlDecode(e: string): Uint8Array<ArrayBuffer> {
  const t = e.replace(/-/g, '+').replace(/_/g, '/');
  return new Uint8Array(
    Buffer.from(t + '='.repeat((4 - (t.length % 4)) % 4), 'base64')
  );
}

interface EncryptedPlayback {
  algorithm: string;
  iv: string;
  payload: string;
  key_parts: string[];
  version: string;
}

/** AES key from key_parts + version permutation (exported for tests). */
export function keyFromParts(p: EncryptedPlayback): Uint8Array<ArrayBuffer> {
  const parts = Array.isArray(p.key_parts) ? p.key_parts : [];
  const version = Number(typeof p.version === 'string' ? p.version.trim() : NaN);
  const picked =
    Number.isInteger(version) && version >= 1 && version <= 20
      ? [parts[version - 1], parts[31 - version - 1]]
      : parts;
  const decoded = picked
    .filter((x) => typeof x === 'string' && x.length > 0)
    .map(b64urlDecode);
  const key = new Uint8Array(decoded.reduce((a, b) => a + b.length, 0));
  let off = 0;
  for (const d of decoded) {
    key.set(d, off);
    off += d.length;
  }
  return key;
}

/** AES-GCM decrypt of the playback payload (exported for tests). */
export async function decryptPlayback(
  p: EncryptedPlayback
): Promise<{ sources?: { url?: string; quality?: string; label?: string; height?: number }[] } | null> {
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      keyFromParts(p),
      'AES-GCM',
      false,
      ['decrypt']
    );
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64urlDecode(p.iv) },
      key,
      b64urlDecode(p.payload)
    );
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    return null;
  }
}

// ---- flow ----

interface PlaybackResponse {
  playback?: EncryptedPlayback;
}

function extractCode(url: string): string | null {
  try {
    const u = new URL(url);
    return /\/e\/([a-z0-9]+)/i.exec(u.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

export async function resolveByse(
  url: string,
  timeoutMs: number
): Promise<ResolvedMedia | null> {
  let host: string;
  let code: string | null;
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    code = extractCode(url);
  } catch {
    return null;
  }
  if (!isByseHost(host) || !code) return null;

  const api = `${new URL(url).protocol}//${host}`;
  const headers = {
    'User-Agent': DEFAULT_UA,
    Referer: `${api}/e/${code}`,
    'Content-Type': 'application/json',
  };

  // 1. start PoW challenge
  const startRes = await fetchEmbedText(`${api}/api/videos/${code}/embed/captcha`, {
    headers,
    timeoutMs,
    method: 'POST',
    body: '{}',
  });
  if (!startRes || !startRes.ok) return null;
  let challenge: { pow_nonce?: string; pow_difficulty?: number; pow_token?: string };
  try {
    challenge = JSON.parse(startRes.text);
  } catch {
    return null;
  }
  const { pow_nonce, pow_difficulty, pow_token } = challenge;
  if (!pow_nonce || typeof pow_difficulty !== 'number' || !pow_token) return null;

  // 2+3. solve + verify — bound the PoW so it gives up before the embed
  // budget is exhausted (leaves time for verify + playback round trips)
  const solution = await solvePow(
    pow_nonce,
    pow_difficulty,
    Math.max(2_000, timeoutMs - 3_000)
  );
  if (solution === null) return null;
  const verifyRes = await fetchEmbedText(
    `${api}/api/videos/${code}/embed/captcha/verify`,
    {
      headers,
      timeoutMs,
      method: 'POST',
      body: JSON.stringify({ pow_token, solution }),
    }
  );
  if (!verifyRes || !verifyRes.ok) return null;
  let verified: { token?: string };
  try {
    verified = JSON.parse(verifyRes.text);
  } catch {
    return null;
  }
  if (!verified.token) return null;

  // 4. playback config (dummy fingerprint passes — attestation unenforced)
  const pbRes = await fetchEmbedText(`${api}/api/videos/${code}/embed/playback`, {
    headers: { ...headers, 'X-Captcha-Token': verified.token },
    timeoutMs,
    method: 'POST',
    body: JSON.stringify({
      fingerprint: { token: 'x', viewer_id: 'x', device_id: 'x', confidence: 0.5 },
    }),
  });
  if (!pbRes || !pbRes.ok) return null;
  let pb: PlaybackResponse;
  try {
    pb = JSON.parse(pbRes.text);
  } catch {
    return null;
  }
  if (!pb.playback) return null;

  // 5. decrypt -> signed direct URL (valid ~3h, no cookies/referer needed)
  const cfg = await decryptPlayback(pb.playback);
  const source = cfg?.sources?.[0];
  if (!source?.url) return null;
  return {
    url: source.url,
    quality: source.label ?? source.quality ?? (source.height ? `${source.height}p` : null),
  };
}

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
