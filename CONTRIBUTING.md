# Contributing

## Skill Source Sync

Bundled autokit skills live under `packages/cli/assets/skills/` and are copied into target repositories by `autokit init`. Preset overrides under `packages/cli/assets/presets/*/skills/` are also runtime-installable and must keep the same prompt_contract field shape, source pins, and safety boundaries. Keep them small, prompt_contract-aware, and scoped to autokit phases.

Current source pins:

| Bundled skill | Source | Pin |
|---|---|---|
| `autokit-implement` | `tdd-workflow` | commit `866d9ebb5364a579ac7d2a8fb79bb421bf9d7052` |
| `autokit-review` | local `general-review` | `sha256:b95eddbaa3e3c671c657084d8919a0a34d031dec60a6228d08158514a742d7f5` |

`general-review` is pinned by local source fingerprint rather than commit because the installed source has no verifiable upstream git commit in this workspace.

When refreshing either source:

1. Re-read the upstream or local source and keep only the parts that apply to autokit `prompt_contract` phases.
2. Preserve `autokit-question` ownership for `status=need_input` and do not edit `autokit-question` as part of a source refresh unless the issue explicitly owns it.
3. Do not change prompt_contract structured-output fields unless the issue also updates SPEC §9.3 and the schema snapshot.
4. Update the pin in this file and `docs/SPEC.md` §8.3 in the same PR.
5. Run `npx --yes bun@1.3.13 test e2e/runners/runner-visibility.test.ts packages/core/src/runner-contract.test.ts packages/codex-runner/src/index.test.ts` and the required handoff gates.
