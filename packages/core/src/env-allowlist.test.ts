import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

import { buildGhEnv, buildRunnerEnv } from "./env-allowlist.ts";

describe("core env allowlist", () => {
  const parentEnv = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: "/Users/example",
    LANG: "ja_JP.UTF-8",
    LC_ALL: "ja_JP.UTF-8",
    LC_CTYPE: "UTF-8",
    TERM: "xterm-256color",
    TZ: "Asia/Tokyo",
    GH_TOKEN: "gh-secret",
    GITHUB_TOKEN: "github-secret",
    XDG_CONFIG_HOME: "/Users/example/.config",
    XDG_CACHE_HOME: "/Users/example/.cache",
    ANTHROPIC_API_KEY: "anthropic-secret",
    OPENAI_API_KEY: "openai-secret",
    AUTOKIT_INTERNAL: "internal",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    npm_config_user_agent: "npm",
    EMPTY_ALLOWED: undefined,
  };

  it("builds the gh subprocess env from explicit core keys only", () => {
    const env = buildGhEnv(parentEnv);

    assert.deepEqual(env, {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: "/Users/example",
      LANG: "ja_JP.UTF-8",
      LC_ALL: "ja_JP.UTF-8",
      LC_CTYPE: "UTF-8",
      TERM: "xterm-256color",
      TZ: "Asia/Tokyo",
      GH_TOKEN: "gh-secret",
      GITHUB_TOKEN: "github-secret",
      XDG_CONFIG_HOME: "/Users/example/.config",
      XDG_CACHE_HOME: "/Users/example/.cache",
    });
  });

  it("builds runner env without GitHub tokens, API keys, AUTOKIT vars, or arbitrary user env", () => {
    const env = buildRunnerEnv(parentEnv);

    assert.deepEqual(env, {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: "/Users/example",
      LANG: "ja_JP.UTF-8",
      LC_ALL: "ja_JP.UTF-8",
      LC_CTYPE: "UTF-8",
      TERM: "xterm-256color",
      TZ: "Asia/Tokyo",
      XDG_CONFIG_HOME: "/Users/example/.config",
      XDG_CACHE_HOME: "/Users/example/.cache",
    });
  });

  it("can override runner HOME and XDG roots for isolated runtime homes", () => {
    const env = buildRunnerEnv(parentEnv, {
      home: "/repo/.autokit/worktrees/issue-5/.runtime-home/plan",
      xdgConfigHome: "/repo/.autokit/worktrees/issue-5/.runtime-home/plan/.config",
      xdgCacheHome: "/repo/.autokit/worktrees/issue-5/.runtime-home/plan/.cache",
    });

    assert.equal(env.HOME, "/repo/.autokit/worktrees/issue-5/.runtime-home/plan");
    assert.equal(
      env.XDG_CONFIG_HOME,
      "/repo/.autokit/worktrees/issue-5/.runtime-home/plan/.config",
    );
    assert.equal(env.XDG_CACHE_HOME, "/repo/.autokit/worktrees/issue-5/.runtime-home/plan/.cache");
    assert.equal("GH_TOKEN" in env, false);
    assert.equal("GITHUB_TOKEN" in env, false);
  });

  it("passes only the runner allowlist to spawned children", () => {
    const child = spawnSync(
      process.execPath,
      ["-e", "process.stdout.write(JSON.stringify(process.env))"],
      {
        encoding: "utf8",
        env: buildRunnerEnv(parentEnv),
      },
    );

    assert.equal(child.status, 0);
    const childEnv = JSON.parse(child.stdout) as Record<string, string>;
    assert.equal(childEnv.PATH, parentEnv.PATH);
    assert.equal(childEnv.HOME, parentEnv.HOME);
    assert.equal(childEnv.GH_TOKEN, undefined);
    assert.equal(childEnv.GITHUB_TOKEN, undefined);
    assert.equal(childEnv.ANTHROPIC_API_KEY, undefined);
    assert.equal(childEnv.OPENAI_API_KEY, undefined);
    assert.equal(childEnv.AUTOKIT_INTERNAL, undefined);
    assert.equal(childEnv.AWS_SECRET_ACCESS_KEY, undefined);
  });

  it("does not mutate the parent env object", () => {
    const original = { ...parentEnv };

    buildGhEnv(parentEnv);
    buildRunnerEnv(parentEnv, { home: "/tmp/isolated" });

    assert.deepEqual(parentEnv, original);
  });
});
