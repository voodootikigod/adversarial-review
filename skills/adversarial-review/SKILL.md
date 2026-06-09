---
name: adversarial-review
description: >-
  Skeptical ship/no-ship code review of a git diff or branch, run against any LLM
  (Anthropic / OpenAI / Gemini API, or a local claude / codex / gemini CLI). Use before
  merging or pushing to catch the expensive failure classes a normal review misses: auth
  and trust-boundary holes, data loss, rollback safety, race conditions, schema drift, and
  observability gaps. Triggers on "review my diff", "review this git diff", "review this
  branch", "will this break", "is this safe to ship", "adversarial review", "code review
  before merge", "review before push", "pre-push review", "CI review gate", "ship or
  no-ship", "find the strongest reason not to ship".
license: MIT
user-invocable: true
argument-hint: "[--base <ref>] [--scope auto|working-tree|branch] [focus...]"
metadata:
  version: 1.1.0
  author: Chris Williams (@voodootikigod)
  homepage: https://github.com/voodootikigod/adversarial-review
---

# Adversarial Review

A skeptical, **ship / no-ship** review of a code change. The reviewer's only job is to
**break confidence in the change, not validate it** — it hunts the strongest reasons a diff
should *not* ship yet, weighting the failure classes that are expensive, dangerous, or hard
to detect: auth and trust boundaries, data loss, rollback safety, race conditions, schema
drift, and observability gaps. Output is a structured verdict (`approve` /
`needs-attention`), a terse summary, grounded findings (severity, file, line range,
confidence, recommendation), and next steps.

Model-agnostic: it runs against an Anthropic / OpenAI / Gemini API key, a local `claude` /
`codex` / `gemini` CLI session, or — with no tooling at all — by handing you the prompt to
run yourself.

## When to use

- Before merging a branch or opening a PR — "review this branch", "is this safe to ship".
- Before pushing — a pre-push / pre-commit gate.
- As a CI gate that fails the build on a material finding (verdict is the exit code).
- Reviewing someone else's diff and asking "what's the strongest reason not to ship this".

## How to run — pick the tier that matches the environment

The three tiers degrade by capability. **Do not assume Tier 1 always works** — check the
preconditions and drop down as needed. The CLI is a convenience; Tier 3 makes the review
possible with no shell and no install.

### Tier 1 — shell + npm + a model (API key or local model CLI)
Full automated path. The CLI collects git context, builds the prompt, calls the model,
validates the JSON, prints a report, and sets the exit code.

```bash
npx adversarial-review                       # review uncommitted working-tree changes
npx adversarial-review --base main           # review current branch vs main (merge-base...HEAD)
npx adversarial-review --base main --json    # machine-readable output for CI
npx adversarial-review "focus on the token refresh path"   # weighted focus area
```

Exit codes: `0` = `approve`, `2` = `needs-attention` (report the findings), `1` = error.

### Tier 2 — shell + npm, but NO API key and no model CLI
Emit the assembled prompt and feed it to the model you already have (this session), no model
call by the CLI:

```bash
npx adversarial-review --prompt-only > /tmp/adv-prompt.txt
```
Then run the contents of `/tmp/adv-prompt.txt` against the current model and require JSON
matching the schema.

### Tier 3 — NO shell / NO npm (truly constrained harness)
Everything needed ships **inside this skill** — no CLI, no install, no network:

- `references/prompt-template.md` — the review prompt with four placeholders.
- `references/schema.json` — the JSON contract the model output must satisfy.

Procedure:
1. Gather the change with whatever capability you have (the diff, or a file list + summary
   for a large change).
2. Open `references/prompt-template.md` and fill the placeholders:
   - `{{TARGET_LABEL}}` — what's under review (e.g. `working tree` or `feature-x...HEAD`).
   - `{{USER_FOCUS}}` — the user's focus text, or `none`.
   - `{{REVIEW_COLLECTION_GUIDANCE}}` — for a small change, inline the full diff as evidence;
     for a large change, tell the model to inspect the diff itself with read-only git
     commands.
   - `{{REVIEW_INPUT}}` — the diff (small change) or the status/shortstat/file-list summary
     (large change).
3. Send the filled prompt to the current model and require it to return **only** JSON
   matching `references/schema.json`.

## Choosing the model (Tier 1)

If `--provider` is not given, the model is auto-detected in this order:

1. `ANTHROPIC_API_KEY` → Anthropic API (default `claude-sonnet-4-6`)
2. `GEMINI_API_KEY` → Gemini API (`gemini-2.5-flash`)
3. `OPENAI_API_KEY` → OpenAI API (`gpt-4o`)
4. A local CLI agent on `PATH`: `claude`, `codex`, or `gemini` (uses your active session)

Force with `--provider <name>`; override the model with `--model <name>`.

## Large changes

The CLI inlines the **full diff** only when the change is small (≤ `--max-files` files **and**
≤ `--max-bytes` bytes). For a large change it inlines only a **summary** and asks the model
to inspect the diff itself with read-only git commands. For API providers, summary-only
large-diff reviews **fail closed** by default (the API model can't read your repo) — use a
local CLI provider, raise the limits, narrow `--scope`, or pass `--allow-summary-review`.

## Reading the output

| Exit code | Verdict | Meaning |
|-----------|---------|---------|
| `0` | `approve` | No material adversarial finding. |
| `2` | `needs-attention` | At least one material finding worth blocking on. |
| `1` | — | The review could not complete. |

Each finding carries: `severity` (critical/high/medium/low), `title`, `body`, `file`,
`line_start`, `line_end`, `confidence` (0–1), `recommendation`.

## Output discipline

Return the reviewer's verdict and findings **verbatim** — do not soften, summarize away, or
silently act on them. The human (or the next agent) decides what to fix. The review's job is
to surface risk, not to apply changes.

## Verification

- Tier 1/2: `npx adversarial-review --help` exits `0`; `npx adversarial-review --prompt-only`
  prints a non-empty prompt with no model call.
- Tier 3: `references/prompt-template.md` and `references/schema.json` exist and are
  non-empty.

## Related

- Repo, full options, and CI example: https://github.com/voodootikigod/adversarial-review
- npm CLI: `npx adversarial-review --help`
