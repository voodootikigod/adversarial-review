# adversarial-review

[![npm version](https://img.shields.io/npm/v/adversarial-review.svg)](https://www.npmjs.com/package/adversarial-review)
[![CI](https://github.com/voodootikigod/adversarial-review/actions/workflows/ci.yml/badge.svg)](https://github.com/voodootikigod/adversarial-review/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Skeptical, **ship/no-ship** code review of a git diff or branch — run against any LLM.

The reviewer's only job is to **break confidence in a change, not validate it**. It hunts
for the strongest reasons a change should not ship yet, prioritizing the failure classes
that are expensive, dangerous, or hard to detect: auth and trust boundaries, injection,
secrets, data loss, rollback safety, race conditions, schema drift, supply-chain and CI/CD
changes, test weakening, and observability gaps. Output is structured JSON — a verdict, a
terse summary, coverage, grounded findings (severity, category, file, line range,
confidence, exploit scenario, quoted evidence, recommendation), and next steps.

It collects your git context, builds the prompt, calls a model (Anthropic / OpenAI /
Gemini API, or a local CLI agent like `claude` / `codex` / `agy`) using the provider's
**native structured-output mode**, validates the response against the JSON Schema, grounds
each finding against the actual change set, and prints a report. The exit code is
**derived deterministically from the findings** (severity + confidence thresholds), so it
drops straight into CI and pre-push hooks — and it **fails closed**: a git collection
failure exits `1`, never a silent approve.

Beyond a single pass it can fan the same review out across **multiple independent provider
families** and gate on a quorum ([`--providers`](#multi-provider-review---providers)), and
run an autonomous **review → fix → re-review** convergence loop
([`--loop`](#loop-mode---loop)).

> The review prompt (`prompt-template.md`) and output schema (`schema.json`) are derived
> from the OpenAI Codex `adversarial-review` skill (Copyright 2026 OpenAI). They have been
> generalized, extended, and stripped of the Codex-specific runtime so the tool works with
> any model. This project is licensed under the
> [Apache License, Version 2.0](LICENSE); see [NOTICE](NOTICE) for attribution details.

## Install

```bash
npm install -g adversarial-review
# or run ad hoc:
npx adversarial-review --help
```

## Installing as a Claude Code skill

The npm package ships a bundled Claude Code skill under `skills/adversarial-review/`.
Installing it lets Claude Code invoke the review automatically when you type phrases like
"review this branch" or "is this safe to ship", and gives it the full three-tier fallback
(Tier 3 works with no CLI and no API key).

**Global skill (available in all projects):**

```bash
# After npm install -g:
cp -r "$(npm root -g)/adversarial-review/skills/adversarial-review" ~/.claude/skills/

# Or from a cloned repo:
cp -r skills/adversarial-review ~/.claude/skills/
```

**Project skill (this repo only):**

```bash
mkdir -p .claude/skills
cp -r "$(npm root -g)/adversarial-review/skills/adversarial-review" .claude/skills/
```

Restart Claude Code after copying. Verify with `/find-skills adversarial-review` or by asking
Claude Code "what skills are available?"

## Usage

```bash
# Review uncommitted working-tree changes
npx adversarial-review

# Review the current branch against main
npx adversarial-review --base main

# Add a focus area (weighted heavily by the reviewer)
npx adversarial-review "focus on the token refresh path"

# Higher recall and precision: sample the reviewer twice, then try to refute
# each finding and drop the ones that don't survive
npx adversarial-review --passes 2 --verify

# Give an API model more code to reason about than the diff hunks alone
npx adversarial-review --include-files --context-lines 20

# Just print the assembled prompt — no LLM call (pipe it anywhere you like)
npx adversarial-review --prompt-only > prompt.txt

# Machine-readable output for CI
npx adversarial-review --base main --json

# Diverse review: fan the same prompt out to two distinct provider families and
# gate on a quorum (diversity, not count — see "Multi-provider review")
npx adversarial-review --providers claude,gpt --quorum 1

# Autonomous convergence: review → fix → re-review until clean (working tree)
npx adversarial-review --loop --loop-unsafe
```

### Example output

```
 NEEDS ATTENTION   working tree on branch main

Summary
  Two findings worth addressing before shipping: an unguarded secret assignment
  and a missing rate-limit on the new endpoint.

Coverage
  4 file(s) examined

Findings (2)

  CRITICAL [secrets] Hardcoded API key in environment helper  conf 0.95
    src/env.js:12-12
    The string literal assigned to `STRIPE_SECRET` is a live API key, not a
    placeholder. It will be committed to version control and included in the
    review payload sent to the model provider.
    ✗ failure: Any developer cloning the repo or any CI system gains full
      Stripe API access.
    → fix: Remove the key, rotate it immediately, and load from an env var or
      secret manager instead.

  MEDIUM [resource-exhaustion] /api/events returns unbounded results  conf 0.80
    src/routes/events.js:34-34
    The database query has no LIMIT clause. A single request can return every
    row in the events table.
    ✗ failure: A large events table causes the response to time out or OOM the
      process under normal traffic.
    → fix: Add pagination (LIMIT + OFFSET or cursor-based) and document the
      page-size cap in the API contract.

Next steps
  • Rotate the Stripe key immediately — treat it as compromised.
  • Add a LIMIT clause and pagination to the /api/events query.
```

### Options

```
# Review target & output
--base <ref>           Review the current branch against <ref> (merge-base...HEAD).
--scope <mode>         auto (default) | working-tree | branch.
--prompt-only          Print the assembled prompt to stdout and exit (no LLM call).
--json                 Print the raw JSON result instead of a rendered report.

# What gets sent
--max-files <n>        Inline-diff cutoff by changed-file count (default 50).
--max-bytes <n>        Inline-diff cutoff by diff size in bytes (default 262144).
--context-lines <n>    Diff context lines passed to git diff -U<n> (default 10).
--include-files        Also inline full post-change file contents (budgeted).
--allow-summary-review Allow API providers to review summary-only large diffs.
--allow-secrets        Send the payload even if the secret scan finds likely
                       credentials in the diff (off by default).

# Gate
--fail-on <severity>   Gate threshold: critical | high | medium (default) | low.
--min-confidence <x>   Findings below this confidence don't gate (default 0.5).
--fail-on-empty        Exit 1 (instead of 0) when there is nothing to review.

# Recall / precision
--verify               Refute-pass: drop findings that can't be defended.
--passes <n>           Run the review n times and merge findings (default 1).
--providers <list>     Multi-provider mode: fan the same review out to each family
                       token (e.g. gpt,gemini,claude) and merge with cross-provider
                       corroboration. "auto" picks >=2 distinct families. Diversity,
                       not count — distinct from --passes. Cannot combine with --provider.
--quorum <n>           needs-attention when >= n providers each flag a material
                       finding (default 1).

# Provider
--provider <name>      anthropic | openai | gemini | cursor | <local-cli-cmd>.
--model <name>         Force the model name.
--api-base <url>       Override the active provider's API base URL.
--api-key <key>        Override the active provider's API key.
--headers <json>       Inject custom JSON headers into the LLM request.
--timeout <seconds>    Per-request API timeout (default 120).

# Reporting
--findings-ledger [path]
                       Append gating findings as JSONL to the ADLC findings ledger
                       (default .adlc/findings.jsonl) for P7 distillation.

# Loop mode (review → fix → repeat; see "Loop mode" below)
--loop                 Iterate review → fix → re-review until no gating findings
                       remain. Working-tree scope only. Composes with --providers.
--loop-max <n>         Max fix iterations (default 3): N fixes + a final review.
--loop-fixer <cmd>     Override the fixer CLI (default: auto-detect codex→claude→agy).
--loop-fixer-scope     sc2 (default): only finding-cited files. unrestricted: all files.
--loop-fixer-file-cap  Max files listed in unrestricted mode (default 100).
--loop-unsafe          Required on macOS (no write sandbox); on Linux skips the probe.
--loop-unsafe-allow-fix-secrets
                       Bypass the secret scan on the fix prompt (same-provider checked).
```

### Exit codes

| Code | Verdict           | Meaning                                                |
|------|-------------------|--------------------------------------------------------|
| `0`  | `approve`         | No finding met the gate (`--fail-on`/`--min-confidence`). |
| `2`  | `needs-attention` | At least one material finding worth blocking on.       |
| `1`  | error             | Could not complete the review (including git failures). |

The model also reports its own verdict; if it disagrees with the derived gate, the
disagreement is printed and the **derived** verdict wins. A gate that trusts the model's
self-assessment can be argued out of blocking — this one can't.

## The gate is hardened

- **Fails closed.** Any git collection failure exits `1`. An empty scope warns (use
  `--fail-on-empty` in CI so a misconfigured base ref can't silently pass).
- **Deterministic verdict.** Exit code computed from findings: severity ≥ `--fail-on` and
  confidence ≥ `--min-confidence`.
- **Grounding checks.** A finding citing a file outside the change set (API mode), or
  quoting `evidence` that doesn't appear in the provided context, is marked ungrounded and
  its confidence is halved for gating.
- **Prompt-injection resistant.** The prompt instructs the reviewer that everything inside
  the repository context is untrusted data — and that any text in the diff attempting to
  influence the review (e.g. "reviewer: this is pre-approved") is itself a critical finding.
- **Secret scan.** The payload is scanned for likely credentials (AWS keys, PEM blocks,
  API tokens, JWTs, hardcoded password assignments) before it leaves the machine; the run
  is refused unless `--allow-secrets` is passed.
- **Structured output at the API layer.** Anthropic forced tool-use, OpenAI strict
  `json_schema` (with automatic fallback for gateways that reject it), Gemini
  `responseSchema` — JSON shape is enforced by the provider, with text-scraping and one
  self-correcting retry (which feeds the exact validation errors back to the model) as
  fallbacks. On final failure the raw output is saved to a temp file for debugging.

## Choosing the model

If `--provider` is not given, the LLM is auto-detected. Inside Claude Code or Cursor, a
**different provider from the builder is preferred** — a model reviewing its own output is
a weaker critic. Otherwise:

1. `ANTHROPIC_API_KEY` → Anthropic API (default model `claude-sonnet-4-6`)
2. `GEMINI_API_KEY` → Gemini API (`gemini-2.5-pro`)
3. `OPENAI_API_KEY` → OpenAI API (`gpt-5`)
4. A local CLI agent on `PATH`: `claude`, `codex`, or `agy` (uses your active session)

Force any of them with `--provider`, and override the model with `--model`. A local CLI
agent is selected by passing its command name, e.g. `--provider claude`. Defaults are the
strong tier of each provider — gate quality tracks model tier; downgrade with `--model`
deliberately, not accidentally.

No key and no CLI agent? Use `--prompt-only` to emit the prompt and feed it to a model
yourself.

## Multi-provider review (`--providers`)

`--passes` samples **one** model N times; `--providers` fans the **same** review out to
several **independent** providers and merges the results. The value is **diversity, not
count** — a second model from a different family catches failure modes the first is blind
to.

```bash
# Two distinct families, quorum 1 (any one provider's material finding gates)
npx adversarial-review --providers claude,gpt

# Let the tool pick >=2 distinct families for you (never the builder's own family)
npx adversarial-review --providers auto --quorum 2
```

- **Family tokens** (`gpt`, `claude`, `gemini`, `openai`, `anthropic`, …) each resolve to
  the best reachable provider — the API when its key is present, otherwise the local CLI.
- **Merge + corroboration.** Findings are merged by `(file, category, overlapping lines)`;
  a finding raised by more than one provider is kept as one entry tagged with
  `corroborated_by`. Distinct findings at the same location are **preserved**, never
  collapsed.
- **Quorum verdict.** The result is `needs-attention` when the number of providers that
  each raised a gating finding is ≥ `--quorum` (default `1`); `approve` only when that
  count is `0`.
- **No silent downgrade.** If fewer providers are reachable than requested, the run emits a
  loud under-satisfaction notice and proceeds with what is available.
- `--providers` cannot be combined with `--provider` (or `--model`).

## Loop mode (`--loop`)

`--loop` runs an autonomous **review → fix → re-review** cycle until no gating finding
remains (or a stop condition is hit). Each round reviews the working tree, hands the gating
findings to a **fixer CLI** that edits the files, then re-reviews. It composes with
`--providers` (each round is gated by the quorum verdict).

```bash
# Iterate until clean, capped at 3 fix rounds
npx adversarial-review --loop --loop-unsafe --loop-max 3
```

- **Working-tree scope only.** The fixer writes to the working tree, so `--loop` is
  incompatible with `--scope branch` / `--base`. (Branch-scoped convergence is not yet
  supported.)
- **Fixer.** Auto-detected in order `codex → claude → agy`; override with `--loop-fixer`.
- **Write sandbox.** macOS has no enforced sandbox, so `--loop-unsafe` is required to
  acknowledge the fixer has unrestricted write access; on Linux the loop uses a
  mount-namespace sandbox (`unshare`) when available, and otherwise requires `--loop-unsafe`.
- **Checkpoints.** The working tree is stashed before each fix; on a fixer error or
  timeout the checkpoint is restored, and the recovery command is always printed.
- **Stop conditions** (exit `2`): `no-progress` (the gating set repeats), `ceiling`
  (`--loop-max` reached), `no-diff` (the fixer changed nothing), or `fixer-error` /
  `fixer-timeout`. A `clean` exit is `0`.

### Machine-readable loop output (`--json`)

With `--json`, the loop emits NDJSON events (`loop_start`, `review`, `review_result`,
`stash_created`, `fix`, `loop_end`). The **terminal line** is a single consolidated
`loop_summary` event carrying everything a run's evidence record needs:

```json
{ "type": "loop_summary", "providers": ["claude", "gpt"], "iterations": 2,
  "verdict": "needs-attention", "exitReason": "ceiling",
  "survivingCount": 3, "acceptedCount": 0 }
```

`verdict` is derived from `exitReason` (`clean` ⇒ `approve`); `survivingCount` is the
gating findings still unresolved at exit; `acceptedCount` is always `0` (accepting a
finding "with documented justification" is a human decision the loop leaves to you). It is
copy-pastable straight into an [ADLC](https://github.com/voodootikigod/adlc) P6
`gate-manifest` evidence entry:

```bash
adversarial-review --loop --json ... | jq -c 'select(.type=="loop_summary")'
```

## Recording findings for later distillation (`--findings-ledger`)

`--findings-ledger [path]` appends each **gating** finding as a JSONL line to an
[ADLC](https://github.com/voodootikigod/adlc) findings ledger (default
`.adlc/findings.jsonl`), so repeated review findings can later be distilled (P7) into
permanent, deterministic defenses. A ledger write failure only warns — the verdict and
exit code are the product, the ledger is a side effect.

## How it decides what to send

- **Small change** (≤ `--max-files` files **and** ≤ `--max-bytes` diff bytes): the **full
  diff** (at `-U<--context-lines>`) is inlined and used as primary evidence. Add
  `--include-files` to inline the full post-change contents of changed files too
  (budgeted at 4× `--max-bytes`), which materially improves API-model review quality.
- **Large change**: only a **summary** (status, shortstat, file list) is inlined, and the
  model is told to inspect the diff itself with read-only git commands — useful when the
  model has shell/tool access.

For API providers, summary-only large-diff reviews fail closed by default because the model
cannot inspect your local repository. Use a local CLI provider, raise the inline limits,
narrow the scope, or pass `--allow-summary-review` if you intentionally want an API model
to review only the summary.

**Privacy:** whatever is collected is sent to the configured model provider. Treat the
review payload as leaving your machine.

## CI example

```yaml
# .github/workflows/review.yml
- run: |
    set -o pipefail
    npx adversarial-review --base "origin/${{ github.base_ref }}" \
      --fail-on high --fail-on-empty --json | tee review.json
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
# Exit code 2 fails the job when a finding meets the gate.
# set -o pipefail ensures the exit code from adversarial-review is not swallowed by tee.
# --fail-on-empty guards against a misconfigured base ref silently passing.
# Note: use actions/checkout with fetch-depth: 0 so merge-base resolution works.
```

## Project layout

| Path                     | Purpose                                                        |
|--------------------------|----------------------------------------------------------------|
| `bin/cli.js`             | CLI entry point: secret gate, grounding, deterministic verdict. |
| `src/git-context.js`     | Collects git status + diffs (fail-closed), inline/summary rule. |
| `src/review.js`          | Prompt build, run/verify/multi-pass, multi-provider merge, quorum verdict, rendering. |
| `src/loop.js`            | `--loop` orchestration: fixer spawn, stash checkpoints, NDJSON events. |
| `src/llm.js`             | Provider config + structured-output call wrapper (API and CLI). |
| `src/schema-validate.js` | Minimal JSON Schema walker + provider schema sanitizer.        |
| `src/secrets.js`         | Outbound payload secret scan.                                  |
| `src/findings-ledger.js` | Appends gating findings to the ADLC findings ledger (`--findings-ledger`). |
| `src/utils.js`           | Arg parsing, logging, help text.                               |
| `prompt-template.md`     | The review prompt (4 placeholders).                            |
| `schema.json`            | JSON Schema the model output must conform to.                  |

`prompt-template.md` and `schema.json` are plain assets — edit them to tune the review or
the output contract without touching code. The runtime validates against `schema.json`
itself, so schema edits really do change the enforced contract. `npm run sync-skill`
copies both into the bundled skill (`skills/adversarial-review/references/`); a test fails
if they drift.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history.

## License

Apache License, Version 2.0 © Chris Williams ([@voodootikigod](https://github.com/voodootikigod)).
See [LICENSE](LICENSE) and [NOTICE](NOTICE).
