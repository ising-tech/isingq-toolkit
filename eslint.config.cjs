'use strict';

const globals = require('globals');
const quality = require('./scripts/eslint-rules.cjs');

module.exports = [
  { ignores: ['node_modules/**', 'dist/**', 'coverage/**', 'output/**', 'video/**', 'docs/assets/**'] },
  {
    files: ['**/*.{js,cjs,mjs}'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: { ...globals.node, __ISINGQ_BUILD_RUNTIME_IDENTITY__: 'readonly' } },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    plugins: { quality },
    rules: {
      'quality/release-before-close': 'error',
      'quality/owned-lock-cleanup': 'error',
      'quality/no-throwing-fs-cleanup-in-finally': 'error',
      'no-unsafe-finally': 'error',
      'no-unsafe-optional-chaining': 'error',
      'no-async-promise-executor': 'error',
      'no-unreachable': 'error',
      'no-dupe-args': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-class-members': 'error',
      'no-self-assign': 'error',
      'no-undef': 'error',
      'no-unexpected-multiline': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
    },
  },
  {
    files: ['packages/core/src/index.js', 'packages/core/src/legacy-solve.js', 'packages/core/src/target-service.js'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'MemberExpression:matches([object.name="store"], [object.property.name="store"], [object.property.value="store"]):matches([property.name=/^(save|archive)$/], [property.value=/^(save|archive)$/])',
          message: '求解入口必须通过 solve-lifecycle.js 写入记录或归档，避免遗漏远端回执和覆盖较新的轮询结果。',
        },
        {
          selector: 'VariableDeclarator:matches([init.name="store"], [init.property.name="store"], [init.property.value="store"]) > ObjectPattern > Property:matches([key.name=/^(save|archive)$/], [key.value=/^(save|archive)$/])',
          message: '不要解构求解存储的写入方法。求解入口必须使用 solve-lifecycle.js。',
        },
      ],
    },
  },
  { files: ['**/*.mjs'], languageOptions: { sourceType: 'module' } },
  { files: ['packages/core/src/target-config/client.js'], languageOptions: { globals: globals.browser } },
];
