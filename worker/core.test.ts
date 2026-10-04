import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyLoginError,
  getCaptcha,
  parseCaptchaResponse,
  parseTokenResponse,
  tokenIsExpired,
  UpstreamError
} from './auth.js';
import { fetchBillsForSession, parseGzicBills, ReauthRequiredError } from './billing.js';
import { cookieValue, upstreamCookie } from './http.js';
import { decryptSession, encryptSession } from './session-crypto.js';
import type { WebSession } from './types.js';

const makeSession = (overrides: Partial<WebSession> = {}): WebSession => ({
  version: 1,
  issuedAt: 1_000,
  accessToken: 'access-old',
  refreshToken: 'refresh-old',
  expiresAt: 10_000_000,
  tokenType: 'bearer',
  tgc: 'tgc-old',
  locSession: 'loc-old',
  user: { name: 'Student', sno: '00000000', campus: 'GZIC' },
  ...overrides
});

test('captcha response parser accepts the SCUT key and image fields', () => {
  assert.deepEqual(
    parseCaptchaResponse({ key: 'captcha-key', image: 'data:image/png;base64,abc' }),
    {
      key: 'captcha-key',
      image: 'data:image/png;base64,abc'
    }
  );
  assert.equal(parseCaptchaResponse({ key: 1, image: 'data:' }), null);
});

test('captcha preflight verifies the keyboard endpoint before allowing login', async () => {
  const requests: string[] = [];
  const captcha = await getCaptcha(async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.includes('/oauth/captcha')) {
      return Response.json({ key: 'key', image: 'data:image/png;base64,abc' });
    }
    return Response.json({ data: { numberKeyboard: '0123456789', uuid: 'uuid' } });
  });
  assert.equal(captcha.key, 'key');
  assert.equal(requests.length, 2);
  assert.ok(requests[0].includes('/oauth/captcha'));
  assert.ok(requests[1].includes('/keyboard'));
});

test('captcha preflight rejects when keyboard access is unavailable', async () => {
  await assert.rejects(
    getCaptcha(async (input) => {
      if (String(input).includes('/oauth/captcha')) {
        return Response.json({ key: 'key', image: 'data:image/png;base64,abc' });
      }
      return new Response(null, { status: 403 });
    }),
    UpstreamError
  );
});

test('login error parser distinguishes captcha required and invalid', () => {
  const required = classifyLoginError(
    { error_description: 'captcha required' },
    new Response(null, { status: 400 }),
    false
  );
  const invalid = classifyLoginError(
    { error_description: 'captcha code incorrect' },
    new Response(null, { status: 400 }),
    true
  );
  assert.equal(required, 'CAPTCHA_REQUIRED');
  assert.equal(invalid, 'CAPTCHA_INVALID');
});

test('numeric Synjones captcha codes are classified as CAPTCHA_REQUIRED', () => {
  for (const code of [8002, 8003, '8002', '8003']) {
    assert.equal(
      classifyLoginError({ code }, new Response(null, { status: 400 }), false),
      'CAPTCHA_REQUIRED'
    );
  }
});

test('numeric captcha code with an explicit incorrect response is CAPTCHA_INVALID after submission', () => {
  assert.equal(
    classifyLoginError(
      { code: 8002, message: 'captcha code incorrect' },
      new Response(null, { status: 400 }),
      true
    ),
    'CAPTCHA_INVALID'
  );
});

test('token response parser keeps expiry, refresh token and TGC cookies', async () => {
  const headers = new Headers();
  headers.append('Set-Cookie', 'TGC=tgc-value; Path=/; HttpOnly');
  headers.append('Set-Cookie', 'locSession=loc-value; Path=/; Secure');
  const before = Date.now();
  const token = await parseTokenResponse(
    Response.json(
      {
        access_token: 'access-value',
        refresh_token: 'refresh-value',
        expires_in: 3600,
        token_type: 'bearer',
        name: 'Test Student',
        sno: '20260001'
      },
      { headers }
    ),
    'GZIC'
  );
  assert.equal(token.accessToken, 'access-value');
  assert.equal(token.refreshToken, 'refresh-value');
  assert.equal(token.tgc, 'tgc-value');
  assert.equal(token.locSession, 'loc-value');
  assert.equal(token.user.campus, 'GZIC');
  assert.ok(token.expiresAt >= before + 3_599_000);
});

test('token expiry uses a five-minute refresh buffer', () => {
  assert.equal(tokenIsExpired(500_000, 0), false);
  assert.equal(tokenIsExpired(300_000, 0), true);
  assert.equal(tokenIsExpired(0, 0), true);
});

