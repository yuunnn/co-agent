import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  server: { watch: { ignored: ["**/src-tauri/**"] } },
  build: {
    outDir: path.resolve("dist/web"),
    emptyOutDir: true,
  },
});
