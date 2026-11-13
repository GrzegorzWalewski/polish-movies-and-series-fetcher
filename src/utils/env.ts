import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Minimal .env loader (KEY=VALUE lines, # comments). Values already present
 * in the environment are never overwritten. Called once at CLI startup.
 */
export function loadEnvFile(path = join(process.cwd(), '.env')): void {
  let content: string;
  try {
    content = readFileSync(path, 'utf-8');
  } catch {
    return;
  }
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}
