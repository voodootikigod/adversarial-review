# ROADMAP-ARL: `adversarial-review-loop` (arl) — handoff for continuing elsewhere

Written 2026-10-10 on branch `feat/arl-skill` (worktree `.worktrees/arl-skill`, based on main at 129e894).
This file is the session handoff for ticket **T120**. It does not replace `ROADMAP.md` (the 3.0.0 roadmap).

## 1. What this is about

`--loop` was built so that a model other than the builder reviews the builder's work. Investigation on
2026-10-10 showed its fixer is a second headless CLI chosen by the review tool, never the context that
built the code:

- `detectFixer` (src/loop.js) walks `codex → claude → agy` on PATH, ignoring both the resolved reviewer
  and the builder environment.
- Inside Claude Code with no Gemini/OpenAI key the reviewer ladder also picks `codex`, so one model
  reviews, fixes from a bare prompt, and re-reviews its own fix.
- The fixer sees only finding text (`buildFixPrompt`), cannot decline a finding (`acceptedCount` is
  hard-coded 0), and the only same-provider check (`--loop-unsafe-allow-fix-secrets`) requires
  fixer == reviewer.
- 3.0.0 R1 (T86/T97) adds the fixer family to the builder set, so a compliant `--loop` from Claude Code
  needs a third model family. Builder-fixes needs two.

**Decision:** the external model reviews, the calling (builder) context fixes, the human ratifies
declines. That is the `arl` skill. `--loop` stays as the unattended/CI mode.

## 2. Session reference artifacts

This section references artifacts produced during ticket T120 planning. (Note: These documents record planning history and do not constrain or substitute for independent code review of the change set).

| Artifact | Location | Status |
|---|---|---|
| Spec (D1–D28 decisions, protocol, 10 ACs, premortem) | `.adlc/specs/T120.md` (tracked) | Approved spec, hash bound in manifest seq 175 |
| Ticket T120 | `.adlc/tickets/t120--*.json` (store) | created seq 166, updated seq 173 (authorized scope widening) |
| Ticket drafts T121, T122, T123, ADLC-ARL | `.adlc/plans/arl-ticket-drafts.json` (gitignored, local only) | drafts; not in the store |
| Deltas 41–43 registry amendment | `.adlc/plans/3.0.0-decisions.md` (gitignored, local only) | recorded as P0-approved |
| Evidence trail | `.adlc/manifest.jsonl` seq 166–175 | spec-lint 171, premortem 172, parallax 170, coldstart 174, spec-approval 175 |
| Session memory | `~/.claude/projects/-home-voodootikigod-Projects-adversarial-review/memory/builder-fixes-reviewer-reviews.md` | principle + rulings |

`adlc run p1 --ticket T120` → "required evidence present". Model-router: cheap/ladder. Merge-forecast
flags a T120–T51 scope overlap (package.json, test/packaging.test.js) only if they run concurrently.

## 3. The decisions in one screen

- **Shape:** skill-only protocol over the non-loop CLI with `--json`. No CLI code in T120. Name
  `adversarial-review-loop`, "arl" and `--loop` in the trigger description, mirrored byte-identically
  into `.agents/skills/`, no npm bin.
- **Fix context:** inline in the main calling context. Never a fork, fresh context, or the reviewer's model.
- **Independence:** read the reviewer identity line from stderr (`Using local CLI agent:` /
  `Using LLM provider:`); any "fell back to" warning, same family as the builder, unknown family, or
  no identity line at all → stop `no-independent-reviewer` before any fix. Explicit `--provider`
  overrides, and an overridden run never reports verdict `approve`.
- **Gating (2.11.1):** severity ≥ `--fail-on` and confidence ≥ `--min-confidence`; empty-but-exit-2
  → over-include everything ≥ `--fail-on`; findings citing a file outside the reviewed change set are
  excluded and listed `out of change set`. T122 retires both rules.
