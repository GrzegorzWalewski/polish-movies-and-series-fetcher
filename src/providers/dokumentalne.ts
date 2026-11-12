import { fetchPage } from '../utils/fetcher.js';
import type {
  Provider,
  ProviderSearchParams,
  StreamResult,
} from '../types.js';
import { pickMatches, cleanTitle, type SiteMatch } from './match.js';

const BASE_URL = 'https://dokumentalne.net';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const fetchOpts = {
  headers: { 'User-Agent': UA, 'Accept-Language': 'pl,en;q=0.8' },
  site: 'dokumentalne.net',
};

const YEAR_IN_TITLE_RE = /\((?:19|20)\d\d\)/;

export interface DocPost extends SiteMatch {
  wpId: number;
}

/** decode HTML entities from WP REST title.rendered (&#8211; &#8222; &amp; ...) */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

interface RestPost {
  id?: number;
  link?: string;
  title?: { rendered?: string };
}

/** Parse /wp-json/wp/v2/posts?search= results; year comes from "(YYYY)" in title */
export function parseRestSearch(data: string): DocPost[] {
  let json: unknown;
  try {
    json = JSON.parse(data) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(json)) return [];
  const posts = json as RestPost[];
  const items: DocPost[] = [];
  for (const p of posts) {
    const url = p.link ?? '';
    const title = decodeEntities(p.title?.rendered ?? '').trim();
    if (!/^https?:\/\/.+/.test(url) || !title) continue;
    const ym = YEAR_IN_TITLE_RE.exec(title);
    items.push({
      title: title.replace(YEAR_IN_TITLE_RE, '').replace(/\s+-\s*$/, '').trim(),
      url,
      year: ym ? ym[0].slice(1, -1) : '',
      wpId: p.id ?? 0,
    });
  }
  return items;
}

/** player = whatever <iframe src> the post embeds (ok.ru videoembed etc.) */
export function parsePostIframes(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<iframe[^>]+src=["']([^"']+)["']/g)) {
    let url = m[1].replace(/&amp;/g, '&');
    if (url.startsWith('//')) url = 'https:' + url;
    if (!/^https?:\/\//.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

function hostLabel(url: string): string | null {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return null;
  }
}

async function searchRest(query: string): Promise<string> {
  const res = await fetchPage(
    `${BASE_URL}/wp-json/wp/v2/posts?search=${encodeURIComponent(query)}&per_page=20&_fields=id,link,title`,
    { ...fetchOpts, headers: { ...fetchOpts.headers, Accept: 'application/json' } }
  );
  return res.text();
}

export const dokumentalne: Provider = {
  name: 'dokumentalne.net',
  baseUrl: BASE_URL,

  async search(params: ProviderSearchParams): Promise<StreamResult[]> {
    // documentary post catalog — titles like "Apollo 11 (2019)"; episodic docs
    // are separate posts with no season/episode structure, so tv is unsupported
    if (params.type !== 'movie') return [];

    const query = cleanTitle(params.title);
    const items = parseRestSearch(await searchRest(query));
    const matches = pickMatches(items, { ...params, title: query });
    if (matches.length === 0) return [];

    const res = await fetchPage(matches[0].url, {
      ...fetchOpts,
      headers: { ...fetchOpts.headers, Referer: `${BASE_URL}/` },
    });
    const iframes = parsePostIframes(await res.text());
    return iframes.map((url) => ({
      provider: 'dokumentalne.net',
      quality: null,
      language: null,
      url,
      label: hostLabel(url) ?? 'embed',
    }));
  },
};
