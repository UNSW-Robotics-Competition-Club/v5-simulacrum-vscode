// Sends a report to the feedback Worker (feedback-worker/) as
// multipart/form-data: `report` (JSON) and, if there is one, `bundle` (zip).
import type { Report } from './report';

export interface SubmitResult { ok: true; id: string }
export class SubmitError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

const TIMEOUT_MS = 60_000;

export async function submitReport(endpoint: string, report: Report, bundle: Buffer | undefined,
                                   userAgent: string, fetchFn: typeof fetch = fetch): Promise<SubmitResult> {
  let url: URL;
  try { url = new URL('report', endpoint.endsWith('/') ? endpoint : `${endpoint}/`); } catch {
    throw new SubmitError(`The feedback address (${endpoint}) is not a URL.`);
  }
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new SubmitError('The feedback address must be https.');
  }
  const form = new FormData();
  form.append('report', JSON.stringify(report));
  if (bundle) form.append('bundle', new Blob([bundle], { type: 'application/zip' }), 'bundle.zip');

  let res: Response;
  try {
    res = await fetchFn(url, { method: 'POST', body: form, headers: { 'user-agent': userAgent },
      signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new SubmitError(`Couldn't reach the feedback server: ${(e as Error).message}`);
  }
  let body: { ok?: boolean; id?: string; error?: string } = {};
  try { body = await res.json() as typeof body; } catch { /* not JSON: fall through on status */ }
  if (!res.ok || !body.ok || typeof body.id !== 'string') {
    throw new SubmitError(body.error ? `The feedback server said: ${body.error}` : `The feedback server answered ${res.status}.`,
      res.status);
  }
  return { ok: true, id: body.id };
}
