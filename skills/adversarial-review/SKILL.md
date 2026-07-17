---
name: adversarial-review
description: >-
  Skeptical ship/no-ship code review of a git diff or branch, run against any LLM
  (Anthropic / OpenAI / Gemini API, or a local claude / codex / agy CLI). Use before
  merging or pushing to catch the expensive failure classes a normal review misses: auth
  and trust-boundary holes, injection, secrets, data loss, rollback safety, race
  conditions, schema drift, supply-chain and CI/CD changes, test weakening, and
  observability gaps. Triggers on "review my diff", "review this git diff", "review this
  branch", "will this break", "is this safe to ship", "adversarial review", "code review
  before merge", "review before push", "pre-push review", "CI review gate", "ship or
  no-ship", "find the strongest reason not to ship".
license: Apache-2.0
user-invocable: true
argument-hint: "[--base <ref>] [--scope auto|working-tree|branch] [--fail-on <sev>] [--verify] [--passes <n>] [focus...]"
metadata:
  version: 2.7.0
  author: Chris Williams (@voodootikigod)
  homepage: https://github.com/voodootikigod/adversarial-review
---

# Adversarial Review

A skeptical, **ship / no-ship** review of a code change. The reviewer's only job is to
**break confidence in the change, not validate it** — it hunts the strongest reasons a diff
should *not* ship yet, weighting the failure classes that are expensive, dangerous, or hard
to detect: auth and trust boundaries, injection, secrets, data loss, rollback safety, race
conditions, schema drift, supply-chain and CI/CD changes, test weakening, and observability
gaps. Output is a structured verdict (`approve` / `needs-attention`), a terse summary,
grounded findings (severity, category, file, line range, confidence, exploit scenario,
quoted evidence, recommendation), and next steps.

Model-agnostic: it runs against an Anthropic / OpenAI / Gemini API key, a local `claude` /
`codex` / `agy` CLI session, or — with no tooling at all — by handing you the prompt to
run yourself.

## When to use

