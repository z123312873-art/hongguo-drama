
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { developmentCjs } from './scripts/vite-dev-cjs.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const scriptJsx = path.resolve(root, 'src/script-jsx');

// Vite hands importers over with forward slashes even on Windows, so compare
// on a normalized path instead of the platform separator.
export const isScriptJsxFile = file => /[/\\]script-jsx[/\\]/.test(String(file || ''));

function traditionalJsx() {
  return {
    name: 'traditional-jsx',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || isScriptJsxFile(importer)) return null;
      if (source === 'react/jsx-runtime') return path.join(scriptJsx, 'jsx-runtime.js');
      if (source === 'react/jsx-dev-runtime') return path.join(scriptJsx, 'jsx-dev-runtime.js');
      return null;
    },
  };
}

export default defineConfig({
  plugins: [traditionalJsx(), developmentCjs(), react(), {
    name: 'development-csp',
    apply: 'serve',

    transformIndexHtml: html => html.replace("script-src 'self';", "script-src 'self' 'unsafe-inline';")
      .replace("connect-src 'self'", "connect-src 'self' ws: wss:"),
  }],
  base: './',
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist-react',
    emptyOutDir: true,


    commonjsOptions: {
      include: [/node_modules/, /[/\\]src[/\\]native[/\\](?:account-(profile|session)|folder-rules)\.js$/],
    },
  },
});