- **Fix/decline:** every gating finding is fixed or declined with an evidence-citing justification.
  Declined findings go back to the reviewer as focus text; re-raised → `contested` (blocking, human
  ratifies), dropped → `withdrawn` (listed, not blocking). Rebuttal reviews count as rounds.
- **Validation:** project tests must pass before each re-review (command from `--test`, CLAUDE.md,
  package.json, Makefile, pyproject, Cargo, go.mod; ask once; none + no user → continue with
  `validated:false` said loudly). Resolved command printed before first run; up to 3 fix attempts
  then `validation-failed`.
- **Checkpoints (ask continue / change approach / stop, with a trend table and a rule-based
  recommendation):** 20 fix rounds (`--max-rounds`), 3 consecutive identical gating sets,
  `--max-time` default 2h, builder-stuck. Recommend continue only if critical+high fell in the last
  5 rounds and nothing recurred 3+ times. `summary.json` written to the round-log dir at every
  checkpoint and stop.
- **Scope/git:** `--base`/`--scope` pass through. Branch mode needs a clean tree and attached HEAD;
  commits only builder-edited paths (`git add -- <paths>`, `--no-gpg-sign`, `fix(review): round N`),
  non-empty porcelain after commit → stop naming strays. Base ref never written. Never `git add -A`.
- **Capture:** stdout and stderr to separate files under `<scratchpad>/arl/<run-id>/`, never merged.
- **Report:** verbatim prose + a fenced JSON block `{"type":"loop_summary","mode":"arl",...}` with the
  CLI's field names (providers, iterations, verdict, exitReason, survivingCount, acceptedCount,
  validated) plus reviews, withdrawnCount, outOfChangeSetCount, elapsedSeconds, independence, scope,
  base, originalHead, roundLog.
- **Timing:** T120 ships now as a 2.11.x docs-and-skill release. T121 (harness stderr notice,
  delta 41), T122 (per-finding `fingerprint` + `gating`, delta 42), T123 (`--accept [path]`
  default `.adlc/acceptances.jsonl`, delta 43) are 3.0.0 tickets. One ticket in the adlc repo swaps
  in-session P5 guidance to arl; the CI template keeps `--loop`.

## 4. Files T120 writes (scope) and must not touch (rails)

Scope:
- `skills/adversarial-review-loop/SKILL.md` (new) + `.agents/skills/adversarial-review-loop/SKILL.md` (byte-identical copy)
- `test/skill-assets.test.js`: SKILL.md pair identity for BOTH skills with a one-byte negative control on a temp copy; frontmatter parse; headings + literal strings; README/CHANGELOG/SKILL-bullet greps; skills-lock parse; src/llm.js identity-string pin (`Using local CLI agent:`, `Using LLM provider:`, `fell back to`)
- `package.json` `files` += `skills/adversarial-review-loop/`; `test/packaging.test.js` asserts it
- `skills-lock.json`: new entry (hash via the skills CLI, not sha256sum)
- `README.md`: install section names both skills; "Loop mode" opens with a "Two loops: which one" paragraph (contains `adversarial-review-loop` and `unattended`)
- `skills/adversarial-review/SKILL.md` + `.agents` copy: the `--loop` bullet opens "not for use inside an agent session: use the `adversarial-review-loop` (arl) skill…" before "unattended"
- `CHANGELOG.md` `[Unreleased]`: Added (skill) + Changed (docs repositioning)

Rails (do not edit): `bin/cli.js`, `src/*.js`, `schema.json`, `prompt-template*.md`,
`skills/adversarial-review/references/**`, `test/parity/**`. `adlc rails-guard --base main --ticket T120` enforces this.

AC4 literal strings the SKILL.md must contain: `--max-rounds`, `--max-time`, `20`, `2h`,
`three consecutive`, `no-independent-reviewer`, `converged-with-accepted`, `checkpoint-time`,
`out of change set`, `independence overridden`, `--no-gpg-sign`, ``Never `git add -A` ``,
`.stdout.json`, `.stderr.txt`, `"mode": "arl"`. Headings: Arguments, Preconditions, Independence,
Gating set, Fix step, Validation, Rebuttal, Progress accounting, Stops and checkpoints, Branch mode,
Report, Output discipline.

