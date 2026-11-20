// Minimal ESLint flat config for Phase 1.
// Full @typescript-eslint plugin set lands with the real app code in Phase 2.
import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import zodParsedBody from './eslint-rules/zod-parsed-body.mjs';

export default [
  js.configs.recommended,
  {
    ignores: ['node_modules/**', 'dist/**', 'coverage/**', 'test/e2e/**'],
  },
  {
    files: ['**/*.{ts,tsx,js,jsx}'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      parser: tsParser,
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
    plugins: {
      local: { rules: { 'zod-parsed-body': zodParsedBody } },
    },
    rules: {
      'no-unused-vars': 'off',
      'no-undef': 'off',
      // Every request body in this app is `unknown` + Zod, so the parse call is
      // the only validation there is. A handler without one is an open door.
      'local/zod-parsed-body': 'error',
    },
  },
];
