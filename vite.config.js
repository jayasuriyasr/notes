import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    // Split the admin surface out of the public bundle. A reader who never
    // signs in should not download the Markdown editor, and the editor is
    // by far the heaviest thing in the app.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (/react-markdown|remark|rehype|micromark|mdast|hast|unist|vfile|highlight\.js|lowlight/.test(id)) {
            return 'markdown';
          }
          if (/@supabase/.test(id)) return 'supabase';
          if (/react-router|@remix-run/.test(id)) return 'router';
          if (/[\\/]react(-dom)?[\\/]|scheduler/.test(id)) return 'react';
        },
      },
    },
  },
});
