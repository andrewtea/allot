import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const SESSION_SECONDS = 12 * 60 * 60;
const digest = (value: string) => createHash('sha256').update(value).digest();
export const sameSecret = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

export function sessionToken(secret: string, expires = Date.now() + SESSION_SECONDS * 1000) {
  const payload = `researcher.${expires}`;
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

export function authenticated(request: IncomingMessage, secret: string) {
  const token = request.headers.cookie?.split('; ').find(c => c.startsWith('allot_session='))?.slice(14);
  if (!token) return false;
  const expires = Number(token.split('.')[1]);
  return Number.isSafeInteger(expires) && expires > Date.now() && sameSecret(token, sessionToken(secret, expires));
}

export function sessionCookie(value: string, secure: boolean, age = SESSION_SECONDS) {
  return `allot_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`;
}
