import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ConfigParseError,
  capabilities,
  capabilityProviders,
  DEFAULT_CONFIG,
  parseConfigYaml,
  runtimePhases,
} from "./index.ts";

describe("core config schema", () => {
  it("parses a minimal config and applies SPEC defaults", () => {
    const config = parseConfigYaml("version: 1\n");

    assert.deepEqual(config, DEFAULT_CONFIG);
    assert.equal(config.base_branch, "");
    assert.equal(config.branch_prefix, "autokit/");
    assert.equal(config.auto_merge, true);
    assert.equal(config.runtime.max_untrusted_input_kb, 256);
    assert.equal(config.phases.plan.provider, "claude");
    assert.equal(config.phases.plan_verify.provider, "codex");
    assert.equal(config.phases.plan_verify.prompt_contract, "plan-verify");
    assert.equal(config.permissions.claude.auto_mode, "optional");
    assert.equal(config.permissions.codex.allow_network, false);
    assert.equal(config.permissions.codex.home_isolation, "shared");
    assert.equal(config.runner_timeout.default_ms, 600_000);
    assert.equal(config.runner_timeout.plan_verify_ms, undefined);
    assert.equal(config.runner_timeout.default_idle_ms, 300_000);
    assert.equal(config.init.backup_blacklist.includes(".autokit/audit-hmac-key"), true);
  });

  it("parses the full config surface used by AK-005", () => {
    const config = parseConfigYaml(`
version: 1
parallel: 2
base_branch: main
branch_prefix: codex/
auto_merge: false
review:
  max_rounds: 2
  warn_threshold: 1
plan:
  max_rounds: 5
ci:
  poll_interval_ms: 12000
  timeout_ms: 900000
  timeout_action: failed
  fix_max_rounds: 2
merge:
  poll_interval_ms: 3000
  timeout_ms: 600000
  branch_delete_grace_ms: 1000
  worktree_remove_retry_max: 4
label_filter:
  - agent-ready
runtime:
  max_untrusted_input_kb: 128
phases:
  plan:
    provider: claude
    model: claude-custom
    prompt_contract: plan
  plan_verify:
    provider: codex
    model: gpt-custom
    prompt_contract: plan-verify
  plan_fix:
    provider: claude
    model: auto
    prompt_contract: plan-fix
  implement:
    provider: codex
    model: auto
    prompt_contract: implement
  review:
    provider: claude
    model: auto
    prompt_contract: review
  supervise:
    provider: claude
    model: auto
    prompt_contract: supervise
  fix:
    provider: codex
    model: auto
    prompt_contract: fix
permissions:
  claude:
    auto_mode: required
    workspace_scope: repo
    allowed_tools: ["Read"]
    home_isolation: isolated
  codex:
    sandbox_mode: readonly
    approval_policy: never
    allow_network: true
    home_isolation: isolated
runner_timeout:
  plan_ms: 1
  plan_verify_ms: 2
  plan_fix_ms: 3
  implement_ms: 4
  review_ms: 5
  supervise_ms: 6
  fix_ms: 7
  default_ms: 8
  plan_idle_ms: 9
  default_idle_ms: 10
logging:
  level: debug
  retention_days: 7
  max_file_size_mb: 10
  max_total_size_mb: 100
  redact_patterns:
    - "secret-[0-9]+"
init:
  backup_dir: ".autokit/custom-backup"
  backup_mode: "0750"
  backup_blacklist:
    - ".custom-secret"
`);

    assert.equal(config.parallel, 2);
    assert.equal(config.auto_merge, false);
    assert.equal(config.ci.timeout_action, "failed");
    assert.deepEqual(config.label_filter, ["agent-ready"]);
    assert.equal(config.phases.plan.model, "claude-custom");
    assert.equal(config.permissions.claude.workspace_scope, "repo");
    assert.equal(config.permissions.codex.allow_network, true);
    assert.equal(config.runner_timeout.plan_verify_ms, 2);
    assert.equal(config.logging.level, "debug");
    assert.deepEqual(config.init.backup_blacklist, [".custom-secret"]);
  });

  it("rejects prompt_contract drift from the fixed runtime phase mapping", () => {
    assertConfigError(
      `
version: 1
phases:
  plan:
    prompt_contract: review
`,
      "phases.plan.prompt_contract",
    );
  });

  it("rejects the codex allow_network + shared home isolation doctor gate", () => {
    assertConfigError(
      `
version: 1
permissions:
  codex:
    allow_network: true
    home_isolation: shared
`,
      "permissions.codex.home_isolation",
    );
  });

  it("rejects unsafe numeric limits and unknown config keys", () => {
    assertConfigError(
      `
version: 1
runtime:
  max_untrusted_input_kb: 0
extra: true
`,
      "runtime.max_untrusted_input_kb",
    );
  });

  it("reports yaml parse failures as config parse errors", () => {
    assert.throws(() => parseConfigYaml("version: ["), ConfigParseError);
  });

  it("keeps runtime phase constants aligned with config phases", () => {
    const config = parseConfigYaml("version: 1\n");

    assert.deepEqual(Object.keys(config.phases), [...runtimePhases]);
  });

  it("keeps config phase provider values inside the capability table", () => {
    const config = parseConfigYaml("version: 1\n");
    const capabilityKeys = new Set(capabilities.map((row) => `${row.phase}:${row.provider}`));

    for (const phase of runtimePhases) {
      assert.equal(capabilityKeys.has(`${phase}:${config.phases[phase].provider}`), true);
    }
  });

  it("accepts providers from the capability provider SoT", () => {
    for (const provider of capabilityProviders) {
      const config = parseConfigYaml(`
version: 1
phases:
  plan:
    provider: ${provider}
`);

      assert.equal(config.phases.plan.provider, provider);
    }
  });
});

function assertConfigError(source: string, expectedPath: string): void {
  assert.throws(
    () => parseConfigYaml(source),
    (error) =>
      error instanceof ConfigParseError &&
      error.issues.some((issue) => issue.path.join(".") === expectedPath),
  );
}
