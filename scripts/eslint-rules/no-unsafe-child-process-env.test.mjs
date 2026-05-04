import { describe, it } from "node:test";
import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";

import { noUnsafeChildProcessEnv } from "./no-unsafe-child-process-env.mjs";

RuleTester.afterAll = () => {};
RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
    parser: tseslint.parser,
  },
});

tester.run("no-unsafe-child-process-env", noUnsafeChildProcessEnv, {
  valid: [
    {
      code: `
        import { spawn } from "node:child_process";
        import { buildRunnerEnv } from "@cattyneo/autokit-core";
        spawn("claude", ["--version"], { env: buildRunnerEnv(parentEnv) });
      `,
    },
    {
      code: `
        import { spawn } from "node:child_process";
        import { buildRunnerEnv as build } from "@cattyneo/autokit-core";
        const runnerEnv = build(parentEnv);
        spawn("claude", { env: runnerEnv });
      `,
    },
    {
      code: `
        import * as childProcess from "node:child_process";
        import { buildGhEnv } from "@cattyneo/autokit-core";
        childProcess.execFile("gh", ["auth", "status"], { env: buildGhEnv(parentEnv) });
      `,
    },
    {
      code: `
        import { spawn } from "node:child_process";
        import { buildRunnerEnv } from "../../packages/core/src/env-allowlist.ts";
        spawn("claude", ["--version"], { env: buildRunnerEnv(parentEnv) });
      `,
    },
    {
      code: `
        const { spawn } = require("node:child_process");
        const { buildRunnerEnv } = require("@cattyneo/autokit-core");
        spawn("claude", ["--version"], { env: buildRunnerEnv(parentEnv) });
      `,
    },
  ],
  invalid: [
    {
      code: `
        import { spawn } from "node:child_process";
        spawn("claude", ["--version"]);
      `,
      errors: [{ messageId: "missingEnv" }],
    },
    {
      code: `
        import { spawn } from "node:child_process";
        spawn("claude", ["--version"], { env: process.env });
      `,
      errors: [{ messageId: "directProcessEnv" }],
    },
    {
      code: `
        import { spawn } from "node:child_process";
        spawn("claude", ["--version"], { env: { ...process.env, FOO: "bar" } });
      `,
      errors: [{ messageId: "spreadProcessEnv" }],
    },
    {
      code: `
        import { execFile } from "child_process";
        execFile("gh", ["auth", "status"], { env: { PATH: "/bin" } });
      `,
      errors: [{ messageId: "wrongEnvBuilder" }],
    },
    {
      code: `
        import { execa } from "execa";
        execa("claude", { env: { ...process.env, FOO: "bar" } });
      `,
      errors: [{ messageId: "spreadProcessEnv" }],
    },
    {
      code: `
        import { spawn } from "node:child_process";
        const options = { env: process.env };
        spawn("claude", ["--version"], options);
      `,
      errors: [{ messageId: "missingEnv" }],
    },
    {
      code: `
        import { spawn } from "node:child_process";
        function buildRunnerEnv() {
          return process.env;
        }
        spawn("claude", ["--version"], { env: buildRunnerEnv(parentEnv) });
      `,
      errors: [{ messageId: "wrongEnvBuilder" }],
    },
    {
      code: `
        import execa from "execa";
        execa("claude", ["--version"]);
      `,
      errors: [{ messageId: "missingEnv" }],
    },
    {
      code: `
        import { spawn } from "node:child_process";
        import { buildRunnerEnv } from "evil-pkg/dist/env-allowlist.js";
        spawn("claude", ["--version"], { env: buildRunnerEnv(parentEnv) });
      `,
      errors: [{ messageId: "wrongEnvBuilder" }],
    },
    {
      code: `
        const { spawn } = require("node:child_process");
        spawn("claude", ["--version"]);
      `,
      errors: [{ messageId: "missingEnv" }],
    },
  ],
});
