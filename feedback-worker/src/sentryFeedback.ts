// Each report also goes to Sentry's User Feedback (when SENTRY_DSN is set), so
// maintainers see and get alerted about reports where they see errors. Only
// what the user wrote and the environment go to Sentry; the bundle (the
// student's code) stays in R2, reached by a signed download link (when
// LINK_KEY is set).
import type { Report } from './validate';

export interface Dsn { origin: string; publicKey: string; projectId: string; raw: string }

export function parseDsn(dsn: string): Dsn | undefined {
  try {
    const u = new URL(dsn);
    const projectId = u.pathname.replace(/^\/+|\/+$/g, '');
    if (!u.username || !/^\d+$/.test(projectId)) return undefined;
    return { origin: `${u.protocol}//${u.host}`, publicKey: u.username, projectId, raw: dsn };
  } catch {
    return undefined;
  }
}

export function envelopeUrl(d: Dsn): string {
  return `${d.origin}/api/${d.projectId}/envelope/?sentry_key=${encodeURIComponent(d.publicKey)}&sentry_version=7`;
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

/** HMAC-SHA256 of a report file's path: the signature in its download link. */
export async function sign(key: string, path: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(path)));
}

export async function verify(key: string, path: string, sig: string): Promise<boolean> {
  const want = await sign(key, path);
  let diff = want.length ^ sig.length;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ (sig.charCodeAt(i) || 0);
  return diff === 0;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A Sentry envelope holding one user feedback item. */
export function feedbackEnvelope(d: Dsn, id: string, report: Report, links: { report?: string; bundle?: string },
                                 now = new Date()): string {
  const eventId = crypto.randomUUID().replace(/-/g, '');
  const env = report.environment as Record<string, unknown>;
  const lines = [
    `[${report.kind}] ${report.summary}`,
    '',
    report.description || '(no description)',
    '',
    `Report: ${id}`,
    ...(links.report ? [`report.json: ${links.report}`] : []),
    ...(links.bundle ? [`bundle.zip (log, project): ${links.bundle}`] : []),
  ];
  const contact = report.contact.trim();
  const item = {
    event_id: eventId,
    timestamp: now.getTime() / 1000,
    platform: 'javascript',
    level: 'info',
    release: typeof env.extension === 'string' ? `v5sim-vscode@${env.extension}` : undefined,
    environment: 'production',
    // without it Sentry shows the SDK as <invalid>
    sdk: { name: 'v5sim.feedback-worker', version: '1.0.0' },
    tags: {
      kind: report.kind,
      report: id,
      ...(typeof env.platform === 'string' ? { os: env.platform } : {}),
      ...(typeof env.vscode === 'string' ? { vscode: env.vscode } : {}),
    },
    contexts: {
      feedback: {
        message: lines.join('\n').slice(0, 4096),
        ...(EMAIL.test(contact) ? { contact_email: contact } : contact ? { name: contact } : {}),
        source: 'v5sim-report-a-problem',
      },
    },
  };
  const body = JSON.stringify(item);
  return [
    JSON.stringify({ event_id: eventId, sent_at: now.toISOString(), dsn: d.raw }),
    JSON.stringify({ type: 'feedback', length: new TextEncoder().encode(body).length }),
    body,
  ].join('\n');
}