## 5. Next steps (in order)

1. **RED**: add the tests above to `test/skill-assets.test.js` and `test/packaging.test.js`; run
   `npm test` and watch them fail for the right reason.
2. **GREEN**: write `skills/adversarial-review-loop/SKILL.md` from spec section "The protocol"
   (it is the normative content), `cp` it to `.agents/skills/…`, then package.json, skills-lock,
   README, the two `--loop` bullets, CHANGELOG. `npm test` green.
3. **AC8 check**: `npx adversarial-review --help` output byte-identical to main; `git diff --stat main`
   touches nothing under bin/, src/, test/parity/, schema.json.
4. **P3**: `adlc rails-guard --base main --ticket T120`.
5. **P5**:
   - `adlc hollow-test --test-cmd "node --test test/"` — run ONLY in a dedicated detached worktree
     (see memory `hollow-test-isolation`), never beside this builder worktree.
   - `npx adversarial-review --base main --providers <two non-anthropic families> --verify`
     (or at least one non-anthropic reviewer) until exit 0.
   - Cold trials (spec AC9), three fresh agents holding only the SKILL.md, in temp repos built
     with the T50 harness mocks (`test/parity/helpers/harness.mjs`: `makeContext`, `makeRepo`,
     `ctx.mock("codex", {responses:[...]})`, `FLAG`/`APPROVE` fixtures):
     (a) FLAG → re-FLAG same finding (rebuttal) → APPROVE ⇒ `converged-with-accepted`, `acceptedCount: 1`;
     (b) FLAG ×4 unchanged ⇒ `checkpoint-no-progress` after the third identical round with a trend table;
     (c) inside Claude Code with the mock named `claude` ⇒ `no-independent-reviewer`, zero fixes.
     Attach the three final messages to the ticket as a P5 note.
   - `adlc run p5 --ticket T120 --base main`.
6. **Commit** on `feat/arl-skill` (conventional message, e.g. `feat(skill): adversarial-review-loop (arl) — external review, in-context fix (T120)`); run `/verify` before the commit per the global rule; open the PR against main; `npx adversarial-review --base main` must exit 0 before merge (global git-workflow rule).
7. **P6**: human gate; `adlc gate-manifest show`; `adlc accept` records the decision; `adlc ticket complete T120 --write --authorize`.
8. **After merge**: write T121/T122/T123 to the store from `.adlc/plans/arl-ticket-drafts.json`
   (`adlc ticket create --input <json> --write`, one ticket per file); file the ADLC-ARL ticket in
   the adlc repo; consider `adlc ticket complete T51` if T51 has shipped (merge-forecast overlap).
9. **Release**: 2.11.x docs-and-skill release via the `release` skill; `npm run sync-skill` is part
   of `prepublishOnly`.

## 6. Gotchas learned this session

- A PreToolUse hook blocks any Bash command whose text contains `--no-verify` near `git commit`,
  even inside a heredoc or JSON string. Write such content with the Write tool, not a heredoc.
- `adlc ticket update … --write` needs `--expect <ticketHash>` (from `adlc ticket show ID --json`)
  and `--authorize` for scope widening. `ADLC_MANIFEST_KEY` is set in this environment; writes are signed.
- The skills-lock `computedHash` is not `sha256sum` of SKILL.md; regenerate with the skills CLI.
- Agent replies over ~4KB are truncated in transit; have subagents write JSON to the scratchpad and
  reply "written".
- `.adlc/specs/` is tracked; `.adlc/plans/`, tickets, manifest are gitignored (local only). When
  continuing on another machine, carry `.adlc/plans/arl-ticket-drafts.json` and the decisions file
  across by hand, or re-derive from section 3 and the spec.
- Never bare `git stash` in this worktree; the stash stack is shared across worktrees.
