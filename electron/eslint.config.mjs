import eslint from '@eslint/js';
import parser from '@typescript-eslint/parser';
import typescript from '@typescript-eslint/eslint-plugin';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default [
  {
    ignores: ['.webpack/**', '.swiftpm-cache/**', '.minecraft-package/**', 'minecraft-runtime/vendor/**', 'minecraft-runtime/node_modules/**', 'coverage/**', 'node_modules/**', 'out/**', 'playwright-report/**', 'test-results/**'],
  },
  eslint.configs.recommended,
  {
    // The isolated runtime is CommonJS. Keep its Node globals scoped here so
    // renderer code does not silently gain require/module or other Node APIs.
    files: ['minecraft-runtime/**/*.{js,cjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: globals.node,
    },
    // Older runtime files declare their environment with /* global ... */.
    // Do not treat those declarations as source-level variable redeclarations.
    rules: { 'no-redeclare': ['error', { builtinGlobals: false }] },
  },
  {
    files: ['*.mjs', 'scripts/**/*.mjs', 'minecraft-runtime/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.nodeBuiltin,
    },
    rules: { 'no-redeclare': ['error', { builtinGlobals: false }] },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      globals: {
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        Buffer: 'readonly',
        DOMException: 'readonly',
        Electron: 'readonly',
        Element: 'readonly',
        HTMLCanvasElement: 'readonly',
        HTMLElement: 'readonly',
        MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: 'readonly',
        MAIN_WINDOW_WEBPACK_ENTRY: 'readonly',
        NodeJS: 'readonly',
        OVERLAY_WINDOW_PRELOAD_WEBPACK_ENTRY: 'readonly',
        OVERLAY_WINDOW_WEBPACK_ENTRY: 'readonly',
        Response: 'readonly',
        ResizeObserver: 'readonly',
        TextDecoder: 'readonly',
        URL: 'readonly',
        __dirname: 'readonly',
        clearInterval: 'readonly',
        clearTimeout: 'readonly',
        crypto: 'readonly',
        document: 'readonly',
        fetch: 'readonly',
        navigator: 'readonly',
        process: 'readonly',
        setInterval: 'readonly',
        setTimeout: 'readonly',
        structuredClone: 'readonly',
        window: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': typescript,
      'react-hooks': reactHooks,
    },
    rules: {
      ...typescript.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
];
