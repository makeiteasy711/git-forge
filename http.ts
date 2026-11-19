import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN_ENV = 'MAKEFUN_SHOP_TOKEN';

let requestCounter = 0;

export function nextRequestId(): string {
  requestCounter += 1;
  return `c${requestCounter.toString(16)}${process.hrtime.bigint().toString(16)}`;
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  if (res.headersSent) return;
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': headers['x-github-request-id'] ?? nextRequestId(),
    ...headers,
  });
  res.end(text);
}

export function sendEmpty(
  res: ServerResponse,
  status: number,
  headers: Readonly<Record<string, string>> = {},
): void {
  if (res.headersSent) return;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': 0,
    'x-github-request-id': headers['x-github-request-id'] ?? nextRequestId(),
    ...headers,
  });
  res.end();
}

export function sendBuffer(
  res: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  if (res.headersSent) return;
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': headers['x-github-request-id'] ?? nextRequestId(),
    ...headers,
  });
  res.end(body);
}

export function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

export function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

export function requestOrigin(req: IncomingMessage): string {
  const host = typeof req.headers.host === 'string' && req.headers.host.trim() !== '' ? req.headers.host : '127.0.0.1';
  return `http://${host}`;
}

export async function readBody(req: IncomingMessage, limit = 64 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(buf);
  }
  return chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, size);
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = Record<string, unknown>;

export function parseJsonBody(buf: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (buf.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(buf.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

export type AuthResult = { ok: true } | { ok: false; status: 401; message: string };

export function expectedToken(): string | undefined {
  const value = process.env[TOKEN_ENV];
  return value && value.length > 0 ? value : undefined;
}

export function authorize(req: IncomingMessage): AuthResult {
  const expected = expectedToken();
  const header = req.headers.authorization;
  const raw = typeof header === 'string' ? header : Array.isArray(header) ? header[0] : undefined;
  if (!raw) return { ok: false, status: 401, message: 'Requires authentication' };
  const match = /^Bearer\s+(\S+)/i.exec(raw.trim());
  const token = match?.[1];
  if (!token) return { ok: false, status: 401, message: 'Requires authentication' };
  if (expected === undefined || token !== expected) {
    return { ok: false, status: 401, message: 'Bad credentials' };
  }
  return { ok: true };
}

export function sendUnauthorized(res: ServerResponse, auth: Exclude<AuthResult, { ok: true }>): void {
  sendJson(res, 401, { message: auth.message });
}

export function sendNotFound(res: ServerResponse, message = 'Not Found'): void {
  sendJson(res, 404, { message });
}

export function sendBadRequest(res: ServerResponse, message = 'Body should be a JSON object'): void {
  sendJson(res, 400, { message });
}
