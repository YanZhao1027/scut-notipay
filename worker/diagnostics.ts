import { CARD_BASE } from './auth.js';

export interface ScutProbeResult {
  status: number | null;
  contentType: string | null;
  server: string | null;
  location: string | null;
  elapsedMs: number;
}

const endpoints = {
  home: `${CARD_BASE}/`,
  captcha: `${CARD_BASE}/berserker-auth/oauth/captcha?synAccessSource=h5`,
  keyboard: `${CARD_BASE}/berserker-secure/keyboard?type=Standard&order=0&synAccessSource=h5`
};

const safeLocation = (value: string | null, base: string): string | null => {
  if (!value) return null;
  try {
    const location = new URL(value, base);
    return `${location.origin}${location.pathname}`;
  } catch {
    return null;
  }
};

export const probeScutEndpoint = async (
  url: string,
  fetcher: typeof fetch = fetch
): Promise<ScutProbeResult> => {
  const startedAt = Date.now();
  try {
    const response = await fetcher(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(10000)
    });
    return {
      status: response.status,
      contentType: response.headers.get('Content-Type'),
      server: response.headers.get('Server'),
      location: safeLocation(response.headers.get('Location'), url),
      elapsedMs: Date.now() - startedAt
    };
  } catch {
    return {
      status: null,
      contentType: null,
      server: null,
      location: null,
      elapsedMs: Date.now() - startedAt
    };
  }
};

export const getScutEgressDiagnostics = async (
  fetcher: typeof fetch = fetch
): Promise<{ captcha: ScutProbeResult; keyboard: ScutProbeResult; home: ScutProbeResult }> => {
  const [home, captcha, keyboard] = await Promise.all([
    probeScutEndpoint(endpoints.home, fetcher),
    probeScutEndpoint(endpoints.captcha, fetcher),
    probeScutEndpoint(endpoints.keyboard, fetcher)
  ]);
  return { captcha, keyboard, home };
};
