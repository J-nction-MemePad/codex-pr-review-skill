# Unified PR Review Config

Required top-level keys:

- `enabledStacks`
- `processChecks`
- `qualityGates`
- `enabledReviewers`

Common optional keys:

- `language`
- `botMarker`
- `packageJsonPath`
- `matchers`
- `testGroups`
- `stacks`
- `reviewers`
- `mergeRules`
- `failurePolicy`
- `commentTemplate`

Key ideas:

- deterministic checks replace legacy ad hoc skill-local check files
- repo-specific logic belongs in repo config, not in the shared skill body
- reviewers are pluggable via config
- final merge policy is explicit
