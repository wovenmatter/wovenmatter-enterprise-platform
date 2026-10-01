#!/usr/bin/env node
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
const toolkit = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.argv[2] ?? process.cwd());
if (process.argv.length > 3) throw new Error("Usage: wme-build [directory]");
await build({
  root,
  configFile: false,
  plugins: [react()],
  base: "./",
  resolve: {
    alias: ["react", "react-dom", "lucide-react"].map((name) => ({
      find: name,
      replacement: join(toolkit, "node_modules", name),
    })),
  },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
});
