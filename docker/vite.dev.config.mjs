import { createRequire } from 'node:module';
const require = createRequire('/workspace/frontend/package.json');
const { defineConfig, loadConfigFromFile, mergeConfig } = await import(require.resolve('vite'));
const original = await loadConfigFromFile({ command: 'serve', mode: 'development' }, '/workspace/frontend/vite.config.ts', '/workspace/frontend', 'warn', undefined, 'runner');
if (!original) throw new Error('Frontend Vite configuration is required.');

import { isServerPath } from './development.mjs';
const proxy = { target: 'http://127.0.0.1:8084', changeOrigin: false, bypass: request => isServerPath(request.url) ? undefined : request.url };
export default defineConfig(mergeConfig(original.config, {
  server: {
    host: '0.0.0.0', port: 8083, strictPort: true,
    watch: { usePolling: true, interval: 500 },
    proxy: { '^/': proxy }
  }
}));
