/**
 * 2Captcha client — reCAPTCHA v2 Enterprise token solving (proxyless).
 *
 * Used by the filman auto-session flow: filman's login form is gated by a
 * visible reCAPTCHA Enterprise checkbox, which FlareSolverr cannot solve.
 */

const API = 'https://api.2captcha.com';
const POLL_INTERVAL_MS = 5000;

export interface TwoCaptchaResult {
  /** gRecaptchaResponse token, null when the job failed */
  token: string | null;
  /** error code / description, null on success */
  error: string | null;
}

/** Pure: interpret a getTaskResult response body. */
export function parseTaskResult(json: unknown): TwoCaptchaResult {
  if (typeof json !== 'object' || json === null) {
    return { token: null, error: 'invalid response' };
  }
  const obj = json as Record<string, unknown>;
  if (obj.errorId !== 0 && obj.errorId !== undefined) {
    return {
      token: null,
      error: [obj.errorCode, obj.errorDescription].filter(Boolean).join(': ') || 'unknown error',
    };
  }
  if (obj.status === 'ready') {
    const solution = obj.solution as Record<string, unknown> | undefined;
    const token = solution?.gRecaptchaResponse;
    if (typeof token === 'string' && token) return { token, error: null };
    return { token: null, error: 'ready response without token' };
  }
  // still processing
  return { token: null, error: null };
}

/** Pure: the createTask body for a proxyless reCAPTCHA v2 Enterprise job. */
export function buildCreateTaskBody(
  clientKey: string,
  sitekey: string,
  url: string
): Record<string, unknown> {
  return {
    clientKey,
    task: {
      type: 'RecaptchaV2EnterpriseTaskProxyless',
      websiteURL: url,
      websiteKey: sitekey,
    },
  };
}

/**
 * Solve a reCAPTCHA v2 Enterprise challenge and return the token.
 * Typical solve time 15-60s; resolves within ~timeoutMs or throws.
 */
export async function solveRecaptchaEnterprise(
  clientKey: string,
  sitekey: string,
  url: string,
  timeoutMs = 120000
): Promise<string> {
  const createRes = await fetch(`${API}/createTask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildCreateTaskBody(clientKey, sitekey, url)),
    signal: AbortSignal.timeout(30000),
  });
  const created = (await createRes.json()) as { errorId?: number; errorCode?: string; taskId?: number };
  if (created.errorId !== 0 || !created.taskId) {
    throw new Error(`2captcha createTask failed: ${created.errorCode ?? 'unknown'}`);
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const res = await fetch(`${API}/getTaskResult`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey, taskId: created.taskId }),
      signal: AbortSignal.timeout(30000),
    });
    const { token, error } = parseTaskResult(await res.json());
    if (error) throw new Error(`2captcha: ${error}`);
    if (token) return token;
  }
  throw new Error('2captcha: solve timed out');
}
