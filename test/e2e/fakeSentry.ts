// A stand-in for Sentry's ingest on localhost: keeps every envelope and
// hands them back on GET /_events. DSN: http://e2ekey@127.0.0.1:<port>/7
import * as http from 'node:http';

export interface FakeSentry {
  port: number;
  dsn: string;
  url: string;
  /** Each received envelope's event (envelopes of other types left out). */
  events(): any[];
  /** Each received user feedback item. */
  feedback(): any[];
  close(): void;
}

export function parseEnvelope(body: string): any[] {
  return body.split('\n').filter(Boolean).map(l => JSON.parse(l));
}

export function itemsOf(envelopes: string[], type: string): any[] {
  return envelopes.map(parseEnvelope).filter(items => items[1]?.type === type).map(items => items[2]);
}

export const eventsOf = (envelopes: string[]): any[] => itemsOf(envelopes, 'event');

/** port 0: any free one. */
export function startFakeSentry(port = 0): Promise<FakeSentry> {
  const envelopes: string[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/_events') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(envelopes));
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c)).on('end', () => {
      envelopes.push(Buffer.concat(chunks).toString('utf8'));
      res.end('{}');
    });
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => {
    port = (server.address() as { port: number }).port;
    resolve({
      port,
      dsn: `http://e2ekey@127.0.0.1:${port}/7`,
      url: `http://127.0.0.1:${port}`,
      events: () => eventsOf(envelopes),
      feedback: () => itemsOf(envelopes, 'feedback'),
      close: () => server.close(),
    });
  }));
}
