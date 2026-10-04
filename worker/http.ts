import type { ApiErrorCode } from './types.js';

export const jsonResponse = (body: unknown, status = 200, headers: HeadersInit = {}): Response => {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('Content-Type', 'application/json; charset=utf-8');
  responseHeaders.set('Cache-Control', 'no-store, private');
  return Response.json(body, { status, headers: responseHeaders });
};

export const apiError = (code: ApiErrorCode, status: number): Response =>
  jsonResponse({ ok: false, code }, status);

export const cookieValue = (header: string | null, name: string): string | null => {
  if (!header) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return null;
};

const cookieHeader = (headers: Headers): string[] => {
  const extended = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof extended.getSetCookie === 'function') return extended.getSetCookie();
  const combined = headers.get('set-cookie');
  if (!combined) return [];
  return combined.split(/,(?=\s*[^;,=\s]+=[^;,]*)/);
};

export const upstreamCookie = (headers: Headers, name: string): string => {
  for (const cookie of cookieHeader(headers)) {
    const pair = cookie.split(';', 1)[0]?.trim() ?? '';
    const separator = pair.indexOf('=');
    if (separator >= 0 && pair.slice(0, separator) === name) {
      return pair.slice(separator + 1);
    }
  }
  return '';
};

export const sessionCookie = (value: string, maxAgeSeconds: number): string =>
  `scut_session=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;

export const clearSessionCookie = (): string =>
  'scut_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';

export const isSameOrigin = (request: Request): boolean => {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
};
