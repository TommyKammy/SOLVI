import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      // Gitignore済みの実行・復元演習成果物。正本のソースは下のルールで検査する。
      '.local/**',
      // Next 15.5が自動生成するroutes型参照。手書きソースの検査は維持する。
      'apps/web/next-env.d.ts',
      '**/coverage/**',
      'docs/planning/**',
      'services/ai-advisor/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // ツールスクリプトはCLIとして直接実行するためconsole出力が正当
    files: ['tools/**/*.mjs'],
    rules: { 'no-console': 'off' },
  },
);
