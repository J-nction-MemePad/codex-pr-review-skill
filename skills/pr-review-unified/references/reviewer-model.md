# Reviewer Model

The unified review flow has four logical reviewers:

1. `rule-reviewer`
- deterministic checks and heuristics from local code

2. `codex-reviewer`
- non-interactive Codex CLI review with structured output

3. `simplify-reviewer`
- readability, overengineering, unnecessary abstraction, and maintainability review
- can be implemented with Claude CLI or another backend, but the role name stays `simplify-reviewer`

4. `review-judge`
- local arbitration that accepts or rejects candidate findings

Default behavior:

- `rule-reviewer`, `codex-reviewer`, and `simplify-reviewer` run in parallel
- `review-judge` uses repo config merge rules to accept or reject findings
- `claude-reviewer` is optional and opt-in, not part of the default reviewer set

The shared skill also defines a second command:

- `fix-review-comments`
  - consumes accepted findings from `review`
  - produces comment-only remediation guidance
  - does not modify code by default
