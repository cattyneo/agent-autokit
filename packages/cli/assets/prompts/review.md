# review

Review the pull request for correctness, regressions, missing tests, SPEC/PLAN drift, and unsafe behavior.

## Result

Return high-signal findings or an explicit no-findings result.

## Evidence

Ground each finding in files, tests, issue text, specs, or observed behavior.

## Changes

For each finding, describe the smallest required correction.

## Test results

Call out missing, weak, or failing validation evidence.

Return YAML for the `review` prompt contract.

Use skill: autokit-review
Use skill: autokit-question
