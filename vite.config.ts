import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const host = process.env.TAURI_DEV_HOST;

// Without an explicit address vite binds to `localhost`, which on Windows
// resolves to ::1 — while the Tauri CLI polls devUrl over IPv4 and waits
// forever for a server that is listening one protocol over. Both ends name
// 127.0.0.1 now, so the answer never depends on how localhost resolves.
const LOOPBACK = "127.0.0.1";

export default defineConfig({
  plugins: [vue()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || LOOPBACK,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
