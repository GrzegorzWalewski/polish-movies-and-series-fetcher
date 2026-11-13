import type { ProviderSearchParams } from '../types.js';

export interface SiteMatch {
  title: string;
  url: string;
  /** release year if it can be extracted from page markup */
  year?: string;
}

/** "Title: Subtitle" -> "Title" (same cleanup zetta applies before searching) */
export function cleanTitle(title: string): string {
  return title.split(':')[0].trim();
}

/**
 * Word-boundary-safe title match (port of zetta's ScraperService matching):
 * normalized equality, prefix, suffix, or containment with spaces — never a
 * bare substring hit (which would match "zdunek" for query "dune").
 */
export function matchesQuery(title: string, query: string): boolean {
  const q = normalize(query);
  const n = normalize(title);
  if (!q || !n) return false;
  return (
    n === q ||
    n.startsWith(`${q} `) ||
    n.endsWith(` ${q}`) ||
    n.includes(` ${q} `) ||
    (q.includes(' ') && n.includes(q))
  );
}

/**
 * Polish sites don't accept imdb_id — we search by title and match results,
 * then prefer the shortest title (closest match) and results whose release
 * year matches TMDB's. TMDB and site years are often off by one (premiere
 * vs. festival/release dates) — ±1-year items are kept as lower-ranked
 * fallbacks instead of being dropped outright.
 */
export function pickMatches<T extends SiteMatch>(
  results: T[],
  params: ProviderSearchParams
): T[] {
  let matches = results.filter((r) => matchesQuery(r.title, cleanTitle(params.title)));

  if (params.year && matches.length > 1) {
    const yearOk = (m: T, y: string) =>
      m.year === y || m.title.includes(y) || m.url.includes(y);
    const y = parseInt(params.year, 10);
    const rank = (m: T): number => {
      if (yearOk(m, params.year!)) return 0;
      if (Number.isFinite(y) && (yearOk(m, String(y - 1)) || yearOk(m, String(y + 1))))
        return 1;
      return 2;
    };

    if (!matches.some((m) => rank(m) === 0)) {
      // no exact-year hit: keep ±1 items if any
      const near = matches.filter((m) => rank(m) <= 1);
      if (near.length > 0) matches = near;
    } else {
      // exact hit: drop items clearly off-year, keep ±1 as fallbacks
      matches = matches.filter((m) => rank(m) < 2);
    }
    matches = [...matches].sort(
      (a, b) => rank(a) - rank(b) || a.title.length - b.title.length
    );
    return matches;
  }

  return matches.sort((a, b) => a.title.length - b.title.length);
}

function normalize(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
}
