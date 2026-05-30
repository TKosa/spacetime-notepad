import { defineConfig } from 'vite';

const enableBuildSourcemap = process.env.VITE_BUILD_SOURCEMAP === 'true';

export default defineConfig({
  logLevel: 'warn',
  build: {
    outDir: 'dist',
    sourcemap: enableBuildSourcemap,
    rollupOptions: {
      input: {
        notepad: 'index.html'
      }
    }
  }
});
