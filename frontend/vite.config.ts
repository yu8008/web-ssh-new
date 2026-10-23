import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { terminalContrastPatch } from "./build/terminalContrastPatch";

export default defineConfig({
  plugins: [terminalContrastPatch(), react()],
  optimizeDeps: { exclude: ["@xterm/xterm", "@xterm/addon-webgl"] },
  server: {
    port: 5173
  },
  build: {
    outDir: "../backend/frontend/dist",
    emptyOutDir: true
  }
});
