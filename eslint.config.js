// Linting: real mistakes only (unused or undefined names, duplicate keys, unreachable code…), not style. `npm run lint`
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

const shared = {
  ...js.configs.recommended.rules,
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true, varsIgnorePattern: '^_' }],
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-control-regex': 'off', // deliberate: text from people is stripped of control characters
};

export default [
  { ignores: ['dist/', 'node_modules/', 'data/', 'test-results/', 'docs/'] },
  // server, shared code, scripts and tests run on Node
  { files: ['server/**/*.js', 'shared/**/*.js', 'scripts/**/*.js', 'test/**/*.js', 'test/**/*.mjs', 'vite.config.js', 'eslint.config.js'], languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: globals.node }, rules: shared },
  // the browser checks send small functions into the page (document, window…) as well as running on Node
  { files: ['test/e2e/**'], languageOptions: { globals: { ...globals.node, ...globals.browser } } },
  // the dashboard runs in the browser
  {
    files: ['web/src/**/*.{js,jsx}'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', parserOptions: { ecmaFeatures: { jsx: true } }, globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: { ...shared, 'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'warn', 'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true, varsIgnorePattern: '^_|^[A-Z]' }] },
  },
];
