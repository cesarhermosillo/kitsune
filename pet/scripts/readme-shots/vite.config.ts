// Dev-only Vite config for the README screenshot harness (`npm run readme-shots`).
// Serves the real pet (index.html + src/main.ts) with Tauri stubbed and a fake daemon.
// Not part of the production build: vite.config.ts only bundles index.html and preview.html.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = fileURLToPath(new URL(".", import.meta.url));
const petRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  root: petRoot,
  clearScreen: false,
  logLevel: "error",
  server: { port: Number(process.env.SHOTS_PORT ?? 5199), strictPort: true, host: "127.0.0.1" },
  resolve: {
    alias: [{ find: /^@tauri-apps\/api\/(core|event|window)$/, replacement: `${here}tauri-stub.ts` }],
  },
  plugins: [
    {
      name: "readme-shots-entry",
      // Same index.html (same CSS/DOM), but booted through the harness so the fakes load first.
      transformIndexHtml(html, ctx) {
        return ctx.path === "/index.html" ? html.replace("/src/main.ts", "/scripts/readme-shots/harness.ts") : html;
      },
    },
  ],
});
