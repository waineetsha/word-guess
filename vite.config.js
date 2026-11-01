import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  if (mode === 'production') {
    const required = ['VITE_FIREBASE_API_KEY', 'VITE_FIREBASE_AUTH_DOMAIN', 'VITE_FIREBASE_PROJECT_ID', 'VITE_FIREBASE_APP_ID'];
    const missing = required.filter((key) => !env[key] || env[key].includes('replace-me') || env[key].includes('your-project'));
    if (missing.length) throw new Error(`Missing Firebase web configuration: ${missing.join(', ')}`);
  }
  return {
    base: './',
    build: { outDir: 'dist', emptyOutDir: true },
  };
});