test('Cookie parsing preserves values and separates combined Set-Cookie headers', () => {
  assert.equal(cookieValue('a=1; scut_session=abc_def-ghi; Path=/', 'scut_session'), 'abc_def-ghi');
  const headers = new Headers();
  headers.append('Set-Cookie', 'TGC=tgc-value; Expires=Wed, 21 Oct 2030 07:28:00 GMT; Path=/');
  headers.append('Set-Cookie', 'locSession=loc-value; Path=/');
  assert.equal(upstreamCookie(headers, 'TGC'), 'tgc-value');
  assert.equal(upstreamCookie(headers, 'locSession'), 'loc-value');
});

test('GZIC billing parser returns platform values without unit conversion', () => {
  const parsed = parseGzicBills([
    { code: 200, map: { showData: { 信息: '12.50 元' }, data: { room: 'C12-345' } } },
    { code: 200, map: { showData: { 信息: '3.25 元' } } },
    { code: 200, map: { showData: { 信息: '水费,8.75' } } }
  ]);
  assert.deepEqual(parsed, { room: 'C12-345', electric: 12.5, ac: 3.25, water: 8.75 });
});

test('expired access token refreshes once before billing', async () => {
  const original = makeSession({ expiresAt: 1000 });
  let refreshCalls = 0;
  let observedToken = '';
  const refreshed = {
    accessToken: 'access-new',
    refreshToken: 'refresh-new',
    expiresAt: 100_000,
    tokenType: 'bearer',
    tgc: 'tgc-new',
    locSession: 'loc-new'
  };
  const result = await fetchBillsForSession(
    original,
    async () => {
      refreshCalls++;
      return refreshed;
    },
    2000,
    async (session) => {
      observedToken = session.accessToken;
      return { room: 'C12-345', electric: 1, water: 2, ac: 3 };
    }
  );
  assert.equal(refreshCalls, 1);
  assert.equal(observedToken, 'access-new');
  assert.equal(result.refreshed, true);
  assert.equal(result.session.refreshToken, 'refresh-new');
});

test('unauthorized billing refreshes once, then retries with the new token', async () => {
  let refreshCalls = 0;
  let queryCalls = 0;
  const result = await fetchBillsForSession(
    makeSession(),
    async () => {
      refreshCalls++;
      return {
        accessToken: 'access-new',
        refreshToken: 'refresh-old',
        expiresAt: 10_000_000,
        tokenType: 'bearer',
        tgc: 'tgc-old',
        locSession: 'loc-old'
      };
    },
    100,
    async (session) => {
      queryCalls++;
      if (queryCalls === 1) throw new ReauthRequiredError();
      assert.equal(session.accessToken, 'access-new');
      return { room: 'C12-345', electric: 1, water: 2, ac: 3 };
    }
  );
  assert.equal(refreshCalls, 1);
  assert.equal(queryCalls, 2);
  assert.equal(result.refreshed, true);
});

test('failed refresh returns REAUTH_REQUIRED without a password login retry', async () => {
  let queryCalls = 0;
  await assert.rejects(
    fetchBillsForSession(
      makeSession(),
      async () => {
        throw new Error('refresh rejected');
      },
      100,
      async () => {
        queryCalls++;
        throw new ReauthRequiredError();
      }
    ),
    ReauthRequiredError
  );
  assert.equal(queryCalls, 1);
});

test('session cookie encryption round-trips and rejects tampering', async () => {
  const secret = '0'.repeat(64);
  const session = makeSession();
  const encrypted = await encryptSession(session, secret);
  assert.deepEqual(await decryptSession(encrypted, secret, 2000), session);
  const tampered = `${encrypted[0] === 'A' ? 'B' : 'A'}${encrypted.slice(1)}`;
  assert.equal(await decryptSession(tampered, secret, 2000), null);
  assert.equal(await decryptSession(`${encrypted}x`, secret, 2000), null);
  assert.equal(await decryptSession(encrypted, '1'.repeat(64), 2000), null);
});

test('refresh fallback retains the previous refresh token when SCUT does not rotate it', async () => {
  const response = Response.json({
    access_token: 'new-access',
    expires_in: 1800,
    token_type: 'bearer'
  });
  const token = await parseTokenResponse(response, 'DXC', 'old-refresh');
  assert.equal(token.accessToken, 'new-access');
  assert.equal(token.refreshToken, 'old-refresh');
});
