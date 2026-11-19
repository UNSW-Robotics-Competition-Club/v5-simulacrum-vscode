// Checks on what the extension sends. Its own module: a Worker's main
// module may only export handlers.

// the extension's bundle: 10 MB of project, plus a log (512 KB) and zip overhead
export const MAX_REQUEST_BYTES = 14 * 1024 * 1024;
export const MAX_BUNDLE_BYTES = 13 * 1024 * 1024;
const MAX_ENV_JSON = 64 * 1024;
const KINDS = new Set(['bug', 'idea', 'question']);
export const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

export interface Report {
  kind: 'bug' | 'idea' | 'question';
  summary: string;
  description: string;
  contact: string;
  environment: Record<string, unknown>;
}

/** The report field, checked. Returns an error string when it doesn't fit. */
export function parseReport(raw: unknown): Report | string {
  if (typeof raw !== 'string') return 'missing report field';
  let r: any;
  try { r = JSON.parse(raw); } catch { return 'report is not JSON'; }
  if (!r || typeof r !== 'object') return 'report is not an object';
  if (!KINDS.has(r.kind)) return 'kind must be bug, idea or question';
  const str = (v: unknown, max: number, name: string, required = false): string | Error => {
    if (v === undefined || v === null) v = '';
    if (typeof v !== 'string') return new Error(`${name} must be text`);
    if (required && !v.trim()) return new Error(`${name} is required`);
    if (v.length > max) return new Error(`${name} is longer than ${max} characters`);
    return v;
  };
  const summary = str(r.summary, 200, 'summary', true);
  const description = str(r.description, 20000, 'description');
  const contact = str(r.contact, 200, 'contact');
  for (const v of [summary, description, contact]) if (v instanceof Error) return v.message;
  const environment = r.environment ?? {};
  if (typeof environment !== 'object' || Array.isArray(environment)) return 'environment must be an object';
  if (JSON.stringify(environment).length > MAX_ENV_JSON) return 'environment is too large';
  return { kind: r.kind, summary: summary as string, description: description as string,
    contact: contact as string, environment };
}
