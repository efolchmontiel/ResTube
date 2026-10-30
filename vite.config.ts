import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { modelsApiPlugin } from './server/modelsApi';
import { summarizeApiPlugin } from './server/summarizeApi';

export default defineConfig({
  plugins: [react(), modelsApiPlugin(), summarizeApiPlugin()],
  test: { environment: 'jsdom', setupFiles: './src/test/setup.ts', css: true },
});
