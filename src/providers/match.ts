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
export function pickMatches(
  results: SiteMatch[],
  params: ProviderSearchParams
): SiteMatch[] {
  let matches = results.filter((r) => matchesQuery(r.title, cleanTitle(params.title)));

  if (params.year && matches.length > 1) {
    const withYear = matches.filter(
      (m) =>
        m.year === params.year ||
        m.title.includes(params.year) ||
        m.url.includes(params.year)
    );
    if (withYear.length > 0) matches = withYear;
  }

  return matches.sort((a, b) => a.title.length - b.title.length);
}

function normalize(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
}
