import * as cheerio from 'cheerio';
import { fetchPage } from '../utils/fetcher.js';
import type {
  Provider,
  ProviderSearchParams,
  StreamResult,
} from '../types.js';
import { cleanTitle, matchesQuery, pickMatches, type SiteMatch } from './match.js';

const BASE_URL = 'https://www.cda.pl';
// cda's CDN/player checks are more lenient with this UA (e2iplayer finding)
const PLAYER_UA =
  'Mozilla/5.0 (PlayStation 4 4.71) AppleWebKit/601.2 (KHTML, like Gecko)';

/** How many search matches to resolve (each costs 1-4 requests) */
const MAX_MATCHES = 5;

interface CdaSearchItem extends SiteMatch {
  id: string;
  premium: boolean;
  qualityHint: string | null;
}

/** Parse cda.pl search results (https://www.cda.pl/szukaj?q=...) */
export function parseSearchHtml(html: string): CdaSearchItem[] {
  const $ = cheerio.load(html);
  const items: CdaSearchItem[] = [];
  const seen = new Set<string>();

  $('div.video-clip-wrapper').each((_, el) => {
    const $el = $(el);
    const a = $el.find('a.video-clip-link').first();
    const href = a.attr('href') ?? '';
    const id = /\/video\/([0-9a-z]+)/i.exec(href)?.[1];
    const title = $el.find('a.link-title-visit').first().text().trim();
    const premium = $el.find('.flag-video-premium').length > 0;
    const qualityHint = $el.find('.hd-ico-elem').first().text().trim() || null;

    if (id && title && !seen.has(id + title)) {
      seen.add(id + title);
      items.push({ id, title, url: `${BASE_URL}/video/${id}`, premium, qualityHint });
    }
  });
  return items;
}

/** Decode cda's obfuscated progressive-file URL (e2iplayer algorithm). */
export function decodeCdaFile(raw: string): string {
  let dat = raw;
  for (const marker of ['_XDDD', '_CDA', '_ADC', '_CXD', '_QWE', '_Q5', '_IKSDE']) {
    dat = dat.split(marker).join('');
  }
  dat = decodeURIComponentSafe(dat);
  dat = Array.from(dat)
    .map((c) => {
      const code = c.charCodeAt(0);
      return code > 32 && code < 127
        ? String.fromCharCode(33 + ((code + 14) % 94))
        : c;
    })
    .join('');
  dat = dat
    .replace(/\.cda\.mp4/g, '')
    .replace(/\.2cda\.pl/g, '.cda.pl')
    .replace(/\.3cda\.pl/g, '.cda.pl');
  if (dat.includes('/upstream')) {
    return 'https://' + dat.replace('/upstream', '.mp4/upstream');
  }
  return 'https://' + dat + '.mp4';
}

function decodeURIComponentSafe(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

interface PlayerData {
  title?: string;
  quality?: string;
  file?: string;
  manifest_apple?: string | null;
  manifest_drm_proxy?: string | null;
  manifest_drm_header?: string | null;
  qualities?: Record<string, string>;
}

/** Extract and parse `player_data='...'` from an ebd.cda.pl embed page. */
export function parsePlayerData(html: string): PlayerData | null {
  const m = /player_data='([^']*)'/.exec(html) ??
    /player_data="([^"]*)"/.exec(html);
  if (!m) return null;
  try {
    const raw = m[1]
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&#039;/g, "'");
    const data = JSON.parse(raw) as { video?: PlayerData };
    return data.video ?? null;
  } catch {
    return null;
  }
}

/** Language/version label from the uploader's title, e.g. "... Lektor PL". */
export function detectLanguage(title: string): string | null {
  const t = title.toLowerCase();
  if (t.includes('lektor')) return 'Lektor PL';
  if (t.includes('dubb')) return 'Dubbing PL';
  if (t.includes('napis')) return 'Napisy PL';
  return null;
}

