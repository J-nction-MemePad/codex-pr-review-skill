# Unified PR Review Config

Required top-level keys:

- `enabledStacks`
- `processChecks`
- `qualityGates`
- `enabledReviewers`

Common optional keys:

- `language`
- `botMarker`
- `remediationMarker`
- `packageJsonPath`
- `matchers`
- `testGroups`
- `stacks`
- `reviewerRoles`
- `reviewers`
- `mergeRules`
- `failurePolicy`
- `fixPolicy`
- `commentTemplate`

Key ideas:

- deterministic checks replace legacy ad hoc skill-local check files
- repo-specific logic belongs in repo config, not in the shared skill body
- shared scripts and fallback prompts/schemas ship with the installed skill
- reviewers are pluggable via config
- final merge policy is explicit
- default reviewer set is `rule-reviewer`, `codex-reviewer`, `simplify-reviewer`, `review-judge`
- remediation is a separate command and is comment-only unless a repo wrapper says otherwise
