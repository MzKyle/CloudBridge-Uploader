import js from '@eslint/js'
import tseslint from 'typescript-eslint'

const globals = {
  Buffer: 'readonly',
  console: 'readonly',
  clearInterval: 'readonly',
  clearTimeout: 'readonly',
  document: 'readonly',
  EventSource: 'readonly',
  fetch: 'readonly',
  File: 'readonly',
  HTMLElement: 'readonly',
  HTMLInputElement: 'readonly',
  localStorage: 'readonly',
  module: 'readonly',
  navigator: 'readonly',
  process: 'readonly',
  React: 'readonly',
  require: 'readonly',
  setInterval: 'readonly',
  setTimeout: 'readonly',
  URL: 'readonly',
  window: 'readonly'
}

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'out/**',
      'node_modules/**',
      '.tools/**',
      '.acceptance/**',
      '.history/**',
      '__MACOSX/**',
      'coverage/**',
      'release/**',
      'index-*.js',
      '*.config.js',
      '*.config.cjs'
    ]
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals
    }
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: {
          jsx: true
        }
      },
      globals
    },
    rules: {
      'no-undef': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_'
        }
      ]
    }
  }
)
