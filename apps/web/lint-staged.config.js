export default {
  '**/*.{ts,tsx}': () => 'pnpm type-check',
  '**/*.{js,jsx,ts,tsx}': ['prettier --write', 'pnpm lint:fix'],
  '*.{json,md,mdx,yml,css}': 'prettier --write',
};
