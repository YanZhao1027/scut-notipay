import { upstreamCookie } from './http.js';
import type { Campus, TokenState, UserProfile } from './types.js';

export const CARD_BASE = 'https://ecardwxnew.scut.edu.cn';
const TOKEN_URL = `${CARD_BASE}/berserker-auth/oauth/token`;
const BASIC_AUTH = 'Basic bW9iaWxlX3NlcnZpY2VfcGxhdGZvcm06bW9iaWxlX3NlcnZpY2VfcGxhdGZvcm1fc2VjcmV0';

export interface CaptchaChallenge {
  key: string;
  image: string;
}

export type LoginFailure = 'CAPTCHA_REQUIRED' | 'CAPTCHA_INVALID' | 'INVALID_CREDENTIALS';

export class LoginError extends Error {
  constructor(readonly code: LoginFailure) {
    super(code);
  }
}

export class UpstreamError extends Error {
  constructor(readonly status: number) {
    super('Upstream request failed');
  }
}

export interface LoginInput {
  username: string;
  password: string;
  campus: Campus;
  captchaKey?: string;
  captchaCode?: string;
}

export interface TokenResult extends TokenState {
  user: UserProfile;
}

export const tokenIsExpired = (expiresAt: number, now = Date.now()): boolean =>
  expiresAt - now <= 5 * 60 * 1000;

export const parseCaptchaResponse = (value: unknown): CaptchaChallenge | null => {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  return typeof record.key === 'string' && typeof record.image === 'string'
    ? { key: record.key, image: record.image }
    : null;
};

export const getCaptcha = async (fetcher: typeof fetch = fetch): Promise<CaptchaChallenge> => {
  const response = await fetcher(`${CARD_BASE}/berserker-auth/oauth/captcha?synAccessSource=h5`, {
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new UpstreamError(response.status);
  const challenge = parseCaptchaResponse(await response.json());
  if (!challenge) throw new UpstreamError(response.status);
  return challenge;
};

const encodePassword = async (password: string, fetcher: typeof fetch): Promise<string> => {
  const url = `${CARD_BASE}/berserker-secure/keyboard?type=Standard&order=0&synAccessSource=h5`;
  const response = await fetcher(url, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new UpstreamError(response.status);
  const payload = (await response.json()) as {
    data?: { numberKeyboard?: string; uuid?: string };
  };
  const keyboard = payload.data?.numberKeyboard;
  const uuid = payload.data?.uuid;
  if (typeof keyboard !== 'string' || typeof uuid !== 'string') {
    throw new UpstreamError(response.status);
  }
  if (!/^\d+$/.test(password)) throw new LoginError('INVALID_CREDENTIALS');
  return (
    Array.from(password)
      .map((digit) => keyboard.charAt(Number(digit)))
      .join('') +
    '$1$' +
    uuid
  );
};

const responseCookie = (response: Response, name: string): string =>
  upstreamCookie(response.headers, name);

const errorText = (payload: Record<string, unknown>): string =>
  [payload.error, payload.error_description, payload.message, payload.msg, payload.code]
    .filter((value) => typeof value === 'string' || typeof value === 'number')
    .join(' ')
    .toLowerCase();

export const classifyLoginError = (
  payload: Record<string, unknown>,
  response: Response,
  hadCaptcha: boolean
): LoginFailure => {
  const text = errorText(payload);
  const captchaSignal = /captcha|验证码|校验码/.test(text);
  if (captchaSignal) {
    const incorrect = /invalid|incorrect|wrong|错误|不正确/.test(text);
    return hadCaptcha && incorrect ? 'CAPTCHA_INVALID' : 'CAPTCHA_REQUIRED';
  }
  if (response.status === 401 || response.status === 400) return 'INVALID_CREDENTIALS';
  return 'INVALID_CREDENTIALS';
};

export const parseTokenResponse = async (
  response: Response,
  campus: Campus,
  oldRefreshToken?: string
): Promise<TokenResult> => {
  let data: Record<string, unknown> = {};
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new UpstreamError(response.status);
  }
  if (!response.ok || typeof data.access_token !== 'string' || !data.access_token) {
    throw new LoginError(classifyLoginError(data, response, false));
  }

  const expiresIn = Number(data.expires_in);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) throw new UpstreamError(response.status);
  const refreshToken =
    typeof data.refresh_token === 'string' && data.refresh_token
      ? data.refresh_token
      : (oldRefreshToken ?? '');

  return {
    accessToken: data.access_token,
    refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
    tokenType: typeof data.token_type === 'string' ? data.token_type : 'bearer',
    tgc: responseCookie(response, 'TGC'),
    locSession: responseCookie(response, 'locSession'),
    user: {
      name: typeof data.name === 'string' ? data.name : '',
      sno: typeof data.sno === 'string' ? data.sno : '',
      campus
    }
  };
};

export const login = async (
  input: LoginInput,
  fetcher: typeof fetch = fetch
): Promise<TokenResult> => {
  const encryptedPassword = await encodePassword(input.password, fetcher);
  const form = new URLSearchParams({
    username: input.username,
    password: encryptedPassword,
    grant_type: 'password',
    scope: 'all',
    loginForm: 'h5',
    logintype: 'card',
    device_token: 'h5',
    synAccessSource: 'h5'
  });

  // These fields are the currently observed Synjones candidate names. The live
  // SCUT login flow still needs a successful user-controlled verification.
  const hadCaptcha = Boolean(input.captchaKey && input.captchaCode);
  if (hadCaptcha) {
    form.set('captcha_header_code', input.captchaCode!);
    form.set('captcha_header_key', input.captchaKey!);
  }

  const response = await fetcher(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: BASIC_AUTH
    },
    body: form.toString(),
    signal: AbortSignal.timeout(15000)
  });

  let data: Record<string, unknown> = {};
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new UpstreamError(response.status);
  }
  if (!response.ok || typeof data.access_token !== 'string' || !data.access_token) {
    throw new LoginError(classifyLoginError(data, response, hadCaptcha));
  }
  return parseTokenResponse(
    Response.json(data, { status: response.status, headers: response.headers }),
    input.campus
  );
};

export const refresh = async (
  session: Pick<TokenState, 'refreshToken' | 'tgc' | 'locSession'>,
  campus: Campus,
  fetcher: typeof fetch = fetch
): Promise<TokenResult> => {
  if (!session.refreshToken) throw new UpstreamError(401);
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: session.refreshToken,
    scope: 'all',
    loginForm: 'h5',
    logintype: 'card',
    device_token: 'h5',
    synAccessSource: 'h5'
  });
  const response = await fetcher(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: BASIC_AUTH,
      ...(session.tgc || session.locSession
        ? { Cookie: `TGC=${session.tgc}; locSession=${session.locSession}` }
        : {})
    },
    body: form.toString(),
    signal: AbortSignal.timeout(15000)
  });

  const result = await parseTokenResponse(response, campus, session.refreshToken);
  if (!result.tgc) result.tgc = session.tgc;
  if (!result.locSession) result.locSession = session.locSession;
  return result;
};
