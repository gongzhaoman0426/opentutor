import { describe, expect, it, afterEach } from 'vitest';
import { parseRange, detectImageMime } from '../src/server/artifacts';
import { authenticate, sessionCookie, verifyOrigin } from '../src/server/auth';
import { jsonBody } from '../src/server/http';

const oldToken = process.env.AUTH_TOKEN;
const oldBase = process.env.OPENTUTOR_BASE_URL;
afterEach(() => { if (oldToken === undefined) delete process.env.AUTH_TOKEN; else process.env.AUTH_TOKEN = oldToken; if (oldBase === undefined) delete process.env.OPENTUTOR_BASE_URL; else process.env.OPENTUTOR_BASE_URL = oldBase; });
describe('private media and request boundaries', () => {
  it('serves valid byte ranges and clamps an oversized end', () => {
    expect(parseRange(null, 100)).toBe(null);
    expect(parseRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
    expect(parseRange('bytes=-20', 100)).toEqual({ start: 80, end: 99 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=90-200', 100)).toEqual({ start: 90, end: 99 });
    for (const bad of ['bytes=100-', 'bytes=20-10', 'bytes=0-1,4-8', 'bytes=-0', 'bytes=-', 'wat']) expect(() => parseRange(bad, 100)).toThrow();
  });
  it('identifies real image magic instead of trusting filenames or MIME', () => {
    expect(detectImageMime(new Uint8Array([137,80,78,71,13,10,26,10]))).toBe('image/png');
    expect(detectImageMime(new Uint8Array([255,216,255,224]))).toBe('image/jpeg');
    expect(detectImageMime(Buffer.from('RIFF1234WEBP'))).toBe('image/webp');
    expect(detectImageMime(Buffer.from('<svg onload="evil">'))).toBe(null);
  });
  it('accepts only loopback without a configured token and rejects cross-site traffic', () => {
    delete process.env.AUTH_TOKEN;
    expect(() => authenticate(new Request('http://127.0.0.1:3000/api/projects'))).not.toThrow();
    expect(() => authenticate(new Request('https://public.example/api/projects'))).toThrow('AUTH_TOKEN');
    expect(() => authenticate(new Request('http://127.0.0.1:3000/api/projects', { headers: { origin: 'https://other.example' } }))).toThrow('跨站');
  });
  it('uses the same secret for bearer and signed HttpOnly sessions', () => {
    process.env.AUTH_TOKEN = 'server-test-secret';
    expect(() => authenticate(new Request('http://127.0.0.1/api/projects'))).toThrow();
    expect(() => authenticate(new Request('http://127.0.0.1/api/projects', { headers: { authorization: 'Bearer server-test-secret' } }))).not.toThrow();
    const cookie = sessionCookie('server-test-secret', true);
    expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('Secure');
    expect(() => authenticate(new Request('http://127.0.0.1/api/projects', { headers: { cookie } }))).not.toThrow();
    expect(() => sessionCookie('bad', false)).toThrow();
    expect(() => authenticate(new Request('http://127.0.0.1/api/projects', { headers: { cookie: cookie.replace(/\.([a-f0-9])/, '.x') } }))).toThrow();
  });
  it('checks the actual HTTP host when Next canonicalizes the internal URL', () => {
    delete process.env.AUTH_TOKEN; delete process.env.OPENTUTOR_BASE_URL;
    const request = (host: string, origin: string) => new Request('http://localhost:3330/api/projects', { method: 'POST', headers: { host, origin, 'sec-fetch-site': 'same-origin' } });
    expect(() => authenticate(request('127.0.0.1:3330', 'http://127.0.0.1:3330'))).not.toThrow();
    expect(() => authenticate(request('127.0.0.1:3330', 'https://example.com'))).toThrow('跨站');
    expect(() => authenticate(request('127.0.0.1:3330', 'http://127.0.0.1:3331'))).toThrow('跨站');
    expect(() => authenticate(request('public.example', 'http://public.example'))).toThrow('AUTH_TOKEN');
    expect(() => authenticate(request('localhost:3330@public.example', 'http://public.example'))).toThrow('地址');
  });
  it('accepts only an explicitly configured proxy origin, not spoofed forwarded headers', () => {
    process.env.AUTH_TOKEN = 'proxy-test-secret'; process.env.OPENTUTOR_BASE_URL = 'https://studio.example';
    expect(() => verifyOrigin(new Request('http://localhost:3330/api/session', { headers: { host: 'studio.example', origin: 'https://studio.example' } }))).not.toThrow();
    expect(() => verifyOrigin(new Request('http://localhost:3330/api/session', { headers: { host: '127.0.0.1:3330', origin: 'https://attacker.example', 'x-forwarded-host': 'attacker.example', 'x-forwarded-proto': 'https' } }))).toThrow('跨站');
  });
  it('bounds chunked JSON bodies independently of Content-Length', async () => {
    const request = new Request('http://localhost/api', { method: 'POST', body: JSON.stringify({ text: 'a'.repeat(100) }) });
    await expect(jsonBody(request, 30)).rejects.toThrow('请求内容过大');
    await expect(jsonBody(new Request('http://localhost/api', { method: 'POST', body: '{bad' }))).rejects.toThrow('JSON');
  });
});
