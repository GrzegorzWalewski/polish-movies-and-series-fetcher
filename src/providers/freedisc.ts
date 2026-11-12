import { fetchPage } from '../utils/fetcher.js';
import type {
  Provider,
  ProviderSearchParams,
  StreamResult,
} from '../types.js';
import { pickMatches, cleanTitle, type SiteMatch } from './match.js';

const BASE_URL = 'https://freedisc.pl';
const STREAM_REFERER = `${BASE_URL}/static/player/v612/jwplayer.flash.swf`;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const fetchOpts = {
  headers: { 'User-Agent': UA, Accept: 'text/html', Referer: `${BASE_URL}/` },
  site: 'freedisc.pl',
};

const FILE_EXT_RE =
  /\.(?:avi|mkv|mp4|mpe?g|mov|wmv|flv|webm|m4v|ts|mp3|m4a|aac|ogg|flac|wma|wav)$/i;
const SXE_RE = /S(\d{1,2})\s*[ .:/x_-]*E(\d{1,4})/i;
const YEAR_RE = /[\s._(\[-]+((?:19|20)\d\d)(?:[\s._)\]-]|$)/;
const ODC_RE = /odc(?:inek)?\.?\s*(\d{1,4})/i;

/** Polish site file names often drop diacritics — fold both sides before matching */
export function foldDiacritics(s: string): string {
  return s
    .replace(/[ą]/g, 'a').replace(/[Ą]/g, 'A')
    .replace(/[ć]/g, 'c').replace(/[Ć]/g, 'C')
    .replace(/[ę]/g, 'e').replace(/[Ę]/g, 'E')
    .replace(/[ł]/g, 'l').replace(/[Ł]/g, 'L')
    .replace(/[ń]/g, 'n').replace(/[Ń]/g, 'N')
    .replace(/[ó]/g, 'o').replace(/[Ó]/g, 'O')
    .replace(/[ś]/g, 's').replace(/[Ś]/g, 'S')
    .replace(/[żź]/g, 'z').replace(/[ŻŹ]/g, 'Z');
}

export interface FileMeta {
  /** "movie" = year in name; "tv" = SxxExx (or absolute odcinek) in name */
  type: 'movie' | 'tv';
  title: string;
  year: string;
  season: number;
  episode: number;
}

/**
 * Port of e2iplayer's _fileMeta: "Movie (2022) Dubbing.mkv" -> movie+year;
 * "Show__Orig.S03E03.PL.avi" -> tv (Polish and original titles are often
 * joined by "__"); "Show - odcinek 123.avi" -> tv with absolute episode.
 */
export function fileMeta(name: string): FileMeta | null {
  const clean = name.trim().replace(FILE_EXT_RE, '');
  const sxe = SXE_RE.exec(clean);
  if (sxe) {
    const show = clean.split(SXE_RE)[0];
    const label = show.replace(/[._]+/g, ' ').trim();
    if (!label) return null;
    return {
      type: 'tv',
      title: label.split('__').pop()!.replace(/[._]+/g, ' ').trim(),
      year: '',
      season: Number(sxe[1]),
      episode: Number(sxe[2]),
    };
  }
  const ym = YEAR_RE.exec(clean);
  if (ym) {
    const label = clean.slice(0, ym.index).replace(/[._]+/g, ' ').trim();
    if (!label) return null;
    return {
      type: 'movie',
      title: label.split('__').pop()!.replace(/[._]+/g, ' ').trim(),
      year: ym[1],
      season: 0,
      episode: 0,
    };
  }
  const om = ODC_RE.exec(clean);
  if (om) {
    const label = clean.slice(0, om.index).replace(/[._]+/g, ' ').trim();
    if (!label) return null;
    return {
      type: 'tv',
      title: label.split('__').pop()!.replace(/[._]+/g, ' ').trim(),
      year: '',
      season: 1,
      episode: Number(om[1]),
    };
  }
  return null;
}

export interface SearchFile extends SiteMatch {
  type: 'movie' | 'tv';
  fileId: string;
  season: number;
  episode: number;
}

export interface SearchApiResponse {
  data_files?: { data?: SearchFileRaw[] };
  logins_translated?: Record<string, { userLogin?: string; display?: string }>;
  directories_translated?: Record<string, { name?: string }>;
}

interface SearchFileRaw {
  id?: string | number;
  type_fk?: string;
  name?: string;
  name_url?: string;
  user_id?: string | number;
}

