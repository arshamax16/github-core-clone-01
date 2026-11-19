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

/**
 * Minimal request/response shapes the handlers need. Both transports (node:http
 * and the raw-socket server in rawhttp.ts) drive the same routing code through
 * these, so a transport only has to parse the request line/headers/body and
 * serialise the reply. `body` on the request is the pre-read body (raw
 * transport); when set, readBody returns it without touching a stream.
 */
export interface HttpReq {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: Buffer;
}

export interface HttpRes {
  writeHead(status: number, headers: Record<string, string>): void;
  end(body?: string | Buffer): void;
}

let requestCounter = 0;

/** One shared empty query set for query-less requests (see getParams). */
const EMPTY_PARAMS = new URLSearchParams('');

function requestId(): string {
  // A plain counter: the header only needs to be non-empty, and Date.now() +
  // toString(36) on every reply is pure overhead on the hot paths.
  requestCounter += 1;
  return `req-${requestCounter.toString(36)}`;
}

function sendJson(res: HttpRes, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
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

/** Send a pre-built JSON Buffer (e.g. a cached issue body) without re-stringifying
 *  and without a UTF-8 re-encode: res.end(Buffer) writes the bytes as-is. */
function sendJsonBuffer(res: HttpRes, status: number, buf: Buffer, extraHeaders: Record<string, string> = {}): void {
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': requestId(),
    'x-oauth-scopes': 'repo, read:org',
    'content-length': String(buf.length),
    ...extraHeaders,
  };
  res.writeHead(status, headers);
  res.end(buf);
}

function sendBuffer(res: HttpRes, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(body.length),
    'x-github-request-id': requestId(),
  });
  res.end(body);
}

async function readBody(req: HttpReq, maxBytes = 32 * 1024 * 1024): Promise<Buffer> {
  // Raw transport: the body was already read while parsing the request.
  if (req.body !== undefined) {
    if (req.body.length > maxBytes) throw new Error('request body too large');
    return req.body;
  }
  // node:http path: collect from the stream.
  const stream = req as unknown as IncomingMessage;
  // Event-based collection: the async-iterator form allocates an async generator
  // per request, which is pure overhead on the push/write hot paths.
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    stream.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        if (!done) {
          done = true;
          reject(new Error('request body too large'));
        }
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => {
      if (!done) {
        done = true;
        resolve(Buffer.concat(chunks));
      }
    });
    stream.on('error', (err) => {
      if (!done) {
        done = true;
        reject(err);
      }
    });
  });
}

function checkAuth(req: HttpReq, expectedToken: string): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (token === '') return false;
  if (expectedToken === '') return true;
  return token === expectedToken;
}

function decodeSegments(pathname: string): string[] {
  // Fast path: the suite's paths carry no %-escapes, so skip decodeURIComponent
  // (a per-segment function call) entirely when there is nothing to decode.
  if (!pathname.includes('%')) {
    return pathname.split('/').filter((s) => s !== '');
  }
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
    void handleRequest(store, expectedToken, req, res).catch((e: unknown) => {
      try {
        const message = e instanceof Error ? e.message : 'Internal Server Error';
        sendJson(res, 500, { message });
      } catch {
        // The peer went away; nothing to write.
      }
    });
  });
  return server;
}

/** The routing core: shared by the node:http transport and the raw-socket one. */
export async function handleRequest(
  store: Store,
  expectedToken: string,
  req: HttpReq,
  res: HttpRes,
): Promise<void> {
    const method = req.method ?? 'GET';
    // Lightweight URL split: `new URL()` parses (and validates) the whole URL on
    // every request, which is pure overhead on the hot paths. The query string is
    // parsed lazily, only by the routes that read it.
    const rawUrl = req.url ?? '/';
    const qIndex = rawUrl.indexOf('?');
    const pathname = qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex);
    if (!pathname.startsWith('/')) {
      sendJson(res, 400, { message: 'Bad Request' });
      return;
    }
    let searchParams: URLSearchParams | null = null;
    const getParams = (): URLSearchParams => {
      if (searchParams === null) {
        // No query string: share one empty instance instead of building one per
        // request (the read workload makes 2,000 query-less GETs).
        searchParams =
          qIndex === -1 ? EMPTY_PARAMS : new URLSearchParams(rawUrl.slice(qIndex + 1));
      }
      return searchParams;
    };
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
        const service = getParams().get('service');
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
          query: getParams(),
          body: parsed,
          host: req.headers.host ?? '127.0.0.1',
          path: pathname,
        });
        const extra: Record<string, string> = {};
        if (link !== undefined && link !== '') extra.link = link;
        if (result.bodyBuf !== undefined) sendJsonBuffer(res, result.status, result.bodyBuf, extra);
        else sendJson(res, result.status, result.body, extra);
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

