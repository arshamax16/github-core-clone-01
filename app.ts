// app.ts — the HTTP server: routing, bearer auth, JSON body parsing, request ids,
// and the /healthz boot probe. All routes answer JSON (never HTML); git routes answer
// the smart-HTTP content types the git client expects.

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { Store, VIEWER_LOGIN } from './store.ts';
import { handleRest, RestError } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  advertisementUploadPack,
  advertisementReceivePack,
  advertisementV2,
  handleUploadPack,
  handleReceivePack,
} from './gitproto.ts';

export interface AppOptions {
  /** The bearer token to accept; '' accepts any non-empty bearer token (local dev). */
  expectedToken: string;
}

let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return `req-${Date.now().toString(36)}-${requestCounter.toString(36)}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = body === null ? '' : JSON.stringify(body);
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': requestId(),
    'x-oauth-scopes': 'repo, read:org',
    ...extraHeaders,
  };
  if (body !== null) headers['content-length'] = String(Buffer.byteLength(text));
  res.writeHead(status, headers);
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(body.length),
    'x-github-request-id': requestId(),
  });
  res.end(body);
}

async function readBody(req: IncomingMessage, maxBytes = 32 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > maxBytes) throw new Error('request body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function checkAuth(req: IncomingMessage, expectedToken: string): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (token === '') return false;
  if (expectedToken === '') return true;
  return token === expectedToken;
}

function decodeSegments(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((s) => s !== '')
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
}

export function createApp(store: Store, options: AppOptions): Server {
  const expectedToken = options.expectedToken;
  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((e: unknown) => {
      try {
        const message = e instanceof Error ? e.message : 'Internal Server Error';
        sendJson(res, 500, { message });
      } catch {
        // The peer went away; nothing to write.
      }
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://entry');
    } catch {
      sendJson(res, 400, { message: 'Bad Request' });
      return;
    }
    const pathname = url.pathname;
    const segments = decodeSegments(pathname);

    // The boot probe: no auth.
    if (pathname === '/healthz' && method === 'GET') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // ---- git smart HTTP: /{owner}/{repo}.git/...
    if (segments.length >= 2 && (segments[1] as string).endsWith('.git')) {
      const owner = segments[0] as string;
      const repoName = (segments[1] as string).slice(0, -'.git'.length);
      if (!checkAuth(req, expectedToken)) {
        sendJson(res, 401, { message: 'Requires authentication' });
        return;
      }
      if (owner !== VIEWER_LOGIN) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      const tail = segments.slice(2);
      if (method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
        const service = url.searchParams.get('service');
        if (service === 'git-upload-pack') {
          const version2 = (req.headers['git-protocol'] ?? '') === 'version=2';
          const out = version2 ? advertisementV2() : advertisementUploadPack(repo);
          sendBuffer(res, out.status, out.contentType, out.body);
          return;
        }
        if (service === 'git-receive-pack') {
          const out = advertisementReceivePack(repo);
          sendBuffer(res, out.status, out.contentType, out.body);
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      if (method === 'POST' && tail.length === 1 && tail[0] === 'git-upload-pack') {
        const body = await readBody(req);
        const version2 = (req.headers['git-protocol'] ?? '') === 'version=2';
        const out = handleUploadPack(repo, body, version2);
        sendBuffer(res, out.status, out.contentType, out.body);
        return;
      }
      if (method === 'POST' && tail.length === 1 && tail[0] === 'git-receive-pack') {
        const body = await readBody(req);
        const out = handleReceivePack(repo, body);
        sendBuffer(res, out.status, out.contentType, out.body);
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    // ---- GraphQL
    if (pathname === '/api/graphql') {
      if (method !== 'POST') {
        sendJson(res, 405, { message: 'Method Not Allowed' });
        return;
      }
      if (!checkAuth(req, expectedToken)) {
        sendJson(res, 401, { message: 'Requires authentication' });
        return;
      }
      const raw = await readBody(req);
      let parsed: unknown;
      try {
        parsed = raw.length === 0 ? {} : JSON.parse(raw.toString('utf8'));
      } catch {
        sendJson(res, 400, { message: 'Invalid JSON body' });
        return;
      }
      const out = handleGraphQL(store, parsed);
      sendJson(res, 200, out);
      return;
    }

    // ---- MCP
    if (pathname === '/mcp') {
      if (method === 'DELETE') {
        sendJson(res, 405, { message: 'Method Not Allowed' });
        return;
      }
      if (method !== 'POST') {
        sendJson(res, 405, { message: 'Method Not Allowed' });
        return;
      }
      if (!checkAuth(req, expectedToken)) {
        sendJson(res, 401, { message: 'Requires authentication' });
        return;
      }
      const raw = await readBody(req);
      const out = handleMcp(store, raw.toString('utf8'));
      if (out.body === null) {
        res.writeHead(out.status, { 'x-github-request-id': requestId() });
        res.end();
        return;
      }
      sendJson(res, out.status, out.body);
      return;
    }

    // ---- REST v3
    if (segments[0] === 'api' && segments[1] === 'v3') {
      if (!checkAuth(req, expectedToken)) {
        sendJson(res, 401, { message: 'Requires authentication' });
        return;
      }
      let parsed: unknown = null;
      if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
        const raw = await readBody(req);
        if (raw.length > 0) {
          try {
            parsed = JSON.parse(raw.toString('utf8'));
          } catch {
            sendJson(res, 400, { message: 'Invalid JSON body' });
            return;
          }
        }
      }
      try {
        const { result, link } = handleRest({
          store,
          method,
          segments: segments.slice(2),
          query: url.searchParams,
          body: parsed,
          host: req.headers.host ?? '127.0.0.1',
          path: pathname,
        });
        const extra: Record<string, string> = {};
        if (link !== undefined && link !== '') extra.link = link;
        sendJson(res, result.status, result.body, extra);
      } catch (e) {
        if (e instanceof RestError) {
          sendJson(res, e.status, { message: e.message });
        } else {
          throw e;
        }
      }
      return;
    }

    // ---- anything else
    sendJson(res, 404, { message: 'Not Found' });
  }

  return server;
}
