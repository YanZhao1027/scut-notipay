export type Campus = 'GZIC' | 'DXC';

export interface UserProfile {
  name: string;
  sno: string;
  campus: Campus;
}

export interface TokenState {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  tokenType: string;
  tgc: string;
  locSession: string;
}

export interface WebSession extends TokenState {
  version: 1;
  issuedAt: number;
  user: UserProfile;
}

export interface Bills {
  room: string;
  electric: number;
  water: number;
  ac: number | null;
  updatedAt: string;
}

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  SESSION_SECRET: string;
  DEBUG_SECRET?: string;
}

export type ApiErrorCode =
  | 'CAPTCHA_REQUIRED'
  | 'CAPTCHA_INVALID'
  | 'INVALID_CREDENTIALS'
  | 'REAUTH_REQUIRED'
  | 'INVALID_REQUEST'
  | 'SESSION_UNAVAILABLE'
  | 'UPSTREAM_UNAVAILABLE';
