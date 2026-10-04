import { CARD_BASE } from './auth.js';
import { upstreamCookie } from './http.js';
import type { Bills, TokenState, UserProfile, WebSession } from './types.js';

const DFYC_BASE = 'https://dfyc.utc.scut.edu.cn';

export class ReauthRequiredError extends Error {
  constructor() {
    super('REAUTH_REQUIRED');
  }
}

export class BillingUpstreamError extends Error {
  constructor(readonly status: number) {
    super('UPSTREAM_UNAVAILABLE');
  }
}

interface GzicResponse {
  code: number;
  map?: {
    showData?: { 信息?: string };
    data?: { room?: string };
  };
}

const fetchJson = async <T>(url: string, init: RequestInit = {}): Promise<T> => {
  const response = await fetch(url, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(15000)
  });
  if (response.status === 401 || response.status === 403) throw new ReauthRequiredError();
  if (!response.ok) throw new BillingUpstreamError(response.status);
  return (await response.json()) as T;
};

const parseAmount = (text: string | undefined, takeLast = false): number => {
  if (typeof text !== 'string') throw new BillingUpstreamError(502);
  const raw = takeLast ? (text.split(',').at(-1)?.trim() ?? '') : text.trim();
  const match = raw.match(/-?\d+(?:\.\d+)?/);
  if (!match) throw new BillingUpstreamError(502);
  const value = Number(match[0]);
  if (!Number.isFinite(value)) throw new BillingUpstreamError(502);
  return value;
};

export const parseGzicBills = (responses: GzicResponse[]): Omit<Bills, 'updatedAt'> => {
  if (responses.length !== 3 || responses.some((item) => item.code !== 200 || !item.map)) {
    throw new BillingUpstreamError(502);
  }
  const room = responses[0].map?.data?.room?.trim();
  if (!room) throw new BillingUpstreamError(502);
  return {
    electric: parseAmount(responses[0].map?.showData?.信息),
    ac: parseAmount(responses[1].map?.showData?.信息),
    water: parseAmount(responses[2].map?.showData?.信息, true),
    room
  };
};

const getGzicBills = async (accessToken: string): Promise<Omit<Bills, 'updatedAt'>> => {
  const ids = [1, 2, 3];
  const responses = await Promise.all(
    ids.map((feeitemid) =>
      fetchJson<GzicResponse>(
        `${CARD_BASE}/charge/feeitem/getThirdDataByFeeItemId?feeitemid=${feeitemid}&synAccessSource=h5`,
        { headers: { 'Synjones-Auth': `bearer ${accessToken}` } }
      )
    )
  );
  return parseGzicBills(responses);
};

const safeRedirectUrl = (location: string | null, currentUrl?: string): URL => {
  if (!location) throw new BillingUpstreamError(502);
  const url = new URL(location, currentUrl ?? `${CARD_BASE}/`);
  if (url.protocol === 'http:') url.protocol = 'https:';
  if (url.protocol !== 'https:' || !/(^|\.)scut\.edu\.cn$/.test(url.hostname)) {
    throw new BillingUpstreamError(502);
  }
  return url;
};

const getLocation = (response: Response, currentUrl?: string): URL =>
  safeRedirectUrl(response.headers.get('location'), currentUrl);

const requireStatus = (response: Response, expected: number): void => {
  if (response.status === 401 || response.status === 403) throw new ReauthRequiredError();
  if (response.status !== expected) throw new BillingUpstreamError(response.status);
};

