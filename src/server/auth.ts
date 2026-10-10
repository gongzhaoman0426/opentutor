import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from './errors';

const COOKIE = 'opentutor_session';
function equal(a: string, b: string) {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}
function requestAddress(request: Request) {
  // Next may canonicalize request.url to localhost although the browser used
  // 127.0.0.1. Host is the HTTP authority; forwarded host headers are not trusted.
  const canonical = new URL(request.url);
  const host = request.headers.get('host');
  if (!host) return canonical;
  let address: URL;
  try { address = new URL(`${canonical.protocol}//${host}`); }
  catch { throw new AppError(403, 'HOST_REJECTED', '访问地址无效'); }
  if (address.username || address.password || address.pathname !== '/' || address.search || address.hash || /[\s,\\/@]/.test(host)) throw new AppError(403, 'HOST_REJECTED', '访问地址无效');
  return address;
}
export function verifyOrigin(request: Request) {
  const origin = request.headers.get('origin'); const address = requestAddress(request);
  const allowed = new Set([address.origin]);
  // A configured public URL supports a TLS-terminating reverse proxy without
  // deriving trust from arbitrary X-Forwarded-Host/Proto request headers.
  if (process.env.OPENTUTOR_BASE_URL) {
    try { const base = new URL(process.env.OPENTUTOR_BASE_URL); if (['http:', 'https:'].includes(base.protocol)) allowed.add(base.origin); }
    catch { /* A malformed configuration never expands the origin allowlist. */ }
  }
  if (origin && !allowed.has(origin)) throw new AppError(403, 'ORIGIN_REJECTED', '跨站请求已拒绝');
  const site = request.headers.get('sec-fetch-site');
  if (site === 'cross-site') throw new AppError(403, 'ORIGIN_REJECTED', '跨站请求已拒绝');
}
export function authenticate(request: Request) {
  verifyOrigin(request);
  const token = process.env.AUTH_TOKEN;
  if (!token) {
    const hostname = requestAddress(request).hostname;
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname)) throw new AppError(403, 'LOCAL_ONLY', '远程访问需要服务端配置 AUTH_TOKEN');
    return;
  }
  const bearer = request.headers.get('authorization');
  if (bearer?.startsWith('Bearer ') && equal(bearer.slice(7), token)) return;
  const raw = request.headers.get('cookie')?.split(';').map(v => v.trim()).find(v => v.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (raw) {
    const [expires, signature] = raw.split('.');
    if (/^\d+$/.test(expires) && Number(expires) > Date.now() && equal(signature || '', createHmac('sha256', token).update(expires).digest('hex'))) return;
  }
  throw new AppError(401, 'AUTH_REQUIRED', '请输入服务端配置的访问令牌');
}
export function sessionCookie(token: string, secure: boolean) {
  if (!process.env.AUTH_TOKEN || !equal(token, process.env.AUTH_TOKEN)) throw new AppError(401, 'INVALID_TOKEN', '访问令牌不正确');
  const expires = String(Date.now() + 7 * 86400000);
  const signature = createHmac('sha256', process.env.AUTH_TOKEN).update(expires).digest('hex');
  return `${COOKIE}=${expires}.${signature}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800${secure ? '; Secure' : ''}`;
}