/** Parse search/get JSON -> video files (type_fk 7) with playable page URLs */
export function parseSearchResponse(data: string): SearchFile[] {
  let json: SearchApiResponse;
  try {
    json = JSON.parse(data).response as SearchApiResponse;
  } catch {
    return [];
  }
  const logins = json.logins_translated ?? {};
  const files = json.data_files?.data ?? [];

  const items: SearchFile[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    if (String(f.type_fk) !== '7') continue;
    const name = (f.name ?? '').trim();
    const nameUrl = f.name_url ?? '';
    const user = logins[String(f.user_id)];
    if (!name || !nameUrl || !user?.userLogin) continue;
    const url = `${BASE_URL}/${user.userLogin},f-${f.id},${nameUrl}`;
    if (seen.has(url)) continue;
    seen.add(url);

    const meta = fileMeta(name);
    const type: 'movie' | 'tv' = meta?.type === 'tv' ? 'tv' : 'movie';
    items.push({
      title: meta?.title || foldDiacritics(name),
      url,
      year: meta?.year ?? '',
      type,
      fileId: String(f.id),
      season: meta?.season ?? 0,
      episode: meta?.episode ?? 0,
    });
  }
  return items;
}

/** Direct stream url constructed from the file page url (id + name_url) */
export function streamUrlFromPageUrl(pageUrl: string): string | null {
  const m = /,f-(\d+),([^/?]+)$/.exec(pageUrl);
  if (!m) return null;
  const nameUrl = m[2].replace(FILE_EXT_RE, '');
  const idx = nameUrl.lastIndexOf('-');
  if (idx === -1) return null;
  return `https://stream.freedisc.pl/video/${m[1]}/${nameUrl.slice(0, idx)}.mp4`;
}

/** ld+json VideoObject embedUrl: player.swf?file=<direct mp4> */
export function parseEmbedUrl(pageHtml: string): string | null {
  const m =
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(pageHtml);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[1]) as { embedUrl?: string };
    const file = (obj.embedUrl ?? '').split('?file=')[1] ?? '';
    return file.startsWith('https') ? file : null;
  } catch {
    return null;
  }
}

/** Embed page: data-video-url or player.swf?file= attributes */
export function parseEmbedPage(embedHtml: string): string | null {
  const m =
    /data-video-url=["'](http[^"']+?)["']/.exec(embedHtml) ??
    /player\.swf\?file=(http[^"']+?)["']/.exec(embedHtml);
  return m?.[1] ?? null;
}

async function fetchHtml(url: string, referer?: string): Promise<string> {
  const res = await fetchPage(url, {
    ...fetchOpts,
    headers: { ...fetchOpts.headers, ...(referer ? { Referer: referer } : {}) },
    site: 'freedisc.pl',
  });
  return res.text();
}

/**
 * Resolve a file page to stream urls. The mp4 CDN only answers with the
 * jwplayer.swf Referer, so the embed page is emitted alongside as a plain
 * browser-playable fallback.
 */
async function resolveFile(pageUrl: string): Promise<StreamResult[]> {
  const html = await fetchHtml(pageUrl);
  let mp4 = parseEmbedUrl(html);
  if (!mp4) {
    const m = /<iframe[^>]+?src=["'](http[^"']+?\/embed\/[^"']+?)["']/.exec(html);
    if (m) mp4 = parseEmbedPage(await fetchHtml(m[1], pageUrl));
  }

  const out: StreamResult[] = [];
  const seen = new Set<string>();
  const add = (url: string, label: string) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ provider: 'freedisc.pl', quality: null, language: null, url, label });
  };
  const constructed = streamUrlFromPageUrl(pageUrl);
  if (mp4) add(mp4, 'freedisc.pl mp4');
  else if (constructed) add(constructed, 'freedisc.pl mp4');
  add(pageUrl, 'freedisc.pl page');
  return out;
}

export const freedisc: Provider = {
  name: 'freedisc.pl',
  baseUrl: BASE_URL,

  async search(params: ProviderSearchParams): Promise<StreamResult[]> {
    const query = foldDiacritics(cleanTitle(params.title));
    const res = await fetchPage(`${BASE_URL}/search/get`, {
      headers: {
        'User-Agent': UA,
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'Content-Type': 'application/json; charset=UTF-8',
        Referer: `${BASE_URL}/search/${params.type === 'tv' ? 'series' : 'movies'}/${encodeURIComponent(query)}`,
      },
      method: 'POST',
      body: JSON.stringify({
        search_phrase: query,
        search_type: 'movies',
        search_saved: 0,
        pages: 0,
        limit: 0,
      }),
      site: 'freedisc.pl',
      retries: 0,
    }).catch((err: Error) => {
      throw new Error(
        `freedisc.pl search unavailable (${err.message}) — the site geo-blocks its search API outside Poland`
      );
    });
    const items = parseSearchResponse(await res.text()).filter(
      (i) => i.type === params.type
    );

    let matches = pickMatches(items, { ...params, title: query });
    if (params.type === 'tv' && params.season && params.episode) {
      const sxe = matches.filter(
        (m) =>
          (m as SearchFile).season === params.season &&
          (m as SearchFile).episode === params.episode
      );
      if (sxe.length > 0) matches = sxe;
    }
    if (matches.length === 0) return [];

    return resolveFile(matches[0].url);
  },
};
