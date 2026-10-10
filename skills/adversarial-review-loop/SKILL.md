---
name: adversarial-review-loop
description: >-
  Iterative adversarial review and repair loop: an independent model reviews, this context fixes.
  Drives npx adversarial-review --json in a structured review-fix-validate cycle until clean or
  ratified. Replaces in-session use of --loop (which is for unattended/CI runs). Triggers on "arl",
  "review and fix until clean", "converge the review", "fix the review findings",
  "loop the adversarial review", "iterate until the review passes".
license: Apache-2.0
user-invocable: true
argument-hint: "[--max-rounds <n>] [--max-time <duration>] [--test <cmd>] [--base <ref>] [--scope working-tree|branch] [--provider <p>] [--providers ...] [--verify] [focus...]"
metadata:
  version: 2.11.1
  author: Chris Williams (@voodootikigod)
  homepage: https://github.com/voodootikigod/adversarial-review
---

# Adversarial Review Loop (arl)

An iterative review-and-repair protocol for agent sessions. The division of labour is strict:
**an independent model reviews, this context fixes, and the human ratifies declines.**

The skill runs `npx adversarial-review --json` against an external model, parses findings,
fixes or justifies each gating finding inline, validates project tests, and re-reviews until
the change converges cleanly or reaches an informed human checkpoint.

## When to use

Use `arl` whenever you are inside an interactive agent session and want to converge code against
adversarial review:
- "arl"
- "review and fix until clean"
- "converge the review"
- "fix the review findings"
- "loop the adversarial review"
- "iterate until the review passes"

Do **not** use the CLI's `--loop` flag inside an agent session; `--loop` is designed for unattended
CI bots and spawns a separate headless fixer CLI. Inside this session, use `arl`.

## Arguments

### Skill-owned flags
- `--max-rounds <n>`: Ceiling of fix rounds before pausing for a progress checkpoint. Default is `20`.
- `--max-time <duration>`: Wall-clock checkpoint interval per block. Default is `2h`.
- `--test <cmd>`: Project validation test command. Overrides automatic command discovery.

### Pass-through flags
All standard `npx adversarial-review` arguments pass through directly, including:
`--base <ref>`, `--scope <working-tree|branch>`, `--provider <p>`, `--providers <p1,p2>`,
`--quorum <n>`, `--verify`, `--passes <n>`, `--fail-on <sev>`, `--min-confidence <x>`,
`--include-files`, `--findings-ledger <path>`, and free positional focus text.

### Refused flags
The following flags are refused with a one-line explanation without calling the review CLI:
- Any `--loop*` flag (`--loop`, `--loop-fixer`, `--loop-max-iterations`, etc.): that is the unattended/CI mode.
- `--input`: no working tree to fix.
- `--prompt-only`: produces no machine-parseable review verdict.
- `--json`: managed automatically by the skill.

## Preconditions

Checked before the first review call:
1. **Git repository**: Must be inside a git repository (`git rev-parse --show-toplevel`).
2. **Branch mode check**: When `--base` is specified or `--scope branch` is active:
   - The working tree must be clean (`git status --porcelain` is empty).
   - HEAD must not be detached (`git symbolic-ref -q HEAD` succeeds).
   - If either check fails, stop with exitReason `precondition` naming the issue.
   - Record the starting HEAD commit hash as `originalHead`.
3. **Working-tree mode check**: No git cleanliness precondition is enforced.
4. **Validation command**: Discover or resolve the test command (see "Validation"). The resolved command is printed before the first run.
5. **Reviewer independence**: Evaluated on each review's stderr (see "Independence").

## Round structure

Each round $r$ ($r \ge 1$) executes:
1. **Review call**:
   ```bash
   npx adversarial-review --json <pass-through-flags> [focus] > <scratchpad>/arl/<run-id>/round-<r>.stdout.json 2> <scratchpad>/arl/<run-id>/round-<r>.stderr.txt
   ```
   Stdout and stderr are captured to separate files and never merged (`.stdout.json` and `.stderr.txt`).
   *Execution note:* Invoke the reviewer with arguments passed as distinct argv elements or strictly quoted strings, avoiding raw shell interpolation of external focus or justifications. In repositories with local dependencies, `npx --no-install adversarial-review` can be used.
   Exit codes:
   - `0`: Approve.
   - `2`: Needs-attention (findings present).
   - `1`: Error. Stop immediately with exitReason `review-error` and print the stderr tail.
