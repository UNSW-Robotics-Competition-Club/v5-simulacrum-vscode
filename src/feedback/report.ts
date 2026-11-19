// A feedback report: what the user wrote, plus (if they agree) the
// environment and log, and what goes into the zip bundle. No vscode import:
// the tests run this under plain Node.
import type { ZipEntry } from './zip';
import type { ProjectRead } from './projectFiles';

export type Kind = 'bug' | 'idea' | 'question';
export const KINDS: readonly Kind[] = ['bug', 'idea', 'question'];

/** Same limits as the Worker's (feedback-worker/src/index.ts). */
export const FIELD_LIMITS = { summary: 200, description: 20000, contact: 200 };

export interface FeedbackForm {
  kind: Kind;
  summary: string;
  description: string;
  contact: string;
  includeLog: boolean;
  includeProject: boolean;
}

export interface Report {
  kind: Kind;
  summary: string;
  description: string;
  contact: string;
  environment: Record<string, unknown>;
}

/** The form from the webview, checked. Anything malformed is an error. */
export function readForm(m: unknown): FeedbackForm | string {
  if (!m || typeof m !== 'object') return 'No form.';
  const f = m as Record<string, unknown>;
  if (!KINDS.includes(f.kind as Kind)) return 'Pick what kind of feedback this is.';
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  const summary = text(f.summary).trim();
  const description = text(f.description).trim();
  const contact = text(f.contact).trim();
  if (!summary) return 'Write a short summary.';
  if (summary.length > FIELD_LIMITS.summary) return `The summary is longer than ${FIELD_LIMITS.summary} characters.`;
  if (description.length > FIELD_LIMITS.description) return `The description is longer than ${FIELD_LIMITS.description} characters.`;
  if (contact.length > FIELD_LIMITS.contact) return `The contact is longer than ${FIELD_LIMITS.contact} characters.`;
  return { kind: f.kind as Kind, summary, description, contact,
    includeLog: f.includeLog === true, includeProject: f.includeProject === true };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Takes the user's identity out of text (logs, settings, messages):
 *  - their home folder becomes ~;
 *  - the account folder in any home path (C:\Users\x, /Users/x, /home/x,
 *    /mnt/c/Users/x) becomes <user>: WSL's Linux user need not be the
 *    Windows one;
 *  - the computer's name (host) becomes <host>, and the user name on its
 *    own (as a whole word, 3+ characters) <user>, e.g. in "jane@JANE-PC:". */
export function redact(text: string, home: string, user: string, host = ''): string {
  let out = text;
  const homes = new Set([home, home.replace(/\\/g, '/'), home.replace(/\//g, '\\')].filter(h => h.length > 3));
  // not /Users/kevinb for /Users/kevin
  for (const h of homes) out = out.replace(new RegExp(`${escapeRe(h)}(?![\\w.-])`, 'gi'), '~');
  out = out.replace(/([\\/](?:Users|home)[\\/])(?!<user>)[^\\/\s'"`)<>:]+/gi, '$1<user>');
  if (host.length > 1) out = out.replace(new RegExp(`(?<![\\w.-])${escapeRe(host)}(?![\\w-])`, 'gi'), '<host>');
  if (user.length > 2) out = out.replace(new RegExp(`(?<![\\w.-])${escapeRe(user)}(?![\\w-])`, 'gi'), '<user>');
  return out;
}

/** Recursively redacts every string in a JSON value. */
export function redactValue<T>(value: T, home: string, user: string, host = ''): T {
  if (typeof value === 'string') return redact(value, home, user, host) as T;
  if (Array.isArray(value)) return value.map(v => redactValue(v, home, user, host)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactValue(v, home, user, host)])) as T;
  }
  return value;
}

export function buildReport(form: FeedbackForm, environment: Record<string, unknown>): Report {
  return {
    kind: form.kind,
    summary: form.summary,
    description: form.description,
    contact: form.contact,
    environment: form.includeLog ? environment : {},
  };
}

/** The zip's files: report.json, log.txt and project/... as chosen. */
export function bundleEntries(report: Report, log: string | undefined, project: ProjectRead | undefined): ZipEntry[] {
  const entries: ZipEntry[] = [{ name: 'report.json', data: JSON.stringify(report, null, 2) }];
  if (log !== undefined) entries.push({ name: 'log.txt', data: log });
  if (project) {
    entries.push({ name: 'project-skipped.txt',
      data: project.skipped.map(s => `${s.rel}\t${s.reason}`).join('\n') + '\n' });
    for (const f of project.files) entries.push({ name: `project/${f.rel}`, data: f.data });
  }
  return entries;
}

/** GitHub refuses new-issue URLs much over 8 KB; this leaves room. */
const GITHUB_URL_MAX = 7500;

/** A prefilled "new issue" page, for when the report can't be uploaded.
 *  The description is cut short so the encoded URL stays under the limit
 *  (non-ASCII text grows several times when encoded). */
export function githubIssueUrl(repo: string, report: Report, bundleName?: string): string {
  const env = Object.entries(report.environment)
    .filter(([, v]) => typeof v !== 'object' || v === null)
    .map(([k, v]) => `- ${k}: ${String(v)}`).join('\n');
  const make = (description: string, cut: boolean) => {
    const body = [
      `**Kind:** ${report.kind}`,
      '',
      description || '_(no description)_',
      ...(cut ? ['', '_(cut short; the rest is in the attached zip)_'] : []),
      ...(env ? ['', '<details><summary>Environment</summary>', '', env, '', '</details>'] : []),
      ...(bundleName ? ['', `_Please attach **${bundleName}** (saved by V5 Sim: Report a Problem) by dragging it here._`] : []),
    ].join('\n');
    const q = new URLSearchParams({ title: `[${report.kind}] ${report.summary}`, body });
    return `${repo.replace(/\/$/, '')}/issues/new?${q}`;
  };
  const full = make(report.description, false);
  if (full.length <= GITHUB_URL_MAX) return full;
  // the longest start of the description (whole characters) that fits
  const chars = Array.from(report.description);
  const cut = (n: number) => make(chars.slice(0, n).join(''), true);
  let lo = 0, hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (cut(mid).length <= GITHUB_URL_MAX) lo = mid;
    else hi = mid - 1;
  }
  return cut(lo);
}
