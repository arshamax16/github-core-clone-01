// rawhttp.ts — a minimal HTTP/1.1 server over raw TCP sockets.
//
// Replaces node:http for the forge: node:http builds an IncomingMessage, a header
// object and a stream per request, which is pure overhead when the only client is
// the suite's undici fetch on a keep-alive connection. This server parses the
// request line + headers + body straight out of the socket buffer and drives the
// same routing core (app.ts handleRequest) through the same HttpReq/HttpRes
// shapes, then writes the reply straight to the socket.
//
// Supports: Content-Length bodies, chunked bodies, keep-alive, pipelining
// (requests are answered strictly in arrival order). HTTP/1.1 defaults to
// keep-alive; HTTP/1.0 defaults to close.

import { createServer, type Server, type Socket } from 'node:net';
import { handleRequest, type AppOptions, type HttpReq, type HttpRes } from './app.ts';
import { type Store } from './store.ts';

const REASON: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

interface ParsedRequest {
  req: HttpReq;
  keepAlive: boolean;
  /** Bytes after this request (pipelined next request, or a partial one). */
  rest: Buffer;
}

/** Parse one complete request out of `buf`, or null when more bytes are needed. */
function tryParseRequest(buf: Buffer): ParsedRequest | null {
  const headEnd = buf.indexOf('\r\n\r\n');
  if (headEnd === -1) {
    // A request line + headers larger than 64 KiB is not one the suite sends.
    if (buf.length > 65536) throw new Error('request headers too large');
    return null;
  }
  const head = buf.subarray(0, headEnd).toString('latin1');
  const lines = head.split('\r\n');
  const requestLine = lines[0] ?? '';
  const parts = requestLine.split(' ');
  if (parts.length < 3) throw new Error('malformed request line');
  const method = parts[0] as string;
  const url = parts[1] as string;
  const version = parts[2] as string;
  const headers: Record<string, string | string[] | undefined> = {};
  let connection = '';
  let contentLength = -1;
  let chunked = false;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] as string;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (name === 'connection') connection = value.toLowerCase();
    else if (name === 'content-length') contentLength = Number.parseInt(value, 10) || 0;
    else if (name === 'transfer-encoding' && value.toLowerCase().includes('chunked')) chunked = true;
    const prev = headers[name];
    if (prev === undefined) headers[name] = value;
    else if (Array.isArray(prev)) prev.push(value);
    else headers[name] = [prev, value];
  }
  const bodyStart = headEnd + 4;
  let body: Buffer;
  let rest: Buffer;
  if (chunked) {
    // Parse chunked body: <hex-size>\r\n<data>\r\n ... 0\r\n\r\n (trailers ignored).
    let off = bodyStart;
    const chunks: Buffer[] = [];
    for (;;) {
      const lineEnd = buf.indexOf('\r\n', off);
      if (lineEnd === -1) return null;
      const sizeText = buf.subarray(off, lineEnd).toString('latin1').split(';')[0] as string;
      const size = Number.parseInt(sizeText.trim(), 16);
      if (!Number.isFinite(size) || size < 0) throw new Error('malformed chunked body');
      const dataStart = lineEnd + 2;
      if (size === 0) {
        // End of chunks: trailers until an empty line.
        const trailerEnd = buf.indexOf('\r\n\r\n', dataStart);
        if (trailerEnd === -1) {
          // A bare final CRLF (no trailers) is the common case.
          if (buf.length < dataStart + 2) return null;
          rest = buf.subarray(dataStart + 2);
        } else {
          rest = buf.subarray(trailerEnd + 4);
        }
        break;
      }
      if (buf.length < dataStart + size + 2) return null;
      chunks.push(buf.subarray(dataStart, dataStart + size));
      off = dataStart + size + 2;
    }
    body = chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks);
  } else if (contentLength > 0) {
    if (buf.length < bodyStart + contentLength) return null;
    body = buf.subarray(bodyStart, bodyStart + contentLength);
    rest = buf.subarray(bodyStart + contentLength);
  } else {
    body = Buffer.alloc(0);
    rest = buf.subarray(bodyStart);
  }
  const keepAlive =
    version === 'HTTP/1.1' ? !connection.includes('close') : connection.includes('keep-alive');
  return { req: { method, url, headers, body }, keepAlive, rest };
}

