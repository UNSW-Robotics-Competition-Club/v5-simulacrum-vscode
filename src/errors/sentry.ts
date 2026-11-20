// A Sentry client for this extension only. The extension host is shared with
// every other extension, so nothing global is touched: no Sentry.init, no
// process-wide handlers, no instrumentation. Only errors passed to capture()
// are sent. This is the one file that imports the Sentry SDK (bundled into
// the package by scripts/bundle-sentry.mjs).
import {
  Scope,
  applySdkMetadata,
  closeSession,
  createStackParser,
  createTransport,
  dedupeIntegration,
  linkedErrorsIntegration,
  makeSession,
  type ErrorEvent,
  type Transport,
  type TransportMakeRequestResponse,
  type TransportRequest,
} from '@sentry/core';
import { ServerRuntimeClient, nodeStackLineParser } from '@sentry/core/server';

export interface SentryOptions {
  dsn: string;
  release: string;
  environment: string;
  /** Last look at every event; return null to drop it. */
  beforeSend: (event: ErrorEvent) => ErrorEvent | null;
  /** For tests: where requests go. */
  fetchFn?: typeof fetch;
}

export interface CaptureContext {
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  fingerprint?: string[];
}

export interface SentryReporter {
  capture(error: Error, context?: CaptureContext): string;
  /** Starts a Release Health session (one per VS Code window): Sentry
   *  counts active installs and crash-free sessions per release from these.
   *  `installId` is an anonymous id for the install; errors captured while
   *  the session runs mark it errored. */
  startSession(installId: string): void;
  /** Ends the session (exited, or errored if an error was captured). */
  endSession(): void;
  flush(timeoutMs?: number): Promise<boolean>;
  close(timeoutMs?: number): Promise<boolean>;
}

const REQUEST_TIMEOUT_MS = 10_000;

function fetchTransport(fetchFn: typeof fetch) {
  return (options: { url: string; recordDroppedEvent: never } & Record<string, unknown>): Transport =>
    createTransport(options as never, async (request: TransportRequest): Promise<TransportMakeRequestResponse> => {
      const res = await fetchFn(options.url, {
        method: 'POST',
        body: request.body as string | Uint8Array,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      return {
        statusCode: res.status,
        headers: {
          'x-sentry-rate-limits': res.headers.get('x-sentry-rate-limits'),
          'retry-after': res.headers.get('retry-after'),
        },
      };
    });
}

export function createSentry(o: SentryOptions): SentryReporter {
  const options = {
    dsn: o.dsn,
    release: o.release,
    environment: o.environment,
    platform: 'node',
    runtime: { name: 'node', version: process.version },
    serverName: '',                    // not the computer's name
    sendDefaultPii: false,
    attachStacktrace: false,
    maxBreadcrumbs: 0,
    stackParser: createStackParser(nodeStackLineParser()),
    integrations: [dedupeIntegration(), linkedErrorsIntegration()],
    transport: fetchTransport(o.fetchFn ?? fetch) as never,
    beforeSend: (event: ErrorEvent) => o.beforeSend(event),
  };
  // the SDK name and version on every event, as Sentry.init would set them
  // (without them Sentry shows the event's SDK as <invalid>)
  applySdkMetadata(options, 'core');
  const client = new ServerRuntimeClient(options);
  client.init();
  const scope = new Scope();
  scope.setClient(client);

  return {
    capture(error, context = {}) {
      const s = scope.clone();
      if (context.tags) s.setTags(context.tags);
      if (context.extra) s.setExtras(context.extra);
      if (context.fingerprint) s.setFingerprint(context.fingerprint);
      return client.captureException(error, { originalException: error }, s);
    },
    startSession(installId) {
      // only the release and environment: no IP address or user agent
      const session = makeSession({ did: installId, release: o.release, environment: o.environment });
      scope.setSession(session);
      client.captureSession(session);
    },
    endSession() {
      const session = scope.getSession();
      if (!session) return;
      closeSession(session);
      client.captureSession(session);
      scope.setSession(undefined);
    },
    flush: timeoutMs => Promise.resolve(client.flush(timeoutMs)),
    close: timeoutMs => Promise.resolve(client.close(timeoutMs)),
  };
}
