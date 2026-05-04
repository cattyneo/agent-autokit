import tseslint from "typescript-eslint";

import { noUnsafeChildProcessEnv } from "./scripts/eslint-rules/no-unsafe-child-process-env.mjs";

export default [
  {
    ignores: ["**/dist/**", "node_modules/**"],
  },
  {
    files: ["packages/**/*.ts", "e2e/**/*.ts", "scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parser: tseslint.parser,
    },
    plugins: {
      autokit: {
        rules: {
          "no-unsafe-child-process-env": noUnsafeChildProcessEnv,
        },
      },
    },
    rules: {
      "autokit/no-unsafe-child-process-env": "error",
    },
  },
];
