import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    exclude: ['scribe.js-ocr', '@scribe.js/tesseract.js']
  },
  assetsInclude: ['**/*.woff', '**/*.woff2', '**/*.ttf'],
  resolve: {
    alias: {
      'node_modules/.vite/fonts': 'node_modules/scribe.js-ocr/fonts'
    }
  },
  build: {
    rollupOptions: {
      external: ['@scribe.js/tesseract.js'],
      output: {
        manualChunks: {
          scribe: ['scribe.js-ocr']
        }
      }
    },
    commonjsOptions: {
      include: [/scribe\.js-ocr/, /node_modules/]
    }
  },
  define: {
    global: 'globalThis'
  }
})
