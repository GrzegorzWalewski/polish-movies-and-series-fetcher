import { fetchPage } from '../utils/fetcher.js';
import type {
  Provider,
  ProviderSearchParams,
  StreamResult,
} from '../types.js';
import { pickMatches, cleanTitle, type SiteMatch } from './match.js';

const BASE_URL = 'https://seriale.vip';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Title URLs look like /<newsId>-<slug>-<year>(-online)?.html */
const TITLE_URL_RE = /\/(\d+)-[^/]*\.html/;
const YEAR_URL_RE = /-((?:19|20)\d{2})(?:-online)?\.html/;
/** "Sezon 2" and "2 Sezon" both occur in playlist labels */
const SEASON_RE = /(?:sezon\s*(\d+))|(?:(\d+)\s*sezon)/i;
const EPISODE_RE = /(\d+)\s*odcin|odcinek\s*(\d+)/i;

const fetchOpts = {
  headers: { 'User-Agent': UA, 'Accept-Language': 'pl,en;q=0.8' },
  site: 'seriale.vip',
};

export interface PlaylistItem {
  url: string;
  player: string;
  version: string;
  season: number;
  episode: number;
}

/**
 * Parse search result tiles: <a class="poster grid-item ..."> ... </a> inside
 * #dle-content, cut at the DLE navigation marker.
 */
export function parseTiles(
  html: string
): (SiteMatch & { type: 'movie' | 'tv' })[] {
  let content = html.includes('id="dle-content"')
    ? html.slice(html.indexOf('id="dle-content"'))
    : html;
  content = content.split('<!--ENGINE_NAVIGATION-->')[0];

  const results: (SiteMatch & { type: 'movie' | 'tv' })[] = [];
  const seen = new Set<string>();
  const tiles = content.split(/<a\s+class="poster grid-item/).slice(1);

  for (const tileHtml of tiles) {
    const tile = tileHtml.split('</a>')[0];
    const url = /href="([^"#]+)/.exec(tile)?.[1] ?? '';
    const title =
      /class="poster__title[^"]*"[^>]*>([\s\S]*?)<\/h3>/
        .exec(tile)?.[1]?.replace(/<[^>]+>/g, '')
        .trim() ?? '';
    if (!TITLE_URL_RE.test(url) || !title || seen.has(url)) continue;
    seen.add(url);

    const label =
      /class="poster__label[^"]*"[^>]*>\s*<span>([\s\S]*?)<\/span>/
        .exec(tile)?.[1]?.trim() ?? '';
    const series =
      /class="poster__series">([\s\S]*?)<\/div>/
        .exec(tile)?.[1]?.replace(/<[^>]+>/g, '')
        .trim() ?? '';
    const year = YEAR_URL_RE.exec(url)?.[1] ?? '';
    const type: 'movie' | 'tv' =
      label === 'Film' && !series ? 'movie' : 'tv';

    results.push({
      title: year ? `${title} (${year})` : title,
      url,
      type,
    });
  }
  return results;
}

function cleanFragment(html: string): string {
  return html.replace(/<[^>]+>/g, '').trim();
}

/**
 * Parse the playlists AJAX HTML (the `response` field of the JSON reply):
 * label items `<li data-id="chain">text</li>` build the folder chain,
 * file items `<li data-file="url" data-id="chain">label</li>` are players.
 * The chain id mirrors the folder path: Stream-X -> version -> Sezon N.
 */
