// V5 Sim feedback intake. The extension POSTs a report (JSON) and, if the
// user agreed, a zip bundle (log, environment, project folder) as
// multipart/form-data to /report. Reports land in R2 under
// reports/<yyyy-mm-dd>/<uuid>/; maintainers read them through /admin with a
// bearer token (scripts/reports.mjs).

import { MAX_BUNDLE_BYTES, MAX_REQUEST_BYTES, ZIP_MAGIC, parseReport } from './validate';

export interface Env {
  REPORTS: R2Bucket;
  LIMITER: RateLimit;
  /** all senders together: caps what can be stored in a day */
  GLOBAL_LIMITER: RateLimit;
  ADMIN_TOKEN?: string;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fail = (status: number, error: string) => json(status, { ok: false, error });

async function intake(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const { success } = await env.LIMITER.limit({ key: ip });
  if (!success) return fail(429, 'too many reports from here; try again in a minute');

  const length = Number(request.headers.get('content-length') ?? NaN);
  if (!Number.isFinite(length)) return fail(411, 'content-length required');
  if (length > MAX_REQUEST_BYTES) return fail(413, 'report is too large');
  if (!(request.headers.get('content-type') ?? '').startsWith('multipart/form-data')) {
    return fail(415, 'expected multipart/form-data');
  }

  let form: FormData;
  try { form = await request.formData(); } catch { return fail(400, 'could not read the form'); }
  const report = parseReport(form.get('report'));
  if (typeof report === 'string') return fail(400, report);

  const bundle = form.get('bundle');
  let bytes: ArrayBuffer | undefined;
  if (bundle !== null) {
    if (typeof bundle === 'string') return fail(400, 'bundle must be a file');
    if (bundle.size > MAX_BUNDLE_BYTES) return fail(413, 'bundle is too large');
    bytes = await bundle.arrayBuffer();
    const head = new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength));
    if (head.length < 4 || ZIP_MAGIC.some((b, i) => head[i] !== b)) return fail(400, 'bundle is not a zip');
  }
  // all senders together, counting only reports that would be stored, so
  // junk from a few addresses can't use up everyone's share
  if (!(await env.GLOBAL_LIMITER.limit({ key: 'all' })).success) {
    return fail(429, 'the feedback server is busy; try again in a minute');
  }

  const now = new Date();
  const id = `${now.toISOString().slice(0, 10)}/${crypto.randomUUID()}`;
  const meta = {
    id,
    receivedAt: now.toISOString(),
    country: (request as any).cf?.country ?? null,
    userAgent: request.headers.get('user-agent')?.slice(0, 200) ?? null,
    bundleBytes: bytes?.byteLength ?? 0,
  };
  const prefix = `reports/${id}/`;
  if (bytes) {
    await env.REPORTS.put(`${prefix}bundle.zip`, bytes, { httpMetadata: { contentType: 'application/zip' } });
  }
  await env.REPORTS.put(`${prefix}report.json`, JSON.stringify({ ...meta, ...report }, null, 2), {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { kind: report.kind, summary: report.summary.slice(0, 200) },
  });
  return json(201, { ok: true, id });
}

/** Constant-time compare, so the token can't be guessed byte by byte. */
function sameToken(given: string, want: string): boolean {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(want);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

async function admin(request: Request, env: Env, rest: string): Promise<Response> {
  const auth = request.headers.get('authorization') ?? '';
  if (!env.ADMIN_TOKEN || !sameToken(auth, `Bearer ${env.ADMIN_TOKEN}`)) return fail(401, 'unauthorized');
  if (request.method !== 'GET') return fail(405, 'GET only');
  const url = new URL(request.url);
  if (rest === '' || rest === '/') {
    const listed = await env.REPORTS.list({
      prefix: `reports/${url.searchParams.get('day') ?? ''}`,
      cursor: url.searchParams.get('cursor') ?? undefined,
      include: ['customMetadata'],
      limit: 500,
    });
    const reports = listed.objects
      .filter(o => o.key.endsWith('/report.json'))
      .map(o => ({ id: o.key.slice('reports/'.length, -'/report.json'.length), uploaded: o.uploaded,
        ...o.customMetadata }));
    return json(200, { reports, cursor: listed.truncated ? listed.cursor : null });
  }
  const m = /^\/(\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36})\/(report\.json|bundle\.zip)$/.exec(rest);
  if (!m) return fail(404, 'not found');
  const obj = await env.REPORTS.get(`reports/${m[1]}/${m[2]}`);
  if (!obj) return fail(404, 'not found');
  return new Response(obj.body, { headers: { 'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream' } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    try {
      if (pathname === '/report') {
        return request.method === 'POST' ? await intake(request, env) : fail(405, 'POST only');
      }
      if (pathname === '/admin' || pathname.startsWith('/admin/reports')) {
        return await admin(request, env, pathname.replace(/^\/admin(\/reports)?/, ''));
      }
      if (pathname === '/') return json(200, { ok: true, service: 'v5sim-feedback' });
      return fail(404, 'not found');
    } catch (e) {
      console.error('feedback worker error', e);
      return fail(500, 'internal error');
    }
  },
} satisfies ExportedHandler<Env>;
