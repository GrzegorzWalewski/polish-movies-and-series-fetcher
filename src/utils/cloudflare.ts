import { CloudflareBlockedError } from '../types.js';

export interface ProviderAttempt<T> {
  provider: string;
  results: T[];
  warning?: string;
}

/**
 * Runs one provider search, converting every failure mode into a warning
 * so a single dead/blocked site never crashes the whole run:
 *  - Cloudflare challenge -> clear message (FlareSolverr hook planned)
 *  - timeout              -> "timeout"
 *  - any other error      -> error message
 */
export async function safeProviderSearch<T>(
  providerName: string,
  fn: () => Promise<T[]>,
  timeoutMs = 60000
): Promise<ProviderAttempt<T>> {
  try {
    const results = await withTimeout(fn(), timeoutMs, providerName);
    return { provider: providerName, results };
  } catch (err) {
    let warning: string;
    if (err instanceof CloudflareBlockedError) {
      warning = `${providerName}: ${err.message}`;
    } else if (err instanceof ProviderTimeoutError) {
      warning = `${providerName}: timed out after ${timeoutMs / 1000}s`;
    } else {
      warning = `${providerName}: ${err instanceof Error ? err.message : String(err)}`;
    }
    return { provider: providerName, results: [], warning };
  }
}

export class ProviderTimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number, who: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new ProviderTimeoutError(`${who} timed out`)),
      ms
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}