export function parsePlaylistHtml(html: string): PlaylistItem[] {
  const labels = new Map<string, string>();
  for (const m of html.matchAll(/<li\s+data-id="([^"]+)"\s*>([\s\S]*?)<\/li>/g)) {
    labels.set(m[1], cleanFragment(m[2]));
  }

  const items: PlaylistItem[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(
    /<li\s+data-file="([^"]+)"\s+data-id="([^"]+)"\s*>([\s\S]*?)<\/li>/g
  )) {
    let fileUrl = m[1].replace(/\\\//g, '/').trim();
    if (fileUrl.startsWith('//')) fileUrl = 'https:' + fileUrl;
    if (!fileUrl.startsWith('http') || seen.has(fileUrl)) continue;
    seen.add(fileUrl);

    const parts = m[2].split('_');
    const chain = parts
      .slice(1)
      .map((_, i) => labels.get(parts.slice(0, i + 2).join('_')) ?? '');

    let player = (chain[0] ?? '').replace(/^Stream-/, '');
    if (!player || /sezon|odcin/i.test(player)) {
      player = hostname(fileUrl);
    }

    // chain[0] is usually the player name ("Stream-X"), but flat structures
    // put the season folder there ("2 Sezon") — scan it for a season too
    let season = 0;
    const sm0 = SEASON_RE.exec(chain[0] ?? '');
    if (sm0) season = Number(sm0[1] || sm0[2]);
    let episode = 0;
    const version: string[] = [];
    for (const text of chain.slice(1)) {
      const sm = SEASON_RE.exec(text);
      if (sm && !season) {
        season = Number(sm[1] || sm[2]);
      } else if (text && !version.includes(text)) {
        version.push(text);
      }
    }

    const label = cleanFragment(m[3]);
    const em = EPISODE_RE.exec(label);
    if (em) {
      episode = Number(em[1] || em[2]);
      season = season || 1;
    } else if (label && !version.includes(label)) {
      version.push(label);
    }

    items.push({
      url: fileUrl,
      player,
      version: version.join(' / '),
      season,
      episode,
    });
  }
  return items;
}

function hostname(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Fetch the DLE playlists AJAX endpoint for a title page URL. */
async function getPlaylist(pageUrl: string): Promise<PlaylistItem[]> {
  const newsId = TITLE_URL_RE.exec(pageUrl)?.[1];
  if (!newsId) return [];
  const res = await fetchPage(
    `${BASE_URL}/engine/ajax/controller.php?mod=playlists&news_id=${newsId}&xfield=pl`,
    {
      headers: {
        ...fetchOpts.headers,
        Referer: pageUrl,
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json, text/javascript, */*; q=0.01',
      },
      site: 'seriale.vip',
      retries: 0,
    }
  );
  const json = JSON.parse(await res.text()) as { response?: string };
  return parsePlaylistHtml(json.response ?? '');
}

export const serialeVip: Provider = {
  name: 'seriale.vip',
  baseUrl: BASE_URL,

  async search(params: ProviderSearchParams): Promise<StreamResult[]> {
    const query = cleanTitle(params.title);
    const res = await fetchPage(
      `${BASE_URL}/index.php?do=search&subaction=search&story=${encodeURIComponent(query)}`,
      fetchOpts
    );
    const html = await res.text();
    const items = parseTiles(html).filter((i) => i.type === params.type);
    const matches = pickMatches(items, { ...params, title: query });
    if (matches.length === 0) return [];

    const playlist = await getPlaylist(matches[0].url);

    let items_: PlaylistItem[];
    if (params.type === 'tv' && params.season && params.episode) {
      items_ = playlist.filter(
        (p) =>
          p.episode !== 0 &&
          p.season === params.season &&
          p.episode === params.episode
      );
    } else {
      // movie: playlist entries without an episode number
      items_ = playlist.filter((p) => p.episode === 0);
    }

    const results: StreamResult[] = [];
    const seen = new Set<string>();
    for (const item of items_) {
      if (seen.has(item.url)) continue;
      // "VIP"-player file URLs (/get_file/…) are session-gated: 403 without
      // the site's browser session, and they masquerade as direct media
      // because the path contains ".mp4". Dead rows — never emit them.
      if (/\/get_file\//.test(item.url)) continue;
      seen.add(item.url);
      results.push({
        provider: 'seriale.vip',
        quality: null,
        language: item.version || null,
        url: item.url,
        label: item.player,
      });
    }
    return results;
  },
};
