// @ts-check
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores(['node_modules/**', 'dist/**', 'coverage/**']),
  js.configs.recommended,
  // Regras com informação de tipos: é o que permite detectar promessas não
  // aguardadas e comparações impossíveis — exatamente a classe de erro que
  // mais custa em código financeiro assíncrono.
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.mjs'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        { allowExpressions: false, allowTypedFunctionExpressions: true },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      // Descartar uma chave por desestruturação é intencional, não um
      // descuido — é como se omite um atributo imutável.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { ignoreRestSiblings: true, argsIgnorePattern: '^_' },
      ],
    },
  },
  // Módulos do Nest e módulos de teste são classes sem membros por desenho:
  // o decorator é que carrega a informação.
  {
    files: ['src/**/*.module.ts', 'test/**/*.spec.ts'],
    rules: { '@typescript-eslint/no-extraneous-class': 'off' },
  },
  prettier,
]);
