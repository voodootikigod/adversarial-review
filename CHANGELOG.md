# Changelog

All notable changes to this project are documented here.

## [2.0.0] — 2026-06-18

### Breaking changes
- Exit code `2` (was `1`) now signals `needs-attention`; exit `1` is reserved for errors only. Update any scripts that tested `$? -ne 0` to distinguish `1` (error) from `2` (gate tripped).
- Output schema v2: findings now require `category`, `exploit_scenario`, and `evidence` fields. Any downstream JSON consumers must handle the new required fields.
- `--scope` default is now `auto` (working-tree when no `--base`, branch when `--base` is given); previously defaulted to working-tree unconditionally.

### Added
- **Structured output at the API layer**: Anthropic forced tool-use, OpenAI strict `json_schema` (with automatic fallback for gateways that reject it), Gemini `responseSchema` — JSON shape enforced by the provider, not just by post-hoc text scraping.
- **`--verify`**: Second adversarial pass that tries to refute each finding; refuted findings are dropped, raising precision.
- **`--passes <n>`**: Run the review n times and merge findings (deduped by file + category + overlapping line range), raising recall.
- **Hardened gate**: Exit code derived deterministically from findings (severity ≥ `--fail-on`, confidence ≥ `--min-confidence`). Model self-verdict is advisory; any disagreement is printed. Gate failure is never silent.
- **Grounding checks**: Findings citing a file outside the change set (API mode), or quoting evidence absent from the provided context, are marked ungrounded and have their confidence halved for gating.
- **`--scope`**: Explicit control over what is reviewed (`auto` / `working-tree` / `branch`).
- **Schema v2** (`schema.json`): `category` enum (17 attack-surface classes), `exploit_scenario`, `evidence`, `coverage.files_examined`/`files_skipped`. File-level findings use `line_start`/`line_end` = 0.
- **Self-correcting retry**: On validation failure the exact schema errors are fed back to the model for one corrective retry; raw output is saved to a temp file on final failure.

### Changed
- Secret scan now runs before the LLM call; the run is refused (not just warned) unless `--allow-secrets` is passed.
- Large-diff API reviews now fail closed by default (add `--allow-summary-review` to explicitly accept a summary-only review when the diff exceeds the inline limits).
- Default models updated to the strong tier of each provider: `claude-sonnet-4-6`, `gemini-2.5-pro`, `gpt-5`.

## [1.1.1] — 2026-06-13

### Fixed
- Correctly handle JSON responses wrapped in markdown fences from some local CLI agents.
- Cross-platform PATH search for local CLI agent detection on Windows.
- More robust merge-base resolution when upstream tracking branch is unavailable.

## [1.1.0] — 2026-06-13

### Added
- **Custom LLM gateway support**: `--api-base`, `--api-key`, `--headers` (and `OPENAI_API_BASE`, `ANTHROPIC_API_BASE`, `GEMINI_API_BASE`, `LLM_API_KEY`, `LLM_HEADERS` env vars) for routing through proxies or gateway servers.
- **Cursor integration**: auto-detected via `TERM_PROGRAM=cursor`; routes to an independent provider when possible, falls back to Cursor's local proxy.
- **Claude Code integration**: auto-detected via `CLAUDECODE`/`CLAUDE_CODE` env vars; prefers a non-Anthropic critic when available.
- `/release` Claude Code command and release skill bundled in `skills/release/`.

## [1.0.0] — 2026-05-01

Initial public release.

- Ship/no-ship adversarial review of git working-tree changes or a branch range.
- Anthropic, OpenAI, and Gemini API support; local `claude`, `codex`, `gemini` CLI fallback.
- Secret scan before the payload leaves the machine.
- Structured JSON output with severity, confidence, file, line range, and recommendation per finding.
- `--prompt-only` mode for no-API-key usage.
- Fail-closed on git collection errors.
- Bundled Claude Code skill (`skills/adversarial-review/`) for zero-install harness usage.
