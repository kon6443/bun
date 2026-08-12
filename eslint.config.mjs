import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettierConfig,
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        sourceType: 'module',
      },
    },
    rules: {
      // NestJS 프로젝트 권장 규칙
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      // CLAUDE.md Never 표의 "타입 억제 금지"를 도구로 강제한다 (선언만 두면 지켜지지 않는다).
      // 불가피한 경우에만 eslint-disable + 사유 주석을 남긴다.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      // 필요에 따라 완화
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-inferrable-types': 'off',
    },
  },
  {
    // 테스트 코드도 린트 대상이다 — 프로덕션 코드와 같은 품질 기준을 적용한다.
    ignores: ['dist/', 'node_modules/', '*.js', '*.mjs'],
  },
);
