import type { WebSession } from './types.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const decodeSecret = (secret: string): Uint8Array => {
  const normalized = secret.trim();
  if (/^[a-f0-9]{64}$/i.test(normalized)) {
    return Uint8Array.from(normalized.match(/.{2}/g) ?? [], (byte) => parseInt(byte, 16));
  }

  const base64 = normalized.replaceAll('-', '+').replaceAll('_', '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

const importKey = async (secret: string): Promise<CryptoKey> => {
  const raw = decodeSecret(secret);
  if (raw.byteLength !== 32) throw new Error('Invalid session key');
  const keyBytes = new Uint8Array(raw.byteLength);
  keyBytes.set(raw);
  return crypto.subtle.importKey('raw', keyBytes.buffer as ArrayBuffer, 'AES-GCM', false, [
    'encrypt',
    'decrypt'
  ]);
};

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
};

const fromBase64Url = (value: string): Uint8Array => {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

export const encryptSession = async (session: WebSession, secret: string): Promise<string> => {
  const key = await importKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(session));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return toBase64Url(new Uint8Array([...iv, ...new Uint8Array(ciphertext)]));
};

export const decryptSession = async (
  encrypted: string,
  secret: string,
  now = Date.now()
): Promise<WebSession | null> => {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(encrypted)) return null;
    const payload = fromBase64Url(encrypted);
    if (toBase64Url(payload) !== encrypted) return null;
    if (payload.byteLength <= 12) return null;
    const iv = payload.slice(0, 12);
    const ciphertext = payload.slice(12);
    const key = await importKey(secret);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    const session = JSON.parse(decoder.decode(plaintext)) as WebSession;
    if (
      session.version !== 1 ||
      !session.accessToken ||
      !session.user?.campus ||
      !Number.isFinite(session.expiresAt) ||
      !Number.isFinite(session.issuedAt) ||
      session.issuedAt > now + 60_000 ||
      now - session.issuedAt > 12 * 60 * 60 * 1000
    ) {
      return null;
    }
    return session;
  } catch {
    return null;
  }
};
