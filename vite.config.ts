import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
  plugins: [react()],
  publicDir: "static",
  build: { outDir: "dist/client" },
  server: {
    port: 7412,
    proxy: { "/api": "http://127.0.0.1:7413" },
  },
})
