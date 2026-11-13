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
 * year matches TMDB's.
 */
export function pickMatches<T extends SiteMatch>(
  results: T[],
  params: ProviderSearchParams
): T[] {
  let matches = results.filter((r) => matchesQuery(r.title, cleanTitle(params.title)));

  if (params.year && matches.length > 1) {
    const yearOk = (m: T, y: string) =>
      m.year === y || m.title.includes(y) || m.url.includes(y);

    const exact = matches.filter((m) => yearOk(m, params.year!));
    if (exact.length > 0) {
      matches = exact;
    } else {
      // TMDB and site years are often off by one (different release dates,
      // premiere vs. festival year) — fall back to ±1 when no exact hit
      const y = parseInt(params.year, 10);
      if (Number.isFinite(y)) {
        const near = matches.filter(
          (m) => yearOk(m, String(y - 1)) || yearOk(m, String(y + 1))
        );
        if (near.length > 0) matches = near;
      }
    }
  }

  return matches.sort((a, b) => a.title.length - b.title.length);
}

function normalize(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
}
