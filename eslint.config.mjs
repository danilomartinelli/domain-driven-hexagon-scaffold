import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig({
  files: ['src/**/*.ts', 'tests/**/*.ts', 'database/**/*.mjs', '*.mjs'],
  extends: [js.configs.recommended, tseslint.configs.strictTypeChecked],
  languageOptions: {
    parserOptions: {
      projectService: true,
      tsconfigRootDir: import.meta.dirname,
    },
  },
  rules: {
    '@typescript-eslint/explicit-module-boundary-types': 'error',
    'no-restricted-syntax': [
      'error',
      { selector: 'LabeledStatement', message: 'Labels obscure control flow.' },
      {
        selector: 'WithStatement',
        message: '`with` is disallowed in strict mode.',
      },
      {
        selector: "MethodDefinition[kind='set']",
        message: 'Property setters are not allowed',
      },
    ],
  },
});
