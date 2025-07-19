import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    //include: ['scribe.js-ocr'], //TODO: delete this?
    exclude: ['scribe.js-ocr', '@scribe.js/tesseract.js']
  },
  assetsInclude: ['**/*.woff', '**/*.woff2', '**/*.ttf'],
  resolve: {
    alias: {
      // Map font imports to the actual font files in the scribe.js-ocr package TODO: delete this?
      'node_modules/.vite/fonts': 'node_modules/scribe.js-ocr/fonts'
    }
  },
  build: {
    rollupOptions: {
      external: ['@scribe.js/tesseract.js']
    }
  }
})