2. **Independence check**: Read `.stderr.txt` on every round and verify reviewer independence (ensuring no mid-loop fallback to a same-family reviewer).
3. **Gating set computation**: Calculate $G_r$. If empty and exit code was 0, evaluate stops.
4. **Fix step**: Fix or decline every finding in $G_r$. Increments fix round counter $F$.
5. **Validation**: Run the project validation command. Fix test breakages before re-review.
6. **Branch commit** (branch mode only): Commit builder-edited files.

## Independence

On every review round, read the reviewer identity line from `.stderr.txt`:
`Using local CLI agent: <cmd>` or `Using LLM provider: <provider> (model: <m>)`.

### Family classification
- CLI binaries: `codex` $\to$ openai, `claude` $\to$ anthropic, `agy` $\to$ gemini, `agent` or `cursor-agent` $\to$ cursor, `copilot` $\to$ unknown, `opencode` $\to$ unknown.
- API providers: `anthropic` $\to$ anthropic, `openai` $\to$ openai, `gemini` $\to$ gemini.
- Gateways: `vercel` / `gateway` $\to$ family of model id if recognizable, otherwise unknown.
- Builder family: Claude Code $\to$ anthropic, Cursor $\to$ cursor, Antigravity $\to$ gemini, Codex CLI $\to$ openai, Copilot $\to$ unknown.

### Hard stop
Stop with exitReason `no-independent-reviewer` before performing any fixes if ANY of the following occur:
- Stderr contains a `fell back to` warning.
- Reviewer family equals builder family.
- Reviewer family or builder family is `unknown`.
- No reviewer identity line is found on stderr.

*(Note: after 3.0.0 D1 lands, `meta.independent` in the JSON document replaces this stderr parse).*

### Override
An explicit `--provider <p>` argument in the invocation overrides the independence stop.
When overridden:
- The summary reports `independence: "overridden"`.
- The final verdict is never `approve`; it is `needs-attention` with reason `independence overridden`.

## Gating set

