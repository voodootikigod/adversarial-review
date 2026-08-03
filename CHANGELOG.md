# Changelog

All notable changes to this project are documented here.

## [Unreleased]

### Fixed
- **`--provider agy`**: pass `--mode plan` instead of Claude’s `--permission-mode plan` (agy 1.1.2 rejects the latter). Unknown-flag rejections from local CLIs are now reported as `provider "X" rejected flag "Y"` instead of being masked as a prompt-size error.
- **Quoted unknown-flag rejections**: commander-based CLIs (GitHub Copilot) report `unknown option '--foo'`, which was mangled into `rejected flag "--'--foo'"`. The flag name is now extracted cleanly.
- **Gateway model pins are no longer duplicated**: `GATEWAY_FAMILY_MODELS` read like the source of truth but the two auto-detection ladder branches and the fallback default each hardcoded the same strings, so editing the map alone changed nothing. All three now read from it, and a test fails the build if a model-id literal reappears elsewhere in `src/`.

### Breaking changes
- **`--provider cursor` no longer targets a localhost HTTP proxy** (`http://127.0.0.1:8765`). It now resolves to the official Cursor Agent CLI (`agent` / `cursor-agent`) in plan/read-only mode. Third-party OpenAI-compatible proxies: `--provider openai --api-base <url>`.

### Added
- **Cursor Agent CLI provider**: `--provider cursor|agent` invokes `agent -p --mode plan --trust` (subscription / `CURSOR_API_KEY`). Auto-detect inside Cursor falls back to `agent` instead of a dead proxy.
- **Vercel AI Gateway provider**: `--provider vercel|gateway` with `AI_GATEWAY_API_KEY` (or `VERCEL_OIDC_TOKEN`), base `https://ai-gateway.vercel.sh/v1`, default model `anthropic/claude-sonnet-5`.
- **One-key multi-family routing**: when only a Gateway credential is set, `--providers auto` / family tokens resolve openai + anthropic + gemini through the Gateway with distinct `provider/model` ids (native vendor keys still win when present).
- **GitHub Copilot CLI provider**: `--provider copilot` invokes `copilot -p … --mode plan` (read-only). Explicit-only — never auto-detected, and not counted as a diversity family, because Copilot routes to Claude/GPT/Gemini depending on `--model`. The prompt travels in argv, so an npm-installed `copilot.cmd` on Windows is refused rather than re-parsed by `cmd.exe`.
- **opencode provider**: `--provider opencode` reaches models no other backend here serves via `opencode-go` (grok, kimi, qwen, glm, deepseek, minimax); default `opencode-go/grok-4.5`. Also explicit-only and not a diversity family. opencode has no read-only flag, so reviews run under a generated config injected via `OPENCODE_CONFIG` — read/grep/glob/list allowed, everything else denied — with a fresh random agent name per run, `--pure`, and an `opencode agent list` preflight that must confirm the agent is primary before the diff is sent.
- **Secret scanning on the model's output**, not just the payload sent to it. A tool-using reviewer can open a gitignored `.env` that was never in the diff and quote it into a finding; the response is now scanned before it is rendered, printed as `--json`, or written to the findings ledger. Matches are masked in place so a finding *about* a hardcoded credential survives with the credential itself removed.
- **Gateway model drift detection**: a test fetches the public gateway catalog and fails when a pinned model is no longer served, reporting newer same-tier models without failing. A parallel test checks opencode's published config schema, because a permission key left unset defaults to `"ask"` and would hang a headless review. Both skip cleanly offline.

### Changed
- **Gateway default models moved forward**, each staying in its existing tier so cost and latency are unchanged: `openai/gpt-5` → `openai/gpt-5.6-sol` (context 400k → 1.05M) and `anthropic/claude-sonnet-4.6` → `anthropic/claude-sonnet-5`. `google/gemini-2.5-pro` deliberately holds: the catalog carries no stable 3.x *pro* text model, only flash tiers and a preview.

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
