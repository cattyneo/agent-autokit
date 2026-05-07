import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createAssetsTransaction,
  createPresetBackupDir,
  manifestDirectory,
  pruneBackupRetention,
  repoBackupId,
} from "./assets-writer.ts";

const NOW = "2026-05-07T22:00:00.000Z";

describe("core assets writer", () => {
  it("backs up changed files, tracks created files, and rolls back byte-identically", () => {
    const root = makeTempDir();
    const backupDir = join(root, ".autokit", ".backup", "2026");
    mkdirSync(join(root, ".agents", "prompts"), { recursive: true });
    writeFileSync(join(root, ".agents", "prompts", "plan.md"), "custom plan\n", { mode: 0o600 });
    const before = manifestDirectory(join(root, ".agents"));
    const tx = createAssetsTransaction({ repoRoot: root, backupDir });

    assert.equal(tx.writeFileAtomic(".agents/prompts/plan.md", "generated plan\n"), "changed");
    assert.equal(tx.writeFileIfAbsent(".agents/prompts/review.md", "review\n"), "changed");
    assert.equal(tx.writeFileIfAbsent(".agents/prompts/review.md", "other\n"), "skipped");
    assert.equal(tx.writeFileAtomic(".agents/prompts/review.md", "generated review\n"), "changed");

    tx.rollback();

    assert.equal(
      readFileSync(join(root, ".agents", "prompts", "plan.md"), "utf8"),
      "custom plan\n",
    );
    assert.equal(existsSync(join(root, ".agents", "prompts", "review.md")), false);
    assert.deepEqual(manifestDirectory(join(root, ".agents")), before);
  });

  it("creates XDG preset backup directories with repo-id separation and 0700 parent modes", () => {
    const parent = makeTempDir();
    const left = join(parent, "left", "repo");
    const right = join(parent, "right", "repo");
    mkdirSync(left, { recursive: true });
    mkdirSync(right, { recursive: true });
    const stateHome = join(parent, "state");

    const leftDir = createPresetBackupDir({
      repoRoot: left,
      stateHome,
      timestamp: NOW,
    });
    const rightDir = createPresetBackupDir({
      repoRoot: right,
      stateHome,
      timestamp: NOW,
    });

    assert.notEqual(repoBackupId(left), repoBackupId(right));
    assert.notEqual(leftDir, rightDir);
    assert.match(leftDir, /autokit\/backup\/[a-f0-9]{16}\/2026-05-07T22.00.00.000Z$/);
    for (const dir of [
      join(stateHome, "autokit"),
      join(stateHome, "autokit", "backup"),
      join(stateHome, "autokit", "backup", repoBackupId(left)),
      leftDir,
      join(stateHome, "autokit", "backup", repoBackupId(right)),
      rightDir,
    ]) {
      assert.equal(statSync(dir).mode & 0o777, 0o700, dir);
    }
  });

  it("uses realpath for repo ids and fails closed when retention pruning cannot delete", () => {
    const root = makeTempDir();
    const link = join(makeTempDir(), "repo-link");
    symlinkSync(root, link);
    assert.equal(repoBackupId(link), repoBackupId(root));

    const backupRootLink = join(makeTempDir(), "backup-link");
    symlinkSync(root, backupRootLink);
    assert.throws(
      () =>
        pruneBackupRetention(backupRootLink, {
          retentionDays: 30,
          now: () => new Date(NOW),
        }),
      /backup retention root must be a directory/,
    );

    const backupRoot = join(root, ".autokit", ".backup");
    const expired = join(backupRoot, "expired");
    mkdirSync(expired, { recursive: true });
    utimesSync(expired, new Date("2026-03-01T00:00:00.000Z"), new Date("2026-03-01T00:00:00.000Z"));

    assert.throws(
      () =>
        pruneBackupRetention(backupRoot, {
          retentionDays: 30,
          now: () => new Date(NOW),
          hooks: {
            remove: () => {
              throw new Error("permission denied");
            },
          },
        }),
      /backup retention prune failed/,
    );
    assert.equal(existsSync(expired), true);

    pruneBackupRetention(backupRoot, {
      retentionDays: 30,
      now: () => new Date(NOW),
    });
    assert.equal(existsSync(expired), false);
  });
});

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "autokit-assets-writer-"));
}
