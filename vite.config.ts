import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
  plugins: [react()],
  publicDir: "static",
  build: { outDir: "dist/client" },
  server: {
    host: "127.0.0.1",
    port: 7412,
    strictPort: true,
    proxy: { "/api": { target: "http://127.0.0.1:7413", changeOrigin: false } },
  },
})
