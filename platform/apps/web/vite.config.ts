import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  base: "/enterprise/",
  plugins: [react()],
  server: {
    fs: {
      allow: [root, resolve(root, "../../../node_modules")],
      deny: [
        ".env",
        ".env.*",
        "*.{crt,pem,key}",
        "**/.git/**",
        "**/.state/**",
        "**/*.sqlite*",
        "**/*.db*",
        "**/private/**",
      ],
    },
    port: 5173,
    host: "127.0.0.1",
    strictPort: true,
    proxy: {
      "/enterprise/api": {
        target: "http://127.0.0.1:4160",
        changeOrigin: false,
      },
      "/enterprise/reports": {
        target: "http://127.0.0.1:4160",
        changeOrigin: false,
      },
    },
  },
  build: { outDir: "dist", sourcemap: true },
});