- Before merging a branch or opening a PR — "review this branch", "is this safe to ship".
- Before pushing — a pre-push / pre-commit gate.
- As a CI gate that fails the build on a material finding (the exit code is derived
  deterministically from the findings, not from the model's mood).
- Reviewing someone else's diff and asking "what's the strongest reason not to ship this".

## How to run — pick the tier that matches the environment

The three tiers degrade by capability. **Do not assume Tier 1 always works** — check the
preconditions and drop down as needed. The CLI is a convenience; Tier 3 makes the review
possible with no shell and no install.

### Tier 1 — shell + npm + a model (API key or local model CLI)
Full automated path. The CLI collects git context, builds the prompt, calls the model
(using the provider's native structured-output mode), validates the JSON, grounds the
findings against the actual change set, prints a report, and sets the exit code.

```bash
npx adversarial-review                       # review uncommitted working-tree changes
npx adversarial-review --base main           # review current branch vs main (merge-base...HEAD)
npx adversarial-review --base main --json    # machine-readable output for CI
npx adversarial-review "focus on the token refresh path"   # weighted focus area
npx adversarial-review --verify --passes 2   # higher recall + refute-pass precision
```

Exit codes: `0` = approve, `2` = needs-attention (report the findings), `1` = error
(including a failed git collection — the gate never approves because collection silently
failed).

Useful hardening flags:

- `--fail-on <severity>` / `--min-confidence <x>` — the deterministic gate: exit 2 iff any
  finding is at/above the severity threshold (default `medium`) with confidence at/above
  the floor (default `0.5`). The model's own verdict is advisory; disagreement is reported.
- `--verify` — second adversarial pass that tries to *refute* each finding; refuted
  findings are dropped. Raises precision (fewer false blocks) at one extra call per finding.
- `--passes <n>` — sample the reviewer n times and merge findings. Raises recall.
- `--include-files` — also inline the full post-change contents of changed files (budgeted)
  so an API model sees code surrounding the hunks, not just `-U10` context.
- `--fail-on-empty` — exit 1 instead of 0 when there is nothing to review. **Set this in
  CI** so a misconfigured base ref cannot silently pass the gate.

**Privacy:** the diff (and untracked file contents) is sent to the selected model provider.
The CLI scans the payload for likely secrets first and refuses to send if any are found
(override with `--allow-secrets`; rotate anything that was committed).

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
   matching `references/schema.json`. Note the contract details: `line_start`/`line_end`
   are line numbers in the **post-change file** (both `0` for a file-level finding such as
   a missing migration), `evidence` must be quoted verbatim from the provided context, and
   `coverage` must list the files examined vs skipped.

## Choosing the model (Tier 1)

If `--provider` is not given, the model is auto-detected. **Inside Claude Code or Cursor
the detection order is deliberately inverted** — a model reviewing its own output is a
weaker critic, so non-Anthropic providers are preferred first:

**Inside Claude Code** (`CLAUDECODE` / `CLAUDE_CODE` env set):
1. `GEMINI_API_KEY` → Gemini API (`gemini-2.5-pro`)
2. `OPENAI_API_KEY` → OpenAI API (`gpt-5`)
3. `AI_GATEWAY_API_KEY` → Vercel AI Gateway (non-Anthropic model preferred)
4. Local `codex` / `agy` / `agent` CLI on `PATH`
5. `ANTHROPIC_API_KEY` → Anthropic API (`claude-sonnet-4-6`) ← last resort, with warning
6. Local `claude` CLI on `PATH` ← last resort, with warning

**Inside Cursor** (`TERM_PROGRAM=cursor`):
1. `GEMINI_API_KEY` → Gemini API
2. `ANTHROPIC_API_KEY` → Anthropic API
3. `OPENAI_API_KEY` → OpenAI API
4. `AI_GATEWAY_API_KEY` → Vercel AI Gateway
5. Local `agy`, `claude`, or `codex` CLI
6. Local `agent` (Cursor Agent CLI) ← last resort, with warning

**Everywhere else** (default order):
1. `ANTHROPIC_API_KEY` → Anthropic API (`claude-sonnet-4-6`)
2. `GEMINI_API_KEY` → Gemini API (`gemini-2.5-pro`)
3. `OPENAI_API_KEY` → OpenAI API (`gpt-5`)
4. `AI_GATEWAY_API_KEY` → Vercel AI Gateway (`anthropic/claude-sonnet-4.6`)
5. Local `claude`, `codex`, `agy`, or `agent` CLI

`--provider cursor|agent` uses the official Cursor Agent CLI (`agent -p --mode plan`),
not a localhost proxy. `--provider vercel|gateway` uses Vercel AI Gateway
(`provider/model` ids; one key can drive `--providers auto` across families).

Force with `--provider <name>`; override the model with `--model <name>`. Gate quality
tracks model tier — defaults are the strong tier of each provider; use `--model` to trade
quality for cost deliberately.

## Large changes

The CLI inlines the **full diff** only when the change is small (≤ `--max-files` files **and**
≤ `--max-bytes` bytes). For a large change it inlines only a **summary** and asks the model
to inspect the diff itself with read-only git commands. For API providers, summary-only
large-diff reviews **fail closed** by default (the API model can't read your repo) — use a
local CLI provider, raise the limits, narrow `--scope`, or pass `--allow-summary-review`.

## Reading the output

| Exit code | Verdict | Meaning |
|-----------|---------|---------|
| `0` | `approve` | No finding met the gate (`--fail-on`/`--min-confidence`). |
| `2` | `needs-attention` | At least one material finding worth blocking on. |
| `1` | — | The review could not complete (including git collection failure). |

Each finding carries: `severity` (critical/high/medium/low), `category` (attack-surface
class), `title`, `body`, `exploit_scenario`, `evidence` (verbatim quote), `file`,
`line_start`, `line_end` (post-change line numbers; `0,0` = file-level), `confidence`
(0–1), `recommendation`. Findings whose cited file is outside the change set or whose
quoted evidence does not appear in the provided context are marked **ungrounded** and have
their confidence halved for gating.

## Output discipline

Return the reviewer's verdict and findings **verbatim** — do not soften, summarize away, or
silently act on them. The human (or the next agent) decides what to fix. The review's job is
to surface risk, not to apply changes.

## Verification

- Tier 1/2: `npx adversarial-review --help` exits `0`.
  `npx adversarial-review --prompt-only` prints the assembled prompt to stdout with no
  model call (works even on a clean working tree — prints the template with empty diff
  sections, which is enough to confirm the template is intact).
- Tier 3: `references/prompt-template.md` and `references/schema.json` exist and are
  non-empty.

## Related

- Repo, full options, and CI example: https://github.com/voodootikigod/adversarial-review
- npm CLI: `npx adversarial-review --help`
