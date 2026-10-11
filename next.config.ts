import type { NextConfig } from 'next';
const config: NextConfig = {
  serverExternalPackages: ['pg', 'bullmq', 'ioredis', '@openai/codex-sdk', '@remotion/renderer', '@remotion/bundler'],
  experimental: { proxyClientMaxBodySize: '26mb' },
};
export default config;
