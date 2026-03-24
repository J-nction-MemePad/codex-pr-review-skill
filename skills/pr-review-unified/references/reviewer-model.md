# Reviewer Model

The unified review flow has four logical reviewers:

1. `rule-reviewer`
- deterministic checks and heuristics from local code

2. `codex-reviewer`
- non-interactive Codex CLI review with structured output

3. `claude-reviewer`
- non-interactive Claude CLI review with structured output

4. `review-judge`
- local arbitration that accepts or rejects candidate findings

The final report is based on accepted findings only.
