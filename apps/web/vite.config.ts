import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // relative asset paths so the same build works from the daemon and inside Tauri
  base: './',
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://localhost:4747' },
  },
})