const getDxcBills = async (
  token: string,
  tgc: string,
  locSession: string
): Promise<Omit<Bills, 'updatedAt'>> => {
  const cookie = `TGC=${tgc}; error_times=0; locSession=${locSession}`;
  const redirectUrl = new URL(
    `${CARD_BASE}/berserker-base/redirect?appId=360&loginFrom=h5&synAccessSource=h5&synjones-auth=${encodeURIComponent(token)}&type=app`
  );
  const redirectResponse = await fetch(redirectUrl, {
    redirect: 'manual',
    headers: { Cookie: cookie },
    signal: AbortSignal.timeout(15000)
  });
  requireStatus(redirectResponse, 302);

  const thirdLoginUrl = getLocation(redirectResponse, redirectUrl.href);
  const thirdLogin = await fetch(thirdLoginUrl, {
    redirect: 'manual',
    headers: { Cookie: `TGC=${tgc}; locSession=${locSession}; error_times=0` },
    signal: AbortSignal.timeout(15000)
  });
  requireStatus(thirdLogin, 302);
  const jsessionid = upstreamCookie(thirdLogin.headers, 'JSESSIONID');
  if (!jsessionid) throw new BillingUpstreamError(502);

  const authorizeUrl = getLocation(thirdLogin, thirdLoginUrl.href);
  const authorize = await fetch(authorizeUrl, {
    redirect: 'manual',
    headers: {
      Cookie: `JSESSIONID=${jsessionid}; TGC=${tgc}; locSession=${locSession}; error_times=0`
    },
    signal: AbortSignal.timeout(15000)
  });
  requireStatus(authorize, 302);

  const getCodeUrl = getLocation(authorize, authorizeUrl.href);
  const getCode = await fetch(getCodeUrl, {
    redirect: 'manual',
    headers: {
      Cookie: `JSESSIONID=${jsessionid}; TGC=${tgc}; locSession=${locSession}; error_times=0`
    },
    signal: AbortSignal.timeout(15000)
  });
  requireStatus(getCode, 302);
  if (getCode.headers.get('location') !== '/sdms-weixin-pay-sp/newWeixin/index.html') {
    throw new BillingUpstreamError(502);
  }

  const dxcCookie = { Cookie: `JSESSIONID=${jsessionid}` };
  const userInfo = await fetchJson<{
    statusCode?: string;
    resultObject?: { roomName?: string };
  }>(`${DFYC_BASE}/sdms-weixin-pay-sp/service/find/userinfo`, { headers: dxcCookie });
  const room = userInfo.resultObject?.roomName?.trim();
  if (userInfo.statusCode !== '200' || !room) throw new BillingUpstreamError(502);

  const electricData = await fetchJson<{
    statusCode?: string;
    resultObject?: { leftMoney?: string | number };
  }>(`${DFYC_BASE}/sdms-weixin-pay-sp/service/ammeterBalance?type=1`, { headers: dxcCookie });
  if (electricData.statusCode !== '200') throw new BillingUpstreamError(502);

  const waterData = await fetchJson<{
    statusCode?: string;
    resultObject?: { leftMoney?: string | number };
  }>(`${DFYC_BASE}/sdms-weixin-pay-sp/service/waterBalance?type=3&systemType=1`, {
    headers: dxcCookie
  });
  if (waterData.statusCode !== '200') throw new BillingUpstreamError(502);

  const electric = Number(electricData.resultObject?.leftMoney);
  const water = Number(waterData.resultObject?.leftMoney);
  if (!Number.isFinite(electric) || !Number.isFinite(water)) throw new BillingUpstreamError(502);
  return { room, electric, water, ac: null };
};

const mergeToken = (
  session: WebSession,
  updated: TokenState & { user?: UserProfile }
): WebSession => ({
  ...session,
  ...updated,
  user: session.user
});

export interface FetchBillsResult {
  bills: Bills;
  session: WebSession;
  refreshed: boolean;
}

export const fetchBillsForSession = async (
  original: WebSession,
  refreshToken: (session: WebSession) => Promise<TokenState & { user?: UserProfile }>,
  now = Date.now(),
  query = (session: WebSession) =>
    session.user.campus === 'GZIC'
      ? getGzicBills(session.accessToken)
      : getDxcBills(session.accessToken, session.tgc, session.locSession)
): Promise<FetchBillsResult> => {
  let session = original;
  let refreshed = false;
  if (session.expiresAt - now <= 5 * 60 * 1000) {
    try {
      session = mergeToken(session, await refreshToken(session));
      refreshed = true;
    } catch {
      throw new ReauthRequiredError();
    }
  }

  try {
    const values = await query(session);
    return { bills: { ...values, updatedAt: new Date().toISOString() }, session, refreshed };
  } catch (error) {
    if (!(error instanceof ReauthRequiredError) || refreshed) throw error;
  }

  try {
    session = mergeToken(session, await refreshToken(session));
  } catch {
    throw new ReauthRequiredError();
  }
  const values = await query(session);
  return { bills: { ...values, updatedAt: new Date().toISOString() }, session, refreshed: true };
};
