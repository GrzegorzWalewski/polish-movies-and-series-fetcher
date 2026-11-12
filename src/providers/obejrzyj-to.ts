import { fetchPage } from '../utils/fetcher.js';
import type {
  Provider,
  ProviderSearchParams,
  StreamResult,
} from '../types.js';
import { cleanTitle, matchesQuery, type SiteMatch } from './match.js';

const BASE_URL = 'https://obejrzyj.to';

const HEADERS = {
  Referer: 'https://obejrzyj.to/',
};

/** Extract `window.bootstrapData = {...}` JSON from obejrzyj.to HTML. */
export function extractBootstrapData(html: string): any | null {
  const re =
    /window\.bootstrapData\s*=\s*(\{.*?\});\s*<\/script>/s;
  const m = re.exec(html);
  if (m) {
    try {
      return JSON.parse(m[1]);
    } catch {
      /* fall through */
    }
  }
  const simple = /window\.bootstrapData\s*=\s*(\{.*?\});/s.exec(html);
  if (simple) {
    try {
      return JSON.parse(simple[1]);
    } catch {
      return null;
    }
  }
  return null;
}

interface ObejrzyjSearchItem {
  id: string | number;
  name?: string;
  type?: string;
  is_series?: boolean;
  imdb_id?: string | null;
}

function toMatch(item: ObejrzyjSearchItem): SiteMatch {
  const name = item.name ?? '';
  // the site ignores the slug part of the URL; only the id matters
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-');
  return { title: name, url: `${BASE_URL}/titles/${item.id}/${slug}` };
}

/** Parse bootstrapData from the search page into site matches. */
export function parseSearchData(
  data: any,
  fullTitle: string,
  imdbId?: string | null
): SiteMatch[] {
  const results: ObejrzyjSearchItem[] =
    data?.loaders?.searchPage?.results ?? [];
  const fallback = cleanTitle(fullTitle);
  const matches: SiteMatch[] = [];

  // best case: exact imdb_id match from the site's own metadata
  if (imdbId) {
    const byImdb = results.find((i) => i.imdb_id === imdbId);
    if (byImdb) return [toMatch(byImdb)];
  }

  for (const item of results) {
    const name = item.name ?? '';
    // full title first ("Dune: Część druga"), colon-stripped as fallback ("Dune")
    if (!matchesQuery(name, fullTitle) && !matchesQuery(name, fallback)) {
      continue;
    }
    matches.push(toMatch(item));
  }

  // exact title match beats longer partial matches
  return matches.sort((a, b) => {
    const aExact = isExact(a.title, fullTitle, fallback) ? 0 : 1;
    const bExact = isExact(b.title, fullTitle, fallback) ? 0 : 1;
    return aExact - bExact || a.title.length - b.title.length;
  });
}

function isExact(title: string, ...queries: string[]): boolean {
  const n = title.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  return queries.some(
    (q) => q && n === q.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim()
  );
}

/** Parse the /watch/<id> page bootstrapData into stream results. */
export function parseWatchPageHtml(html: string): StreamResult[] {
  const data = extractBootstrapData(html);
  const watchData = data?.loaders?.watchPage;
  if (!watchData) return [];

  const sources: StreamResult[] = [];
  const mainVideo = watchData.video;
  const mainId = mainVideo?.id != null ? String(mainVideo.id) : null;

  if (mainVideo) {
    const s = mapJsonToSource(mainVideo, 0);
    if (s) sources.push(s);
  }

  const alternatives: any[] = watchData.alternative_videos ?? [];
  alternatives.forEach((v, i) => {
    if (v?.id == null || mainId == null || String(v.id) !== mainId) {
      const s = mapJsonToSource(v, i + 1);
      if (s) sources.push(s);
    }
  });

  return sources;
}

function mapJsonToSource(v: any, index: number): StreamResult | null {
  const src: string = v?.src ?? '';
  if (!src) return null;

  const hostName = hostnameOf(src);
  const langLabel: string = v?.language_label?.toString() ?? '';
  const subLabel: string = v?.subtitle_label?.toString() ?? '';

  const tags: string[] = [];
  if (langLabel) tags.push(langLabel);
  if (subLabel && subLabel !== langLabel) tags.push(subLabel);
  if (tags.length === 0) {
    const langType = v?.language_type?.toString().toLowerCase() ?? '';
    if (langType.includes('lektor')) tags.push('Lektor');
    if (langType.includes('napisy')) tags.push('Napisy');
  }

  const label = tags.length > 0 ? `${hostName} (${tags.join(' & ')})` : hostName;

  return {
    provider: 'obejrzyj.to',
    quality: v?.quality?.toString() ?? 'Auto',
    language: tags.length > 0 ? tags.join(' & ') : null,
    url: src,
    label,
  };
}

function hostnameOf(url: string): string {
  try {
    const parts = new URL(url).host.split('.');
    if (parts.length >= 2) {
      const raw = parts[parts.length - 2];
      return raw[0].toUpperCase() + raw.slice(1);
    }
  } catch {
    /* ignore */
  }
  return 'Wideo';
}

export const obejrzyjTo: Provider = {
  name: 'obejrzyj.to',
  baseUrl: BASE_URL,

  async search(params: ProviderSearchParams): Promise<StreamResult[]> {
    const query = cleanTitle(params.title).toLowerCase();
    const searchUrl = `${BASE_URL}/search/${encodeURIComponent(query)}`;
    const res = await fetchPage(searchUrl, {
      headers: HEADERS,
      site: this.name,
    });
    const html = await res.text();

    const data = extractBootstrapData(html);
    const matches = data
      ? parseSearchData(data, params.title, params.imdbId)
      : [];

    // filter by requested type (movie vs series)
    const searchItems: ObejrzyjSearchItem[] =
      data?.loaders?.searchPage?.results ?? [];
    const filtered = matches.filter((m) => {
      const item = searchItems.find(
        (i) => m.url.includes(`/titles/${i.id}/`)
      );
      if (!item) return true;
      const isSeries =
        item.is_series === true || item.type === 'series';
      return params.type === 'tv' ? isSeries : !isSeries;
    });

    if (filtered.length === 0) return [];
    return getSources(filtered[0].url, params);
  },
};

async function getSources(
  titleUrl: string,
  params: ProviderSearchParams
): Promise<StreamResult[]> {
  let targetUrl = titleUrl;
  if (params.type === 'tv' && params.season && params.episode) {
    const clean = titleUrl.endsWith('/')
      ? titleUrl.slice(0, -1)
      : titleUrl;
    targetUrl = `${clean}/season/${params.season}/episode/${params.episode}`;
  }

  const res = await fetchPage(targetUrl, {
    headers: HEADERS,
    site: 'obejrzyj.to',
  });
  const html = await res.text();

  // watch id from bootstrap data, fallback to /watch/<id> regex
  const data = extractBootstrapData(html);
  let watchId: string | undefined;
  const episodePage = data?.loaders?.episodePage?.episode;
  const titlePage = data?.loaders?.titlePage?.title;
  const mediaData = episodePage ?? titlePage;
  if (mediaData?.videos?.length) {
    watchId = String(mediaData.videos[0].id);
  }
  if (!watchId) {
    watchId = /\/watch\/(\d+)/.exec(html)?.[1];
  }
  if (!watchId) return [];

  const watchRes = await fetchPage(`${BASE_URL}/watch/${watchId}`, {
    headers: HEADERS,
    site: 'obejrzyj.to',
  });
  return parseWatchPageHtml(await watchRes.text());
}
