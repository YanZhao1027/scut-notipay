import { getCaptcha, LoginError, login, refresh, UpstreamError } from './auth.js';
import { fetchBillsForSession, ReauthRequiredError } from './billing.js';
import { getScutEgressDiagnostics } from './diagnostics.js';
import {
  apiError,
  clearSessionCookie,
  cookieValue,
  isSameOrigin,
  jsonResponse,
  sessionCookie
} from './http.js';
import { decryptSession, encryptSession } from './session-crypto.js';
import type { Campus, Env, WebSession } from './types.js';

const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;
const SESSION_COOKIE_MAX_BYTES = 3500;

const securityHeaders = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
};

const secure = (response: Response): Response => {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(securityHeaders)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
};

const readJson = async (request: Request): Promise<Record<string, unknown> | null> => {
  const contentType = request.headers.get('Content-Type') ?? '';
  const length = Number(request.headers.get('Content-Length') ?? 0);
  if (!contentType.toLowerCase().includes('application/json') || length > 8192) return null;
  try {
    const value: unknown = await request.json();
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const loadSession = async (request: Request, env: Env): Promise<WebSession | null> => {
  const value = cookieValue(request.headers.get('Cookie'), 'scut_session');
  if (!value || !env.SESSION_SECRET) return null;
  return decryptSession(value, env.SESSION_SECRET);
};

const saveSession = async (session: WebSession, secret: string): Promise<string | null> => {
  const encrypted = await encryptSession(session, secret);
  if (new TextEncoder().encode(`scut_session=${encrypted}`).byteLength > SESSION_COOKIE_MAX_BYTES) {
    return null;
  }
  return sessionCookie(encrypted, SESSION_MAX_AGE_SECONDS);
};

const profile = (session: WebSession) => ({
  name: session.user.name,
  sno: session.user.sno,
  campus: session.user.campus
});

const makeSession = (tokens: Awaited<ReturnType<typeof login>>): WebSession => ({
  version: 1,
  issuedAt: Date.now(),
  accessToken: tokens.accessToken,
  refreshToken: tokens.refreshToken,
  expiresAt: tokens.expiresAt,
  tokenType: tokens.tokenType,
  tgc: tokens.tgc,
  locSession: tokens.locSession,
  user: tokens.user
});

const responseWithCookie = (response: Response, cookie: string): Response => {
  const headers = new Headers(response.headers);
  headers.append('Set-Cookie', cookie);
  return new Response(response.body, { status: response.status, headers });
};

const probeTarget = async (
  initialUrl: string
): Promise<{
  status: number | null;
  elapsedMs: number;
  redirects: Array<{ status: number; host: string; path: string }>;
  finalHost: string | null;
  finalPath: string | null;
  error: 'timeout' | 'network' | null;
}> => {
  const start = Date.now();
  const redirects: Array<{ status: number; host: string; path: string }> = [];
  let url = new URL(initialUrl);
  try {
    for (let hop = 0; hop <= 5; hop++) {
      const response = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(10000)
      });
      if (response.status < 300 || response.status > 399) {
        return {
          status: response.status,
          elapsedMs: Date.now() - start,
          redirects,
          finalHost: url.hostname,
          finalPath: url.pathname,
          error: null
        };
      }
      const location = response.headers.get('Location');
      if (!location) {
        return {
          status: response.status,
          elapsedMs: Date.now() - start,
          redirects,
          finalHost: url.hostname,
          finalPath: url.pathname,
          error: null
        };
      }
      const next = new URL(location, url);
      if (next.protocol === 'http:') next.protocol = 'https:';
      if (next.protocol !== 'https:' || !/(^|\.)scut\.edu\.cn$/.test(next.hostname)) {
        return {
          status: response.status,
          elapsedMs: Date.now() - start,
          redirects,
          finalHost: url.hostname,
          finalPath: url.pathname,
          error: 'network'
        };
      }
      redirects.push({ status: response.status, host: url.hostname, path: url.pathname });
      url = next;
    }
    return {
      status: null,
      elapsedMs: Date.now() - start,
      redirects,
      finalHost: url.hostname,
      finalPath: url.pathname,
      error: 'network'
    };
  } catch (error) {
    return {
      status: null,
      elapsedMs: Date.now() - start,
      redirects,
      finalHost: url.hostname,
      finalPath: url.pathname,
      error: error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network'
    };
  }
};

const egressProbe = async (): Promise<Response> => {
  const [ecard, dxy] = await Promise.all([
    probeTarget('https://ecardwxnew.scut.edu.cn'),
    probeTarget('https://dfyc.utc.scut.edu.cn')
  ]);
  return jsonResponse({ ok: true, ecard, dxy });
};

