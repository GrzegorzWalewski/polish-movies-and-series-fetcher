#!/usr/bin/env node
import { Command } from 'commander';
import * as p from '@clack/prompts';
import {
  searchTmdbCandidates,
  resolveMediaDetails,
  resolveAbsoluteEpisode,
  TmdbAuthError,
  type TmdbSearchCandidate,
} from './tmdb.js';
import { providers } from './providers/registry.js';
import { safeProviderSearch } from './utils/cloudflare.js';
import { loadEnvFile } from './utils/env.js';
import type { MediaResult, StreamResult } from './types.js';

const program = new Command();

program
  .name('msf')
  .description('Search movies/series (TMDB) and fetch stream links from Polish streaming sites')
  .version('1.0.0');

program
  .command('search')
  .description('Search TMDB and list available stream links from providers')
  .argument('<query>', 'movie or series title (PL or EN)')
  .option('-s, --season <number>', 'season number (series)')
  .option('-e, --episode <number>', 'episode number (series)')
  .option('-p, --pick <number>', 'pick the Nth TMDB result non-interactively (1-based)')
  .action(
    async (query: string, opts: { season?: string; episode?: string; pick?: string }) => {
    loadEnvFile();
    p.intro('movies-series-fetcher');

    try {
      const s = p.spinner();
      s.start(`Searching TMDB for "${query}"...`);
      const candidates = await searchTmdbCandidates(query);
      s.stop(`Found ${candidates.length} TMDB results`);

      if (candidates.length === 0) {
        p.outro('No results.');
        return;
      }

      let selected: TmdbSearchCandidate | undefined;
      if (opts.pick) {
        const idx = Number(opts.pick) - 1;
        selected = candidates[idx];
        if (!selected) {
          p.cancel(`--pick ${opts.pick} is out of range (1-${candidates.length}).`);
          return;
        }
      } else {
        const chosen = await p.select({
          message: 'Select a result',
          options: candidates.slice(0, 15).map((c) => ({
            value: c,
            label: `${c.title}${c.year ? ` (${c.year})` : ''} [${c.type === 'movie' ? 'film' : 'serial'}]`,
            hint: c.rating != null ? `★ ${c.rating.toFixed(1)}` : undefined,
          })),
        });
        if (p.isCancel(chosen)) {
          p.cancel('Cancelled.');
          return;
        }
        selected = chosen;
      }

      s.start('Resolving details (imdb_id, runtime)...');
      const media = await resolveMediaDetails(selected);
      s.stop();

      printMedia(media);

      let season: number | undefined;
      let episode: number | undefined;
      if (media.type === 'tv') {
        if (opts.season && opts.episode) {
          season = Number(opts.season);
          episode = Number(opts.episode);
        } else {
          const sIn = await p.text({ message: 'Season number:', placeholder: '1' });
          if (p.isCancel(sIn)) { p.cancel('Cancelled.'); return; }
          const eIn = await p.text({ message: 'Episode number:', placeholder: '1' });
          if (p.isCancel(eIn)) { p.cancel('Cancelled.'); return; }
          season = Number(sIn);
          episode = Number(eIn);
          if (!Number.isInteger(season) || !Number.isInteger(episode) || season < 1 || episode < 1) {
            p.cancel('Invalid season/episode.');
            return;
          }
        }
      }

      // Some sites (telekino.top) number episodes continuously across
      // seasons — resolve the absolute episode number from TMDB
      let absoluteEpisode: number | undefined;
      if (season && episode) {
        if (season === 1) {
          absoluteEpisode = episode;
        } else {
          s.start('Resolving absolute episode number...');
          absoluteEpisode =
            (await resolveAbsoluteEpisode(media.tmdbId, season, episode)) ??
            episode;
          s.stop();
        }
      }

      p.log.step(
        `Checking ${providers.length} providers (${providers.map((x) => x.name).join(', ')})...`
      );

      const attempts = await Promise.all(
        providers.map((prov) =>
          safeProviderSearch(
            prov.name,
            () =>
              prov.search({
                imdbId: media.imdbId,
                type: media.type,
                title: media.plTitle,
                originalTitle: media.originalTitle,
                year: media.year,
                runtimeMinutes: media.runtimeMinutes,
                season,
                episode,
                absoluteEpisode,
              }),
            // filman's token endpoint has a ~1-2min rate-limit cooldown that
            // the provider waits out — give it room
            120000
          )
        )
      );

      printResults(attempts);
    } catch (err) {
      if (err instanceof TmdbAuthError) {
        p.log.error(err.message);
        p.outro('Set TMDB_READ_TOKEN and try again.');
      } else {
        p.log.error(err instanceof Error ? err.message : String(err));
        p.outro('Failed.');
      }
      process.exitCode = 1;
    }
  });

program.parse();

function printMedia(media: MediaResult): void {
  p.log.info(
    [
      media.plTitle,
      media.originalTitle !== media.plTitle ? `(${media.originalTitle})` : null,
      media.year,
      media.runtimeMinutes ? `${media.runtimeMinutes} min` : null,
      media.imdbId ? `[${media.imdbId}]` : '[no imdb id]',
    ]
      .filter(Boolean)
      .join(' ')
  );
}

function printResults(
  attempts: { provider: string; results: StreamResult[]; warning?: string }[]
): void {
  const all: StreamResult[] = [];

  for (const attempt of attempts) {
    if (attempt.warning) {
      p.log.warn(attempt.warning);
    }
    all.push(...attempt.results);
  }

  if (all.length === 0) {
    p.outro('No stream links found.');
    return;
  }

  p.outro(`Found ${all.length} stream link(s):\n`);
  console.log(formatTable(all));
}

function formatTable(rows: StreamResult[]): string {
  const headers = ['provider', 'quality', 'language', 'url'];
  const cell = (r: StreamResult, key: 'provider' | 'quality' | 'language') =>
    (key === 'language' ? r.language : key === 'quality' ? r.quality : r.provider) ?? '-';
  const data = rows.map((r) => [
    cell(r, 'provider'),
    cell(r, 'quality'),
    cell(r, 'language'),
    r.url,
  ]);

  const widths = headers.map((h, i) =>
    Math.max(h.length, ...data.map((d) => d[i].length))
  );
  const line = (l: string, m: string, rr: string) => l + widths.map((w) => '─'.repeat(w)).join(m) + rr;

  const row = (d: string[]) =>
    d.map((c, i) => c.padEnd(widths[i])).join(' │ ');

  return [
    line('┌', '┬', '┐'),
    row(headers),
    line('├', '┼', '┤'),
    ...data.map((d) => row(d)),
    line('└', '┴', '┘'),
  ].join('\n');
}
