// @ts-check
import { defineConfig } from 'astro/config';

import cloudflare from '@astrojs/cloudflare';

import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  output: 'server',
  adapter: cloudflare({
    // Workers AI (the `AI` binding) has no local emulation, so the Cloudflare Vite
    // plugin otherwise tries to open a remote proxy session to the real Workers AI
    // service on every dev/build run, which requires Cloudflare credentials we don't
    // have here. Disabling remote bindings keeps local dev/build fully working for
    // everything except the photo/OCR upload path, which only needs real credentials
    // once actually deployed (or via `wrangler login` + remote bindings re-enabled).
    remoteBindings: false,
  }),

  vite: {
    plugins: [tailwindcss()],
    server: {
      watch: {
        // Miniflare's local KV/cache/observability state lives under .wrangler/state and
        // is rewritten on every request; without this the file watcher treats those writes
        // as source changes and reloads the whole dev server mid-request.
        ignored: ['**/.wrangler/**'],
      },
    },
  }
});