# supervise

Decide which review findings require fixes.

Accepted findings must include concrete fix instructions. Rejected findings must include evidence.

## Result

Classify each review finding as accepted or rejected.

## Evidence

Use issue scope, SSOT, tests, and diff evidence to justify each decision.

## Changes

For accepted findings, produce the fix instructions.

## Test results

State which validation evidence must be rerun after fixes.

Return YAML for the `supervise` prompt contract.

Use skill: autokit-question
