import preact from '@preact/preset-vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: preact(),
  resolve: {
    alias: {
      react: 'preact/compat',
      'react-dom': 'preact/compat',
      'react/jsx-runtime': 'preact/jsx-runtime',
    },
  },
  test: {
    // Playwright owns tests/*.spec.js; vitest runs the unit tests in src/ and
    // service/
    include: ['src/**/*.test.{js,jsx}', 'service/**/*.test.js'],
    exclude: ['**/node_modules/**'],
  },
});
