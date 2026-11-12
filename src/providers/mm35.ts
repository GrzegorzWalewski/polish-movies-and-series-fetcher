import { fetchPage } from '../utils/fetcher.js';
import type {
  Provider,
  ProviderSearchParams,
  StreamResult,
} from '../types.js';
import { pickMatches, cleanTitle, type SiteMatch } from './match.js';
import { foldDiacritics } from './freedisc.js';

const BASE_URL = 'https://35mm.online';
const CMS_CONTENT = 'https://cms.35mm.online/umbraco/api/content';
const SITEMAP = `${BASE_URL}/Home/XmlSiteMapLang?lang=pl-pl`;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** headers the Vue SPA's axios interceptor sends with every umbraco call */
const cmsHeaders = (path: string) => ({
  'User-Agent': UA,
  'x-origin-url': `${BASE_URL}${path}`,
  'x-language': 'pl-pl',
  'x-eduType': '',
  TvStatus: '',
});

/** title-level catalog page: /vod/<category>/<slug> */
const TITLE_URL_RE = /^\/vod\/(?!subskrypcja\/)([a-z-]+)\/([a-z0-9-]+)$/;

/** parse /Home/XmlSiteMapLang -> title pages (slug-derived titles, no year) */
export function parseSitemapTitles(xml: string): SiteMatch[] {
  const items: SiteMatch[] = [];
  const seen = new Set<string>();
  for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const path = m[1].replace(/^https?:\/\/[^/]+/, '');
    if (!TITLE_URL_RE.test(path) || seen.has(path)) continue;
    seen.add(path);
    const slug = path.split('/').pop()!;
    items.push({ title: slug.replace(/-/g, ' ').trim(), url: BASE_URL + path });
  }
  return items;
}

interface CmsResponse {
  statusCode?: number;
  content?: Record<string, unknown> & { alias?: string };
}

export interface ContentAsset {
  alias: 'asset' | 'series' | string;
  title: string;
  year: string;
  quality: string | null;
  language: string | null;
  seasons?: Season[];
}

interface Season {
  title?: string | null;
  episodes?: Episode[];
}

export interface Episode {
  title?: string;
  url?: string;
}

export function parseContentAsset(data: string): ContentAsset | null {
  let json: CmsResponse;
  try {
    json = JSON.parse(data) as CmsResponse;
  } catch {
    return null;
  }
  const c = json.content;
  if (json.statusCode !== 200 || !c) return null;
  const language = c.language as
    | { sound?: { fullName?: string }[] | null }
    | null
    | undefined;
  const quality = c.quality as { name?: string } | null | undefined;
  const seasonsModel = c.seasonsModel as
    | { seasons?: Season[] | null }
    | null
    | undefined;
  return {
    alias: c.alias ?? '',
    title: (c.title as string) ?? '',
    year: String(c.year ?? ''),
    quality: quality?.name ?? null,
    language:
      language?.sound?.map((s) => s.fullName).filter(Boolean).join(', ') || null,
    seasons: seasonsModel?.seasons ?? undefined,
  };
}

/** 1-based season/episode -> ordered entry from seasonsModel (episodes have no number field) */
export function seasonEpisode(
  asset: ContentAsset,
  season: number,
  episode: number
): Episode | null {
  return (
    asset.seasons?.[season - 1]?.episodes?.[episode - 1] ??
    null
  );
}

async function fetchContent(path: string): Promise<ContentAsset | null> {
  try {
    const res = await fetchPage(CMS_CONTENT, {
      headers: cmsHeaders(path),
      site: '35mm.online',
      retries: 0,
    });
    return parseContentAsset(await res.text());
  } catch {
    return null; // 400 error-page JSON for bad paths etc.
  }
}

function pageUrl(path: string): string {
  return path.startsWith('http') ? path : BASE_URL + path;
}

/** skip candidates whose CMS year is way off TMDB (±1: release dates differ
 *  between Polish/other premieres — site says 1983, TMDB 1984 for Seksmisja) */
function yearOk(asset: ContentAsset, wanted: string): boolean {
  return (
    !wanted || !asset.year || Math.abs(Number(asset.year) - Number(wanted)) <= 1
  );
}

export const mm35: Provider = {
  name: '35mm.online',
  baseUrl: BASE_URL,

  async search(params: ProviderSearchParams): Promise<StreamResult[]> {
    // official WFDiF VOD (Umbraco CMS). The site's own search API ignores the
    // phrase entirely, so title discovery goes through the sitemap (one 3MB
    // XML of all /vod/ urls). Playback requires SSO login, so the provider
    // emits browser-playable page urls (metadata comes from the CMS payloads).
    // site slugs fold diacritics ("Królowym" -> "krolowym") — fold the TMDB
    // query the same way or normalize() drops the letters and nothing matches
    const query = foldDiacritics(cleanTitle(params.title));
    const items = parseSitemapTitles(await (await fetchPage(SITEMAP, { site: '35mm.online' })).text());
    const matches = pickMatches(items, { ...params, title: query });
    if (matches.length === 0) return [];

    const out: StreamResult[] = [];
    const seen = new Set<string>();
    // cap CMS round-trips per search
    for (const m of matches.slice(0, 4)) {
      const asset = await fetchContent(new URL(m.url).pathname);
      if (!asset) continue;

      if (params.type === 'movie') {
        if (asset.alias !== 'asset' || !yearOk(asset, params.year)) continue;
        if (seen.has(m.url)) continue;
        seen.add(m.url);
        out.push({
          provider: '35mm.online',
          quality: asset.quality,
          language: asset.language,
          url: m.url,
          label: 'page (login to play)',
        });
      } else {
        if (asset.alias !== 'series' || !params.season || !params.episode) continue;
        const ep = seasonEpisode(asset, params.season, params.episode);
        if (!ep?.url || seen.has(ep.url)) continue;
        seen.add(ep.url);
        out.push({
          provider: '35mm.online',
          quality: asset.quality,
          language: asset.language,
          url: pageUrl(ep.url),
          label: `page (login to play) — S${params.season}E${params.episode}${ep.title ? ` "${ep.title}"` : ''}`,
        });
      }
    }
    return out;
  },
};
