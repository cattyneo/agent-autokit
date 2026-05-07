# Issue #90 Claude Runner Capability + Write Path Guard Plan

## Goal
Claude runner を capability table 由来の permission に移行し、write profile だけ `Edit` / `Write` / `Bash` を許可しつつ、secret path / git-gh write / package script 迂回を fail-closed にする。

## Observable Success Criteria
- `claudeRunnerPhases` 固定 whitelist を使わず、Claude runner が 7 agent phase を `derive_claude_perm()` 由来で検証する。
- read-only profile は `Read,Grep,Glob` のみ、write profile は `Read,Grep,Glob,Edit,Write,Bash` を `--tools` に渡し、`WebFetch/WebSearch` は常時 deny。
- `packages/core/src/path-safety.ts` が secret path / `.git` write / git-gh command policy を提供し、`packages/claude-runner` が一方向に import する。
- PreToolUse hook が read-only path guard と write path guard を切り替え、`.env*`, `.codex/**`, `.claude/credentials*`, `id_rsa*`, `*.pem`, `*.key` を deny する。
- runner env が HOME / XDG / `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_NOSYSTEM` / `GH_CONFIG_DIR` を isolated scratch に寄せ、host git / gh config を読まない。
- deprecated `permissions.claude.allowed_tools` は capability hard cap 内だけ受理し、read-only phase で write tools 指定なら fail-closed する。

## Key Constraints
- SSOT: `docs/spec/phase1-core-cli-runner.md` §1.4 / §1.5 / §5.1、`docs/references/v0.2.0-issue-plan.md` Issue 1.4、`docs/SPEC.md` §11.4.3。
- Codex runner と Claude effort profile 変換は #91 / #92 に残す。
- OS-level network sandbox と arbitrary network syscall blocking は v0.2 #90 の保証外。
- Claude Code docs 確認結果: PreToolUse hook は `permissionDecision` と `updatedInput` を返せるが、command rewrite を安全境界の主軸にせず、deny-first validation と autokit-owned guarded command policy で実装する。

## Relevant Skills / Tools
- `agent-autokit-issue-train`, `issue-implementation`, `plan-writing`, `general-review`
- Context7: `/anthropics/claude-code` hook / CLI docs
- Tests: `packages/core/src/*`, `packages/claude-runner/src/index.test.ts`

## Execution Steps
- [ ] RED: core path-safety testsを追加し、secret paths、git/gh read/write判定、output redactionを表現する。
- [ ] RED: claude-runner testsを更新し、7 phase受理、dynamic tools、write_path_guard、env isolation、deprecated allowed_tools hard-capを表現する。
- [ ] GREEN: `packages/core/src/path-safety.ts` を実装し、core indexから exportする。
- [ ] GREEN: `packages/claude-runner/src/index.ts` を capability由来 permission / hook settings / isolated env に置換する。
- [ ] SPEC: `docs/SPEC.md` §11.4.3 を v0.2 write profile + deprecate path に同期する。
- [ ] Verification: targeted tests → `bash scripts/check-trace.sh` if SPEC trace touched → common gates。
- [ ] PR: #90 scope / non-goals / validation / provider-backed tests not run を明記し、`$general-review` 後に valid findings を直す。

