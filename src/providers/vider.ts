import { fetchPage } from '../utils/fetcher.js';
import type {
  Provider,
  ProviderSearchParams,
  StreamResult,
} from '../types.js';
import { pickMatches, cleanTitle, type SiteMatch } from './match.js';
import { foldDiacritics } from './freedisc.js';

const BASE_URL = 'https://vider.info';
const STREAM_BASE = 'https://stream.vider.info/video';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * File codes (`/vid/+f<code>`) are the numeric file id encoded digit-by-digit
 * with a substitution cipher (verified: xn8m5x -> 215072 serves a real mp4).
 */
const CODE_TO_DIGIT: Record<string, string> = {
  m: '0', n: '1', x: '2', s: '3', e: '4',
  '8': '5', '1': '6', '5': '7', c: '8', v: '9',
};
const DIGIT_TO_CODE: Record<string, string> = Object.fromEntries(
  Object.entries(CODE_TO_DIGIT).map(([code, digit]) => [digit, code])
);

export function decodeFileCode(code: string): string | null {
  if (!code) return null;
  let out = '';
  for (const ch of code) {
    const digit = CODE_TO_DIGIT[ch];
    if (digit === undefined) return null;
    out += digit;
  }
  return out;
}

/** Inverse of decodeFileCode — for search results that only carry a numeric id */
export function encodeFileId(id: string | number): string | null {
  let out = '';
  for (const ch of String(id)) {
    const code = DIGIT_TO_CODE[ch];
    if (code === undefined) return null;
    out += code;
  }
  return out;
}

const SXE_RE = /S(\d{1,2})\s*[ .:/x_-]*E(\d{1,4})/i;
const YEAR_RE = /[\s._(\[-]+((?:19|20)\d\d)(?:[\s._)\]-]|$)/;
const ODC_RE = /odc(?:inek)?\.?\s*(\d{1,4})/i;
/** vider series uploads number episodes bare: "Pokemon Indigo League 01- ..." */
const BARE_EP_RE = /\b(\d{1,4})\s*[-–:]\s/;

export interface ViderFile extends SiteMatch {
  type: 'movie' | 'tv';
  code: string;
  /** numeric file id (stream.vider.info/video/<id>/v.mp4) */
  fileId: string;
  season: number;
  episode: number;
  year: string;
}

/**
 * "1670 S02E04 Palant" -> tv s2e4; "Show - odcinek 123" -> tv absolute;
 * "Pokemon Indigo League 01- ..." -> tv absolute; "The Fix 2026 PL" -> movie.
 */
export function titleMeta(name: string): {
  type: 'movie' | 'tv';
  title: string;
  season: number;
  episode: number;
  year: string;
} {
  const clean = name.trim();
  const sxe = SXE_RE.exec(clean);
  if (sxe) {
    const show = clean.slice(0, sxe.index).replace(/[._]+/g, ' ').trim();
    return {
      type: 'tv',
      title: show,
      season: Number(sxe[1]),
      episode: Number(sxe[2]),
      year: '',
    };
  }
  const om = ODC_RE.exec(clean);
  if (om) {
    return {
      type: 'tv',
      title: clean.slice(0, om.index).trim(),
      season: 1,
      episode: Number(om[1]),
      year: '',
    };
  }
  const ym = YEAR_RE.exec(clean);
  if (ym) {
    return {
      type: 'movie',
      title: clean.slice(0, ym.index).trim(),
      season: 0,
      episode: 0,
      year: ym[1],
    };
  }
  const bm = BARE_EP_RE.exec(clean);
  if (bm) {
    return {
      type: 'tv',
      title: clean.slice(0, bm.index).trim(),
      season: 1,
      episode: Number(bm[1]),
      year: '',
    };
  }
  return { type: 'movie', title: clean, season: 0, episode: 0, year: '' };
}

interface SearchFileRaw {
  id?: string | number;
  id_url?: string;
  type_fk?: string | number;
  name?: string;
}

interface SearchApiResponse {
  data_files?: { data?: SearchFileRaw[] };
  /** vider renders this transform of data_files client-side */
  data_files_render?: SearchFileRaw[];
}

/** true when vider returned its generic error shell instead of content */
export function is404Shell(html: string): boolean {
  return /<title>\s*404 error\s*-\s*Vider\.info/i.test(html);
}

