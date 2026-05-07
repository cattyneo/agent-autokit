import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_CONFIG } from "@cattyneo/autokit-core";

import { redactGitDiff } from "./diff.ts";

describe("cli diff redaction", () => {
  it("redacts blacklisted path hunks and sanitizes remaining hunk bodies", () => {
    const openAiKey = dummyOpenAiKey("newsecret");
    const githubToken = dummyGithubToken("1");
    const rawDiff = [
      "diff --git a/.env b/.env",
      "index 1111111..2222222 100644",
      "--- a/.env",
      "+++ b/.env",
      "@@ -1 +1 @@",
      `-OPENAI_API_KEY=${dummyOpenAiKey("oldsecret")}`,
      `+OPENAI_API_KEY=${openAiKey}`,
      "diff --git a/README.md b/README.md",
      "index 3333333..4444444 100644",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1 +1 @@",
      "-safe line",
      `+Bearer ${githubToken}`,
    ].join("\n");

    const redacted = redactGitDiff(rawDiff, DEFAULT_CONFIG);

    assert.match(redacted, /\[REDACTED hunk: \.env\]/);
    assert.match(redacted, /README\.md/);
    assert.match(redacted, /<REDACTED>/);
    assert.doesNotMatch(redacted, new RegExp(escapeRegExp(openAiKey)));
    assert.doesNotMatch(redacted, /OPENAI_API_KEY=/);
    assert.doesNotMatch(redacted, new RegExp(escapeRegExp(githubToken)));
  });

  it("redacts credential-style paths across git path prefixes", () => {
    const rawDiff = [
      "diff --git a/secrets/id_rsa_prod b/secrets/id_rsa_prod",
      "index 1111111..2222222 100644",
      "--- a/secrets/id_rsa_prod",
      "+++ b/secrets/id_rsa_prod",
      "@@ -1 +1 @@",
      "-ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQCsecret",
      "+ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQCnewsecret",
    ].join("\n");

    const redacted = redactGitDiff(rawDiff, DEFAULT_CONFIG);

    assert.match(redacted, /\[REDACTED hunk: secrets\/id_rsa_prod\]/);
    assert.doesNotMatch(redacted, /AAAAB3Nza/);
  });

  it("sanitizes placeholder paths before rendering blacklisted hunks", () => {
    const githubToken = dummyGithubToken("2");
    const sensitivePath = `.env.${githubToken}`;
    const rawDiff = [
      `diff --git a/${sensitivePath} b/${sensitivePath}`,
      "index 1111111..2222222 100644",
      `--- a/${sensitivePath}`,
      `+++ b/${sensitivePath}`,
      "@@ -1 +1 @@",
      "-TOKEN=old",
      "+TOKEN=new",
    ].join("\n");

    const redacted = redactGitDiff(rawDiff, DEFAULT_CONFIG);

    assert.match(redacted, /\[REDACTED hunk: \.env\.<REDACTED>\]/);
    assert.doesNotMatch(redacted, new RegExp(escapeRegExp(githubToken)));
    assert.doesNotMatch(redacted, /TOKEN=/);
  });

  it("redacts all configured sensitive path classes", () => {
    const rawDiff = [
      diffForPath(".codex/auth.json", "+raw codex auth"),
      diffForPath(".claude/credentials.json", "+raw claude credentials"),
      diffForPath(".autokit/audit-hmac-key", "+0123456789abcdef0123456789abcdef"),
      diffForPath(".env~", "+DATABASE_PASSWORD=plain-secret"),
      diffForPath(".env+prod", "+DATABASE_PASSWORD=punctuation-secret"),
      diffForPath(".CODEX/auth.json", "+raw uppercase codex auth"),
      diffForPath(".Claude/Credentials.JSON", "+raw uppercase claude credentials"),
      diffForPath("secrets/ID_RSA_BACKUP", "+raw uppercase id rsa"),
      diffForPath("keys/private.pem", "+raw pem body"),
      diffForPath("keys/prod.key", "+raw key body"),
    ].join("\n");

    const redacted = redactGitDiff(rawDiff, DEFAULT_CONFIG);

    assert.match(redacted, /\[REDACTED hunk: <REDACTED>\]/);
    assert.doesNotMatch(redacted, /\.codex\/auth\.json|\.claude\/credentials\.json/i);
    for (const path of [
      ".autokit/audit-hmac-key",
      ".env~",
      ".env+prod",
      "secrets/ID_RSA_BACKUP",
      "keys/private.pem",
      "keys/prod.key",
    ]) {
      assert.match(redacted, new RegExp(`\\[REDACTED hunk: ${escapeRegExp(path)}\\]`));
    }
    assert.doesNotMatch(redacted, /raw codex auth/);
    assert.doesNotMatch(redacted, /raw claude credentials/);
    assert.doesNotMatch(redacted, /0123456789abcdef0123456789abcdef/);
    assert.doesNotMatch(redacted, /plain-secret/);
    assert.doesNotMatch(redacted, /punctuation-secret/);
    assert.doesNotMatch(redacted, /raw uppercase codex auth/);
    assert.doesNotMatch(redacted, /raw uppercase claude credentials/);
    assert.doesNotMatch(redacted, /raw uppercase id rsa/);
    assert.doesNotMatch(redacted, /raw pem body/);
    assert.doesNotMatch(redacted, /raw key body/);
  });

  it("redacts blacklisted paths that contain spaces in git headers", () => {
    const rawDiff = [
      "diff --git a/secret dir/prod.key b/secret dir/prod.key",
      "index 3367afd..3e75765 100644",
      "--- a/secret dir/prod.key\t",
      "+++ b/secret dir/prod.key\t",
      "@@ -1 +1 @@",
      "-old-secret",
      "+new-secret",
    ].join("\n");

    const redacted = redactGitDiff(rawDiff, DEFAULT_CONFIG);

    assert.match(redacted, /\[REDACTED hunk: secret dir\/prod\.key\]/);
    assert.doesNotMatch(redacted, /old-secret/);
    assert.doesNotMatch(redacted, /new-secret/);
  });

  it("redacts a full hunk when any old or new diff path is blacklisted", () => {
    const rawDiff = [
      "diff --git a/.env b/docs/example.md",
      "similarity index 80%",
      "rename from .env",
      "rename to docs/example.md",
      "index 1111111..2222222 100644",
      "--- a/.env",
      "+++ b/docs/example.md",
      "@@ -1 +1 @@",
      "-DATABASE_PASSWORD=plain-secret",
      "+documented example",
    ].join("\n");

    const redacted = redactGitDiff(rawDiff, DEFAULT_CONFIG);

    assert.match(redacted, /\[REDACTED hunk: \.env\]/);
    assert.doesNotMatch(redacted, /DATABASE_PASSWORD/);
    assert.doesNotMatch(redacted, /plain-secret/);
    assert.doesNotMatch(redacted, /documented example/);
  });

  it("redacts renamed credential store hunks when the destination path is not blacklisted", () => {
    const rawDiff = [
      "diff --git a/.codex/auth.json b/docs/auth.json",
      "similarity index 80%",
      "rename from .codex/auth.json",
      "rename to docs/auth.json",
      "index 1111111..2222222 100644",
      "--- a/.codex/auth.json",
      "+++ b/docs/auth.json",
      "@@ -1 +1 @@",
      "-plain structured credential",
      "+documented auth example",
    ].join("\n");

    const redacted = redactGitDiff(rawDiff, DEFAULT_CONFIG);

    assert.match(redacted, /\[REDACTED hunk: <REDACTED>\]/);
    assert.doesNotMatch(redacted, /\.codex\/auth\.json/);
    assert.doesNotMatch(redacted, /plain structured credential/);
    assert.doesNotMatch(redacted, /documented auth example/);
  });

  it("redacts private key blocks and subscription credential JSON in non-blacklisted paths", () => {
    const rawDiff = [
      "diff --git a/docs/example.md b/docs/example.md",
      "index 1111111..2222222 100644",
      "--- a/docs/example.md",
      "+++ b/docs/example.md",
      "@@ -1 +1,4 @@",
      "-safe line",
      "+-----BEGIN OPENSSH PRIVATE KEY-----",
      "+secret-body",
      "+-----END OPENSSH PRIVATE KEY-----",
      '+{"oauthAccessToken":"codex-secret-token"}',
    ].join("\n");

    const redacted = redactGitDiff(rawDiff, DEFAULT_CONFIG);

    assert.match(redacted, /docs\/example\.md/);
    assert.match(redacted, /<REDACTED>/);
    assert.doesNotMatch(redacted, /OPENSSH PRIVATE KEY/);
    assert.doesNotMatch(redacted, /secret-body/);
    assert.doesNotMatch(redacted, /codex-secret-token/);
  });
});

function diffForPath(path: string, bodyLine: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1 +1 @@",
    "-old",
    bodyLine,
  ].join("\n");
}

function dummyGithubToken(fill: string): string {
  return `ghp_${fill.repeat(36)}`;
}

function dummyOpenAiKey(seed: string): string {
  return `sk-${seed.repeat(3)}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
