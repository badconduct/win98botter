import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],

  // In dev (npm run dev) proxy all API calls to the running relay server
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
      "/chat": "http://localhost:3000",
      "/sse": { target: "http://localhost:3000", changeOrigin: true },
      "/history": "http://localhost:3000",
      "/changes": "http://localhost:3000",
      "/undo": "http://localhost:3000",
      "/control": "http://localhost:3000",
      "/health": "http://localhost:3000",
    },
  },

  build: {
    // Output goes to relay-server/public/ so Fastify serves it
    outDir: path.resolve(__dirname, "../public"),
    emptyOutDir: true,
  },
});