/** captcha gate: `input[name="captcha"]` + image inside the parent form */
export function isCaptcha(html: string): boolean {
  return /<input[^>]+name=["']captcha["']/.test(html);
}

/** Parse search/get JSON -> video files with /vid/+f<code> urls */
export function parseSearchResponse(data: string): ViderFile[] {
  if (is404Shell(data) || !data.trimStart().startsWith('{')) return [];
  let json: SearchApiResponse;
  try {
    json = JSON.parse(data) as SearchApiResponse;
  } catch {
    return [];
  }
  const files = json.data_files?.data ?? json.data_files_render ?? [];

  const items: ViderFile[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    if (f.type_fk !== undefined && String(f.type_fk) !== '7') continue;
    const name = (f.name ?? '').trim();
    if (!name) continue;
    const code = f.id_url ?? encodeFileId(f.id ?? '');
    const fileId = decodeFileCode(code ?? '');
    if (!code || !fileId) continue;
    if (seen.has(code)) continue;
    seen.add(code);

    const meta = titleMeta(name);
    items.push({
      title: meta.title || foldDiacritics(name),
      url: `${BASE_URL}/vid/+f${code}`,
      type: meta.type,
      code,
      fileId,
      season: meta.season,
      episode: meta.episode,
      year: meta.year,
    });
  }
  return items;
}

/** direct mp4 stream — live-verified: 302 to signed url, then 200 video/mp4 */
export function streamUrl(fileId: string): string {
  return `${STREAM_BASE}/${fileId}/v.mp4?uid=0`;
}

function languageOf(title: string): string | null {
  if (/lektor/i.test(title)) return 'Lektor PL';
  if (/napisy/i.test(title)) return 'Napisy PL';
  if (/dubbing/i.test(title)) return 'Dubbing PL';
  if (/\b(PL|polski|polska)\b/.test(title)) return 'PL';
  if (/\b(ENG|angielski)\b/i.test(title)) return 'ENG';
  return null;
}

async function searchSite(query: string): Promise<string> {
  const res = await fetchPage(`${BASE_URL}/search/get`, {
    headers: {
      'User-Agent': UA,
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'Content-Type': 'application/json; charset=UTF-8',
      Referer: `${BASE_URL}/search/movies/${encodeURIComponent(query)}`,
    },
    method: 'POST',
    body: JSON.stringify({
      search_phrase: query,
      search_type: 'movies',
      search_saved: 0,
      pages: 0,
      limit: 0,
    }),
    site: 'vider.info',
    retries: 0,
    // vider answers valid pages with HTTP 404 (advvidedl client does the same)
    allowStatuses: [404],
  });
  const body = await res.text();
  if (isCaptcha(body)) {
    throw new Error(
      'vider.info served a captcha — open https://vider.info/ in a browser, solve it, then retry'
    );
  }
  if (is404Shell(body)) {
    throw new Error(
      'vider.info currently returns its error shell for every request (site-side outage or block) — its stream CDN still works, try again later'
    );
  }
  return body;
}

/**
 * TV preference: exact S/E first, else the show's absolute episode number
 * (vider series uploads are numbered continuously: "Title 09- ...").
 */
export function selectTvMatches(
  matches: ViderFile[],
  params: ProviderSearchParams
): ViderFile[] {
  const sxe = matches.filter(
    (m) =>
      m.season === (params.season ?? 1) && m.episode === params.episode
  );
  if (sxe.length > 0) return sxe;
  if (params.absoluteEpisode) {
    const abs = matches.filter(
      (m) => m.episode === params.absoluteEpisode
    );
    if (abs.length > 0) return abs;
  }
  return matches;
}

export const vider: Provider = {
  name: 'vider.info',
  baseUrl: BASE_URL,

  async search(params: ProviderSearchParams): Promise<StreamResult[]> {
    const query = cleanTitle(params.title);
    const items = parseSearchResponse(await searchSite(foldDiacritics(query)))
      .filter((i) => i.type === params.type);

    let matches = pickMatches(items, { ...params, title: query }) as ViderFile[];
    if (params.type === 'tv') matches = selectTvMatches(matches, params);
    if (matches.length === 0) return [];

    const out: StreamResult[] = [];
    const seen = new Set<string>();
    for (const file of matches.slice(0, 5)) {
      const lang = languageOf(file.title) ?? languageOf(query);
      const stream = streamUrl(file.fileId);
      if (!seen.has(stream)) {
        seen.add(stream);
        out.push({
          provider: 'vider.info',
          quality: null,
          language: lang,
          url: stream,
          label: 'vider.info stream',
        });
      }
      if (!seen.has(file.url)) {
        seen.add(file.url);
        out.push({
          provider: 'vider.info',
          quality: null,
          language: lang,
          url: file.url,
          label: 'vider.info page',
        });
      }
    }
    return out;
  },
};
