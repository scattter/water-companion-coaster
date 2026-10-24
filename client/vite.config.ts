import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  build: { outDir: ['android', 'windows'].includes(process.env.TAURI_ENV_PLATFORM ?? '') ? `dist/${process.env.TAURI_ENV_PLATFORM}` : 'dist' },
  clearScreen: false,
  server: { host: '127.0.0.1', port: 1420, strictPort: true },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
});
