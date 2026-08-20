// @ts-check
import { defineConfig } from 'astro/config';

import cloudflare from '@astrojs/cloudflare';

import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  site: 'https://recipenutritioncalc.com',
  output: 'server',
  security: {
    // Astro's action body limit defaults to 1MB, well under the 8MB photo-upload budget the rest of
    // the app is built around (see MAX_IMAGE_BYTES in src/actions/index.ts and MAX_UPLOAD_BYTES in
    // PhotoUploadForm.astro) — without raising it, any camera photo the client didn't need to resize
    // (anything already under PhotoUploadForm's 1.5MB SKIP_RESIZE_BELOW_BYTES threshold) or that
    // resizing still left over 1MB was rejected with a raw "Request body exceeds 1048576 bytes" error
    // before the app's own friendly oversize message ever had a chance to fire. A little headroom
    // over 8MB covers multipart/form-data's encoding overhead on top of the raw image bytes.
    actionBodySizeLimit: 9 * 1024 * 1024,
  },
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