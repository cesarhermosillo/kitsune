import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { rollupOptions: { input: { main: "index.html", preview: "preview.html" } } },
  test: { globals: true, environment: "node", include: ["src/**/*.test.ts", "art/**/*.test.ts"] },
});