/** Fetch the embed page and turn it into stream results (all qualities). */
async function resolveVideo(item: CdaSearchItem): Promise<StreamResult[]> {
  const embedUrl = `https://ebd.cda.pl/620x368/${item.id}`;
  const res = await fetchPage(embedUrl, {
    headers: { 'User-Agent': PLAYER_UA, Referer: `${BASE_URL}/` },
    site: 'cda.pl',
    retries: 0,
  });
  const video = parsePlayerData(await res.text());

  // premium-only videos serve an upsell page without player_data
  if (!video) return [];
  if (video.manifest_drm_proxy || video.manifest_drm_header) return [];

  const language = detectLanguage(item.title);
  const results: StreamResult[] = [];

  if (video.file) {
    results.push({
      provider: 'cda.pl',
      quality: qualityLabel(video.quality),
      language,
      url: decodeCdaFile(video.file),
      label: item.title,
    });

    // remaining qualities need one refetch per quality name
    for (const [name, code] of Object.entries(video.qualities ?? {})) {
      if (name === 'auto' || code === video.quality) continue;
      try {
        const qRes = await fetchPage(
          `${embedUrl}/vfilm?wersja=${encodeURIComponent(name)}&a=1&t=0`,
          {
            headers: { 'User-Agent': PLAYER_UA, Referer: `${BASE_URL}/` },
            site: 'cda.pl',
            retries: 0,
          }
        );
        const qVideo = parsePlayerData(await qRes.text());
        if (qVideo?.file) {
          results.push({
            provider: 'cda.pl',
            quality: name,
            language,
            url: decodeCdaFile(qVideo.file),
            label: item.title,
          });
        }
      } catch {
        // single quality variant failing is not fatal
      }
    }
  } else if (video.manifest_apple) {
    results.push({
      provider: 'cda.pl',
      quality: qualityLabel(video.quality),
      language,
      url: video.manifest_apple,
      label: item.title,
    });
  }

  return results;
}

function qualityLabel(code: string | undefined): string | null {
  if (!code) return null;
  const map: Record<string, string> = {
    vl: '360p',
    lq: '480p',
    sd: '720p',
    hd: '1080p',
  };
  return map[code] ?? code;
}

export const cda: Provider = {
  name: 'cda.pl',
  baseUrl: BASE_URL,

  async search(params: ProviderSearchParams): Promise<StreamResult[]> {
    const query = cleanTitle(params.title);
    const searchUrl = `${BASE_URL}/szukaj?q=${encodeURIComponent(query)}`;
    const res = await fetchPage(searchUrl, { site: this.name });

    const items = parseSearchHtml(await res.text());
    // premium videos can't be resolved without a paid account — skip upfront
    const free = items.filter((i) => !i.premium);

    let candidates = pickMatches(free, { ...params, title: query }) as CdaSearchItem[];

    // for episodes, prefer uploads titled "odcinek <n>"
    if (params.episode) {
      const withEpisode = candidates.filter((m) =>
        matchesQueryEpisode(m.title, params.episode!)
      );
      if (withEpisode.length > 0) candidates = withEpisode;
    }

    // movie queries must not resolve episodic junk uploads ("Obsesja s01e01",
    // "Obsesja odcinek 2") that match the title by prefix
    if (params.type === 'movie') {
      const nonEpisodic = candidates.filter((m) => !looksEpisodic(m.title));
      if (nonEpisodic.length > 0) candidates = nonEpisodic;
    }

    const results: StreamResult[] = [];
    for (const match of candidates.slice(0, MAX_MATCHES)) {
      try {
        results.push(...(await resolveVideo(match)));
      } catch {
        // one dead video must not kill the rest
      }
    }
    return results;
  },
};

/** "Diuna odcinek 3" matches episode 3 */
function matchesQueryEpisode(title: string, episode: number): boolean {
  return new RegExp(`\\bodcinek\\s+0*${episode}\\b`, 'i').test(title);
}

/** Upload title carries series markers (s01e01 / "odcinek") → episodic junk */
export function looksEpisodic(title: string): boolean {
  return /\bs\d{1,2}e\d{1,2}\b/i.test(title) || /\bodcinek\b/i.test(title);
}
