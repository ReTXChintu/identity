import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Served by the identity server at /admin (routes/admin.ts); the API is the
// same origin, so in development proxy it to a running server.
export default defineConfig({
  base: "/admin/",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
  server: {
    port: 5174,
    proxy: { "/admin/api": "http://127.0.0.1:50011", "/admin/theme.css": "http://127.0.0.1:50011" },
  },
});
