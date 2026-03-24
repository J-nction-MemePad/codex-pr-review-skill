---
name: pr-review-unified
description: Unified PR review skill that combines deterministic repo checks, parallel reviewers, critical arbitration, and remediation planning.
---

# Unified PR Review

Use this skill when one workflow should cover:
- deterministic process checks
- stack-aware review focus
- parallel reviewer execution
- final accepted/rejected finding arbitration
- remediation planning for accepted findings

## Workflow

1. Resolve the PR scope.
- Prefer `PR_NUMBER`.
- Otherwise use `HEAD_REF` and `BASE_REF`.

2. Load the repo config.
- Read stacks, deterministic checks, quality gates, reviewer commands, merge rules, and failure policy.

3. Run `review` as the default command.
- Build shared deterministic context first.
- Run `rule-reviewer`, `codex-reviewer`, and `simplify-reviewer` in parallel.
- Run `review-judge` after reviewer outputs are normalized.

4. Use `fix-review-comments` when accepted findings need follow-up.
- Read the accepted findings from the `review` result.
- Produce remediation comments or checklists only.
- Do not auto-edit code unless a repo-specific wrapper explicitly adds that behavior.

5. Produce one consolidated markdown result.
- Reuse one bot marker.
- Prefer a single final PR comment instead of per-reviewer comments.

## Required Inputs

- `PR_NUMBER`, or
- `HEAD_REF` + `BASE_REF`
- A repo config path for the target repository

## Default Command Shape

```bash
node scripts/pr-review/orchestrator.js review --pr "$PR_NUMBER" --config config/pr-review/repo-config.json
node scripts/pr-review/orchestrator.js fix-review-comments --pr "$PR_NUMBER" --config config/pr-review/repo-config.json
```

## References

- Config: `references/config-schema.md`
- Reviewer model: `references/reviewer-model.md`