const api = async (request: Request, env: Env): Promise<Response> => {
  const { pathname } = new URL(request.url);

  if (pathname === '/api/health' && request.method === 'GET') {
    return jsonResponse({ ok: true });
  }

  if (pathname === '/api/health/egress' && request.method === 'GET') {
    if (!env.SESSION_SECRET || request.headers.get('X-Egress-Probe') !== env.SESSION_SECRET) {
      return apiError('INVALID_REQUEST', 404);
    }
    return egressProbe();
  }

  if (pathname === '/api/debug/scut-egress' && request.method === 'GET') {
    const debugSecret = env.DEBUG_SECRET;
    if (!debugSecret || request.headers.get('X-Debug-Secret') !== debugSecret) {
      return apiError('INVALID_REQUEST', 404);
    }
    return jsonResponse(await getScutEgressDiagnostics());
  }

  if (!isSameOrigin(request)) return apiError('INVALID_REQUEST', 403);

  if (pathname === '/api/auth/captcha' && request.method === 'GET') {
    try {
      return jsonResponse(await getCaptcha());
    } catch {
      return apiError('UPSTREAM_UNAVAILABLE', 502);
    }
  }

  if (pathname === '/api/auth/login' && request.method === 'POST') {
    if (!env.SESSION_SECRET) return apiError('SESSION_UNAVAILABLE', 503);
    const body = await readJson(request);
    const username = typeof body?.username === 'string' ? body.username.trim() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    const campus = body?.campus;
    const captchaKey = typeof body?.captchaKey === 'string' ? body.captchaKey : undefined;
    const captchaCode = typeof body?.captchaCode === 'string' ? body.captchaCode.trim() : undefined;
    if (
      !body ||
      !username ||
      username.length > 100 ||
      !password ||
      password.length > 128 ||
      (campus !== 'GZIC' && campus !== 'DXC') ||
      (captchaKey && captchaKey.length > 256) ||
      (captchaCode && captchaCode.length > 32)
    ) {
      return apiError('INVALID_REQUEST', 400);
    }

    const input = { username, password, campus: campus as Campus, captchaKey, captchaCode };
    body.password = '';
    try {
      const tokens = await login(input);
      const session = makeSession(tokens);
      const cookie = await saveSession(session, env.SESSION_SECRET);
      if (!cookie) return apiError('SESSION_UNAVAILABLE', 502);
      return responseWithCookie(jsonResponse({ ok: true, user: profile(session) }), cookie);
    } catch (error) {
      if (error instanceof LoginError) {
        const status = error.code === 'INVALID_CREDENTIALS' ? 401 : 400;
        return apiError(error.code, status);
      }
      if (error instanceof UpstreamError) return apiError('UPSTREAM_UNAVAILABLE', 502);
      return apiError('UPSTREAM_UNAVAILABLE', 502);
    } finally {
      input.password = '';
    }
  }

  if (pathname === '/api/auth/logout' && request.method === 'POST') {
    return responseWithCookie(jsonResponse({ ok: true }), clearSessionCookie());
  }

  if (pathname === '/api/auth/session' && request.method === 'GET') {
    const session = await loadSession(request, env);
    return session
      ? jsonResponse({ ok: true, user: profile(session) })
      : apiError('REAUTH_REQUIRED', 401);
  }

  if (pathname === '/api/auth/refresh' && request.method === 'POST') {
    const session = await loadSession(request, env);
    if (!session) {
      return responseWithCookie(apiError('REAUTH_REQUIRED', 401), clearSessionCookie());
    }
    try {
      const renewed = await refresh(session, session.user.campus);
      const updated = { ...session, ...renewed, user: session.user };
      const cookie = await saveSession(updated, env.SESSION_SECRET);
      if (!cookie) return apiError('SESSION_UNAVAILABLE', 502);
      return responseWithCookie(jsonResponse({ ok: true, user: profile(updated) }), cookie);
    } catch {
      return responseWithCookie(apiError('REAUTH_REQUIRED', 401), clearSessionCookie());
    }
  }

  if (pathname === '/api/bills' && request.method === 'GET') {
    const session = await loadSession(request, env);
    if (!session) {
      return responseWithCookie(apiError('REAUTH_REQUIRED', 401), clearSessionCookie());
    }
    try {
      const result = await fetchBillsForSession(session, (current) =>
        refresh(current, current.user.campus)
      );
      const cookie = await saveSession(result.session, env.SESSION_SECRET);
      if (!cookie) return apiError('SESSION_UNAVAILABLE', 502);
      const response = jsonResponse(result.bills);
      return result.refreshed ? responseWithCookie(response, cookie) : response;
    } catch (error) {
      if (error instanceof ReauthRequiredError) {
        return responseWithCookie(apiError('REAUTH_REQUIRED', 401), clearSessionCookie());
      }
      return apiError('UPSTREAM_UNAVAILABLE', 502);
    }
  }

  if (pathname.startsWith('/api/')) return apiError('INVALID_REQUEST', 404);
  return env.ASSETS.fetch(request);
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const response = await api(request, env);
    return secure(response);
  }
};
