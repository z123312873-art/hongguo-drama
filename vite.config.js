// 红果短剧 2.8：前端构建配置，运行版本由 package.json 提供。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const root = path.dirname(fileURLToPath(import.meta.url));
const scriptJsx = path.resolve(root, 'src/script-jsx');

function traditionalJsx() {
  return {
    name: 'traditional-jsx',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || importer.includes(`${path.sep}script-jsx${path.sep}`)) return null;
      if (source === 'react/jsx-runtime') return path.join(scriptJsx, 'jsx-runtime.js');
      if (source === 'react/jsx-dev-runtime') return path.join(scriptJsx, 'jsx-dev-runtime.js');
      return null;
    },
  };
}

export default defineConfig({
  plugins: [traditionalJsx(), react(), {
    name: 'development-csp',
    apply: 'serve',
    // React Refresh injects an inline preamble only in the development server.
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
  },
});
