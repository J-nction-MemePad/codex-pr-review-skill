---
name: pr-review-unified
description: Unified PR review skill that combines deterministic repo checks, stack-aware review, and parallel AI reviewers with final finding arbitration.
---

# Unified PR Review

Use this skill when one workflow should cover:
- deterministic process checks
- stack-aware review focus
- parallel Codex / Claude reviewer execution
- final accepted/rejected finding arbitration

## Workflow

1. Resolve the PR scope.
- Prefer `PR_NUMBER`.
- Otherwise use `HEAD_REF` and `BASE_REF`.

2. Load the repo config.
- Read stacks, deterministic checks, quality gates, reviewer commands, merge rules, and failure policy.

3. Run the deterministic rule reviewer first.
- Produce process checks, test adequacy, quality gates, and rule-based findings.

4. Run external reviewers in parallel.
- `codex-reviewer`
- `claude-reviewer`

5. Normalize and arbitrate.
- Merge duplicates.
- Keep accepted findings only when evidence is concrete enough.
- Reject speculative or duplicate low-signal findings with a reason.

6. Produce one consolidated markdown result.
- Reuse one bot marker.
- Prefer a single final PR comment instead of per-reviewer comments.

## Required Inputs

- `PR_NUMBER`, or
- `HEAD_REF` + `BASE_REF`
- A repo config path for the target repository

## Default Command Shape

```bash
node scripts/pr-review/orchestrator.js --pr "$PR_NUMBER" --config config/pr-review/repo-config.json
```

## References

- Config: `references/config-schema.md`
- Reviewer model: `references/reviewer-model.md`
