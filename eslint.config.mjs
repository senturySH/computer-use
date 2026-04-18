import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	eslint.configs.recommended,
	...tseslint.configs.recommended,
	{
		rules: {
			'@typescript-eslint/no-unused-vars': ['error', {argsIgnorePattern: '^_'}],
			'@typescript-eslint/no-explicit-any': 'off',
			'@typescript-eslint/ban-ts-comment': 'off',
			'@typescript-eslint/no-this-alias': 'off',
			'no-empty': ['error', {allowEmptyCatch: true}],
		},
	},
	{
		ignores: ['dist/**', 'node_modules/**', 'native/**', '**/*.test.ts'],
	},
);
