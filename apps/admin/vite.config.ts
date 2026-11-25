import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.VITE_API_PROXY_TARGET || "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
  build: {
    target: "es2022",
    // D-17: production ships no sourcemaps (they were served from
    // dist/ via the Worker ASSETS binding) and splits the vendor
    // code out of the initial chunk, so a one-line app change does
    // not invalidate the whole chunk's browser cache.
    sourcemap: false,
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // D-17: function form — the object form left vendor-react
        // EMPTY (react/react-dom stayed in the index chunk; the
        // tanstack packages split fine but react did not). Match on
        // the resolved node_modules path. "react/" with the trailing
        // slash must not swallow react-dom/react-router, and
        // scheduler rides with react-dom.
        manualChunks: (id: string) => {
          if (
            id.includes("node_modules/react-dom") ||
            id.includes("node_modules/react/") ||
            id.includes("node_modules/scheduler")
          )
            return "vendor-react";
          if (id.includes("node_modules/@tanstack/")) return "vendor-tanstack";
          return undefined;
        },
      },
    },
  },
});
