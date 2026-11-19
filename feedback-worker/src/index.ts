// V5 Sim feedback intake. The extension POSTs a report (JSON) and, if the
// user agreed, a zip bundle (log, environment, project folder) as
// multipart/form-data to /report. Reports land in R2 under
// reports/<yyyy-mm-dd>/<uuid>/; maintainers read them through /admin with a
// bearer token (scripts/reports.mjs). With SENTRY_DSN set, each report also
// shows up in Sentry's User Feedback, with signed download links (LINK_KEY)
// to its files; the files themselves never go to Sentry.

import { envelopeUrl, feedbackEnvelope, parseDsn, sign, verify } from './sentryFeedback';
import { MAX_BUNDLE_BYTES, MAX_REQUEST_BYTES, type Report, ZIP_MAGIC, parseReport } from './validate';

export interface Env {
  REPORTS: R2Bucket;
  LIMITER: RateLimit;
  /** all senders together: caps what can be stored in a day */
  GLOBAL_LIMITER: RateLimit;
  ADMIN_TOKEN?: string;
  /** Sentry project for user feedback; unset: not forwarded */
  SENTRY_DSN?: string;
  /** key for the download links in Sentry; unset: no links */
  LINK_KEY?: string;
}

/** How long the download links in Sentry work. */
const LINK_LIFETIME_S = 60 * 24 * 3600;

const FILE_PATH =/^(\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36})\/(report\.json|bundle\.zip)$/;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fail = (status: number, error: string) => json(status, { ok: false, error });

async function intake(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
  // after answering: the student doesn't wait on Sentry
  ctx.waitUntil(toSentry(request, env, id, report, !!bytes).catch(e => console.error('sentry feedback failed', e)));
  return json(201, { ok: true, id });
}

async function toSentry(request: Request, env: Env, id: string, report: Report, hasBundle: boolean): Promise<void> {
  const dsn = env.SENTRY_DSN ? parseDsn(env.SENTRY_DSN) : undefined;
  if (!dsn) return;
  const origin = new URL(request.url).origin;
  const exp = Math.floor(Date.now() / 1000) + LINK_LIFETIME_S;
  const link = async (file: string) => {
    if (!env.LINK_KEY) return undefined;
    const path = `${id}/${file}`;
    return `${origin}/d/${path}?exp=${exp}&sig=${await sign(env.LINK_KEY, `${path}|${exp}`)}`;
  };
  const envelope = feedbackEnvelope(dsn, id, report, {
    report: await link('report.json'),
    bundle: hasBundle ? await link('bundle.zip') : undefined,
  });
  const res = await fetch(envelopeUrl(dsn), { method: 'POST', body: envelope,
    headers: { 'content-type': 'application/x-sentry-envelope' } });
  if (!res.ok) throw new Error(`sentry answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/** /d/<day>/<uuid>/<file>?exp=<unix s>&sig=...: a report file through a
 *  signed link, until it expires (after that, /admin). */
async function download(request: Request, env: Env, rest: string): Promise<Response> {
  if (request.method !== 'GET') return fail(405, 'GET only');
  const m = FILE_PATH.exec(rest);
  const q = new URL(request.url).searchParams;
  const exp = q.get('exp') ?? '';
  const sig = q.get('sig') ?? '';
  if (!/^\d{1,12}$/.test(exp) || Number(exp) < Date.now() / 1000) return fail(410, 'this link has expired');
  if (!m || !env.LINK_KEY || !(await verify(env.LINK_KEY, `${rest}|${exp}`, sig))) return fail(404, 'not found');
  const obj = await env.REPORTS.get(`reports/${rest}`);
  if (!obj) return fail(404, 'not found');
  return new Response(obj.body, { headers: {
    'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
    'content-disposition': `attachment; filename="v5sim-${m[1].replace('/', '-')}-${m[2]}"`,
    'cache-control': 'private, no-store',
  } });
}

const REPORT_ID = /^\/(\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36})$/;

/** DELETE /admin/reports/<day>/<uuid>: a report and its bundle, for good
 *  (a deletion request). Its download links stop working with it; a copy
 *  forwarded to Sentry's User Feedback has to be deleted there. */
async function deleteReport(env: Env, rest: string): Promise<Response> {
  const m = REPORT_ID.exec(rest);
  if (!m) return fail(404, 'not found');
  const keys = [`reports/${m[1]}/report.json`, `reports/${m[1]}/bundle.zip`];
  const found = (await Promise.all(keys.map(k => env.REPORTS.head(k)))).map((o, i) => (o ? keys[i] : undefined))
    .filter((k): k is string => !!k);
  if (!found.length) return fail(404, 'not found');
  await env.REPORTS.delete(found);
  return json(200, { ok: true, deleted: found.map(k => k.slice('reports/'.length)) });
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
  if (request.method === 'DELETE') return await deleteReport(env, rest);
  if (request.method !== 'GET') return fail(405, 'GET or DELETE only');
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
  const m = FILE_PATH.exec(rest.slice(1));
  if (!m) return fail(404, 'not found');
  const obj = await env.REPORTS.get(`reports/${m[1]}/${m[2]}`);
  if (!obj) return fail(404, 'not found');
  return new Response(obj.body, { headers: { 'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream' } });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);
    try {
      if (pathname === '/report') {
        return request.method === 'POST' ? await intake(request, env, ctx) : fail(405, 'POST only');
      }
      if (pathname.startsWith('/d/')) return await download(request, env, pathname.slice(3));
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