export interface RawServer extends Server {
  closeAllConnections(): void;
}

export function createRawApp(store: Store, options: AppOptions): RawServer {
  const expectedToken = options.expectedToken;
  const sockets = new Set<Socket>();

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setNoDelay(true);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {
      try {
        socket.destroy();
      } catch {
        // Already gone.
      }
    });
    let buf = Buffer.alloc(0);
    // Requests on one socket are answered strictly in order: each drain awaits
    // the previous handler before parsing the next request.
    let chain: Promise<void> = Promise.resolve();
    let dead = false;
    socket.on('data', (chunk: Buffer) => {
      if (dead) return;
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      chain = chain.then(drain).catch(() => {
        dead = true;
        try {
          socket.destroy();
        } catch {
          // Already gone.
        }
      });
    });

    async function drain(): Promise<void> {
      for (;;) {
        if (socket.destroyed) return;
        let parsed: ParsedRequest;
        try {
          const p = tryParseRequest(buf);
          if (p === null) return;
          parsed = p;
        } catch {
          // Malformed request: answer 400 and close.
          try {
            socket.write('HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\nconnection: close\r\n\r\n');
          } catch {
            // Peer went away.
          }
          socket.end();
          return;
        }
        buf = parsed.rest;
        const keepAlive = parsed.keepAlive;
        await handleOne(socket, parsed.req, keepAlive);
        if (!keepAlive || socket.destroyed) {
          try {
            socket.end();
          } catch {
            // Already gone.
          }
          return;
        }
      }
    }

    async function handleOne(socket: Socket, req: HttpReq, keepAlive: boolean): Promise<void> {
      let status = 200;
      let outHeaders: Record<string, string> = {};
      let outBody: Buffer | null = null;
      const res: HttpRes = {
        writeHead(s: number, headers: Record<string, string>): void {
          status = s;
          outHeaders = headers;
        },
        end(body?: string | Buffer): void {
          outBody = body === undefined ? null : typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
        },
      };
      try {
        await handleRequest(store, expectedToken, req, res);
      } catch (e: unknown) {
        try {
          const message = e instanceof Error ? e.message : 'Internal Server Error';
          status = 500;
          outHeaders = { 'content-type': 'application/json; charset=utf-8' };
          outBody = Buffer.from(JSON.stringify({ message }), 'utf8');
        } catch {
          return;
        }
      }
      // Frame the reply: always carry an explicit content-length (except 204/304,
      // which carry no body by definition) so a keep-alive client can delimit it.
      const body = outBody ?? Buffer.alloc(0);
      const headers: Array<[string, string]> = [];
      let hasLength = false;
      for (const [k, v] of Object.entries(outHeaders)) {
        if (k.toLowerCase() === 'content-length') hasLength = true;
        headers.push([k, v]);
      }
      if (!hasLength && status !== 204 && status !== 304) {
        headers.push(['content-length', String(body.length)]);
      }
      if (!keepAlive) headers.push(['connection', 'close']);
      const reason = REASON[status] ?? '';
      const headText = `HTTP/1.1 ${status} ${reason}\r\n${headers.map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`;
      const headBuf = Buffer.from(headText, 'latin1');
      try {
        if (body.length === 0) socket.write(headBuf);
        else socket.write(Buffer.concat([headBuf, body]));
      } catch {
        // Peer went away.
      }
    }
  }) as RawServer;

  server.closeAllConnections = (): void => {
    for (const s of sockets) {
      try {
        s.destroy();
      } catch {
        // Already gone.
      }
    }
    sockets.clear();
  };
  return server;
}
