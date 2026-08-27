import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [react()],
    base: './',
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      // Default include covers node_modules only; add the single local
      // CommonJS module the renderer imports by name ([\\/] keeps the
      // pattern separator-safe on Windows).
      commonjsOptions: {
        include: [/node_modules/, /[\\/]shared[\\/]media-translations\.js$/, /[\\/]shared[\\/]shorts-state\.js$/, /[\\/]shared[\\/]shorts-export-contract\.js$/, /[\\/]shared[\\/]help-catalog\.js$/],
      },
    },
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY || ''),
      __VANISCRIPT_BUILD_ID__: JSON.stringify(env.VANISCRIPT_BUILD_ID || new Date().toISOString()),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      port: 3000,
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});
