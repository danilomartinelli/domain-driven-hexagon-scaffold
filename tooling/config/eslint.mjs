import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

const restrictedSyntax = [
  { selector: 'LabeledStatement', message: 'Labels obscure control flow.' },
  {
    selector: 'WithStatement',
    message: '`with` is disallowed in strict mode.',
  },
  {
    selector: "MethodDefinition[kind='set']",
    message: 'Property setters are not allowed',
  },
];

export default defineConfig(
  {
    files: [
      'src/**/*.ts',
      'tests/**/*.ts',
      'scripts/**/*.ts',
      'database/**/*.{mjs,ts}',
      '*.mjs',
      'tooling/**/*.mjs',
    ],
    extends: [js.configs.recommended, tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname + '/../..',
      },
    },
    rules: {
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      'no-restricted-syntax': ['error', ...restrictedSyntax],
    },
  },
  {
    files: [
      'src/apps/*/tests/component/**/*.ts',
      'tests/**/*.ts',
      'scripts/tests/{environment,test-database-runner}.test.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...restrictedSyntax,
        {
          selector: 'TryStatement > BlockStatement.finalizer AwaitExpression',
          message:
            'Use withCleanup from scripts/tests/cleanup.ts to preserve operation and cleanup failures.',
        },
      ],
    },
  },
);
