// Minimal ESLint flat config for Phase 1.
// React, Next.js, and TypeScript linting are deferred to Phase 2 - the goal
// here is to get the toolchain green so CI can run. The full set of plugins
// (eslint-plugin-react, react-hooks, jsx-a11y, prettier) was dropped with
// the starter boilerplate; add them back when the app starts growing UI.
//
// T-A11Y-LINT (2026-09-16): the app is now growing UI, so jsx-a11y is back.
// It is the only AUTOMATED accessibility check in this repo - nothing else
// (not tsc, not vitest) can see a missing alt, an unlabelled control, or a
// click handler on a non-interactive element. Only a few rules are enabled
// below, chosen deliberately rather than whole-config, so the signal stays
// honest instead of becoming a wall of noise nobody reads.

import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import jsxA11y from 'eslint-plugin-jsx-a11y';

export default [
  js.configs.recommended,
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      '.next/**',
      'coverage/**',
      'src/test/e2e/**',
      'public/sw.js',
    ],
  },
  {
    files: ['**/*.{ts,tsx,js,jsx}'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      parser: tsParser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        React: 'readonly',
        JSX: 'readonly',
        console: 'readonly',
        process: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      'jsx-a11y': jsxA11y,
    },
    rules: {
      'no-unused-vars': 'off',
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': 'off',

      // Errors: these are correctness bugs, not style preferences.
      'jsx-a11y/alt-text': 'error',
      'jsx-a11y/aria-props': 'error',
      'jsx-a11y/aria-proptypes': 'error',
      'jsx-a11y/aria-unsupported-elements': 'error',
      'jsx-a11y/role-has-required-aria-props': 'error',
      'jsx-a11y/role-supports-aria-props': 'error',
      // A click handler on a non-interactive element is unreachable by
      // keyboard. This is the rule that catches the <div onClick> pattern the
      // frontend skill warns about.
      'jsx-a11y/click-events-have-key-events': 'error',
      'jsx-a11y/no-static-element-interactions': 'error',
      'jsx-a11y/no-noninteractive-element-interactions': 'error',
      'jsx-a11y/label-has-associated-control': 'error',
      'jsx-a11y/no-autofocus': 'error',

      // Warn: real but sometimes intentional (e.g. a wrapper delegating to a
      // labelled child), so they surface without blocking.
      'jsx-a11y/anchor-is-valid': 'warn',
      'jsx-a11y/tabindex-no-positive': 'warn',
      // OFF, and this one needs justifying because it looks like laziness.
      // `role="list"` on a <ul> is technically redundant, and this rule fires on
      // it - but Tailwind's preflight sets `list-style: none` on ul/ol, and
      // Safari/VoiceOver DROPS list semantics entirely for a list with
      // `list-style: none` (unless nested in <nav>). So without the explicit
      // role, a screen reader user loses "list, N items" on every list in the
      // app. The redundant-looking attribute is the fix; the rule is wrong here.
      // Re-enable only if the preflight list-reset is ever removed.
      'jsx-a11y/no-redundant-roles': 'off',
    },
  },
];