At 2.11.1, compute gating set $G_r$ from the review JSON:
1. **Threshold**: Include findings where `severity` $\ge$ `--fail-on` (default `medium`) AND `confidence` $\ge$ `--min-confidence` (default `0.5`).
2. **Empty-set edge**: If the computation produces an empty set but the CLI exited with code 2, treat every finding with `severity` $\ge$ `--fail-on` as gating and record the fallback in the round log.
3. **Grounding filter**: Drop any candidate whose cited `file` is not in the reviewed change set (`git status --porcelain --untracked-files=all` for working-tree, or `git diff --name-only <merge-base>...HEAD` for branch mode). Exclude it from $G_r$ and list it as `out of change set`.
*(Note: T122 will replace these rules with the CLI's native `gating` boolean flag).*

### Finding identity
Two findings match if they have the same `file`, `category`, and `title`, and `line_start` within 5 lines (or both 0).
Two gating sets are identical if every finding matches and set sizes are equal.

## Fix step

Performed inline in this calling context. For each finding in $G_r$:
- **fix**: Edit code to address the finding. Fixes beyond the cited file are allowed if needed; unrelated refactoring is prohibited.
- **decline**: Provide a substantive written justification (at least one sentence citing code, a test, or a spec requirement). "Works as intended" without evidence is rejected. Declined findings enter the declined set.

Record each action in the round log:
`{ round, action: "fix"|"decline", finding: <verbatim>, justification?: <text>, filesEdited?: [<paths>] }`.

## Validation

### Command resolution
Resolve the test command using first match:
1. `--test <cmd>` argument.
2. Test command in `CLAUDE.md` or `AGENTS.md`.
3. `package.json` `scripts.test`.
4. `Makefile` target `test`.
5. `pyproject.toml` or `pytest.ini` $\to$ `pytest`.
6. `Cargo.toml` $\to$ `cargo test`.
7. `go.mod` $\to$ `go test ./...`.

If no command is discovered, ask the user once at start. If unattended or user confirms none exists, proceed with `validated: false` announced prominently in the report.

### Validation execution
Run the test command after every fix step. If tests fail, repair the failure (up to 3 attempts within the round). If still failing after 3 attempts, stop with exitReason `validation-failed` and log the test output tail. No review call is made on an unvalidated tree.

## Rebuttal

If round $r$ declined any findings, round $r+1$ appends rebuttal focus text to the review:
> The builder declined the following findings from the previous review and asks you to refute or withdraw each. For each one, either re-raise it with the specific evidence that defeats the justification, or omit it. Declined: [for each: title; file:line; the justification verbatim].

### Rebuttal accounting
- If the reviewer re-raises the finding: marked as `contested` (blocking human-ratified finding). It is not re-sent in subsequent rebuttal rounds.
- If the reviewer drops the finding: marked as `withdrawn` (non-blocking, listed in report).

## Progress accounting

Track each round $r$:
- Count of $G_r$ by severity (critical, high, medium, low).
- `new`: findings matching nothing in earlier rounds.
- `recurring`: findings matching $G_{r-1}$.
- `reintroduced`: findings matching $G_k$ ($k < r - 1$) but not $G_{r-1}$.
- `fixed`: findings from $G_{r-1}$ resolved and absent in $G_r$.
- `declined`: findings declined this round.
- `outOfChangeSetCount`: findings citing files outside the change set.
- `roundsSinceDecrease`: rounds since $|G|$ last decreased.

## Stops and checkpoints

Evaluated in order after each review:
1. **clean**: Exit code 0 and contested set is empty $\to$ exitReason `clean`, verdict `approve`.
2. **converged-with-accepted**: Exit code 0 and contested set is non-empty $\to$ exitReason `converged-with-accepted`, verdict `needs-attention`.
3. **no-progress checkpoint**: Three consecutive identical gating sets ($G_r = G_{r-1} = G_{r-2}$) $\to$ trigger checkpoint (`three consecutive`).
4. **ceiling checkpoint**: Fix count $F ==$ `--max-rounds` (`20`) $\to$ trigger checkpoint.
5. **time checkpoint**: Wall-clock time since the block started $\ge$ `--max-time` (`2h`) $\to$ trigger checkpoint (exitReason `checkpoint-time` if stopped). When continuing for another block, reset `blockStart` to the current time.
6. **builder-stuck**: The builder may raise a checkpoint on architectural ambiguity.

### Checkpoint pause
Print the trend table and present three options:
1. Continue for another `--max-rounds` block.
2. Change approach (user provides directive focus text or adjusts scope).
3. Stop.

**Rule-based recommendation**:
Recommend **continue** ONLY if the combined critical + high count decreased within the last 5 rounds AND no finding has been `recurring` or `reintroduced` 3 or more times. Otherwise recommend **stop** and list the blocking findings.

Before prompting the user at any checkpoint or stop, write the summary block to `<scratchpad>/arl/<run-id>/summary.json`.

### Trend table columns
`round | elapsed | critical | high | medium | low | new | recurring | reintroduced | fixed | declined | out-of-change-set | rounds-since-decrease | validated`

## Branch mode

When running in branch mode:
1. Following a validated fix step, stage only edited files:
   `git add -- <paths>`
   Never `git add -A`.
2. Commit with:
   `git commit --no-gpg-sign -m "fix(review): round <r>" -m "<one line per fixed finding title>"`
3. Verify `git status --porcelain` is empty. If any untracked or modified files remain, stop immediately with exitReason `precondition` naming the stray paths.
4. Record `originalHead` at session start. At any stop, output `git reset --hard <originalHead>` as the rollback command.

## Report

### Prose report
1. Header stating validation status (`validated: true|false`).
2. Surviving gating findings verbatim (title, severity, file:line, body, recommendation).
3. Contested findings with builder justification and reviewer rebuttal.
4. Withdrawn findings.
5. Out of change set findings.
6. Progress trend table.

### Summary block
The final response must end with a fenced JSON block:
```json
{
  "type": "loop_summary",
  "mode": "arl",
  "providers": ["<reviewer id as announced>"],
  "iterations": 0,
  "reviews": 1,
  "verdict": "approve",
  "exitReason": "clean",
  "survivingCount": 0,
  "acceptedCount": 0,
  "withdrawnCount": 0,
  "outOfChangeSetCount": 0,
  "elapsedSeconds": 12,
  "validated": true,
  "validationCommand": "npm test",
  "independence": "verified",
  "scope": "branch",
  "base": "main",
  "originalHead": "dae18ce",
  "roundLog": "<scratchpad>/arl/<run-id>"
}
```

## Output discipline

Findings are quoted verbatim, never softened or paraphrased.
The skill never declares a finding fixed without a validated tree and a subsequent review that drops it.
The skill never exits `clean` while a contested finding exists.
