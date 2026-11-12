import { fetchPage } from '../utils/fetcher.js';
import type {
  Provider,
  ProviderSearchParams,
  StreamResult,
} from '../types.js';
import { pickMatches, cleanTitle, type SiteMatch } from './match.js';

const BASE_URL = 'https://telekino.top';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const fetchOpts = {
  headers: { 'User-Agent': UA, Accept: 'text/html' },
  site: 'telekino.top',
};

/** "Wiedźmin &#8211; 7 &#8211; Przed upadkiem" -> entity-decoded text */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#8211;/g, '\u2013')
    .replace(/&#8217;/g, "'")
    .replace(/&#8222;/g, '\u201e')
    .replace(/&#8221;/g, '\u201d')
    .replace(/&#038;|&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)));
}

export interface EpisodePart {
  series: string;
  episode: number;
  name: string;
}

/**
 * Episode posts carry a "Series – N – Name" title (en-dash or hyphen
 * separators). Movies never match this shape.
 */
export function parseEpisodeTitle(raw: string): EpisodePart | null {
  const m = /^(.*?)\s*[\u2013-]\s*(\d{1,4})\s*[\u2013-]\s*(.+)$/.exec(raw.trim());
  if (!m) return null;
  const series = m[1].trim();
  if (!series) return null;
  return { series, episode: Number(m[2]), name: m[3].trim() };
}

export interface Tile extends SiteMatch {
  /** episode number when the title is "Series – N – Name" */
  episode: number | null;
  /** post is in the login-only category — redirects to /ograniczony-dostep/ */
  gated: boolean;
}

/** Parse a listing (search /?s=, category or /tag/ archive) into tiles */
export function parseTiles(html: string): Tile[] {
  const out: Tile[] = [];
  const seen = new Set<string>();
  for (const tile of html.split('<div id="post-').slice(1)) {
    // tile header: <div id="post-N" class="... post type-post ... category-X tag-Y">
    const head = tile.slice(0, tile.indexOf('>'));
    if (!/post type-post/.test(head)) continue;
    const title = /<h2 class="entry-title"><a href="([^"]+)">([\s\S]*?)<\/a>/.exec(
      tile
    );
    if (!title) continue;
    const url = title[1];
    if (seen.has(url)) continue;
    seen.add(url);
    const raw = decodeEntities(title[2].replace(/<[^>]+>/g, '')).trim();
    const ep = parseEpisodeTitle(raw);
    out.push({
      title: ep ? ep.series : raw,
      url,
      episode: ep?.episode ?? null,
      gated: /category-tylko-dla-zalogowanych/.test(head),
    });
  }
  return out;
}

/** Tag slugs from a post page's article class list (`tag-<slug>`) */
export function parsePostTags(html: string): string[] {
  const m = /<article[^>]*class="[^"]*"/.exec(html);
  if (!m) return [];
  const slugs = new Set<string>();
  for (const t of m[0].matchAll(/tag-([a-z0-9-]+)/g)) {
    if (t[1] !== 'links') slugs.add(t[1]);
  }
  return [...slugs];
}

/** "next" pagination link from an archive page, if any */
export function nextPageUrl(html: string): string | null {
  const m = /<a class="next page-numbers" href="([^"]+)"/.exec(html);
  return m?.[1] ?? null;
}

const RESTRICTED_RE =
  /<title>Ten wpis dost[^<]*dla zalogowanych/i;

function hostname(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Player iframes from a post page (`entry-content` embeds) */
export function parseEmbedIframes(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<iframe[^>]*src="([^"]+)"/g)) {
    let src = m[1].trim().replace(/&amp;/g, '&');
    if (src.startsWith('//')) src = 'https:' + src;
    if (!/^https?:\/\//.test(src) || seen.has(src)) continue;
    seen.add(src);
    out.push(src);
  }
  return out;
}

/** Fetch a post page; flags login-gated posts (302 to /ograniczony-dostep/) */
async function fetchPost(url: string): Promise<{ html: string; restricted: boolean }> {
  const res = await fetchPage(url, fetchOpts);
  const html = await res.text();
  return { html, restricted: RESTRICTED_RE.test(html) };
}

async function fetchTagEpisodes(
  tagSlug: string,
  maxPages: number
): Promise<Tile[]> {
  const tiles: Tile[] = [];
  let url: string | null = `${BASE_URL}/tag/${tagSlug}/`;
  for (let page = 0; page < maxPages && url; page++) {
    const html = await fetchPage(url, fetchOpts).then((r) => r.text());
    tiles.push(...parseTiles(html).filter((t) => t.episode !== null));
    url = nextPageUrl(html);
  }
  return tiles;
}

function toResults(srcs: string[]): StreamResult[] {
  return srcs.map((src) => ({
    provider: 'telekino.top',
    quality: null,
    language: null,
    url: src,
    label: hostname(src),
  }));
}

export const telekino: Provider = {
  name: 'telekino.top',
  baseUrl: BASE_URL,

  async search(params: ProviderSearchParams): Promise<StreamResult[]> {
    const query = cleanTitle(params.title);
    const html = await fetchPage(
      `${BASE_URL}/?s=${encodeURIComponent(query)}`,
      fetchOpts
    ).then((r) => r.text());
    const tiles = parseTiles(html).filter((t) => !t.gated);

    if (params.type === 'movie') {
      const movies = tiles.filter((t) => t.episode === null);
      const matches = pickMatches(movies, { ...params, title: query });
      if (matches.length === 0) return [];
      const post = await fetchPost(matches[0].url);
      if (post.restricted) return [];
      return toResults(parseEmbedIframes(post.html));
    }

    // tv: find episode tiles of the series -> tag archive -> target episode
    const episodeTiles = tiles.filter((t) => t.episode !== null);
    const seriesMatches = pickMatches(episodeTiles, {
      ...params,
      title: query,
    });
    if (seriesMatches.length === 0) return [];

    const post = await fetchPost(seriesMatches[0].url);
    if (post.restricted) return [];

    const target = params.absoluteEpisode ?? params.episode;
    if (!target) return [];
    const wanted = parseEmbedIframes(post.html);
    if (
      episodeTiles.some(
        (t) => t.url === seriesMatches[0].url && t.episode === target
      )
    ) {
      return toResults(wanted);
    }

    // target not in the first search page — walk the series tag archive
    for (const tag of parsePostTags(post.html)) {
      const episodes = await fetchTagEpisodes(tag, 3);
      const hit = episodes.find((t) => t.episode === target && !t.gated);
      if (hit) {
        const epPost = await fetchPost(hit.url);
        if (!epPost.restricted) return toResults(parseEmbedIframes(epPost.html));
      }
    }
    return [];
  },
};
