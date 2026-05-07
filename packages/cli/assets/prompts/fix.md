# fix

Fix accepted review or CI findings in the assigned worktree.

Keep the patch focused, rerun relevant checks, and preserve unrelated user changes.

## Result

Summarize the fix outcome and unresolved accepted findings, if any.

## Evidence

Reference the accepted finding or CI failure and the code path changed.

## Changes

List changed files and accepted finding IDs resolved by the patch.

## Test results

Report exact checks rerun and whether they passed, failed, or were skipped.

Return YAML for the `fix` prompt contract.

Use skill: autokit-implement
Use skill: autokit-question
