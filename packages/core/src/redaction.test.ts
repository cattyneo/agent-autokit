import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_CONFIG } from "./config.ts";
import { sanitizeLogString } from "./redaction.ts";

describe("core redaction public API", () => {
  it("redacts tokens, env values, home paths, and repo paths", () => {
    const sanitized = sanitizeLogString(
      [
        "/Users/tester/.codex/auth.json",
        "/repo/project/.env:3 SECRET=raw-secret",
        "Bearer ghp_aaaaaaaaaaaaaaaaaaaaaaaa",
        "effort=high provider=codex model=gpt-5.4-mini",
      ].join(" "),
      DEFAULT_CONFIG,
      false,
      { homeDir: "/Users/tester", repoRoot: "/repo/project" },
    );

    assert.doesNotMatch(sanitized, /\/Users\/tester/);
    assert.doesNotMatch(sanitized, /\/repo\/project/);
    assert.doesNotMatch(sanitized, /raw-secret|ghp_/);
    assert.match(sanitized, /~\/\.codex\/auth\.json/);
    assert.match(sanitized, /<repo>\/\.env:3 SECRET=<REDACTED>/);
    assert.match(sanitized, /effort=high provider=codex model=gpt-5.4-mini/);
  });
});
