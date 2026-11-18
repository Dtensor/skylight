import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

const SHARED = resolve(__dirname, "../shared/src");
const SERVER = process.env.SERVER_URL ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@shared": SHARED },
  },
  server: {
    host: true, // expose dev server on LAN too
    fs: { allow: [resolve(__dirname, ".."), SHARED] },
    proxy: {
      "/api": { target: SERVER, changeOrigin: true },
      "/ws": { target: SERVER, ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // The projector's Android WebView is older than a desktop browser.
    target: "chrome66",
    rollupOptions: {
      input: {
        index: resolve(__dirname, "index.html"),
        control: resolve(__dirname, "control.html"),
        wall: resolve(__dirname, "wall.html"),
      },
    },
  },
});
