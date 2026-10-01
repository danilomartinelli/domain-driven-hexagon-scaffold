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

const containerRemovalSyntax = [
  {
    selector: [
      "ArrayExpression[elements.0.value='docker'][elements.1.value=/^(rm|remove)$/]",
      "ArrayExpression[elements.0.value='docker'][elements.1.value='container'][elements.2.value=/^(rm|remove)$/]",
      "CallExpression[arguments.0.value='docker'][arguments.1.elements.0.value=/^(rm|remove)$/]",
      "CallExpression[arguments.0.value='docker'][arguments.1.elements.0.value='container'][arguments.1.elements.1.value=/^(rm|remove)$/]",
      'CallExpression > Literal.arguments[value=/^docker\\s+(container\\s+)?(rm|remove)(\\s|$)/]',
      'ArrayExpression > Literal.elements[value=/^docker\\s+(container\\s+)?(rm|remove)(\\s|$)/]',
      'CallExpression > TemplateLiteral.arguments[quasis.0.value.cooked=/^docker\\s+(container\\s+)?(rm|remove)(\\s|$)/]',
    ].join(', '),
    message:
      'Use removeOwnedContainer from scripts/tests/owned-container.ts to verify ownership and remove the inspected ID.',
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
      'scripts/tests/**/*.ts',
    ],
    ignores: ['scripts/tests/owned-container.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...restrictedSyntax,
        ...containerRemovalSyntax,
      ],
    },
  },
  {
    files: [
      'src/apps/*/tests/component/**/*.ts',
      'tests/**/*.ts',
      'scripts/tests/{environment,test-database-runner,broker}.test.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...restrictedSyntax,
        ...containerRemovalSyntax,
        {
          selector: 'TryStatement > BlockStatement.finalizer AwaitExpression',
          message:
            'Use withCleanup from scripts/tests/cleanup.ts to preserve operation and cleanup failures.',
        },
        {
          selector:
            "CallExpression[callee.name='withCleanup'] > ArrayExpression.arguments > :matches(ArrowFunctionExpression, FunctionExpression) > BlockStatement > ExpressionStatement[expression.type='AwaitExpression'] ~ ExpressionStatement > AwaitExpression > CallExpression:matches([callee.property.name=/^(close|end|stop|destroy|shutdown)$/], [callee.name=/^(close|end|stop|destroy|shutdown)([A-Z_]|$)/])",
          message:
            'Use nested withCleanup so an earlier cleanup failure cannot skip closing this resource.',
        },
        {
          selector:
            "CallExpression[callee.name='withCleanup'] > ArrayExpression.arguments > :matches(ArrowFunctionExpression, FunctionExpression) :matches(ForOfStatement, ForInStatement, ForStatement, WhileStatement, DoWhileStatement) AwaitExpression > CallExpression[callee.property.name='purgeQueue']",
          message:
            'Register each queue purge separately with withCleanup and its own channel so a failure cannot skip other queues.',
        },
      ],
    },
  },
);
