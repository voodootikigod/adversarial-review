# adversarial-review

Skeptical, **ship/no-ship** code review of a git diff or branch — run against any LLM.

The reviewer's only job is to **break confidence in a change, not validate it**. It hunts
for the strongest reasons a change should not ship yet, prioritizing the failure classes
that are expensive, dangerous, or hard to detect: auth and trust boundaries, data loss,
rollback safety, race conditions, schema drift, and observability gaps. Output is
structured JSON — a verdict, a terse summary, grounded findings (severity, file, line
range, confidence, recommendation), and next steps.

It collects your git context, builds the prompt, calls a model (Anthropic / OpenAI /
Gemini API, or a local CLI agent like `claude` / `codex` / `gemini`), validates the
response against a JSON Schema, and prints a report. The verdict is also the **exit code**,
so it drops straight into CI and pre-push hooks.

> The review prompt (`prompt-template.md`) and output schema (`schema.json`) are derived
> from the OpenAI Codex `adversarial-review` skill (Copyright 2026 OpenAI). They have been
> generalized and stripped of the Codex-specific runtime so the tool works with any model.
> This project is licensed under the [Apache License, Version 2.0](LICENSE); see
> [NOTICE](NOTICE) for attribution details.

## Install

```bash
npm install -g adversarial-review
# or run ad hoc:
npx adversarial-review --help
```

## Usage

```bash
# Review uncommitted working-tree changes
npx adversarial-review

# Review the current branch against main
npx adversarial-review --base main

# Add a focus area (weighted heavily by the reviewer)
npx adversarial-review "focus on the token refresh path"

# Just print the assembled prompt — no LLM call (pipe it anywhere you like)
npx adversarial-review --prompt-only > prompt.txt

# Machine-readable output for CI
npx adversarial-review --base main --json
```

### Options

```
--base <ref>          Review the current branch against <ref> (merge-base...HEAD).
--scope <mode>        auto (default) | working-tree | branch.
--prompt-only         Print the assembled prompt to stdout and exit (no LLM call).
--json                Print the raw JSON result instead of a rendered report.
--max-files <n>       Inline-diff cutoff by changed-file count (default 50).
--max-bytes <n>       Inline-diff cutoff by diff size in bytes (default 262144).
--allow-summary-review Allow API providers to review summary-only large diffs.
--provider <name>     anthropic | openai | gemini | <local-cli-cmd>.
--model <name>        Force the model name.
-h, --help            Show help.
```

### Exit codes

| Code | Verdict           | Meaning                                          |
|------|-------------------|--------------------------------------------------|
| `0`  | `approve`         | No material adversarial finding.                 |
| `2`  | `needs-attention` | At least one material finding worth blocking on. |
| `1`  | error             | Could not complete the review.                   |

## Choosing the model

If `--provider` is not given, the LLM is auto-detected in this order:

1. `ANTHROPIC_API_KEY` → Anthropic API (default model `claude-sonnet-4-6`)
2. `GEMINI_API_KEY` → Gemini API (`gemini-2.5-flash`)
3. `OPENAI_API_KEY` → OpenAI API (`gpt-4o`)
4. A local CLI agent on `PATH`: `claude`, `codex`, or `gemini` (uses your active session)

Force any of them with `--provider`, and override the model with `--model`. A local CLI
agent is selected by passing its command name, e.g. `--provider claude`.

No key and no CLI agent? Use `--prompt-only` to emit the prompt and feed it to a model
yourself.

## How it decides what to send

Mirroring the original skill's collection logic:

- **Small change** (≤ `--max-files` files **and** ≤ `--max-bytes` diff bytes): the **full
  diff** is inlined and used as primary evidence.
- **Large change**: only a **summary** (status, shortstat, file list) is inlined, and the
  model is told to inspect the diff itself with read-only git commands — useful when the
  model has shell/tool access.

For API providers, summary-only large-diff reviews fail closed by default because the model
cannot inspect your local repository. Use a local CLI provider, raise the inline limits,
narrow the scope, or pass `--allow-summary-review` if you intentionally want an API model
to review only the summary.

## CI example

```yaml
# .github/workflows/review.yml
- run: npx adversarial-review --base "origin/${{ github.base_ref }}" --json | tee review.json
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
# Exit code 2 fails the job when the reviewer says needs-attention.
```

## Project layout

| Path                 | Purpose                                                       |
|----------------------|---------------------------------------------------------------|
| `bin/cli.js`         | CLI entry point.                                              |
| `src/git-context.js` | Collects git status + diffs, applies the inline/summary rule. |
| `src/review.js`      | Builds the prompt, runs the model, validates and renders.     |
| `src/llm.js`         | Provider config + universal call wrapper (API and CLI).       |
| `src/utils.js`       | Arg parsing, logging, help text.                              |
| `prompt-template.md` | The review prompt (4 placeholders).                           |
| `schema.json`        | JSON Schema the model output must conform to.                 |

`prompt-template.md` and `schema.json` are plain assets — edit them to tune the review or
the output contract without touching code.

## License

Apache License, Version 2.0 © Chris Williams ([@voodootikigod](https://github.com/voodootikigod)).
See [LICENSE](LICENSE) and [NOTICE](NOTICE).
