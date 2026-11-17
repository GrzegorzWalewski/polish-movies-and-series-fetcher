/**
 * `msf warm` — pre-solve the Cloudflare challenges of the CF-protected
 * sites, one at a time, so their solved cookies are cached (and persisted
 * via FLARESOLVERR_CACHE_FILE) before any real search needs them.
 *
 * Solves take up to ~80s EACH on weak hardware — that is exactly why this
 * exists: paying it inside a search request looks like a hang, while here
 * it is just a slow batch job. Cron it (e.g. every 12h) on always-on boxes.
 */

import * as p from '@clack/prompts';
import { fetchPage } from './utils/fetcher.js';
import { configured as flaresolverrConfigured } from './utils/flaresolverr.js';
import {
  BASE_URL as FILMAN_BASE,
  autoConfigured as filmanAutoConfigured,
  filmanIdentity,
  filmanOnChallenge,
  loadSessionState,
  type FilmanIdentity,
} from './utils/filman-session.js';
import { CloudflareBlockedError } from './types.js';

export interface WarmOutcome {
  site: string;
  ok: boolean;
  seconds: number;
  note: string;
}

async function timed(name: string, run: () => Promise<string>): Promise<WarmOutcome> {
  const t0 = performance.now();
  try {
    const note = await run();
    return { site: name, ok: true, seconds: (performance.now() - t0) / 1000, note };
  } catch (err) {
    return {
      site: name,
      ok: false,
      seconds: (performance.now() - t0) / 1000,
      note: err instanceof Error ? err.message : String(err),
    };
  }
}

/** filman keeps its own identity (session cookies + solver UA); a fetch with
 * those headers is identity-owned, so a challenge must be handled by the
 * dedicated refresh flow, not fetchPage's auto-solve. */
async function warmFilman(): Promise<string> {
  if (!loadSessionState()) {
    if (!filmanAutoConfigured()) {
      return 'skipped: no filman session and auto-session not configured';
    }
    return 'skipped: no session yet — run any filman search once to bootstrap the login';
  }
  const identity: FilmanIdentity | null = await filmanIdentity();
  if (!identity) return 'skipped: no identity available';

  const opts = {
    headers: { Cookie: identity.cookie, 'User-Agent': identity.ua },
    site: 'filman.cc',
    retries: 0,
  };
  try {
    await fetchPage(`${FILMAN_BASE}/`, opts);
    return 'ok (existing clearance still valid)';
  } catch (err) {
    if (!(err instanceof CloudflareBlockedError)) throw err;
    const refreshed = await filmanOnChallenge();
    if (!refreshed) throw new Error('clearance refresh failed');
    await fetchPage(`${FILMAN_BASE}/`, {
      ...opts,
      headers: { Cookie: refreshed.cookie, 'User-Agent': refreshed.ua },
    });
    return 'ok (clearance refreshed)';
  }
}

export async function warmCfSites(): Promise<WarmOutcome[]> {
  const out: WarmOutcome[] = [];

  if (!flaresolverrConfigured()) {
    return [
      {
        site: '-',
        ok: false,
        seconds: 0,
        note: 'FLARESOLVERR_URL is not set — nothing to warm',
      },
    ];
  }

  const s = p.spinner();

  s.start('zaluknij.cc: fetching homepage (solves CF if challenged)...');
  out.push(
    await timed('zaluknij.cc', async () => {
      await fetchPage('https://zaluknij.cc/', { site: 'zaluknij.cc', retries: 0 });
      return 'ok';
    })
  );
  s.stop(
    `${out[0].ok ? '✓' : '✗'} zaluknij.cc — ${out[0].seconds.toFixed(0)}s ${out[0].note}`
  );

  s.start('cda-hd.cc: fetching homepage (solves CF if challenged)...');
  out.push(
    await timed('cda-hd.cc', async () => {
      await fetchPage('https://cda-hd.cc/', { site: 'cda-hd.cc', retries: 0 });
      return 'ok';
    })
  );
  s.stop(
    `${out[1].ok ? '✓' : '✗'} cda-hd.cc — ${out[1].seconds.toFixed(0)}s ${out[1].note}`
  );

  s.start('filmyonline.cc: fetching homepage (solves CF if challenged)...');
  out.push(
    await timed('filmyonline.cc', async () => {
      await fetchPage('https://filmyonline.cc/', {
        site: 'filmyonline.cc',
        retries: 0,
      });
      return 'ok';
    })
  );
  s.stop(
    `${out[out.length - 1].ok ? '✓' : '✗'} filmyonline.cc — ${
      out[out.length - 1].seconds.toFixed(0)
    }s ${out[out.length - 1].note}`
  );

  s.start('filman.cc: checking session clearance...');
  out.push(await timed('filman.cc', warmFilman));
  s.stop(
    `${out[2].ok ? '✓' : '✗'} filman.cc — ${out[2].seconds.toFixed(0)}s ${out[2].note}`
  );

  return out;
}
