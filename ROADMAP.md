# Roadmap: optimize and simplify adversarial-review (from v2.11.0, ships as 3.0.0)

> Status: plan only; nothing here is implemented yet. This is plan v58, the version that
> received an `approve` verdict with zero findings from an adversarial review by the
> `agy` CLI (round 56 of a review-and-revise loop; rounds 1-15 were reviewed by the
> `codex` CLI, which last saw v17). Items marked "withdrawn" were removed during that
> loop and need their own spec and review before any implementation.
>
> v59 = v58 + the human P0 decisions of 2026-10-04 (`.adlc/plans/3.0.0-decisions.md`,
> which is binding and wins over any v58 text it contradicts). v59 RECEIVED an
> `approve` verdict with zero findings from the `agy` CLI on 2026-10-04 (adversarial-review
> 2.11.0 `--input`, split into three passes because of the argv limit A11 fixes: A =
> v58->v59 diff vs decisions, approve; C = D7-D10 vs Step 0 and R1-R5, approve; B = the
> new items, 4 findings in round 1, all fixed, approve in round 2, which also covered
> A11/delta 38). The re-review covered the amended sections only: this status header, the step 0
> loop-delta list and matrix (delta 28 rows), R1 (B1, B2 notes), R4 (B7, B8 notes and
> the limit 5 success-line sentence), R5 (delta 28 sentence,
> numeric validation, quorum validation, CLI unit budget, B11 note), A9 (B12 note),
> C4, D1 (Q3, B9, B10 notes), the new items D7, D8 and D9, "Intended deltas" (deltas
> 2, 8, 17 and 28 amended; 32 to 36 added; new flags) and "Sequencing" (steps 3 and 4).
> v59 also covers the new item D10 (optional decision provider, P0 decisions J1-J9,
> delta 37, ticket T99), with delta 37 and the `--decider-*` flags in "Intended
> deltas", delta 37 in the step 0 loop-delta list, and its step 6 entry in
> "Sequencing", plus A11 (agy stdin transport, delta 38, ticket T117).
> Every other line is byte-identical to v58.

Target repo: adversarial-review (Node CLI). Core intent: review a change in a DIFFERENT
context with a DIFFERENT model than the one that built it, as a single review or as a
loop (review -> fix -> re-review) until the gate approves.

Files referenced: bin/cli.js, src/review.js, src/loop.js, src/llm.js, src/git-context.js,
src/config-store.js, src/resolution-lifecycle.js, src/utils.js, prompt-template.md,
prompt-template-artifact.md, schema.json.

This is a major release (3.0.0) because R1 and D1 change observable behavior. Every
intended behavior change is listed in section "Intended deltas"; anything not listed
there must be behavior-preserving and is held to the parity suite in step 0.

## Step 0. Parity suite (lands first, before any refactor)

A black-box suite, `test/parity/*.test.mjs`, that runs `bin/cli.js` as a subprocess
against temp git repos, with mock provider CLIs on PATH (the existing `#!/bin/sh` mock
pattern) and a local HTTP stub for API providers. It asserts only observable output:
exit code, stdout JSON / NDJSON events, stderr warning presence, resulting git state.
It is written against the CURRENT code. C2 and C1 are pure refactors: the suite must
pass with zero edits before and after each of them. The loop's checkpoint and rollback MECHANISMS (stash; `reset --hard` + `clean -fd`)
are not changed by this plan (R4), and C2/C1 change nothing about when they run. The only
loop-behavior deltas in this plan are delta 18 (acknowledgement flag), delta 25 (working-tree loops refuse to
start while untracked, non-ignored files exist), delta 21
(`validated` field), delta 24 (`review-error` events) and delta 26 (fix-prompt
redaction field), plus, from v59, delta 34 (`thrash` exit, D7) and delta 35 (reviewer
rotation and the confirmation review, D8), and delta 37 (configured-only and additive:
with a decider configured, `loop_summary.meta.decider` and decider requests between
loop rounds, D10; an unconfigured loop is byte-identical); none of them changes how a checkpoint is taken, what the fixer may edit, or how
rollback runs.
Matrix:

- scope: working-tree, branch
- providers: single API, single CLI, multi-provider (2 families, quorum 1 and 2)
- flags: --verify on/off, --passes 1/2, --json on/off
- inputs: empty scope (with and without --fail-on-empty), oversized diff (API fails
  closed, CLI gets summary, --allow-summary-review), payload containing a secret (with
  and without --allow-secrets), reviewer output containing a secret (redacted)
- failures: one provider fails in multi-provider (skipped + under-satisfied notice), all
  fail (exit 1), malformed model JSON (one corrective retry, then exit 1)
- loop: clean first round, converge after 1 fix, no-progress, ceiling, fixer error with
  partial changes (rollback), fixer timeout, no-diff; both working-tree and branch scope
- usage errors (v59, delta 28 kept): `--model` with `--providers` as a single entry,
  as a list, and as `auto` -> exit 1, zero provider calls; these three rows pin
  v2.11.0 behavior, land here, and never list 28 in `futureDeltas`
- exit codes for every row above

Context source: "collect context" and "build prompt" are a pair chosen by the caller
and passed into the shared round, never chosen inside it: the git pair
(`collectReviewContext` + `buildPrompt`) for diff reviews and for every loop round,
or the artifact pair (`collectArtifactContext` + `buildArtifactPrompt`) when
`--input` is given. `--input` applies only to non-loop runs. Today
`--loop --input <file>` silently ignores `--input` and runs the fix loop on the git
worktree; intended delta 30 makes that combination a usage error in `parseArgs`
(exit 1, stderr only, nothing touched), with a message that the loop reviews and
edits the git worktree and cannot target an artifact. As today, an unreadable, binary,
oversized, or empty artifact exits 1, and an artifact context never takes the
summary path. Step 0 parity rows for `--input`: single API provider, single CLI
provider, multi-provider, a missing file (exit 1), an empty file (exit 1), a file
over `--max-bytes` (exit 1), and a run from a non-git directory.
Scope of the shared round (C2): it covers the stages from "collect context" through
"redact secrets in reviewer output" and RETURNS one envelope: `{ status: "reviewed", unredacted, redacted, assessments,
scrubbedAssessments, derived, reviewers, failedReviewers, statuses }` (`assessments`
keeps the original grounding notes for internal use only: gating and the fix prompt;
`scrubbedAssessments` has exactly the same shape, an array of `{ notes,
effectiveConfidence }` index-aligned with the findings, with identical
`effectiveConfidence` values and each note string scrubbed, and it is the ONLY
assessments value a caller may pass to `renderReport`, log, or emit, so the human
report shows the same grounding notes and the same gate grouping as today; `statuses` is the per-finding verification-status side
array of A9, index-aligned with the findings of both `unredacted` and `redacted`; it
is present from the A9 change onward, and the caller attaches `statuses[i]` to finding
`i` of the redacted copy when it emits the JSON document or a loop `review_result`), i.e. BOTH the unredacted result (with its
assessments and derived verdict) and a separate redacted copy, plus the execution
facts only the round knows: `reviewers` (for each provider that returned a review:
id, provider, final model, transport, family, independent) and `failedReviewers`
(id + cause). The caller builds `meta` from these (D1) and, in a loop, accumulates
them across rounds and learns from them when a fallback changed the reviewer; it never mutates the
unredacted result, never writes the ledger, never prints, never emits an event, and
NEVER calls `process.exit`. Every way a round can end without a review is handed
back to the caller, which alone decides the exit code, stderr text, and events: an
empty scope (when the caller enabled the empty exit) returns `{ status: "empty" }`;
every refusal or failure is thrown as a typed error carrying its data
(`SecretRefusalError`, `NotIndependentError`, `QuorumUnmetError`,
`NoConfigurationError`, `ReviewFailedError`, and context-collection errors). How the
drivers map these outcomes is STAGED. In the C2/C1 refactor (step 1) both drivers map
every outcome to exactly what v2.11.0 does for it today, with the same exit code,
the same stderr text, and the same events or absence of events (for example a loop
review failure still prints to stderr and exits 1 with NO terminal events, and a
multi-provider shortfall still follows today's capped-quorum behavior); the error
types that have no v2.11.0 counterpart (`NotIndependentError`, `QuorumUnmetError`)
are simply never thrown yet. The new mappings arrive only with their deltas:
`review-error` events with delta 24, the JSON error objects and the
`quorum-unmet` / `not-independent` events with the step 3 change. That is what lets
the parity suite pass unedited across step 1. Wherever this plan says a step "ends the run" or "exits", it
means the round returns or throws this outcome and the CALLER ends the run. The redacted copy is
what any caller prints, emits, or ledgers. The unredacted result is used for exactly
one thing: the loop's fix prompt, through today's path unchanged
(`redactSecretsInFindings` unless `--loop-unsafe-allow-fix-secrets` passed its
existing same-provider check), so that flag keeps working. One correction to that path, intended delta 26: `redactSecretsInFindings`
today scans only `title`, `body`, `evidence`, `recommendation`; `exploit_scenario` is
added to that list (the fix prompt does not currently include that field, so this is
defense in depth for any field the prompt builder uses, now or later, and the
function's contract becomes "every free-text finding field"). A parity row pins the
flag: with
`--loop-unsafe-allow-fix-secrets` the fixer's stdin contains the unmasked token; without
it, the placeholder. That flag's existing rule requires the reviewer and the fixer
to be the SAME provider, which under R1 is by definition `independent: false`: from
the step 3 change onward the flag can only be used together with
`--allow-same-family` (its help text says so; without it the loop ends with the
ordinary `not-independent` refusal), and the step 3 change adds `--allow-same-family`
to that parity row's invocation in addition to `--builder human`. Ledger and emit are
caller stages: the non-loop CLI driver writes the ledger and prints one report/JSON
document after the round, exactly as today; the loop driver, exactly as today, writes
no ledger, prints the human report per round to stdout only when `--json` is off, and
with `--json` emits only NDJSON events. The stage order below is the non-loop
end-to-end order; for loop rounds the order tests stop at "redact" and then assert
today's event sequence. The suite is black-box,
so it asserts only OBSERVABLE precedence, i.e. which outcome wins when two
conditions hold at once, and never the internal order of steps that have no
observable difference (for example whether the prompt string is built before or
after the legacy secret scan: in v2.11.0 the non-loop driver builds the prompt
first and the loop driver scans first, and neither is observable). The precedence
pairs asserted against v2.11.0, one test each: an empty scope ends the run before a
secret refusal can occur (non-loop without `--prompt-only`, and loop); a secret
refusal happens before any provider is called (the mock provider records zero
invocations); the review call precedes verify calls; verify precedes the derived
verdict (a refuted finding does not gate); grounding uses unredacted evidence while
printed output is redacted; the ledger and the printed result carry the same
redacted findings. In step 0, and unchanged through C2 and C1, the secret scan
covers what it covers today: the collected repository content only.
Delta 17 is a separate, later change (sequencing step 2, right after A7) that
moves the scan to the complete prompt text (template + focus + content)
exactly ONCE per round, centrally and synchronously, after the prompt is
built and BEFORE any provider worker is dispatched (the prompt is identical for every
provider and pass). A hit without `--allow-secrets` aborts the whole run exactly as
today (exit 1, stderr message, nothing on stdout, no provider called); it is never
reported as a per-provider failure and can never be absorbed by `allSettled`. A
corrective retry adds only already-scrubbed feedback to that scanned prompt, so no
per-attempt rescan exists,
with the same refuse-unless-`--allow-secrets` behavior; that change edits the two
stage-order tests adjacent to the scan and adds fixtures with a token in the diff, in
the focus text. C2 changes no stage position. Grounding must see unredacted evidence (it compares
quotes against the real diff), which is why redaction of the retained result stays
late. Step 0 asserts ONLY v2.11.0 behavior: the legacy output shape (no `meta`, no
`verification_status`), today's verify behavior (findings sent to the verifier as
they are), and today's defaults. Nothing in step 0 tests a delta. Every intended
delta listed at the end of this plan lands as its own change after C2/C1, and that
change is the one that edits the parity rows it affects and adds its own tests; in
particular the verify-payload rules (A9 / delta 15) and `verification_status` and
`meta` (D1) are tested only from the changes that introduce them. Old code paths
are deleted only in the same change in which the parity suite passes on the new path.

## Rules (decisions, not options)

R1. Independence invariant.
- Family normalization: provider `anthropic`/CLI `claude` -> anthropic; provider
  `openai`/CLI `codex` -> openai; provider `gemini`/CLI `agy` -> gemini; gateway
  (`vercel`) -> family of the model id prefix (`anthropic/`, `openai/`, `google/` ->
  gemini), else unknown; any custom base URL (flag or env, for any provider including the gateway), the Cursor agent CLI, `copilot`,
  `opencode`, and any unrecognized CLI -> unknown.
- Builder set: `--builder` takes a comma-separated list and may be repeated
  (`--builder openai,anthropic`); `ADVERSARIAL_REVIEW_BUILDER` takes the same
  comma-separated form (exact grammar in D2). Source precedence: flag > env > harness detection > none (these are exactly the `meta.builder.source` values `flag`, `env`, `detected`, `none`; with source `none` the builder set is {unknown});
  the first source that is present supplies the WHOLE set (sources are not merged), and
  an empty or invalid value is a usage error, exit 1. Exception (P0 decision B2): when
  `--builder` is given, an empty or invalid `ADVERSARIAL_REVIEW_BUILDER` is NOT a usage
  error, because it supplies nothing; one stderr warning names the env value (passed
  through the A7 output scrub) and says `--builder` is used, and `meta.builder.source`
  is `flag`. Test: `ADVERSARIAL_REVIEW_BUILDER=bogus --builder human` -> proceeds, one
  warning containing `bogus`; negative control: the same env value without `--builder`
  -> usage error, exit 1. Harness detection yields one
  family. In `--loop`, the fixer's family is added to the INTERNAL evaluation set B used by the independence formula; it is never written into `meta.builder`. `meta.builder.families` and `meta.builder.source` record only what was declared or detected as the builder (so `--builder human` with a codex fixer emits `families: ["human"]`, `source: "flag"`), and the fixer is reported separately in `meta.fixer`. Rows pinned by test:
  `--builder openai,anthropic` + anthropic reviewer -> false; + gemini reviewer ->
  true; `--builder human,openai` + openai reviewer -> false; + anthropic -> true;
  `--builder human,unknown` + any reviewer -> null.
- `independent` is tri-state and computed by exactly this formula, per reviewer, over
  the builder set B (the declared/detected builder family, plus the fixer family in
  `--loop`): (1) drop every `human` member from B; (2) if B is now empty, the result
  is true regardless of the reviewer's family (a human-only builder; this is the only
  case where an unknown-family reviewer is true); (3) else if the reviewer family is
  known and equals any known member of B, false; (4) else if the reviewer family is
  unknown or any member of B is unknown, null; (5) else true. In `--loop` B always
  contains the fixer, so `--builder human` never makes a loop reviewer independent of
  the fixer by itself.
- Builder family values are anthropic, openai, gemini, human (code not written by a
  model; every reviewer is independent of it), and unknown.
- Enforcement is fail-closed and identical in every mode (single review, multi-
  provider, loop) and for every reviewer source (auto-selected or operator-named). It
  runs before any model call:
    independent === true  -> proceed.
    independent === false -> exit 1, unless `--allow-same-family` (proceed, warning).
    independent === null  -> exit 1, unless `--allow-unverified-independence`
                             (proceed, warning).
  The exit-1 message names the applicable flag and, for an unknown builder, names
  `--builder` / `ADVERSARIAL_REVIEW_BUILDER` (including the value `human`). The two
  flags are independent of each other: each unlocks only its own row. Both are recorded
  in provenance (D1). There is no other override and no silent path; the existing
  "fell back to Claude" warn-and-continue branches are removed.
  A non-loop `--prompt-only` run is outside R1 (P0 decision B1): it selects no
  reviewer and calls no model (bin/cli.js L325 and L354 return before any provider is
  configured), so R1 is never evaluated, `--builder` is not required, and no refusal
  is possible. The exemption is keyed on `--prompt-only` WITHOUT `--loop`: in v2.11.0
  the loop hand-off (bin/cli.js L287-290) runs before both prompt-only exits and
  src/loop.js never reads `promptOnly`, so `--prompt-only --loop` runs the full
  reviewer and fixer loop; R1 is therefore evaluated for every `--loop` run whether
  or not `--prompt-only` is also given (`--prompt-only` stays ignored by the loop, as
  today). Its help text and the README state that independence of whatever model
  receives the printed prompt is the operator's responsibility. Non-loop prompt-only
  parity rows therefore do NOT gain `--builder human` when delta 1 lands. Test:
  `--prompt-only` with no builder source (no flag, no env var, no harness marker) and
  an API key present -> exit 0, prompt printed, zero provider requests; negative
  control: the same invocation without `--prompt-only` -> exit 1 (independence null,
  builder unknown); negative control: `--prompt-only --loop
  --loop-accept-rollback-limits` with no builder source -> exit 1 (R1 refusal), zero
  fixer and provider calls.
- Consequence, stated explicitly because it is a breaking change: a run with no
  `--builder`, no env var, and no detected harness has an unknown builder, so
  `independent` is null and the run exits 1 until the operator declares the builder
  (`--builder human` for human-written code) or passes
  `--allow-unverified-independence`. The resolution matrix (C3) pins the row
  "undetected Codex builder + only an OpenAI candidate + no flags": exit 1.
- Auto-selection order: candidates whose `independent` is true, in the context's base order (C3). Only if
  none exists and `--allow-unverified-independence` is set: null candidates, in the
  context's base order. Only if none exists and `--allow-same-family` is set: false candidates, in
  the context's base order. If nothing is selectable, exit 1. The REFUSED CANDIDATE reported for an
  auto-selected run is defined once and used identically by the stderr message, the
  non-loop `not-independent` error object, and `meta.refusal`: among eligible
  candidates, prefer those with `independent === null` over those with `false` (null
  needs the less permissive override), and within that group take the first in the
  context's base order; its override is `--allow-unverified-independence` for null
  and `--allow-same-family` for false. Example: default context, `--builder
  anthropic`, ANTHROPIC key and cli:cursor present -> refused candidate cli:cursor,
  override `--allow-unverified-independence`, in both stderr and JSON.
- Multi-provider (`--providers`) run-level rule: the enforcement table above is applied
  per provider, before any call. A provider whose row is "exit 1" is not run, is
  listed in `meta.failed_reviewers` as `{ "id": <id>, "error": "not-independent" }`, and counts as not
  successful. Order of the pre-call steps, non-loop MULTI mode, each step's exit
  taking precedence over every later one: (1) collect context; (2) empty check: an
  empty scope ends the run here exactly as today (exit 0, or exit 1 with
  `--fail-on-empty`), before any provider or quorum logic, so an empty change never
  reports `quorum-unmet`. In `--loop` this exit applies, exactly as in v2.11.0, ONLY
  to the initial round (before any fixer has run), where it emits today's `empty` /
  `clean` terminal events; in later rounds the shared round performs no empty exit
  and never applies `--fail-on-empty`: an empty context after a fix (the fixer
  reverted the change) is reviewed as today and reaches the loop's ordinary `clean`
  condition with its normal `review_result`, `loop_end`, and `loop_summary` events.
  The caller tells the round whether the empty exit is enabled; a parity row covers
  a fixer that empties the diff, with and without `--fail-on-empty`; (3) resolve tokens (unreachable ones recorded); (4) R1
  filter (`not-independent` recorded); (5) `resolveReachableProviders` for a
  non-inlinable diff (API providers downgraded to their family CLI, or recorded
  `diff-too-large`; a downgraded CLI is re-checked against R1); (6) pre-call quorum
  check on what remains; (7) build prompt; (8) the central secret scan (a hit without `--allow-secrets` aborts with exit 1; in
  a NON-loop run that is stderr only with nothing on stdout; in a loop, where
  `loop_start` has already been emitted, it is the `review-error` terminal event
  pair of delta 24, in the first round as in any other); (9) phase 1 dispatch. Until delta 17
  lands, the secret scan keeps its legacy position between (2) and (3). SINGLE mode
  follows the same order with "select reviewer + R1 enforcement" in place of
  (3)-(6). In `--loop`, as today, fixer/reviewer selection and R1 enforcement happen
  ONCE before the first round (before any context is collected), and each round then
  runs (1), (2), (5), (6), (7), (8), (9). Pre-call check: if the number of PERMITTED providers is zero, or is less
  than `--quorum` and `--allow-degraded-quorum` is not set, the run exits 1 before
  any model call; with `--json` it prints the same `quorum-unmet` error object as the
  post-call case (R5), with `successful: []`, `failed` listing each excluded
  provider with its cause, and `permitted` listing the ids of providers that passed
  every check but were not called because the quorum could not be met (so every
  requested provider appears in exactly one of the three arrays), so stdout is never empty under `--json`; in
  a MULTI-provider `--loop --json` it emits `loop_end` and `loop_summary` with
  exitReason `quorum-unmet`. This pre-call quorum check and the `quorum-unmet`
  outcome exist only in MULTI mode. In SINGLE mode the corresponding case (the one
  reviewer is an API provider, the diff is not inlinable, and `--allow-summary-
  review` is unset) is today's fail-closed summary-only guard error: non-loop, exit
  1, stderr only; in a single-reviewer loop it is a review failure and emits the
  `review-error` terminal events (delta 24). After the calls, the number of providers that returned a review must
  be >= `--quorum` (delta 19), else exit 1. So with one independent and one same-family provider and no flags: quorum 1 ->
  proceeds on the independent one; quorum 2 -> exit 1 with zero model calls made. Tests cover mixed
  true/false/null sets at quorum 1 and 2 with each override.
- Loop startup order, each step's failure taking precedence over later steps: (1)
  argument validation, including `--loop-accept-rollback-limits` (usage errors:
  stderr only, no events); (2) scope preconditions exactly as today (branch scope:
  clean tree, attached HEAD, resolvable base; a failure is stderr only, exit 1, no
  events); (3) fixer candidate detection, then joint selection and R1 enforcement;
  an empty fixer list is the stderr-only "No fixer CLI found" error, while an R1
  refusal or a multi-provider shortfall emits the three-event stream (`loop_start`
  with null fixer fields, `loop_end`, `loop_summary`); (4) the OS write-sandbox
  probe for the selected fixer (failure: stderr only, exit 1, as today); (5)
  `loop_start` with the selected fixer, then the first round. So a dirty tree in
  branch scope always produces the stderr-only precondition error, never a
  `not-independent` stream. In loop mode, as in v2.11.0, fixer/reviewer selection
  (step 3) runs BEFORE any context is collected, so it takes precedence over the
  empty check: a loop started on an empty scope with an unsatisfiable selection ends
  with the `not-independent` / `quorum-unmet` stream, not with the `empty` exit. The
  rule "an empty change never reports `quorum-unmet`" is a statement about NON-loop
  runs only, where context collection and the empty check come first.
- Decision table (the complete expected results; tests enumerate mode {single, loop} x
  source {auto, named} x every reachable `independent` value x the two flags):
    true,  any flags                                  -> proceed
    false, no `--allow-same-family`                   -> exit 1
    false, `--allow-same-family`                      -> proceed with warning
    null,  no `--allow-unverified-independence`       -> exit 1
    null,  `--allow-unverified-independence`          -> proceed with warning
  Mode and source do not change any row; they only change how B is built (loop adds
  the fixer) and whether a candidate is chosen by the table or named by the operator.
- Threat model and resolver, stated normatively. The adversary this tool defends
  against is the REPOSITORY UNDER REVIEW (and anything it can place or cause to be
  placed inside the worktree). The operator's own machine configuration, including
  PATH directories outside the worktree, is trusted; a hostile binary the operator has
  on their own PATH is out of scope, as it is for git itself. "Trusted resolver" means
  exactly the existing `resolveTrustedCommand`: walk PATH (and PATHEXT on Windows) in
  order, skip any entry located inside the review trust root (the git worktree root,
  not merely cwd), take the first match, canonicalize it with realpath, and reject it
  if the canonical target is inside the trust root. A value containing a path separator (e.g. `--loop-fixer /opt/tools/codex`) is
  not PATH-walked: as today, it is resolved with `path.resolve`, canonicalized with
  realpath, must be a regular executable file, and is REJECTED (resolver returns
  null, the loop exits 1 with "a repository must not supply the tool that edits it")
  if the canonical path is inside the trust root. So a repository-relative or
  in-repo path such as `./tools/codex` can never be used as a fixer or reviewer,
  whatever flags are passed; only a path that canonicalizes OUTSIDE the worktree is
  accepted. Family attribution from a bare CLI name therefore
  rests on operator-environment trust and is labelled as such:
  `family_source: "cli"` for fixers and `transport: "cli"` for reviewers mean "the
  operator's installed CLI of that name", not a cryptographic vendor identity. An
  operator who wraps or replaces those names sets `--builder` / `--loop-fixer-family`
  / `--allow-unverified-independence` accordingly.
- Fixer family is KNOWN only for a fixer that is a bare name `codex`, `claude`, or
  `agy` (auto-detected, or given as exactly that bare name to `--loop-fixer`) and
  resolved by the trusted resolver to an executable on PATH outside the repository.
  Any `--loop-fixer` value containing a path separator, any other name, and any value
  whose basename merely looks like a known CLI (e.g. `/opt/tools/codex` outside the repository, a wrapper, or a
  symlink given by path) has family `unknown`, unless the operator declares it with
  `--loop-fixer-family <anthropic|openai|gemini>`. That flag is valid ONLY together
  with a `--loop-fixer` value whose family is otherwise unknown (a path, or an
  unrecognized name); it is a usage error, exit 1, when given without `--loop-fixer`,
  or with a bare `codex` / `claude` / `agy` (whose family is fixed by the name and
  cannot be re-declared; an operator who has replaced one of those names with a
  wrapper invokes the wrapper by path instead). A valid declaration is recorded as
  `meta.fixer.family_source: "declared"` (otherwise `"cli"` or `"unknown"`). Tests:
  `--loop-fixer ./tools/codex` (inside the repository) -> refused by the resolver,
  exit 1, regardless of `--loop-fixer-family`; `--loop-fixer /opt/tools/codex`
  (outside the repository) -> fixer family unknown -> exit 1 (null) without a
  flag; with `--loop-fixer-family anthropic` and an Anthropic reviewer -> exit 1
  (false); with an OpenAI reviewer -> proceeds.
- `--loop` selects the (fixer, reviewer) pair jointly and deterministically. Fixer
  candidates, in order: the `--loop-fixer` value alone if given; otherwise, for each
  family in the builder set in declaration order (or the single detected family), that
  family's CLI if the family is anthropic/openai/gemini and its CLI is installed; then
  codex, claude, agy (installed ones, skipping duplicates). So `--builder
  openai,anthropic` yields codex, claude, agy and `--builder anthropic,openai` yields
  claude, codex, agy. For
  each fixer candidate in order, build B (builder + that fixer) and run reviewer
  selection; take the first pair whose reviewer is `independent: true`. If no pair
  qualifies, repeat the scan accepting null reviewers only with
  `--allow-unverified-independence`, then false only with `--allow-same-family`; else
  exit 1. Example: `--builder human`, codex and claude installed, OPENAI and ANTHROPIC
  keys, default context -> fixer codex, reviewer api:anthropic. The fixer is fixed for
  the whole loop. With a named single reviewer (`--provider <name>`), reviewer
  auto-selection is disabled and the reviewer is never replaced: the scan is over
  fixers only, exactly as the `--providers` scan below with a requested set of one
  and quorum 1 (tier 1: first fixer against which the named reviewer is `independent:
  true`; tier 2/3 only with the respective override flag; else exit 1). Example:
  `--loop --provider anthropic`, builder human, codex and claude installed -> fixer
  codex. With `--providers`, reviewers are not auto-selected, so the scan is
  over fixers only: the scan runs in up to three tiers and stops at the first tier that yields a
  fixer. In every tier a provider counts only if it is REACHABLE (its token resolves to a usable API key, gateway key, or trusted installed CLI; an unreachable provider never counts toward "all" or toward quorum, and "ALL requested providers" below means all reachable ones, with at least one reachable). Tier 1 counts a reachable provider only if it is `independent: true` against B. Tier 2
  (only with `--allow-unverified-independence`) also counts null. Tier 3 (only with
  `--allow-same-family`) also counts false. Within a tier the scan is explicitly TWO passes over the
  whole fixer candidate list: pass 1 returns the first fixer for which ALL requested
  providers count; only if pass 1 finds none in the entire list does pass 2 return the
  first fixer for which the count is >= the EFFECTIVE quorum, which is `--quorum`, or
  1 when `--allow-degraded-quorum` is set (the same effective value the pre-call
  check uses). (Test: `--providers openai,anthropic --quorum 2
  --allow-degraded-quorum`, builder human, only codex installed -> fixer codex with
  the anthropic reviewer, warning printed.) (Test: `--providers
  openai,anthropic --quorum 1`, builder human, codex and agy installed -> agy, not
  codex.) If no tier yields a fixer, the loop exits 1
  before any call, and in MULTI mode this outcome is ALWAYS `quorum-unmet`, never
  `not-independent`: after the same null-fixer `loop_start`, `loop_end` and
  `loop_summary` carry exitReason `quorum-unmet`,
  `iterations: 0`, `survivingCount: null`, `meta.fixer: null`, `meta.refusal: null`,
  and `meta.failed_reviewers` lists, for the FIRST fixer candidate in scan order,
  each requested provider that R1 excluded against it (`not-independent`) or that
  was `unreachable`. `not-independent` as an exitReason, and `meta.refusal`, exist
  only for SINGLE-reviewer loops (`--provider` or auto-selection), where exactly one
  reviewer candidate is being judged; `refusal.reviewer` is never drawn from the
  context base order when `--providers` was given. So the override flags never displace a fixer that gives genuine
  independence: `--loop --providers openai,anthropic --allow-same-family` with codex,
  claude, agy installed still selects agy in tier 1. Example: `--loop --providers openai,anthropic
  --quorum 2`, builder human, codex/claude/agy installed -> codex and claude each
  disqualify one provider, so the fixer is agy. The fixer is
  selected once, before `loop_start` is emitted, and is IMMUTABLE for the whole loop
  from then on (so `loop_start.fixerCmd`, the sandbox probe, and every `fix` event
  always agree). A stale-credential fallback, in the initial round or any later
  round, re-runs REVIEWER selection only, against the same B, with the failed
  candidate excluded, and exits 1 (`not-independent` if a candidate exists but none
  is permitted, otherwise `review-error`) if no permitted reviewer remains.
- Separate context is structural and unchanged: every review is a new API request or a
  new CLI process with no session reuse (`--ephemeral` for codex).

R2. Injection taxonomy. Repository text that tries to steer the reviewer is reported
with category `injection` and severity at least `high` (so it gates at the default
`--fail-on medium`). Both templates and their synced skill copies use this single
wording; the `security`-category sentence in `<grounding_rules>` is replaced. A test
greps all template copies for the old wording.

R3. Trust policy text is NOT deduplicated. Local CLI adapters have no system channel:
`callCliLLM` concatenates the system instruction and the prompt into one message. The
policy therefore stays both in the system instruction and in the template for every
provider. (v1 item B4 is withdrawn.)

R4. Loop checkpoint and rollback: mechanisms unchanged, and every loop is gated behind
an explicit acknowledgement until the redesign lands.
- Mechanisms are not redesigned in this plan: the working-tree loop keeps its stash
  checkpoint and the branch loop keeps `reset --hard` + `clean -fd`, as in v2.11.0. A
  redesign (byte-preserving snapshots including untracked and ignored files, an
  ownership-safe per-worktree lock, symlink-safe restore, submodules, signal-safe
  rollback, fixer-termination confirmation, checkpoint timing, a retained base
  checkpoint, and guarded recovery commands) and a post-fix verify command are a
  separate design needing its own spec and review; v1 item B6, v5 item D5, and the
  earlier A8 / delta 20 / delta 25 / delta 27 of this plan are withdrawn into that
  spec. NOTHING in this plan changes `updateStashCheckpoint`,
  `restoreFromStash`, `buildRecoveryCmd`, `spawnFixer`, the SIGINT handlers, or the
  branch-scope reset/clean; the parity suite pins all of them. `createStashCheckpoint`
  and `getFixFiles` are also unchanged: the fixer is still offered tracked files
  only, and untracked files are never editable by it and never checkpointed.
- Untracked files and the working-tree loop, intended delta 25. Today the
  working-tree loop reviews untracked files (they are inlined into the review) but
  can neither fix them (the fixer is offered tracked files only) nor checkpoint them
  (the stash covers tracked changes only). So a finding in an untracked file can
  never be resolved by the loop, an untracked file the fixer touches anyway cannot be
  rolled back, and a loop whose changes are ALL untracked aborts at the checkpoint
  step with the misleading "Failed to create stash checkpoint". Making untracked
  files editable or checkpointed belongs to the checkpoint redesign, not here.
  Delta 25 instead adds one precondition to loop startup step (2), working-tree
  scope: if ANY untracked, non-ignored file exists
  (`git ls-files --others --exclude-standard` is non-empty), the loop exits 1 before
  any fixer or model is involved (stderr only, no events), listing up to 20 of the
  paths and saying to `git add` them (tracked files are reviewed, fixable, and
  checkpointed), commit them and use branch scope, or add them to `.gitignore`. This
  is the same rule branch scope already enforces through its clean-tree check, so
  after delta 25 NO loop ever runs with untracked, non-ignored files present.
  If `git ls-files --others --exclude-standard` itself fails, the loop fails closed
  (P0 decision B7): exit 1, stderr only, no events, with the git error text; it never
  treats a failed listing as "no untracked files" (so this call must not use
  `gitRun`'s `allowFail` mode, src/loop.js L59-76, which returns "" on failure).
  Test: a stub trusted git whose `ls-files --others` exits non-zero -> exit 1, the
  git error on stderr, no events, no fixer or model invoked; negative control: a
  successful empty listing lets the loop proceed past startup.
  Non-loop reviews are unaffected and still review untracked files. Parity: the
  existing rows that run a working-tree loop with untracked files present are
  replaced by a row asserting this refusal and that no model or fixer was invoked;
  the remaining working-tree loop rows stage their new files first.
- This plan makes NO claim that either loop scope is safe. `--loop` in BOTH scopes is
  disabled by default in 3.0.0 (intended delta 18): it exits 1 before detecting a
  fixer, touching git state, or calling any model unless
  `--loop-accept-rollback-limits` is passed. The exit message, the flag's help text,
  and a startup warning printed on every loop run state these limits verbatim:
    1. Git-ignored files (e.g. `.env`, local databases) are never checkpointed; if the
       fixer edits or deletes one it cannot be restored. (both scopes)
    2. There is no lock; two loops, or a loop and any other tool or person writing to
       the same worktree, can interleave, and rollback (`stash pop`, or `reset --hard`
       + `clean -fd`) cannot tell their changes from the fixer's. (both scopes)
    3. Ctrl-C kills the fixer but does not roll back its partial changes. (both scopes)
    4. Files the fixer creates are untracked and are not removed by a working-tree
       rollback. (Pre-existing untracked, non-ignored files cannot be present: both
       scopes refuse to start when any exist.)
    5. The loop never builds, typechecks, or runs tests. Its terminal state `clean`
       means only "the reviewer raised no gating finding"; a fix can still break the
       build. (both scopes)
    6. The loop does not confirm that every process the fixer started has exited; a
       surviving descendant can keep writing during the next review or after the loop
       ends. (both scopes)
    7. Only the most recent round's checkpoint is kept, so the pre-loop state of
       tracked files is not recoverable after the second fix; automatic rollback and
       the printed recovery command use `git stash pop`, which can fail on conflicts
       and, on that fallback path, drops the checkpoint. (working-tree scope)
    8. A loop cannot start while untracked, non-ignored files exist; new files must
       be `git add`ed (or committed, or ignored) first. (both scopes)
  Because of limit 5 the terminal record is explicit: `loop_summary` gains
  `"validated": false` (always false in 3.0.0, since no validation command exists), the
  human-readable success line states "review-clean (not build- or test-validated)", and
  the README states that CI must run its own build and tests after a loop.
  Wording (P0 decision B8): ": review-clean (not build- or test-validated)." is
  APPENDED to the existing clean-exit success line rather than replacing it. The
  lines that gain the suffix are exactly the non-empty-scope clean exits: working
  tree src/loop.js L1182 (stash dropped) and L1184 (clean on first review; the two
  are alternatives, at most one prints), branch L1665 and L1666. Punctuation rule:
  one trailing `.` of the existing line is removed before appending, so L1184 becomes
  "clean on first review — no fix iterations ran: review-clean (not build- or
  test-validated)." The empty-scope exits (L1070, L1584) keep their own lines
  unchanged, while their `loop_summary` still carries `validated: false`. Test: a
  clean exit in each scope -> stderr contains the suffixed line exactly once;
  negative control: an empty-scope exit -> its line is unchanged and has no suffix.
  The message tells the operator to run the loop only in a disposable clone or
  dedicated worktree with nothing else writing to it.
- `--loop-accept-rollback-limits` is separate from the existing `--loop-unsafe` (no OS
  write sandbox); neither implies the other. It is recorded in
  `meta.loop_accept_rollback_limits`.
- The gate is removed only by the future checkpoint change, after that spec's own
  review; that is out of scope here.
- Parity rows for both loop scopes are run with `--loop-accept-rollback-limits` from
  the change that introduces delta 18 onward; that change edits only the invocation
  flags of those rows and adds one refusal row per scope.

R5. Concurrency and failure semantics for parallel calls (replaces v1 B2).
- Schedule. There are two independent lanes that run at the same time: the API lane,
  a pool whose in-flight HTTP requests are capped by `--concurrency`; and the CLI
  lane, a strictly sequential queue in which at most ONE local CLI process (review
  or verify) exists at any moment. The lane is held for one whole UNIT OF WORK of a CLI
  provider, not per spawned process and not per `llmCall`: a unit is one review pass
  (the entire `runReviewOnce`, i.e. the first attempt, its corrective retry after
  malformed output, and every internal stdin-then-argv fallback inside either
  attempt) or one verify call (with its internal fallbacks). The lane is acquired
  before the unit's first spawn and released in a `finally` when the unit returns or
  throws. Another queued CLI unit can therefore never run between a provider's failed
  first attempt and its retry or fallback, and a provider's passes run in their
  original order. Timers start per spawned process, as stated below, but a unit has ONE budget: for a review pass the budget is the reviewer timeout (`--timeout` or its default), for a verify call it is `--verify-timeout`; each process spawned inside the unit gets a watchdog of (budget minus the time the unit's earlier spawns have already run), and when nothing remains the unit fails with the timeout error without spawning again. A corrective retry or an argv fallback therefore cannot extend a pass beyond its configured budget. A CLI process may therefore run while API requests
  are in flight, but two CLI processes never overlap. A pool slot is acquired per
  individual HTTP request and released when that request settles; a retry, a later
  `--passes` sample, and each verify call acquire a slot again, and nothing holds a
  slot while waiting for another slot, so the pool cannot deadlock. Timers start at EXECUTION, not at enqueue: the
  per-request AbortController timeout for an API call is created only after its pool
  slot has been acquired, immediately before the request is sent, and the watchdog
  for a CLI call starts only after the CLI lane has been acquired, immediately before
  the process is spawned; time spent waiting for a slot or for the lane never counts
  against `--timeout` or `--verify-timeout`. Both the pool slot and the CLI lane are
  released in a `finally` around the call, so every outcome (success, HTTP error,
  timeout, resolution failure, spawn error such as E2BIG, watchdog kill) releases
  it; a failed CLI call can never leave the lane held. Tests: 20 queued verify calls
  at `--concurrency 2` all get their full timeout; a CLI call that fails at spawn is
  followed by the next queued CLI call. The round has a
  hard BARRIER between reviewing and verifying, in every mode. Phase 1: every
  permitted provider runs its review passes and its own pass-merge; no verify call
  is made by anyone during phase 1. Gate: when ALL providers have settled (returned
  or failed), the quorum gate is evaluated (delta 19); on a shortfall the run ends
  there and no verify call has been made. Phase 2, only if the gate passes: each
  successful provider's verify calls run, using the same two lanes. So verification
  can never start for one provider while another provider's review is still
  outstanding.
  Every stderr progress line is prefixed with its provider id so interleaved lines
  stay attributable. (P0 decision B11: the prefix is exactly `[<C3 candidate id>] `,
  e.g. `[api:anthropic] `, on provider-work lines only; run headers, the report and the
  verdict line stay unprefixed.)
  The one-budget rule above is intended delta 33 (P0 decision Q6): in v2.11.0 every
  spawn inside a unit gets a fresh watchdog of the full timeout (e.g. `callCodexCli`,
  src/llm.js L542 stdin attempt and L558 argv fallback, each passed the whole
  `timeoutMs`), so a pass can run for a multiple of `--timeout`. Exit codes and the
  timeout error text are unchanged.
- A global limiter caps in-flight API calls: `--concurrency <n>`, default 4.
- Numeric flag validation, applied by `parseArgs` before any git access, process
  spawn, or model call; a violation is a usage error, exit 1: `--concurrency` must
  match `^[0-9]+$` and be 1..16; `--loop-fixer-timeout`, `--timeout` and `--verify-timeout`
  must each match `^[0-9]+$` and be 1..86400 (seconds); `--verify-max` must match `^[0-9]+$` and be 1..1000. No coercion, no clamping. Tests: 0, negative,
  fractional, `1e3`, empty, non-numeric, and one past each bound, for each flag.
  v59 notes: the strict `--timeout` rule is part of delta 2 and lands with A2 (P0
  decision B5); v2.11.0 parses it with `parsePositiveInteger` (src/utils.js L247-254,
  `Number()` + `Number.isSafeInteger`), which accepts `1e3`, `0x10`, ` 5 ` and any
  value above 86400. `--verify-timeout` or `--verify-max` given without `--verify` is
  a usage error, exit 1 (P0 decision B4); negative control: the same value with
  `--verify` is accepted. `--loop-seed` (D8) must match `^[0-9]+$` and be
  0..4294967295.
- `Promise.allSettled`, never `Promise.all`. Outcomes are unchanged from today: in
  multi-provider mode a failed provider is skipped with a warning and the
  under-satisfied notice, and zero successful providers exits 1; within one provider, a
  failed `--passes` sample fails that provider (as today, where the sequential loop
  throws).
- `--model` names ONE model and is meaningless across several providers (it would
  be sent to every provider, and on the gateway it would collapse distinct family
  tokens onto one model and one family). `--model` together with ANY `--providers`
  value (a single entry, a list, or `auto`) is a usage error, exit 1, before any call,
  exactly as in v2.11.0 (`parseArgs`, src/utils.js L477-479); per-provider models
  come from config pins (`defaults.models`) or the built-in defaults. This is delta
  28 as amended by P0 decision Q1: the v2.11.0 rejection is KEPT, including for a
  single entry, which supersedes v58's "single-entry `--providers` remains allowed";
  whether synonyms count as one entry is therefore moot. Because family is derived from each provider's
  final model, a config pin that would make two entries of one run the same family
  is detected after resolution: the later entry is recorded in `failed_reviewers` as
  `"duplicate-family"` and not run, so quorum always counts distinct families. Duplicate-family detection applies to
  KNOWN families only. Entries whose family is `unknown` (cursor agent, copilot,
  opencode, any custom base URL) are distinct entries keyed by their lowercased id,
  are never merged with each other, and each count toward quorum when permitted;
  their `independent` value comes from the R1 formula like any reviewer's: with a
  human-only builder set it is true (rule 2: no model built the change, so any
  reviewer is independent of the builder, whatever its family), and in every other
  case an unknown-family reviewer is null and requires
  `--allow-unverified-independence`. So `--builder human --providers cursor,copilot
  --quorum 2` proceeds without an override, while the same with `--builder openai`
  needs the flag (both rows are in the decision-table tests). Independence from the
  builder is the only thing R1 asserts; it does not assert that two reviewers differ
  from each other, and that flag's warning states that the tool
  cannot tell whether unknown-family reviewers share an underlying model.
- `gateway` and `vercel` are NOT valid `--providers` tokens: the gateway is a
  transport, reached only through a family token (`openai`, `anthropic`, `gemini`)
  when that family has no native key, in which case the gateway model is that
  token's family model (`GATEWAY_FAMILY_MODELS[family]`), not a diversity pick.
  Either token in `--providers` is a usage error, exit 1, with a message saying to
  name families instead (part of intended delta 32). So two entries of a `--providers` set can never resolve to
  the same family through the gateway, and the "first family not in B" diversity
  pick applies only to single-reviewer auto-selection and `--provider gateway`.
  Test: `--providers openai,gateway` -> usage error.
- Reviewer identity for quorum. `--providers` tokens are resolved and then
  de-duplicated exactly as `selectProviders` does today: one entry per diversity
  family (synonyms such as `gpt`/`openai`/`codex` collapse to one), and tokens with no
  family are keyed by their lowercased id. Quorum counts those distinct entries only;
  the same provider can never be counted twice. Every usage error in this bullet,
  and the gateway/vercel token rule above, is intended delta 32 (P0 decision Q2): in
  v2.11.0 `--quorum` goes through `parsePositiveInteger` (src/utils.js L327-332), is
  accepted without `--providers`, and has no upper bound. Validation is in two places, both before any model call:
  `parseArgs` checks syntax only (`--quorum` must match `^[0-9]+$` and be >= 1; 0,
  negative, fractional, or non-numeric is a usage error, exit 1) and also rejects, as
  a usage error, `--quorum` greater than 1 when `--providers` is absent (a quorum
  needs multi-provider mode; the message says to add `--providers`), so a requested
  quorum is never silently ignored; `selectProviders`,
  after tokens have been resolved and de-duplicated, applies the upper bound, and the
  rule differs by how providers were requested. EXPLICIT token list: `--quorum`
  greater than the number of distinct requested entries is a usage error, exit 1
  (stderr only). `auto`: `--quorum` greater than 3 (the number of known families) is
  a usage error, exit 1; any `--quorum` from 1 to 3 is valid for `auto`, because auto always
  requests all three families. If the R1 filter, reachability, or the diff-size rule
  then leaves fewer PERMITTED providers than `--quorum`, that is the pre-call
  `quorum-unmet` outcome (exit 1), never a usage error, and its `failed` lists each
  excluded family with its cause. Every pre-call
  `quorum-unmet` message (auto or explicit) names the remedy that matches WHY
  providers were excluded: FIRST, whenever at least one permitted provider remains, it names
  `--allow-degraded-quorum` as the way to proceed with the remaining independent
  reviewer(s), ahead of any flag that weakens independence; then, if any was
  excluded with `independent === false`, it names
  `--allow-same-family`; if any was excluded with `independent === null`, it names
  declaring `--builder` / `ADVERSARIAL_REVIEW_BUILDER` and
  `--allow-unverified-independence`; for a provider excluded as `unreachable` it names that provider and says to
  supply its API key (or install its CLI), and, ONLY when at least one permitted
  provider remains, that `--allow-degraded-quorum` would accept fewer reviewers (it
  is never suggested when zero providers are permitted, since it cannot help then); for `diff-too-large` it says to pass
  `--allow-summary-review`, raise `--max-bytes` / `--max-files`, narrow the scope, or
  install that family's local CLI; for `duplicate-family` it names the two entries
  that resolved to the same family and says to change the `defaults.models` pin (or
  the `--providers` tokens) so each entry is a distinct family. Every distinct cause
  present is named once. (Test: in a
  Cursor context with no `--builder`, `--providers auto --quorum 2` -> message names
  `--builder` and `--allow-unverified-independence`, not `--allow-same-family`.) Auto ALWAYS submits all three known families
  (openai, anthropic, gemini) to the provider pipeline as its requested set, ordered
  with families not in the builder set first; it never subtracts builder families
  itself. Exclusion of a builder family is done only by the R1 filter, which records
  it in `failed` / `meta.failed_reviewers` as `not-independent` (or permits it under
  `--allow-same-family`), so a `quorum-unmet` outcome always shows which families
  were excluded and why. (Test: claudecode, `--providers auto --quorum 3 --json` ->
  `quorum-unmet` with `failed` containing `{ id: "anthropic", error:
  "not-independent" }`.) Reachability is not part of this check; too few reachable or
  permitted providers is the `quorum-unmet` outcome defined above and below. Tests: `--quorum 0` -> usage error; `--providers openai,gpt --quorum 2` -> usage error;
  `--providers openai,openai` -> one reviewer.
- `failed_reviewers[].error` / `failed[].error` values distinguish the cause: the
  literal `"not-independent"` (excluded by R1 before any call), the literal
  `"duplicate-family"` (a config-pinned model made it the same family as an earlier
  entry), the literal
  `"diff-too-large"` (an API provider dropped by the existing
  `resolveReachableProviders` because the diff is not inlinable, `--allow-summary-
  review` is unset, and its family has no local CLI to downgrade to), the literal
  `"unreachable"` (the token resolved to nothing usable: no API key, no gateway key,
  and no trusted installed CLI for that family), or, for a provider that was called
  and failed, that provider's (scrubbed) error message. A requested provider that is
  unreachable is listed, not silently dropped. Test: `--providers openai,anthropic
  --quorum 2 --builder human` with no OpenAI credential or CLI -> `quorum-unmet` with
  `failed: [{ id: "openai", error: "unreachable" }]`.
- Quorum under provider failure fails closed (intended delta 19). After the review
  stage, if the number of providers that returned a review is less than the requested
  `--quorum`, the run exits 1 with no verdict, before verify/assess/derive, and prints
  requested quorum, successful ids, and failed ids; with `--json` it emits
  `{ "error": "quorum-unmet", "message": <human-readable string>, "quorum": n,
  "successful": [ids], "failed": [{id, error}], "permitted": [] }` (`permitted` is always present and is empty in this post-call case; the same required `error` +
  `message` shape D1's schema defines). In `--loop` the same condition ends the loop with exitReason
  `quorum-unmet`, exit 1. The only override is `--allow-degraded-quorum`, which
  restores today's behavior (effective quorum capped at the number of successful
  providers, minimum 1; warning printed) and is recorded in
  `meta.allow_degraded_quorum`. With the default `--quorum 1`, one successful provider
  satisfies the quorum and the existing under-satisfied notice is still printed. D1
  `meta.failed_reviewers: [{ "id": string, "error": string }]` lists providers that
  did not contribute. Parity rows edited by this change: "one provider fails in
  multi-provider" with quorum 2 (was exit by result, now exit 1), plus a new row with
  the override.
- No cross-cancellation: each call keeps its own timeout and retry budget. SIGINT
  handling is unchanged from today and this plan adds no cancellation plumbing: in a
  non-loop run there is no handler, so Ctrl-C terminates the process and in-flight
  HTTP requests are abandoned with it (no verdict is printed, exit by signal); in a
  loop the existing handlers run. Known and unchanged: neither path explicitly
  terminates an in-flight reviewer or verifier CLI process on Ctrl-C (today's loop
  handler kills only the fixer), so such a process may outlive the tool until it
  finishes or the terminal's own signal delivery stops it. Fixing that requires the
  cancellation plumbing this plan deliberately does not add; it is recorded as
  follow-up work and stated in the README's limitations.

## A. Fixes where the tool works against its own intent

A1. Fixer/reviewer independence: implement R1.

A2. Timeout defaults. `parseArgs` defaults `timeout` to null. Unset: API requests 120s,
local CLI reviewers 2400s, fixer 1800s. `--timeout` sets the reviewer budget;
new `--loop-fixer-timeout <seconds>` sets the fixer budget. Verify calls get their own,
shorter bounds (they judge one finding, not a whole diff): each verify call times out
after `--verify-timeout <seconds>` (default 300; same `^[0-9]+$`, 1..86400
validation). Nothing is ever abandoned while running: the per-call timeout is
enforced by the mechanisms that already terminate a call (the per-request
AbortController for API calls; the exec watchdog, which kills the CLI process tree,
for CLI calls), so when a verify call times out it has ended before the pipeline
moves on. A verify call that times out or errors leaves its finding kept with
`verification_status: "verify-error"`, and the next finding's call proceeds. The
phase as a whole is bounded by a COUNT, not a clock, so no timing or queueing
question arises: `--verify-max <n>` (default 20; integer 1..1000) is the maximum
number of findings verified PER PROVIDER. Each provider's findings are ordered by
descending severity, then descending confidence, then original order; the first
`n` are verified and every finding after that is kept unverified with
`verification_status: "verify-error"` (logged as "not verified: over
--verify-max"), exactly like any other unverified finding (it still gates). A
provider's verify phase is therefore bounded by `n` x `--verify-timeout`, whatever
the scheduling. Phase 2 completes only when every started verify call has
settled; no later stage (gate, merge, or a loop's fixer) starts while any verify
call is still in flight. Before A9 lands and the status field exists, the same
findings are simply kept, as an errored verify is today.

A3. Withdrawn from this plan. Delta-aware re-review (sending prior findings and
post-fix excerpts to the next round) creates new trust boundaries (model-cited paths
read from disk, prior model output re-entering a prompt) and needs its own spec and
review. Every loop round stays what it is today: a full cold review of the whole
target, built only by the existing `buildPrompt` with its existing nonce-tagged,
sentinel-stripping fences. No prior finding and no model-cited path is ever read or
re-sent to a reviewer.

A4. No-progress detection keeps its own matcher (it compares findings ACROSS rounds,
where fixer edits shift line numbers, so the same-diff `rangesOverlap` rule is not
reused). Two findings match when: same normalized file, same category,
a title-similarity test (replacing today's exact title equality), and either both are file-level (line_start 0) or neither is and
(|a.line_start - b.line_start| <= 5 OR their line ranges overlap). The title test is the existing `titleSimilar` from src/review.js,
UNCHANGED, with its existing 0.7 token-overlap threshold. A lower cross-round
threshold (0.4) was considered and rejected: at 0.4, "SQL injection in auth handler"
and "Command injection in auth handler" at the same location match, so a fixer that
removed one defect and introduced another would end the loop as `no-progress`. The
two possible errors are not symmetric: when a reworded title fails to match, the
loop merely runs on to `--loop-max` (bounded cost, findings still reported); when
two different defects wrongly match, the loop stops while a new defect was just
introduced. The stricter threshold is therefore kept. The +/-5 drift
tolerance of today's `findingsMatch` is retained. Set equality (`gatingSetsEqual`) becomes a one-to-one matching: the two
sets are equal only if they have the same size and every finding of the earlier set
can be paired with a DISTINCT finding of the later set (each later finding paired with at most one earlier finding). The pairing is
computed EXACTLY, as a maximum bipartite matching by augmenting paths over the
`findingsMatch` relation (gating sets are small), not greedily, so the answer does
not depend on array order: the sets are equal iff a perfect matching exists. Tests: two similar-titled findings in round 1 vs one of them plus a new
unrelated finding in round 2 -> not equal (loop continues); A1 matches B1 and B2 while A2 matches only B1, in
both array orders -> equal; reworded title with a
3-line shift (match), same title shifted 40 lines without overlap (no match),
file-level vs line-level (no match).

A5. Untracked file bytes count toward `--max-bytes`, measured as the bytes that would
actually be INLINED: the formatted body `readFileInline` produces for each untracked
file, so a binary file, a symlink, or a file over `MAX_INLINE_FILE_BYTES` contributes
only its short "(skipped: ...)" line, never its raw `stat.size`. `diffBytes` becomes
staged + unstaged diff bytes + those inlined untracked bytes. Over budget takes the
existing summary path (API providers fail closed unless `--allow-summary-review`).
Tests: a 5 MB untracked binary plus a 2 KB diff stays inline; forty 200 KB untracked
text files take the summary path.

A6. Implement R2.

A7. Redaction at the output sink. Today only the validated result is redacted; error
paths can carry reviewer-originated text (a `JSON.parse` error message quotes a snippet
of the raw response; CLI stderr is appended to error messages; `fixerStderr` is put in
NDJSON events). Change: for plain-text diagnostics (every `log.*` line, `errorTrace`, and every error
message printed to stderr) the final string passes through the scrubber at the
single point of output. The review RESULT is scrubbed once, as an object, at the
"redact secrets in reviewer output" stage of the shared round (the allowlisted
free-text fields below, two-layer), and BOTH renderers consume that scrubbed object:
`renderReport` for the human report on stdout and `JSON.stringify` for `--json`. The
human report therefore can never contain text that the `--json` document would have
masked. (Test: the same reviewer output rendered both ways; the token is absent from
both.) For structured output (the `--json` document and every NDJSON event)
the redactor is NEVER run over serialized JSON text, because its patterns can match
across quotes and colons and corrupt the framing: instead, before serialization, the scrubber is applied to the
VALUES of an explicit allowlist of free-text fields only, never to keys and never to
any other value: result `summary` and each `next_steps` entry; finding `title`,
`body`, `evidence`, `exploit_scenario`, `recommendation`; error-object `message`;
every string in each finding's grounding `notes` (they are built from the
unredacted finding and embed model-written text such as the cited `file`; the
round's envelope carries them as `scrubbedAssessments` alongside the redacted result,
and that scrubbed copy is the only one `renderReport`, stderr warnings, and events
ever print; test: a hallucinated `file` containing a token appears as the
placeholder both in the finding and in its "cited file is not in the repository"
note); `failed_reviewers[].error` and the error document's `failed[].error` (both carry
provider error text); `meta.fixer.kind` and `meta.refusal.fixer.kind` (an operator-supplied executable
basename); and event fields `fixerCmd`, `fixerStderr`, and the string properties
`resumeHint.command` and `resumeHint.id` (`resumeHint` is an object `{cli, id,
command}`; its shape is preserved and only those two strings are scrubbed). Path-valued
fields that the MODEL writes (a finding's `file`, and the entries of
`coverage.files_examined` / `coverage.files_skipped`) are emitted verbatim only when
the string is an exact member of the known path set for the run (the context's
changed files plus `git ls-files` tracked paths; for `--input`, the input file
list); any model-written path that is not a known path is treated as free text and
goes through the two-layer scrubber like `body` does, so a model cannot use a path
field to carry a token out. Paths the TOOL writes from git (`filesTargeted`,
`filesModified`), ids, refs, branch
names, enum values, `recoveryCmd`, and everything in `meta` other than
`failed_reviewers[].error`, `fixer.kind` and `refusal.fixer.kind` are emitted unchanged, so a path such as
`tests/fixtures/fake_aws_key_fixture.js` is never replaced by a placeholder. Then
`JSON.stringify` runs on the result. (Tests: a finding whose `file` is a real tracked path matching a
scanner pattern keeps its path; the same string in `body` is scrubbed; a finding
whose `file`, or a coverage entry, is a token-shaped string that is not a known path
is emitted as the placeholder.) The sink is two-layer for every string it handles (text line or structured value):
first the redactor (masks the matched span), then `scanForSecrets` on the redacted
string; if the scanner still reports a hit, the redactor missed it, and the WHOLE
string is replaced by `[REDACTED: contains likely secret (<pattern name>)]` (the
same whole-field replacement `redactSecretsInFindings` already uses for fix prompts).
The guarantee is scoped precisely: nothing the scanner flags inside a SCRUBBED string
(every plain-text log/error line, and the allowlisted free-text fields of structured
output) can reach stdout, stderr, an event, or the ledger. Path, ref, and branch-name
values are deliberately outside the guarantee and are emitted verbatim even if they
match a scanner pattern: they are repository metadata the operator already has, they
were already covered by the pre-flight payload scan (a token-shaped file path or
branch name in the review payload triggers the existing refuse-unless-
`--allow-secrets` gate before any call), and masking them would break fixers and
consumers. The README states this boundary. Within that scope this also covers a finding that A9 marked `skipped-secret` because of a
scanner hit. Test: a string matched by a scanner pattern but not by the redactor is
emitted as the placeholder in the JSON document, in an NDJSON event, and in a log
line. A test emits an event and a result whose values
include `api_key=...`-style text and whose keys include a credential-like name, and
asserts every emitted line still parses and validates against its schema with the
value masked; the corrective-retry prompt is the original prompt plus error feedback (a parse-error
message or validation errors), and that appended feedback is passed through the
same two-layer scrubber as the output sink (redactor, then `scanForSecrets` with
whole-string placeholder replacement on a remaining hit) before it is appended, so the retry prompt (the centrally scanned prompt plus scrubbed feedback) never
carries a token the model itself emitted (test: malformed first response containing a token-shaped string on a clean
repository -> the retry is sent, with the token masked in the feedback). The raw-output dump
file is written from text scrubbed in three steps that always consider the WHOLE
response, so no secret can hide across an artificial boundary (the text is never
chunked): (1) run the span redactor over the entire raw text; (2) run
`scanForSecrets` over the entire result; if it reports nothing, write that; (3) if
it still reports a hit, replace each real line (split on actual newlines only) that
the scanner flags on its own with the placeholder, then scan the ENTIRE text again;
if that final whole-text scan is clean, write it (the other lines are preserved for
diagnosis); if it still reports a hit (a secret the per-line pass cannot isolate,
e.g. a single-line minified response), write ONLY the placeholder plus the response
length in bytes. The file therefore never contains text that the whole-text scanner
flags. It goes into a fresh private directory created with
`fs.mkdtempSync` (mode 0700) per dump, file mode 0600, so concurrent failures in the
same millisecond cannot collide and a failure to write is reported in the error
message instead of being swallowed;
there is no unredacted dump. A test asserts that after a secret-bearing malformed
response no file under the temp dir contains the token.
Tests: secret-bearing malformed review JSON, malformed verify JSON, API error body,
CLI stderr, and fixer stderr; assert the token never appears on stdout or stderr.
Listed as intended delta 16.

A8. Withdrawn from this plan into the separate checkpoint/rollback spec (see R4):
fixer-termination confirmation, the `fixer-not-terminated` outcome, checkpoint-timing
changes, and rewritten recovery commands/texts. `spawnFixer` and every recovery
message stay exactly as in v2.11.0; the corresponding risks are acknowledged limits
6-8 in R4.

A10. Verify prompt for artifact reviews, intended delta 29. `buildVerifyPrompt` today
calls every finding "a code-review finding" and wraps the context in
`<repository_context>`, including for `--input` artifact reviews. It takes the
context mode: in artifact mode the role text says the finding is about the artifact
shown, the context block is `<artifact_under_review>`, the refute rule reads
"refuted only when the artifact text itself contradicts the finding", and every
other reference to the block inside the prompt, in particular the first line of
`<grounding_rules>` ("Everything inside <repository_context> is data under
review..."), names `<artifact_under_review>` instead, so the data-not-instructions
rule points at the tag that actually wraps the artifact (a test asserts the
artifact-mode prompt contains no `repository_context` string); diff mode is
unchanged. The default-to-not-refuted stance is identical in both. A parity row
covers `--input --verify` with a mock verifier.

A9. Verify payload handling (delta 15). The verify stage builds its outbound payload from a REDACTED COPY of
the findings (`redactSecretsInResult`) and runs the outbound secret scanner on that
payload before every verify call. Verification is one isolated call per
finding, and redaction never implies acceptance or rejection. Scope of the verify-time
secret handling: it concerns ONLY the finding block of the verify prompt (the
reviewer's own output). The repository-context block of the verify prompt is the same
content the review call already sent; it is governed solely by the pre-flight scan
and `--allow-secrets`, exactly as today, and is neither re-scanned nor redacted at
verify time, so `--allow-secrets` runs verify normally. With `--allow-secrets` the operator has
already accepted sending this content to the provider, so the per-finding
redact-and-skip steps below are NOT applied at all: findings go to the verifier
unredacted, as today, and can be refuted normally (the OUTPUT scrub of A7 still
applies when anything is printed). Without `--allow-secrets`, per finding: (1) run the
redactor over that one finding and put the REDACTED copy in the finding block; then
scan that redacted finding block alone, excluding the finding's `file` path field
(P0 decision B12: the cited path is matched against known paths and scrubbed on
output by A7, and a token-shaped path in a tracked file was already covered by the
pre-flight scan; test: a finding whose `file` is a real tracked path matching a
token pattern is still verified, and negative control: the same token in `evidence`
yields `skipped-secret`); a hit there (redaction missed something) is
the only case where no call is made; (2) if step (1) found no scanner hit and the redactor did not change the
`evidence` field, the verifier's answer applies normally (refuted -> dropped) and the
status is `verified` when it is not refuted; (3) if the redactor changed the `evidence` field, NO verify call is made for that
finding: it is kept with status `skipped-secret`, because masked evidence can be
neither fairly refuted nor confirmed and a call whose answer would be discarded is
waste.
`verification_status` is never stored on a finding object inside the pipeline:
`validateResult` keeps validating model output, merged multi-pass results, and merged
multi-provider results against the unchanged strict `schema.json`, which has no such
property. The status is tracked in a side array parallel to `findings`. The MULTI-mode
stage order around the merge is exactly v2.11.0's and is pinned by a parity row:
per-provider review -> per-provider verify -> per-provider `assessFindings` (each
provider's own grounding-adjusted confidences) -> `mergeProviderResults`, which
receives those per-provider assessments and uses them to choose each group's
representative, so an ungrounded high-confidence finding can never outrank a
grounded one (the gh-9 P5#2 behavior is retained) -> `assessFindings` on the merged
result -> `deriveQuorumVerdict` from the per-provider assessments. Assessments are
deterministic and are recomputed for the merged result as today; verification
statuses come from model calls and cannot be recomputed, so they must be carried:
when A9 lands, `verifyFindings` returns `{ result, statuses }`, and
`mergeProviderResults` returns `{ result, statuses }` where `result` is exactly
today's merged object (and is the only thing passed to `validateResult`) and
`statuses[i]` is the group-rule status for `result.findings[i]`. These are internal
signatures; the black-box parity suite is unaffected, and the unit tests of
`mergeProviderResults` are updated in the A9 change. The side array is
attached to each finding, together with `meta`, only at the emit stage, after the
last `validateResult` call; the emitted document is then validated against
`output-schema.json` in tests.
Every finding in emitted output carries `verification_status`, added by the CLI:
`not-requested` (`--verify` off), `verified` (case 2, not refuted), `skipped-secret`
(case 3, or the case-1 scanner hit; in both no call is made), or `verify-error` (the verify call failed; kept, as
today). Multi-provider merge: verification runs per provider before the merge, so
when `mergeProviderResults` collapses corroborated findings into one, the merged
finding's `verification_status` is the status of the REPRESENTATIVE finding itself
(the one whose text and evidence are emitted), never a better status borrowed from
another provider's finding in the group: a status describes what was done to the
evidence the reader sees. (A finding refuted by its own provider was already dropped
and is not in the group.) Tests: provider A `verified` with lower confidence,
provider B `skipped-secret` with higher confidence -> representative B, merged
status `skipped-secret`; the reverse -> `verified`.
A `skipped-secret` or `verify-error` finding is treated exactly like a
finding under `--verify` off: it still gates and still reaches the fixer, which is
the fail-closed direction for a gate; the status makes it visible to automation, and
a stderr warning names each such finding. Also tested: a secret-bearing diff with
`--allow-secrets --verify` and five clean findings -> five verify calls are made. Tests: a token-shaped string placed in
each of title, body, recommendation, exploit_scenario (verified normally, can be
refuted and dropped) and in evidence (kept, `skipped-secret`); one secret-bearing and
two clean findings from one provider (the clean two are verified normally).

A11. agy prompts over the argv limit (intended delta 38; added in v59 by human request,
2026-10-04). Today agy has no stdin sentinel, so the review prompt is passed as the
`-p` value (src/llm.js L334-339 `ARGV_PROMPT_CLIS`, L1124-1140); a prompt over
`maxArgvPromptBytes()` (about 128 KiB on Linux, the per-argument MAX_ARG_STRLEN)
exits 1 with `argvTooLargeMessage`. Observed: a 3-file `--input` review of 270 739
bytes failed this way. agy 1.2.16 added `--input-format stream-json` (print mode reads
NDJSON from stdin, one turn per message; it requires `--output-format stream-json`).
Verified by hand on agy 1.2.16: the message shape is
`{"event":"user","message":{"role":"user","content":<string>}}`, the flag order must
put `-p=` (empty) last because `-p` consumes the next argument, and a 300 KB prompt
was accepted. ALSO OBSERVED, and the reason this item is not a one-line change: with
`--mode plan` and argv input, the `init` event carries `expanded_commands:
[{"name":"plan"}]`; with stream-json input it does not, so plan mode (the read-only
review isolation, src/llm.js L404) is NOT shown to apply on the stdin path.
Rule: the stdin path is used ONLY when the prompt exceeds the argv limit (prompts
within it keep today's argv path byte-for-byte, so no parity row changes), ONLY when
the resolved agy advertises `--input-format` in its `--help` (probed once per run;
older agy keeps today's error), and ONLY when plan mode is ATTESTED for that run:
the adapter reads the `init` event and proceeds only if it proves plan mode
(`expanded_commands` contains `plan`, or a successor signal pinned at P1). If no
attestation is possible, the review is refused BEFORE the prompt is written to stdin,
with exit 1 and a message naming the size, the limit and the missing attestation; a
P1 spike must establish a working attestation (for example a first stream message
that runs `/plan`, verified by the init or a follow-up event) or record that none
exists, in which case A11 ships only the improved error and the probe. The result is
read from the `result` event (`status` SUCCESS -> `response` is parsed exactly as the
argv path's stdout; any other status -> the CLI error path, classified by C5). The
watchdog, `--print-timeout` pass-through and secret scan are unchanged. Tests (mock
agy shell scripts on PATH): a prompt under the limit -> argv path, stdin unused; over
the limit with `--input-format` advertised and plan attested -> stdin path, result
parsed; over the limit without the flag -> today's error; over the limit with the flag
but no attestation -> refused with zero bytes written to stdin (negative control: the
same mock emitting the plan attestation -> proceeds); a `result` status ERROR -> exit 1
via the CLI error path. A PATH-gated live test runs a real agy over the limit.

## B. Execution optimizations

B1. Withdrawn. Batching puts several findings in one verifier prompt, where text in one
finding could influence the verdict on another. `--verify` keeps today's one isolated
call per finding (each under the redaction rule of delta 15).

B2. Parallel API calls per R5.

B3. Omit the stringified schema from the system instruction only for API calls where
native structured output is active (Anthropic tool, OpenAI/gateway strict json_schema,
Gemini responseSchema). It stays for CLI providers and for the degraded `json_object`
retry. Mechanism: `runReviewOnce` no longer bakes the schema text into the system
instruction; it passes `llmCall` the instruction as TWO parts plus the
schema OBJECT (which it already passes today): a HEADER (the role sentence) and a
TRAILER (`TRUST_POLICY`). The transport assembles the system instruction in today's
order, header, then the schema text when it is included, then a blank line, then the
trailer, so `TRUST_POLICY` always comes last exactly as in v2.11.0 and the schema
never moves below it or next to the user prompt. Verify calls use the same two-part
interface and stay byte-for-byte what they are today: header "You are a skeptical
verification reviewer. Return ONLY a single JSON object.", trailer `TRUST_POLICY`,
schema object `VERIFY_SCHEMA`, and an explicit `schemaTextInPrompt: true` option that
tells the transport NOT to append schema text to the system instruction, because
`buildVerifyPrompt` already inlines `VERIFY_SCHEMA` in the user prompt (as today,
where the verify system instruction carries no schema text). Native structured
output for verify calls is unchanged. The review header has two exact wordings so
no dangling clause is ever sent: with the schema text appended it ends, as today,
"...that conforms exactly to this JSON Schema:" followed by the schema; with native
structured output it instead reads "Return ONLY a single JSON object that conforms
to the response schema configured for this request." and contains no schema clause.
The schema text is appended
inside the transport, per attempt, at the point where the request body is built:
the appended text is `JSON.stringify` of a copy of the schema with the annotation
keys `$schema`, `$id` and `$comment` removed at every level (constraints and
`additionalProperties` kept), so a model that mirrors the text cannot echo a
top-level `$schema` key that the strict validator would reject (intended delta 31;
today the raw schema text, annotations included, is sent). It is
appended for CLI providers always; for an API attempt, appended iff that attempt is
NOT using native structured output. The OpenAI/gateway client's existing reactive
downgrade (`strictSchemaUnsupported` after an HTTP 400) therefore rebuilds the
system message with the schema text on the `json_object` retry. Tests: a stub
endpoint that rejects `json_schema` with 400 receives a second request whose system
message contains the schema text; a stub that accepts it receives none.

B5. Working tree uses one `git diff HEAD` instead of separate staged and unstaged
diffs; in a repository with no commits it keeps today's two-diff path.

B7. Memoize `loadSchema()`.

## C. Simplification / code reduction

C1. Merge `runLoop` and `runBranchLoop` into one loop, as a pure refactor: the two
existing rollback mechanisms (stash checkpoint; `reset --hard` + `clean -fd`) and the
two existing SIGINT handlers are kept verbatim behind a small checkpoint interface, and
the parity suite passes unedited.

C2. One shared review round with the stage order fixed in step 0, used by single
review, multi-provider review, and both loop scopes. `runMultiProvider` in bin/cli.js
is replaced by `runProviderRound`. The shared round does NOT take a pre-resolved provider list. It takes
the raw arguments, a context source (collector + prompt builder), a mode, and a
provider-resolution callback (`configureLLM` with R1 enforcement for SINGLE mode,
`selectProviders` + R1 filter for MULTI mode), and it invokes that callback only
AFTER the context has been collected and the empty check has passed, exactly in the
order R1 lists; an empty scope therefore exits before any credential, provider, or
independence logic runs, as today. The callback's signature is `resolve({ exclude })`, where
`exclude` is the set of reviewer candidate ids that have failed with a classified
stale-credential/model error during this run; it returns the selection for the
current attempt or throws the R1 / no-configuration outcome. In SINGLE mode the round calls
it once normally and once more (with the failed id added) for the one-step
stale-credential fallback. In MULTI mode there is NO fallback and the callback is
called exactly once per round: the provider set is resolved once, providers run
under `allSettled`, and a provider that fails (stale credential or anything else)
is simply recorded in `failedReviewers` and skipped, as today; no provider is ever
re-resolved or run twice. WHEN the selection is first computed differs by mode, and the callback
hides that difference from the round: in a NON-loop run nothing is resolved before
the round, so the callback's first invocation (after the empty check) performs the
selection and R1 enforcement. In `--loop`, selection and R1 enforcement have ALREADY
run at loop startup step (3), before any context was collected, and any refusal has
already ended the run with its event stream; the round never sees that path. There
the loop driver supplies a STATEFUL resolver that simply returns the selection made
at startup (no re-evaluation, so nothing is deferred behind the empty check): the fixer and B
are fixed before the first round, the resolver remembers the current reviewer and
the exclusions accumulated across rounds, and a fallback re-runs reviewer selection
against the same B with those exclusions, so a credential that expires in round 2
advances to the next permitted reviewer instead of retrying the failed one. Given
the mode, and the two modes keep their v2.11.0 result shapes exactly, which the unedited
parity suite pins: SINGLE mode (no `--providers`): one provider, the provider-fallback
lifecycle, `deriveVerdict`, the model's own `summary` string preserved, no
`corroborated_by`, no merge step; MULTI mode (`--providers`, even with one token):
fan-out, `mergeProviderResults`, `deriveQuorumVerdict`, the synthesized quorum
summary, `corroborated_by` on every finding. C2 unifies the code path (collection,
scan, prompt, per-provider review+verify, assess, redact) and removes the duplicated
drivers; it does not make a single-provider run look like a multi-provider run.

C3. Replace the four hand-written detection ladders with the table below. The context's base order,
then R1 filtering, alone controls resolution; wherever R1 says "order" it means this
context base order. `builderFamily` and the builder context
are derived from the same table.

Candidates and their eligibility predicates (unchanged from v2.11.0):
  api:anthropic  ANTHROPIC_API_KEY non-empty      family anthropic  transport api
  api:gemini     GEMINI_API_KEY non-empty         family gemini     transport api
  api:openai     OPENAI_API_KEY non-empty         family openai     transport api
  gateway        AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN non-empty; transport gateway;
                 model = GATEWAY_FAMILY_MODELS[f] where f is the first of
                 [anthropic, openai, gemini] not in the builder set B; family f
  cli:claude     trusted install + usable for review  family anthropic  transport cli
  cli:codex      same                                 family openai     transport cli
  cli:agy        same                                 family gemini     transport cli
  cli:cursor     `agent`, else `cursor-agent`, trusted family unknown   transport cli
Family is always derived from the FINAL effective model, never from the selection
step: resolve the model first (`--model` > config pin > gateway diversity choice >
default), then, ONLY for the gateway candidate on its default base URL
(`https://ai-gateway.vercel.sh/v1`), take
the family from that final id's prefix (`anthropic/` -> anthropic, `openai/` ->
openai, `google/` -> gemini, anything else -> unknown), and only then run R1
enforcement and build provenance from that same value. A `--model` or config pin that
changes the family changes the R1 outcome. Tests: claudecode + gateway +
`--model anthropic/...` -> exit 1 (false); `--model openai/...` -> proceeds;
`--model mistral/...` -> exit 1 (null) unless `--allow-unverified-independence`; a
config pin of an anthropic gateway model inside claudecode -> exit 1.
If B contains all three of anthropic, openai, and gemini there is no absent family. The
gateway candidate REMAINS ELIGIBLE in that case (it has a credential); its default
model is then `GATEWAY_FAMILY_MODELS.anthropic` (the first family in the fixed
order), its family is therefore in B, and its `independent` is false. It is handled
by the ordinary R1 rules like any other same-family candidate: without
`--allow-same-family` it is refused and, if it is the refused candidate, the
`not-independent` refusal names it with override `--allow-same-family` (the message
adds that `--model` can choose which family's model the gateway uses); with the flag
it proceeds with a warning. It never falls into the "No LLM configuration found"
path. Tests, single review and loop: `--builder openai,anthropic,gemini` + gateway
key only -> `not-independent` refusal (JSON error object under `--json`); plus
`--allow-same-family` -> proceeds with warning; plus `--model openai/x
--allow-same-family` -> proceeds using that model.
R1's normalization is authoritative: any provider used with a custom base URL
(`--api-base` or a `*_API_BASE` / `*_BASE_URL` env var, including a gateway on a
non-default base) has family `unknown` regardless of its model id, so it needs
`--allow-unverified-independence`. Tests: custom base + `openai/x` model inside
claudecode -> exit 1 (null); same with the flag -> proceeds with warning.
Default models are unchanged: anthropic `claude-sonnet-4-6`, gemini `gemini-2.5-pro`,
openai `gpt-5`, gateway per GATEWAY_FAMILY_MODELS; precedence is `--model` >
config pin > gateway diversity choice > default (a change from v2.11.0, where the
diversity choice outranked a pin; it is safe now because R1 is enforced on the final
model, so a pin that reintroduces the builder's family exits 1 instead of running).

Builder contexts (detected harness -> detected builder family) and base order:
  claudecode  (CLAUDECODE / CLAUDE_CODE; anthropic):
    api:gemini, api:openai, gateway, cli:codex, cli:agy, cli:cursor, api:anthropic,
    cli:claude
  cursor      (TERM_PROGRAM=cursor; builder family UNKNOWN: the variable identifies the
              host application, not the model that wrote the code, so the operator
              must declare `--builder` or pass `--allow-unverified-independence`):
    api:gemini, api:anthropic, api:openai, gateway, cli:agy, cli:claude, cli:codex,
    cli:cursor
  antigravity (ANTIGRAVITY_AGENT / ANTIGRAVITY_CONVERSATION_ID; gemini):
    api:anthropic, api:openai, gateway, cli:codex, cli:claude, cli:cursor, api:gemini,
    cli:agy
  default     (no harness; builder from `--builder`/env, else unknown):
    api:anthropic, api:gemini, api:openai, gateway, cli:claude, cli:codex, cli:agy,
    cli:cursor
`--builder` / the env var overrides the detected family but not the context's base
order. Selection = take the context's base order, keep eligible candidates, compute
`independent` for each against B (R1), then pick the first true; else, only with
`--allow-unverified-independence`, the first null; else, only with
`--allow-same-family`, the first false; else exit 1. In `--loop`, B also contains the
fixer family; fixer and reviewer are chosen jointly as R1 specifies.
Stale-credential fallback: if the selected auto candidate fails with a classified
auth/model error, remove that one candidate and run the same selection once more; a
second such failure, or no selectable candidate, exits 1.

Resolution matrix (expected results, pinned as tests; "none" = no flags):
  claudecode, only ANTHROPIC_API_KEY, none                    -> exit 1
  claudecode, only ANTHROPIC_API_KEY, --allow-same-family     -> api:anthropic, warning
  claudecode, GEMINI + OPENAI keys                            -> api:gemini
  claudecode, gateway key only                                -> gateway, openai model
  claudecode, only cli:codex and cli:claude                   -> cli:codex
  claudecode, only cli:cursor, none                           -> exit 1 (null)
  claudecode, only cli:cursor, --allow-unverified-independence -> cli:cursor, warning
  cursor, OPENAI + ANTHROPIC keys, none                       -> exit 1 (unknown builder)
  cursor, --builder openai, OPENAI + ANTHROPIC keys           -> api:anthropic
  cursor, --builder anthropic, OPENAI + ANTHROPIC keys        -> api:openai
  cursor, --builder openai, only OPENAI key                   -> exit 1
  antigravity, GEMINI + OPENAI keys                           -> api:openai
  antigravity, only cli:agy, none                             -> exit 1
  default, no --builder, any candidates, none                 -> exit 1 (unknown builder)
  default, --builder human, ANTHROPIC + OPENAI keys           -> api:anthropic
  default, --builder openai, ANTHROPIC + OPENAI keys          -> api:anthropic
  default, --builder anthropic, ANTHROPIC + OPENAI keys       -> api:openai
  default, --builder openai, only cli:codex, none             -> exit 1
  default, --builder openai, gateway key only                 -> gateway, anthropic model
  claudecode, GEMINI key rejected (401), OPENAI key present   -> api:openai (fallback)
  claudecode, GEMINI key rejected (401), only ANTHROPIC left  -> exit 1
  loop, claudecode, fixer cli:claude, only cli:codex reviewer -> cli:codex
  loop, default, --builder human, fixer cli:codex, only OPENAI key -> exit 1

C4. Delete the resolution cache: `cachedResolutionUsable`, `apiOutranksCliInContext`
(deleted, not derived), `_fromCache`, `_autoResolution`, `persistAutoResolution`, and
lock-file mutation. The tool no longer writes the config file, except through the
`setup` command below. An existing `cache` key
in config.json is ignored and left untouched; `defaults.models` pins keep working.
From v59 (P0 decision on provider setup), the review path, `--loop` and the skill
NEVER write config.json; the ONLY writer is the user-run `adversarial-review setup`
command (D9), which writes only the `inventory` key and preserves every other key,
including a legacy `cache`. C4 therefore deletes only the cache-specific code and
the review path's CALLS to the writer; it KEEPS, as helpers D9 consumes, the
reread-under-lock writer (`mutateConfigFile`, src/config-store.js L170-198, after C4
called only by `setup`, so concurrent `setup` runs serialize on its lock) and the
trusted-CLI re-verification check that `cachedResolutionUsable` (src/llm.js
L1251-1284) performs today (re-resolve through `resolveTrustedCli` to the same
canonical path, outside the trust root), extracted into a named helper before the
rest of that function is deleted. Test: run a review, a loop and a stale-credential
fallback against a mkdtemp config file and assert its bytes and mtime are unchanged;
negative control: `setup` against the same file changes it. The
stale-credential fallback applies to any auto-detected provider: on an auth/model
failure it advances the table once, excluding the failed candidate, subject to R1.

C5. One CLI error classifier replacing the repeated
`Object.assign(new Error(...), {stdout, stderr, cause})` blocks and the three
`isOpencode*` loops. Parity suite rows for CLI timeout, argv-too-large, unknown-flag,
and generic failure pin the messages.

C6. Remove the unreachable `unshare` branches in `buildFixerCmd` / `spawnFixer` /
`probeLinuxConstraint`. The bwrap read-only bind of the fixer's own directory when the
resolved fixer lives under `/tmp` is KEPT unchanged: bwrap mounts a fresh tmpfs over
`/tmp`, so without that bind any fixer installed under `/tmp` (including the parity
suite's mock fixers) would not exist inside the sandbox.

C7. Replace `getGatingFindings` with `isGatingFinding`.

C8. Split src/llm.js into detection, CLI adapters, and HTTP clients. Pure move; no
export renamed.

C9. Skill reference copies stay committed (git-based skill installs need them). Add a
CI check that fails when they differ from the root templates and schema.

C10. In test/copilot-prompt.test.mjs, only the one test that executes the REAL
copilot binary ("the real copilot CLI accepts the review argv we build") is gated
behind `ADVERSARIAL_REVIEW_LIVE_CLI_TESTS=1`. The always-on mock-executable test in the
same file ("copilot receives the review prompt as a -p ARGUMENT") and the existing
argv/sandbox-flag unit tests stay in default CI unchanged, so copilot's argv, `--mode
plan` flag, and prompt delivery remain covered on every run.

## D. New capabilities

D1. Reviewer provenance. `schema.json` (the model output contract) is unchanged. The
CLI adds one top-level key, `meta`, to its emitted JSON after validation, described by
the published `output-schema.json` (in its final state: schema.json plus `meta`
and, once A9 lands, a required per-finding `verification_status` enum):

    "meta": {
      "schema_version": 1,
      "builder": { "families": [ "anthropic|openai|gemini|human|unknown", ... ],
                   "source": "flag|env|detected|none" },
      "fixer": { "kind": string, "family": "anthropic|openai|gemini|unknown",
                 "family_source": "cli|declared|unknown" } | null,
      "reviewers": [ { "id": string, "provider": string, "model": string|null,
                       "transport": "api|gateway|cli",
                       "family": "anthropic|openai|gemini|unknown",
                       "independent": true|false|null } ],
      "failed_reviewers": [ { "id": string, "error": string } ],
      "independent": true|false|null,
      "refusal": { "independent": false|null, "override": string,
                   "reviewer": { "id": string, "family": string },
                   "fixer": { "kind": string, "family": string } | null } | null,
      "allow_same_family": boolean,
      "allow_unverified_independence": boolean,
      "allow_degraded_quorum": boolean,
      "loop_accept_rollback_limits": boolean
    }

v59 notes on this shape (P0 decisions): `schema_version` stays 1 through the 3.0.0
release, including the keys D7 and D8 add before release; after 3.0.0 it is bumped
only for a breaking shape change, and `output-schema.json` documents that rule (B10).
In SINGLE mode `reviewers[].id` is the C3 candidate id (`api:anthropic`,
`cli:claude`, `gateway`, ...), the same id vocabulary as `refusal.reviewer.id` and
`failed_reviewers[].id` (Q3). D7 adds `loop_summary.meta.thrash` and D8 adds
`loop_summary.meta.rotation`; both are loop-only and absent from non-loop `meta`.

Schema staging, so that no change tests against a schema that does not exist yet and
no schema requires a field before the change that emits it: STEP 0 publishes both
schema files describing v2.11.0 output exactly (the review result as emitted today,
i.e. schema.json plus optional `corroborated_by`; and today's loop events with
today's `exitReason` values), and the step 0 parity suite validates every emitted
document and event line against them. Each later delta that changes emitted output
extends the schema in the same change that starts emitting it: delta 21 adds
`validated`; delta 24 makes `loop_summary.survivingCount` `integer | null` and adds
`review-error`; the step 3 change (D1, deltas 1/8/19) makes `loop_start.fixerCmd` and `loop_start.constraintMode` `string | null` (for pre-loop refusals), and adds `meta`, the error-object
variants, and exitReasons `quorum-unmet` and `not-independent`; A9 (delta 15) adds
the required per-finding `verification_status`. The text below describes the FINAL
state after all deltas.
Two schemas are published, both strict (`additionalProperties: false`):
- `output-schema.json`: the single JSON document printed by a non-loop `--json` run.
  It is `oneOf` (a) a review result = schema.json's properties + `meta` +
  per-finding `verification_status` (+ the existing `corroborated_by`), or (b) an
  error object with required `error` (enum `quorum-unmet` | `not-independent`) and
  `message` (string), plus: for `quorum-unmet`, `quorum`, `successful`, `failed`, and `permitted` (an array of ids, empty in the post-call case); for
  `not-independent` (a single-reviewer run refused by R1), ONE uniform shape for
  named and auto-selected runs, all six properties top-level and required, nothing
  nested inside `reviewer` beyond its two fields: `error`, `message`, `reviewer`
  (`{ "id": string, "family": string }`), `builder` (the `meta.builder` object),
  `independent` (`false | null`), `override` (non-empty string). Which candidate
  fills `reviewer`: for a named reviewer (`--provider`) the named provider; for an
  auto-selected run the refused candidate as defined in R1 (null before false, then
  context base order). `independent` and `override` describe that candidate.
  An R1 refusal exists only when at least one ELIGIBLE candidate exists and
  none is permitted. In a SINGLE-reviewer run (`--provider` or auto-detection), when
  no candidate is eligible at all (no key, no CLI), that is
  not an R1 refusal: it is today's "No LLM configuration found" error, exit 1, stderr
  only, no JSON document. This stderr-only case does not exist in MULTI mode: with
  `--providers`, unreachable entries are recorded as `unreachable` and the run always
  ends through the pre-call quorum check with the structured `quorum-unmet` output
  (error object, or loop events), even when every requested provider is unreachable.
  For single-reviewer runs, in a loop this no-events behavior applies ONLY at startup,
  before `loop_start` has been emitted. Once a loop has emitted `loop_start`, any
  later absence of a usable reviewer (credentials expire mid-loop and no candidate
  is eligible) is a review failure and emits the `review-error` terminal events of
  delta 24. These two refusals are the only
  exit-1 cases that print a JSON document. Precisely: in MULTI mode (`--providers`),
  any shortfall of returned reviews below the effective quorum, including every
  provider failing, prints the `quorum-unmet` document; in SINGLE mode a failure of
  the one provider (after any fallback) prints nothing on stdout, as today. This paragraph is about NON-loop runs (the single JSON document). Every
  other non-loop exit-1 error (usage error, git collection failure, secrets refusal,
  a single-mode provider failure) keeps today's behavior under `--json`: message on
  stderr, nothing on stdout. Loop runs never use this rule after `loop_start`: there,
  the same failures end the stream with `review-error` events (delta 24). This is documented in the README so
  consumers treat empty stdout + exit 1 as an operational error.
- `loop-events-schema.json`: one NDJSON line of a `--loop --json` run, a `oneOf`
  discriminated by the required `type` field, one variant per event the loop emits
  today, with today's fields: `loop_start` {scope, fixerCmd, constraintMode, loopMax,
  branch?, originalHead?}, `review` {iteration, findingCount}, `review_result`
  {iteration, result: ROUND result or null}, where a round result is schema.json's
  properties + per-finding `verification_status` (+ `corroborated_by`) and has NO
  `meta` key (`meta` is run-level and appears only on `loop_summary`), `stash_created` {stashRef, stashName,
  recoveryCmd}, `fix` {iteration, fixerCmd, filesTargeted, filesModified?, stashRef?},
  `fix_committed` {iteration, commit, beforeFixHead}, `loop_end` {exitReason,
  iterations, stashRef?, originalHead?, matchedIteration?, fixerStderr?}, and
  `loop_summary` {providers, iterations, verdict, exitReason, survivingCount,
  acceptedCount, resumeHint?, meta, validated}. In `loop_summary`: `providers` is always the requested/selected reviewer ids;
  `verdict` is `approve` only when `exitReason` is `clean`, else `needs-attention`;
  `survivingCount` is `integer | null`: `null` whenever the loop ends DURING a review
  stage without a completed review of the current tree (`quorum-unmet`, or a review
  error), regardless of whether earlier rounds completed, because the tree as it now
  stands was not evaluated; for `clean`, `no-progress` and `ceiling` it is the count
  from the final completed review; for `fixer-error`,
  `fixer-timeout` and `no-diff` it is the count from the review that preceded that
  fix. For `empty` (nothing to review; no review ran) it is 0, as today, and for `clean`
  it is 0. Consumers must treat `null` as "unknown", never as zero.
  `exitReason` is an enum: clean, empty,
  no-progress, ceiling, fixer-error, fixer-timeout, no-diff,
  quorum-unmet, not-independent, review-error.
  Precedence between `quorum-unmet` and `review-error`: in a MULTI-provider loop,
  provider runtime failures (including all providers failing) that leave fewer
  returned reviews than the effective quorum always yield `quorum-unmet`;
  `review-error` is used for a SINGLE-reviewer loop's review failure and, in either
  mode, for pipeline errors that are not about a provider (context collection
  failure, or a secret-scan refusal, in ANY round once `loop_start` has been emitted,
  including the initial round).
  `review-error` (intended delta 24): today a review failure inside a loop (provider
  error after retries/fallback, malformed output after the corrective retry, or a
  context-collection or secret-scan refusal, in any round after `loop_start`,
  including the first) prints to stderr and
  exits 1 with no terminal events. It now first emits `loop_end` {exitReason:
  "review-error", iterations} and `loop_summary` {exitReason: "review-error",
  verdict: "needs-attention", survivingCount: null, validated: false, ...}, then
  exits 1; the existing recovery text still goes to stderr. Like every other
  terminal `loop_end`, the review-error `loop_end` also carries `stashRef` (working-tree
  scope; the current checkpoint ref or null) or `originalHead` (branch scope) (P0
  decision B9). Git state handling is
  unchanged (nothing is rolled back; fixes already applied remain, as today).
  A PRE-LOOP R1 refusal in a SINGLE-reviewer `--loop --json` run (a named reviewer or
  auto-selection for which no permitted fixer/reviewer pair exists, decided before
  the first review; multi-provider loops use `quorum-unmet` as specified in R1)
  emits exactly three events and nothing else on stdout, so the stream still begins
  with `loop_start` as every loop stream does: `loop_start` {scope, loopMax,
  fixerCmd: null, constraintMode: null} (these two fields are nullable in the schema
  for exactly this case: the refusal happens before a fixer is chosen or probed),
  then `loop_end` {exitReason: "not-independent", iterations: 0} and
  `loop_summary` {exitReason: "not-independent", verdict: "needs-attention",
  iterations: 0, survivingCount: null, acceptedCount: 0, validated: false, providers:
  the requested/selected ids (possibly empty), meta}; exit 1. The non-loop error
  object is never printed in loop mode. A MID-LOOP refusal (a stale-credential
  fallback after fixes have run finds no permitted reviewer) comes after the events
  already emitted for earlier rounds; it emits `loop_end` and `loop_summary` with
  exitReason `not-independent`, `iterations` equal to the number of fixer runs
  completed, `survivingCount: null`, and `meta.refusal` set; fixes already applied
  remain, as on any review failure. In EVERY mid-loop terminal event, whatever the exitReason
  (`not-independent`, `review-error`, or a multi-provider `quorum-unmet` that occurs
  after rounds have run), `iterations` is the number of fixer runs completed so far;
  `iterations: 0` appears only when the loop ends before its first fixer run.
Tests validate EVERY line emitted in every loop parity row against the event schema,
and every non-loop `--json` output against the output schema.

`fixer.kind` is the output of the existing `fixerKind()`: the lowercased basename of
the fixer executable with any Windows extension removed (e.g. `codex`). It is never a
path, never includes arguments or environment values (`--loop-fixer` takes an
executable name or path only, with no arguments), and is passed through the existing
secret redactor like every other emitted string; a fixture uses a fixer path that
contains a token-like segment and asserts it does not appear in output.

Run-level only. `reviewers` has one entry per provider that contributed a result (one
for single-provider). If the fixer candidate list is EMPTY (no `--loop-fixer`, and none of codex, claude,
agy installed), that is not an R1 refusal and R1 is never evaluated: it is today's
`detectFixer` error ("No fixer CLI found (tried codex, claude, agy)"), exit 1,
stderr only, no events. In loop mode `refusal` is populated deterministically from the FIRST fixer candidate
in scan order: `reviewer` is the named reviewer when `--provider` was given, otherwise the refused
candidate as defined in R1 (null before false, then context base order), evaluated against that fixer, `independent` is its value,
and `override` is always a flag that is sufficient by itself to permit that
candidate: `--allow-unverified-independence` if `independent` is null (including
when the cause is a custom fixer of unknown family), else `--allow-same-family`.
When the null is caused by a fixer given as a path or unrecognized name, the
human-readable `message` additionally says that, if that fixer wraps an Anthropic,
OpenAI, or Gemini model, declaring it with `--loop-fixer-family` lets independence
be evaluated properly instead; `--loop-fixer-family` is never the `override` value. The fixer candidate evaluated is reported as `meta.refusal.fixer` (`{ kind, family }`), never as `meta.fixer`: `meta.fixer` describes a fixer that was actually SELECTED for the loop and is null for every pre-loop termination (`not-independent` and `quorum-unmet` alike), matching the null `fixerCmd` of that run's `loop_start`.
`refusal` is non-null only when R1 refused the run (loop `not-independent`
summaries): it carries the evaluated candidate's `independent` value (false or null)
and the name of the override flag that would permit it, mirroring the non-loop
`not-independent` error object, so automation can tell a same-family refusal from an
unknown-builder one. In a loop, `reviewers` is cumulative: the distinct providers that contributed a
completed review in ANY round of the run (a reviewer replaced by a stale-credential
fallback stays listed). Top-level `independent` is decided in this order: if the run
ended with exitReason `not-independent`, it EQUALS `refusal.independent` (false or
null), whatever earlier rounds contributed, so a refused run can never report true;
else it is null when `reviewers` is empty (no reviewer contributed: every
run that ends in an error object or with no completed review); otherwise false if any reviewer is false, else
null if any is null, else true. Per-finding attribution stays in the existing
`corroborated_by`. In `--loop --json`, the same object is the `meta` field of the
`loop_summary` event (with `fixer` non-null once a fixer has been selected; it is null whenever the loop
ends before a fixer is selected, i.e. every pre-loop `quorum-unmet` or `not-independent` exit; `refusal.fixer` is null outside loop mode); existing `loop_summary` fields are
unchanged. `meta` is an additive key; it is called out in the 3.0.0 changelog for
consumers that validate with `additionalProperties: false`. Fixtures validate emitted
output against `output-schema.json` for single, multi-provider, and loop modes.

D2. `--builder <family[,family...]>` and `ADVERSARIAL_REVIEW_BUILDER` (same grammar).
Grammar, the single definition (R1 refers to it): each token is one of `anthropic`,
`openai`, `gemini`, `human`, `unknown`, matched case-sensitively after trimming ASCII
whitespace around each token; tokens are separated by commas; the flag may be
repeated, and all occurrences are concatenated in order then de-duplicated
(`--builder openai --builder anthropic,openai` = {openai, anthropic}); an empty token,
an empty list, or any token outside the five values is a usage error, exit 1, naming
the bad token. Parser tests: single value, comma list, repeated flag, mixed
comma + repeated, duplicates, surrounding whitespace, trailing comma (error), unknown
token (error), empty env var (error). Semantics are entirely R1's formula; this item
adds no rule. Example under R1: `--loop --builder human` with an OpenAI reviewer and
the codex fixer exits 1. Harness detection for Codex is added only once an
environment marker has been verified against the real CLI; until then Codex users set
the flag or env var.

D3. Withdrawn: strict independence is the default under R1, so no flag is needed.

D4. Withdrawn from this plan. Cross-provider verification gives one provider the
power to delete another provider's finding, which needs its own design (grounded
refutations, corroboration for high/critical) and its own review. `--verify` keeps
today's semantics: each provider verifies only its own findings.

D5. Withdrawn from this plan (see R4).

D6. Withdrawn from this plan (call budgets need their own state-transition spec).

D7. Loop thrash detection (intended delta 34; added in v59 by P0 decision). Today a
loop whose fixer keeps trading one defect for another, or keeps undoing its own last
edit, runs to `--loop-max` and ends as `ceiling`, because no-progress
(`gatingSetsEqual`, src/loop.js L352, checked at L1192 and L1671) only fires when a
gating set REPEATS. D7 adds exitReason `thrash`. Before build it needs its own P1
spec (`/adlc:adlc-spec`) and an independent cross-model review of that spec (agy);
the two thresholds below (2 rounds, 50%) are confirmed at P1 and are named constants.
Definitions:
- Round r (r = 0, 1, ...) is the completed review of the tree after r fixer runs;
  G_r is its gating set (in MULTI loops, the merged gating set). Fix N is the fixer
  run between round N-1 and round N (N >= 1). D8 confirmation reviews: a confirmation
  reviews the SAME tree as the clean round r it confirms, so it does not create a new
  index. If it is clean the loop ends; if it is gating, its set REPLACES the clean
  set as G_r (and W_r), and fix r+1 runs against it. A transition whose later round
  was replaced by a confirmation is NEVER a swap for signal 1 (the difference
  reflects a reviewer change, not fixer behavior); later transitions are evaluated
  normally. `meta.thrash.weighted_counts[r]` records the replaced value.
- Weighted count W_r = sum over G_r of a severity weight (critical 8, high 4,
  medium 2, low 1; proposed, confirmed at P1).
- Swap between rounds r-1 and r: G_r and G_{r-1} are NOT equal under the A4
  one-to-one matcher (so it is not no-progress), and the maximum matching between
  them leaves at least one finding unmatched on EACH side (a finding was resolved and
  a different one appeared). The A4 matcher is used unchanged (0.7 title threshold).
- Signal 1, stalled count: for two consecutive fix rounds W did not decrease
  (W_r >= W_{r-1} >= W_{r-2}) AND both transitions (r-2 -> r-1 and r-1 -> r) are
  swaps. Needs r >= 2.
- Signal 2, hunk churn: C_N = the lines fix N changed, taken from the zero-context
  diff between the checkpoint before fix N and the tree after fix N (working tree:
  `git diff -U0 --no-ext-diff --no-renames <stashRef>`; branch: the same between
  `beforeFixHead` and the fix commit), counting each `+` line and each `-` line once.
  Fix N+1 REVERSES OR REWRITES a line of C_N when it removes a `+` line of fix N, or
  re-adds the content of a `-` line of fix N in the same file. Matching is a
  per-file MULTISET match on the exact line content (bytes after the diff marker,
  trailing `\r` removed, nothing else normalized): each line of C_N can be matched
  by at most one line of fix N+1, so a content occurring k times in C_N and j times
  in the opposite direction in fix N+1 contributes min(k, j). Lines that are empty
  or whitespace-only are excluded from C_N and from matching (they would otherwise
  dominate churn through blank lines and lone braces). Churn
  = |reversed or rewritten| / |C_N|; the signal fires when churn >= 0.5 for any
  consecutive pair (N, N+1). The diffs are captured in memory at fix time; no ref,
  stash or object is created, so R4's mechanisms are unchanged.
Edge cases, each pinned by a test: a pair whose |C_N| = 0 records churn `null` and
never fires (this CAN happen without `no-diff`, because no-diff compares
`takeSnapshot`, src/loop.js L79-83, which includes `git status --porcelain`, so a
fix that only creates an untracked file or only edits a binary file continues the
loop); binary files and files the fixer CREATED (untracked, R4 limit 4) are outside
the `-U0` line diff and not counted; a rename counts as a delete plus an add; a
clean round always wins over thrash (subject to D8's confirmation review); the
per-round exit order is clean, no-progress, thrash, ceiling, so a repeated set is
still `no-progress` and thrash at the last allowed round reports `thrash`, not
`ceiling`; a loop with `--loop-max 1` can never thrash (both signals need two fixes).
Exit: `thrash` behaves exactly like `no-progress`: exit 2, `verdict:
"needs-attention"`, the working-tree stash checkpoint is KEPT and the recovery
command printed (branch scope: fix commits left and the recovery line printed),
`survivingCount` = |G_r| from the final completed review, `loop_end` carries
`stashRef` or `originalHead`. `loop_summary.meta.thrash` is present on every loop
summary: `{ "signal": "stalled-count" | "hunk-churn" | null, "weighted_counts":
[W_0, ...], "churn": [ratio per consecutive fix pair], "severity_escalation":
boolean, "diff_growth": [changed-line total of the cumulative loop diff per round] }`.
Severity escalation (the highest severity in G_r is above that in G_{r-1}) and diff
growth are REPORTED ONLY and never stop the loop. The change adds `thrash` to the
`exitReason` enum and `meta.thrash` to the loop-events schema (schema staging rule).
Tests: three rounds with weighted counts 6, 6, 8 and swapped findings -> `thrash`,
`signal: "stalled-count"`; negative control: the same counts with the SAME findings
-> `no-progress`; negative control: counts 8, 6, 4 with swaps -> continues; fix 2
reverting 3 of fix 1's 4 changed lines -> `hunk-churn`; negative control: fix 2
touching 1 of 4 -> continues; severity escalation alone -> continues with
`severity_escalation: true`; the same defects at the same location worded as two
different providers word them (fixtures from two mock reviewers, as D8 will produce)
-> matched by A4 and counted as repeated, not swapped; `thrash` keeps
the stash (working tree) and prints the recovery command; a fix that only creates
an untracked file -> the loop continues and that pair's `churn` entry is `null`;
every event validates against the schema (the confirmation-round cases are tested
in D8, which introduces them). Every D7 loop test pins its reviewer with `--provider`
(a mock) so that D8 landing later does not change it. Docs in the same change: the
README stop conditions (README.md L455-457) gain `thrash`.

D8. Reviewer rotation in single-reviewer `--loop` (intended delta 35; added in v59).
Today every round of a single-reviewer loop is reviewed by the one reviewer chosen at
startup, so one model's blind spots persist for the whole loop. Before build D8 needs
a P1 spec (`/adlc:adlc-spec`) and an agy spec review. Risk: trust-root, because it
changes reviewer selection under R1.
- Scope: a `--loop` whose reviewer is AUTO-selected (no `--provider`, no
  `--providers`, `--loop-reviewer` absent or `rotate`). `--provider X` or
  `--loop-reviewer fixed` pins one reviewer exactly as in v2.11.0. Multi-provider
  loops are unaffected (every round already uses the full set). `--loop-reviewer`
  takes `rotate` (default) or `fixed`; it, and `--loop-seed`, are usage errors
  without `--loop`, with `--providers`, or (for `--loop-reviewer rotate` and
  `--loop-seed`) with `--provider`; `--loop-seed` with `--loop-reviewer fixed` is
  also a usage error. So a seed is never silently ignored, except in the one case
  that cannot be known at parse time (a pool of 1, below), which warns.
- Pool P: R1's joint selection (unchanged) fixes the fixer F and the tier it selected
  from (true; null only with `--allow-unverified-independence`; false only with
  `--allow-same-family`). P = every REACHABLE C3 candidate whose `independent`
  against B (builder plus F) is in that tier, i.e. it passes R1 against BOTH the
  builder and the fixer, then collapsed to ONE candidate per diversity family (the
  first of that family in C3 base order, as `selectProviders` collapses by
  `familyKey`, src/llm.js L1803-1807); unknown-family candidates are keyed by their
  lowercased id and never merged, as in R5. So `api:anthropic` and `cli:claude`
  never both appear, and "no two consecutive rounds" holds over families, not only
  ids (unknown-family members carry R5's caveat that they may share a model). P is
  computed once, at startup, before `loop_start`.
- Order: seed s is `--loop-seed <n>` or, when absent, a random 32-bit value. P is
  sorted in C3 base order, then permuted by a Fisher-Yates shuffle driven by a named,
  specified PRNG seeded with s (fixed at P1), so the same seed and pool give the same
  order on every machine. Reviewers are chosen by a cursor over the fixed `order`
  array: each review (including a confirmation) advances the cursor to the next
  index (wrapping) whose provider is still in P; while nothing has been removed this
  is `order[k mod |P|]` for the k-th review. Every provider reviews once before any
  repeats, and for |P| >= 2 no provider reviews two consecutive reviews (including
  across the wrap, and after a removal: the cursor skips removed ids and, when two
  or more remain, never yields the previous reviewer). `loop_summary.meta.rotation =
  { "seed": s, "order": [ids], "rounds": [the C3 id that actually performed each
  review, in sequence] }` (`order` is the startup order; `rounds` is the effective
  sequence, so a `--loop-seed` replay of a run with a fallback is comparable) and
  `loop_summary.providers` = `order`; each `review` and `review_result` event gains
  `reviewer` (that review's C3 id). With rotation inactive (pinned, multi-provider,
  or |P| = 1) `meta.rotation` is null and events are as today; a `--loop-seed` given
  to a run whose pool turns out to be 1 prints one warning that the seed was unused.
  The change adds `reviewer`, `confirmation` and `meta.rotation` to the loop-events
  schema in the same change (schema staging rule), each optional or nullable so
  inactive-rotation events validate unchanged.
- Fallback: a stale-credential failure (C4) removes that provider from P for the rest
  of the run and the same review is retried by the cursor's next provider; if P
  becomes empty, R1's mid-loop rule applies (`not-independent` if a candidate exists
  but none is permitted, else `review-error`).
- Confirmation before a clean exit: a round with an empty gating set triggers ONE
  confirmation review of the SAME tree (no fixer run between) by the cursor's next
  provider. The loop exits 0 (`clean`) only if that review is also clean. Budget:
  `--loop-max` is a budget of loopMax units; a fixer run consumes one unit, a GATING
  confirmation consumes one unit, and a CLEAN confirmation consumes none. A
  confirmation ALWAYS runs after a clean round, even when no unit is left, so a
  clean exit is never reached without one. If it finds gating findings, it is an
  ordinary round for detection (no-progress and thrash per D7, using D7's
  replacement rule) and then: if a unit is left it consumes it, and its gating set
  goes to the fixer if a further unit is left, else the loop exits `ceiling`; if no
  unit is left it exits `ceiling` at once (exit 2, checkpoint kept, as today's
  ceiling). So fixer runs plus gating confirmations never exceed loopMax, and the
  worst-case review count is `passes x (loopMax + 2)` (the initial review, at most
  loopMax reviews after fixes or gating confirmations, and one final clean
  confirmation); with rotation inactive it stays `passes x (loopMax + 1)`. The
  confirmation's `review` / `review_result` events carry `confirmation: true`. With
  rotation inactive there is no confirmation review. The empty-scope exit of the
  initial round is unaffected (no review ran).
- Cross-round detection is reviewer-independent: A4's matcher is unchanged at 0.7, and
  D7's hunk churn reads only diffs.
- Parity: loop rows whose auto-selected pool has two or more providers change; each
  is edited only if its manifest `futureDeltas` lists 35, and passes `--loop-seed` for
  determinism. CHANGELOG Breaking entry. Docs in the same change: README (the
  `--loop-max` line, README.md L203, gains the confirmation budget; the loop section
  gains rotation) and `HELP_TEXT` (src/utils.js) gain `--loop-seed`,
  `--loop-reviewer` and the new `--loop-max` semantics.
Every D8 test, and every existing loop test whose reviewer changes under delta 35,
passes `--loop-seed` (or injects the seed) so its order is deterministic.
Tests: a golden-vector unit test: seed 7 and a fixed sorted pool of three ids ->
an exact hardcoded order array (catches PRNG or shuffle drift across machines and
Node versions); pool {api:openai, api:gemini} with `--loop-seed 7` -> the recorded
order matches and reviewers alternate; negative control: a different seed with a
pool of 3 yields a different order; `--loop-reviewer fixed` -> every round the same
reviewer, `meta.rotation: null` (v2.11.0 rows unchanged); pool of 1 -> today's
behavior; a clean round followed by a gating confirmation -> the loop continues and
the confirmation consumes a unit; negative control: a clean round followed by a
clean confirmation -> exit 0; `--loop-max 1`: gating, fix 1, clean, clean
confirmation -> exit 0 after 3 reviews; `--loop-max 1`: gating, fix 1, clean, gating
confirmation -> `ceiling`, exit 2, no second fixer run; a clean round, a gating
confirmation, a fix, then a round with different findings -> no `stalled-count`
from those transitions alone, and `meta.thrash.weighted_counts` holds the
confirmation's value at that index; without `--allow-same-family`, a candidate
that is same-family as the FIXER is never in P; with `--allow-same-family` (tier
false) the pool contents are pinned by a row; a pool with `api:anthropic` and
`cli:claude` -> one anthropic entry; negative control: anthropic plus openai -> two
entries; a stale credential mid-loop removes that provider, the next one reviews,
and `meta.rotation.rounds` records it; `--loop-seed` with `--providers` -> usage
error; `--loop-seed 7 --loop-reviewer fixed` -> usage error; negative control:
`--loop-seed 7 --loop-reviewer rotate` is accepted; each new flag appears in
`HELP_TEXT`; every event validates against the schema, with rotation active and
inactive.

D9. `setup` command and verified provider inventory (intended delta 36; added in v59).
v2.11.0 auto-writes a per-builder-context resolution `cache` holding ONE winner
(`persistAutoResolution`, src/resolution-lifecycle.js L34-42, through
`mutateConfigFile`, src/config-store.js L170-198). C4 still deletes it. D9 replaces it
with an operator-run command. Before build it needs a P1 spec with a security lens
(config trust boundary, path re-verification). Risk: trust-root.
- Command: `adversarial-review setup [--refresh]`, recognized ONLY when `setup` is the
  first argument; any other flag with it is a usage error, exit 1. (A review whose
  focus text starts with the word `setup` must now be written `adversarial-review --
  setup ...`; today `parseArgs` treats it as focus text, src/utils.js L450-457. This
  is part of delta 36 and its CHANGELOG Breaking entry.) `setup` never collects a
  diff or any other review context and never calls a model. It does compute the
  trust root, exactly as `defaultConfigPath` (src/config-store.js L38-45) and
  `resolveTrustedCli` (src/llm.js L235-243) already do through `reviewTrustRoot`
  (src/trust-root.js L64): the enclosing worktree, or the canonical cwd when there is
  no `.git` boundary. If that computation throws (for example `EUNTRUSTEDGIT`),
  `setup` exits 1 with the error and writes nothing.
- Discovery: for every C3 candidate, `setup` records `{ id, family, transport
  ("api" | "gateway" | "cli"), path (cli only: the canonical absolute path from the
  trusted resolver, i.e. what `resolveTrustedCli` returns), version (cli only: the
  first line of `<path> --version`, run through spawn-safe with a 10 s watchdog,
  at most 200 characters, passed through the redactor; null on any failure),
  key_present (api and gateway only: whether the env credential is non-empty; the
  VALUE is never read into the record), present (boolean), discoveredAt (ISO) }`
  under `inventory = { version: 1, discoveredAt, candidates: [...] }` in config.json.
  `resolveTrustedCli` SKIPS repo-local PATH entries and keeps walking (src/llm.js
  L235-243), so it never returns a CLI inside the trust root: a CLI present ONLY on a
  repo-local PATH entry is recorded `present: false`, and a repo-local shim in front
  of a system copy records the system copy's canonical path.
- Writes: `setup` is the only writer of config.json (C4). Without `--refresh` and
  with an inventory present it re-verifies and prints the inventory without writing;
  with `--refresh`, or with no inventory, it rediscovers and writes. It writes
  through the reread-under-lock helper C4 keeps (`mutateConfigFile`,
  src/config-store.js L170-198), so concurrent `setup` runs serialize and the file is
  reread immediately before writing; it preserves every other key and writes
  atomically with mode 0600 (`saveConfig`, src/config-store.js L145-156). Because
  `saveConfig` swallows every error and returns false ("must never fail the
  review"), `setup` checks that result: a false return (or a lock that cannot be
  taken) is exit 1 with a message naming the config path. It also exits 1 with a
  clear message, writing nothing, when the config path is disabled
  (`defaultConfigPath` returns null: a relative or in-repo
  `ADVERSARIAL_REVIEW_CONFIG`), the file is malformed, or its `version` is newer.
- Boot: when an inventory is present, every inventory candidate recorded `present:
  true` is re-verified before use with the trusted-CLI re-verification helper C4
  extracts from `cachedResolutionUsable` (src/llm.js L1251-1284): a CLI must
  re-resolve through the trusted resolver to the SAME canonical path, outside the
  current trust root, and still be usable for review; an API or gateway candidate
  must have its credential set NOW. A candidate that fails re-verification, and
  every C3 candidate that is ABSENT from the inventory or recorded `present: false`,
  is live-detected at boot, so a CLI installed or a key exported after `setup` is
  found. Invariant, pinned by a differential test over the C3 resolution matrix: the
  eligible candidate set and its order are IDENTICAL with and without an inventory.
  The inventory does not reduce PATH resolution (re-verification is the same
  `resolveTrustedCli` call live detection makes); what it adds is the recorded
  `version` and `discoveredAt` (so no `--version` spawn at boot) and a stderr
  warning when a recorded CLI now resolves to a different canonical path. R1 always
  runs on the result. A malformed `inventory` (fails its schema, a non-absolute or
  NUL-containing path) is ignored with one stderr warning naming the config path; it
  never fails the run.
- No inventory: live detection as today, plus ONE stderr info line suggesting
  `adversarial-review setup` (not printed for a non-loop `--prompt-only` run, which
  detects nothing). Parity rows that assert stderr exactly list 36 in
  `futureDeltas`.
- Consumers: the R1/C3 candidate table, D8's rotation pool, and quorum reachability.
  SKILL.md checks for the inventory on load and suggests `setup` instead of probing
  for CLIs itself.
- Docs in the same change: README's config section (README.md L346-405, which
  documents the auto-written `cache`) is rewritten for `setup` and the inventory;
  `HELP_TEXT` (src/utils.js) gains `setup [--refresh]`; BOTH committed copies of the
  skill, skills/adversarial-review/SKILL.md and .agents/skills/adversarial-review/
  SKILL.md (byte-identical today; `npm run sync-skill` copies only the references/
  files), are updated, and a test asserts the two SKILL.md copies are byte-identical.
Tests: `setup` with fake API keys set to sentinel tokens -> the config bytes contain
`key_present: true` and never the sentinel; `setup` with a mock CLI on PATH -> the
recorded path is canonical and absolute; a CLI present ONLY on a repo-local PATH
entry -> `present: false`; a repo-local shim plus a system copy -> the system copy's
canonical path is recorded; `setup` from a non-repo mkdtemp dir -> succeeds, trust
root = that dir; boot with the recorded CLI replaced by a symlink to another file ->
re-verification fails and live detection is used; negative control: an unchanged CLI
-> the inventory entry is used; an inventory recorded with no codex CLI, then a mock
codex added to PATH -> the candidate set includes `cli:codex`; negative control: the
same with codex still absent -> it does not; a review, a loop and a fallback leave
the config file byte-identical; `setup` over a config holding `defaults.models` and
a legacy `cache` -> both survive byte-equal (negative control: a mutator that drops
them fails this test); `setup` twice without `--refresh` -> the second run leaves
bytes and mtime unchanged (negative control: with `--refresh` they change); `setup`
with a read-only config dir -> exit 1, message names the path (negative control: a
writable dir -> exit 0); `setup --json` -> usage error, exit 1 (negative control:
`setup --refresh` is accepted); a malformed inventory -> exactly one stderr warning,
the run exits as it would without an inventory (negative control: a valid inventory
-> no warning); `setup` with an in-repo `ADVERSARIAL_REVIEW_CONFIG` -> exit 1,
nothing written; `adversarial-review -- setup` -> a review with focus `setup`; the
two SKILL.md copies are byte-identical; `setup` appears in `HELP_TEXT`.

D10. Optional decision provider (intended delta 37; added in v59). Binding inputs: P0
decisions J1-J9 (`.adlc/plans/3.0.0-decisions.md`); ticket T99 (no draft yet; its
draft must satisfy every rule below). A decision provider is a server that answers
structured questions over `POST {base}/v1/systemone` (Bearer auth): request `{ state,
model, questions: { <id>: { type: "noul" | "choice" | "score", instructions,
criteria } } }`, response `{ model, answers: { <id>: { type, noul (probability of
yes, 0-1) | choice + probabilities | score + probabilities } }, usage }`, errors 401,
422, 429 and 529. TypeSafe's hosted Jev and OpenJev (razorback16/openjev,
Apache-2.0, a DiffusionGemma model, so family `gemini`) speak this wire format.
OpenJev rejects pinned `jev-x.y.z` model names, so the default model is `jev-latest`.
The ecosystem is about three weeks old and has no published ground-truth
calibration, so D10 only OBSERVES: it records what the decider would have decided
next to what the LLM pipeline did, to gather agreement data. Scope is the product
runtime only (J1); the ADLC development process does not call it. Before build it
needs a P1 spec (`/adlc:adlc-spec`) with a security lens (egress, a new outbound
destination) and an agy spec review. Risk: high. The defaults marked "proposed"
below are confirmed at P1 and are named constants.
- Non-disruption rule (J9; binding, wins over every other bullet). The decider is
  entirely optional. It is CONFIGURED only when `--decider-url` is given or
  `ADVERSARIAL_REVIEW_DECIDER_URL` is set to a value that is non-empty after
  trimming ASCII whitespace (an empty or whitespace-only env value means unset).
  When it is not configured: (1) no decider request, DNS lookup or port probe is
  made, and `setup` (D9) never probes for decision servers in any case; (2) JSON,
  NDJSON and stderr are byte-identical to a build without T99: `meta.decider` and
  the per-finding `decider` record are ABSENT (not null), and there is no hint,
  notice or "decider not configured" line, even when `DECIDER_API_KEY` is set; (3)
  the decider module (`src/decider.js`) is loaded only by a dynamic `import()`
  behind the configured check, no file imports it statically, and T99 adds no npm
  dependency (it uses global `fetch` and the retry helpers named under "Transport
  and failure"); (4) T99 edits NO existing parity row: no step 0 row lists 37 in
  `futureDeltas`, and T99 only ADDS rows (below); (5) every schema addition is an
  optional property and `meta.schema_version` stays 1 (B10); (6) the `--decider-*`
  flags appear in `HELP_TEXT` only under a separate "Optional: decision provider"
  group, the README covers them in an optional section, and no existing flag's
  meaning changes (the help text is the one output a user without a decider sees
  change, and no parity row pins it); (7) invalid configuration fails only its own
  use: a configured but INVALID decider is a usage error, exit 1, only in a run that
  would consult it (see "Configuration"), while a configured decider that is
  unreachable, slow or erroring is recorded as unavailable, is bounded by the run
  budget and circuit breaker below, and never delays a reviewer, verify or fixer
  call. Delta 37 changes no UNCONFIGURED output, so it needs no step 0 row edit; it
  is listed among the step 0 loop-behavior deltas as configured-only and additive
  (`loop_summary.meta.decider`), changing no checkpoint, fixer input or rollback.
- Configuration (J4, J5). `--decider-url <base>` (flag wins over
  `ADVERSARIAL_REVIEW_DECIDER_URL`); requests go to the base with trailing `/`
  removed plus `/v1/systemone`. No vendor URL is hard-coded. Validation, each a
  usage error, exit 1, stderr only, before any git access, naming the source (flag or
  env) and never echoing the value: the base does not parse with `new URL`; its
  scheme is not `http:` or `https:`; it carries a username or password; or it is
  `http:` to a non-loopback host while `DECIDER_API_KEY` is set (the key would cross
  the network in clear). `--decider-url ""` is a usage error (an explicit empty flag
  asks for something invalid), unlike the empty env value above. Loopback means
  `localhost`, `127.0.0.0/8` or `::1`, decided from the URL text only (no DNS).
  `DECIDER_API_KEY` (optional) is sent as `Authorization: Bearer <key>`, never
  printed, never recorded, and never placed in any payload. `--decider-model
  <name>` (default `jev-latest`; any non-empty string of at most 200 characters).
  `--decider-family <anthropic|openai|gemini|unknown>` (default `unknown`; D2's
  vocabulary without `human`, same trimming and case rule) is recorded in
  `meta.decider.family`. R1 is NOT evaluated against the decider in shadow mode: a
  decider of the builder's family runs, with no refusal and no warning; the later
  gating spec makes R1 mandatory for it. `--decider-timeout <s>` (default 10,
  proposed) is a per-request watchdog validated like `--timeout` (`^[0-9]+$`,
  1..86400). `--decider-model`, `--decider-family` and `--decider-timeout` without a
  configured decider are usage errors, exit 1, so a decider flag is never silently
  ignored. Which runs consult the decider: review runs and `--loop` runs. In a run
  that never consults it (`setup`, and a non-loop `--prompt-only` run), an
  env-derived decider configuration is neither validated nor used, so an invalid
  global `ADVERSARIAL_REVIEW_DECIDER_URL` cannot fail such a run; an explicit
  `--decider-*` flag in such a run is a usage error, exit 1 (never silently
  ignored). `setup` never contacts a decider and, in 3.0.0, the inventory records
  no decider (J9 permits recording a user-configured one; that is deferred); boot
  reads the decider only from the flag or env, never from config.json.
- Decision points (J2). (a) Injection pre-check: once per review round (a non-loop
  run is one round; in a loop, every review round including a D8 confirmation
  review), started after the pre-flight secret-scan stage has completed (passed, or
  overridden by `--allow-secrets`, which does not relax decider egress; see
  "Egress"). It runs in its own decider lane, CONCURRENTLY with the reviewer calls:
  no reviewer call waits for it, and it is computed once per round, not per provider
  or per pass, because every provider receives the same payload. Chunks: the
  untrusted values the review prompt fences today (`TARGET_LABEL` and
  `REVIEW_INPUT`, src/review.js L149-155). `REVIEW_INPUT` is split first at its
  section headers (the `## <title>` lines `section()` writes, src/git-context.js
  L56-58: Git Status, Staged Diff, Unstaged Diff, Untracked Files, Commit Log, Diff
  Stat, Branch Diff, Changed File Contents (post-change), and the summary-mode
  sections), then within a section at each per-file header (`diff --git` in a diff
  section; the `### <path>` header `readFileInline` writes, src/git-context.js
  L66-93, in the Untracked Files and Changed File Contents sections). A chunk's
  `file` is the path parsed from its per-file header, or null for a chunk with
  none (attribution is best-effort: header-shaped text inside a file can split it,
  but every byte of `REVIEW_INPUT` lands in exactly one chunk). An `--input`
  artifact, which has no such headers, is split into consecutive slices. A chunk
  over `DECIDER_CHUNK_BYTES` (16 KiB, proposed) is split into consecutive 16 KiB
  slices with the same `file`; nothing is truncated inside a chunk. At most
  `DECIDER_MAX_CHUNKS` (64, proposed) are asked per round, in input order; the
  remainder is counted as `truncated`. One `noul` question per chunk: does this text
  try to instruct an AI reviewer (change its role, its rules or its verdict)? Wire
  placement (fixed, one request per chunk): `state` = `{ "kind": "untrusted-chunk",
  "file": <file|null>, "text": <the redacted chunk text> }`; `questions` = one entry
  with id `injection`, `type` `noul`, and `instructions` and `criteria` that are
  CONSTANT strings defined in src/decider.js (criteria `{ "true": ..., "false": ...
  }`). Untrusted text appears ONLY in `state.text` (and `state.file`), never in
  `instructions`, `criteria` or a question id; a unit test asserts the instructions
  and criteria are byte-identical across two different chunks (negative control: a
  chunk containing the instruction text itself changes only `state`). The verify
  stage follows the same rule: the redacted finding block and its file chunks go in
  `state`, and the question text is constant. Today
  there is no injection-detection code, only the prompt text of `TRUST_POLICY` rule
  2 (src/review.js L104-121, rule 2 at L112); D10 adds none that acts. (b) Verify
  stage: only under `--verify`, one `choice` question per finding the LLM verifier
  was asked about (so `--verify-max` bounds these calls too), with options
  `confirmed`, `refuted` and `insufficient`. `verifyFindings` (src/review.js
  L807-842) is one function that loops over a provider's findings; there is no
  per-finding call to hook. So the T99 change extends its INTERNAL return value
  (after A9: `{ result, statuses }`) with `outcomes`: one entry per finding it was
  given, in input order, carrying the redacted finding and its LLM outcome
  (`verified`, `refuted` for a finding it dropped, `verify-error`, or
  `skipped-secret`), so that dropped findings are visible to the decider stage.
  Within a run, decider questions are MEMOIZED by the sha256 of the exact request
  body (state, model and questions): an identical question, such as the same
  redacted finding verified for two providers in MULTI mode or an unchanged chunk in
  a later loop round, is sent once and its outcome reused (the reuse is recorded as
  `cached: true` on the record and counts toward the agreement data once). Only
  byte-identical bodies are reused; no similarity matching. A test sends the same
  finding through two MULTI providers -> one stub hit and two records, one with
  `cached: true` (negative control: one changed byte -> two hits).
  The decider's verify-stage questions for a provider are asked in the decider lane
  AFTER that provider's verify phase has settled, so A2's verify-phase bound
  (`n` x `--verify-timeout`) and its "no later stage starts while a verify call is in
  flight" rule hold unchanged. Their records travel in a `deciderRecords` side
  array parallel to `statuses` (dropped findings' records feed only the agreement
  counts), and `mergeProviderResults` returns `{ result, statuses, deciderRecords }`
  with `deciderRecords[i]` chosen by A9's representative rule; the unit tests of
  `verifyFindings` and `mergeProviderResults` are updated in the T99 change, and
  T99's scope and rails list them. The black-box behavior of both functions and of
  the LLM verify call is unchanged, as is `VERIFY_SCHEMA` (src/review.js L765). A
  verify-stage question's `state` is the redacted finding plus the `REVIEW_INPUT`
  chunk(s) whose `file` equals the finding's `file` (capped as above; when none
  matches, the finding alone). Decider requests run one at a time within the
  decider lane (concurrency 1, proposed), independent of `--concurrency`. The lane's
  work for a round settles, or is cut off by the run budget below, before the
  round's output is emitted (non-loop: the JSON document or report; loop: before
  the next round's review starts); this is the only wait a decider can add, and the
  budget bounds it. With `--verify` off the verify stage makes no decider call; a
  non-loop `--prompt-only` run makes none at all.
- Shadow mode (J3). Decider results NEVER change findings, verification statuses,
  gating, the verdict, the exit code, what the fixer receives, or which provider
  reviews; they are never placed in a review, verify or fix prompt. Promotion to
  gating needs a separate later spec justified by the recorded agreement data.
- Egress (J6). Every decider payload is built from the REDACTED copy (the A9 /
  delta 15 redactor, `redactSecrets` / `redactSecretsInResult`, src/secrets.js L37
  and L62), and the complete serialized request body is then run through the full
  outbound scanner of delta 17 (`scanForSecrets`, src/secrets.js L92). A scanner hit
  means no call is made and that one record (one chunk or one finding) is
  `skipped-secret`. Verify stage: A9's per-finding rule applies (a redactor change
  to `evidence` -> `skipped-secret`, no call; the `file` field is excluded from the
  scan per B12). `--allow-secrets` does NOT relax decider egress, because it
  accepts the reviewer provider as a destination, not the decider (proposed;
  confirmed at P1, conservative direction): under it the pre-check still runs, and
  each chunk whose request body hits the scanner is `skipped-secret`. When the URL
  host is not loopback, ONE stderr notice per run names the host only (no path,
  query or key) and says payloads are redacted and scanned. Every request is sent
  with `redirect: "manual"`: a 3xx response is a final failure recorded as
  `unavailable` with reason `http-<status>`, is never retried and is never
  followed, so a payload can reach only the validated base URL.
- Transport and failure. Each request carries exactly ONE question (one chunk or
  one finding), so skip, unavailable and retry are per record and stub hit counts
  are exact. Retry policy is `llmCall`'s (src/llm.js L1888): `isRetryable` (L1876;
  429, 529 and other 5xx, timeouts and network errors retry, 401 and 422 do not),
  `retryWaitMs` with `parseRetryAfterMs` (L1850-1862), at most 3 attempts, each
  under the `--decider-timeout` watchdog. `isRetryable` and `retryWaitMs` are
  module-private in v2.11.0, so the T99 change exports them (no rename, no behavior
  change to `llmCall`) from the module that holds them after C8 (T111) and imports
  them from there; T99 lands after T105 (pinned `llmCall` interface) and T111 (the
  `src/llm.js` split), see "Sequencing". `malformed-response` and 3xx are marked
  `noRetry`. Bounds (named constants, confirmed at P1): any wait (backoff or
  Retry-After) is capped at the smaller of 60 s and the remaining run budget;
  `DECIDER_RUN_BUDGET_MS` (60 000, proposed) caps the total wall time of decider
  requests in the whole run (a loop included), after which every remaining
  question is recorded `unavailable` with reason `budget-exhausted` and no request;
  and a run-wide circuit breaker opens on the first question whose FINAL outcome is
  `timeout`, `network`, `http-429`, `http-5xx`, `http-401` or `http-403` (a bad or
  expired key fails every question identically), or on the second CONSECUTIVE
  question whose final outcome is `malformed-response` or `http-422` (an endpoint
  that does not speak `/v1/systemone`), after which every remaining
  question in the run is recorded `unavailable` with reason `circuit-open` and no
  request. Any final failure records `unavailable` with `reason` one of
  `http-<status>`, `timeout`, `network`, `malformed-response`, `circuit-open` or
  `budget-exhausted`; the response body is never recorded or printed (it may echo
  the payload). A response is `malformed-response` when it is over 1 MiB, is not
  JSON, lacks the asked question id, its `type` differs from the question's, a
  `noul` is not a number in [0, 1], a `choice` is not one of the three options, the
  key set of `probabilities` is not exactly {`confirmed`, `refuted`,
  `insufficient`}, a `probabilities` value is not a number in [0, 1], or `model` is
  not a string of at most 200 characters. An unavailable decider never fails the
  run; when any record in the run was unavailable, one stderr line states how many,
  says the run is unaffected, and passes through the A7 output scrub.
- Recorded values (J7). Only raw probabilities (the `noul` value; the `choice` and
  its `probabilities`) and the server-reported `model` id. The vendor `confidence`
  field, whatever a server returns there, is ignored for every record, decision and
  metric, as is `usage`. No threshold is applied: shadow mode records probabilities,
  not verdicts. The server-reported model id is server-controlled text, so the T99
  change amends A7's structured-output allowlist to scrub `meta.decider.models[]`
  entries, the per-finding `decider.model` and the same fields under
  `loop_summary.meta.decider`; every other decider field is tool-written (enums,
  counts, numbers, the operator's validated host) and emitted unchanged.
- Output shape (schema staging rule; every addition optional). Non-loop
  `meta.decider = { "mode": "shadow", "host": string, "loopback": boolean, "family":
  "anthropic|openai|gemini|unknown", "requested_model": string, "models": [server
  ids seen, sorted, unique], "injection": { "chunks", "answered", "skipped_secret",
  "unavailable", "truncated", "results": [ { "source": "TARGET_LABEL|REVIEW_INPUT",
  "file": string|null, "status", "noul": number|null, "reviewer_injection_finding":
  boolean } in chunk order ] }, "verify": { "requested", "answered",
  "skipped_secret", "unavailable", "llm_unresolved", "agreement": a 2 x 3 count
  table keyed by the LLM outcome (`verified`, `refuted`) and the decider choice
  (`confirmed`, `refuted`, `insufficient`) } | null }`;
  `reviewer_injection_finding` is true when an emitted finding with category
  `injection` (R2) cites that chunk's file. The agreement table counts exactly the
  findings the LLM verifier was asked about whose LLM outcome is `verified` or
  `refuted` (including findings it refuted and dropped, taken from `outcomes`) AND
  whose decider record is `answered`; a finding whose decider record is
  `skipped-secret` or `unavailable` is counted only in that counter, and one whose
  LLM outcome is `verify-error` or `skipped-secret` (with an answered decider) only
  in `llm_unresolved`, so every asked finding lands in exactly one place. Each
  emitted finding gains an optional `decider: { "status": "answered" |
  "skipped-secret" | "unavailable", "reason": string|null, "choice": string|null,
  "probabilities": { "confirmed": number, "refuted": number, "insufficient": number
  } | null, "model": string|null }` next to A9's `verification_status`, attached at
  the emit stage from the `deciderRecords` side array exactly as A9's statuses are
  (never inside the pipeline, so `validateResult` and `schema.json` are unchanged);
  in MULTI mode the merged finding carries the REPRESENTATIVE's record (A9's rule).
  In `--loop`, `loop_summary.meta.decider` holds the same configuration fields plus
  `rounds: [ { "injection", "verify" } per review ]`; no other loop event changes.
  `output-schema.json` and `loop-events-schema.json` gain these optional properties
  in the T99 change (strict, `additionalProperties: false`; `probabilities` uses
  three fixed number properties, so no map keyword outside the schema-lite subset is
  needed), and documents captured before T99 still validate. T99 owns the
  `test/parity/schemas.test.mjs` controls this flips (plan section 2.1 critic fix):
  a document with `meta.decider` validates; one with `meta.decider.bogus`, or with
  a fourth key in a finding's `decider.probabilities`, fails.
- Parity (J9.4). New manifest `test/parity/rows/decider.json` (with its
  `roadmapLines`), rows registered through `defineRows` / `row()` with empty
  `futureDeltas`, exercised by `test/parity/decider.test.mjs`:
  DECIDER-ABSENT-single, DECIDER-ABSENT-multi, DECIDER-ABSENT-loop and
  DECIDER-ABSENT-verify (decider not configured). Each ABSENT row names, by manifest
  id, the existing step 0 row whose invocation it repeats (the ids are chosen at P1
  from the step 0 manifests: one single, one multi, one `--loop` and one `--verify`
  row) and asserts in-suite that its stdout and stderr, after the harness's
  normalization, equal that row's expected output; its network check is the
  fetch-wrapping preload, which records every outbound URL and fails the row on any
  URL other than the reviewer stub's (a stub-hit count alone would miss a build
  that calls some default host). Negative control: the same preload in a configured
  run records the decider URL and the row's check fails. The "pre-T99 capture" of
  J9.4 is enforced separately by P5 behavior-diff (T50's `PARITY_CAPTURE`, base vs
  HEAD), which must show zero changes in every pre-existing row.
  DECIDER-SHADOW-single, DECIDER-SHADOW-multi, DECIDER-SHADOW-loop and
  DECIDER-SHADOW-verify (stub configured): findings, statuses, verdict and exit code
  equal the matching ABSENT row once `meta.decider` and every per-finding `decider`
  are deleted. Rows follow house rules 5 and 9 (`--builder human`; loop rows pass
  `--loop-accept-rollback-limits` and pin their reviewer or pass `--loop-seed`). The
  parity glob is run unquoted (house rule 1): `node --test test/parity/*.test.mjs`.
- Docs in the same change: README optional section "Decision provider (optional,
  shadow mode)"; `HELP_TEXT` (src/utils.js L15) group "Optional: decision provider";
  a CHANGELOG entry under `## [Unreleased]` citing delta 37 (not Breaking).
Tests use a local HTTP stub speaking `/v1/systemone` (the parity harness's API-stub
pattern) that counts hits and can answer each error status; live Jev or OpenJev
tests run only when an opt-in env var is set and are skipped otherwise. Tests:
J9 negative control: `ADVERSARIAL_REVIEW_DECIDER_URL=""` (and, separately, `"  "`)
plus an unrelated env var -> decider off, zero stub hits, output identical to the
unset run; negative control: the same env var set to the stub URL -> stub hits > 0
and `meta.decider` present; `DECIDER_API_KEY` set with no URL -> zero hits, no
stderr line, output identical (negative control: adding the URL -> the request
carries the Bearer header); a preload that wraps `globalThis.fetch` and records
every URL -> no URL ends in `/v1/systemone` in an unconfigured single, multi,
`--verify` and `--loop` run (negative control: configured -> it does); module
isolation: a source test that no file statically imports `src/decider.js`, and, on
Node >= 20.6 via a `--import` resolve hook (skipped with a stated reason on Node
18), an unconfigured run never resolves it (negative control: a configured run
does); `package.json` `dependencies` unchanged by T99; `meta.decider` absent (key
not present) in every unconfigured mode; shadow invariance: a stub answering
`refuted` with probability 1.0 for every finding and `noul` 1.0 for every chunk ->
findings, gating, verdict and exit code equal the unconfigured run (negative
control: a mutant that drops decider-refuted findings fails this test under `adlc
hollow-test`); no decider output appears in the fix prompt of a configured loop;
usage errors, each exit 1 with zero stub hits: `--decider-url ftp://x`,
`--decider-url http://u:p@127.0.0.1:9`, `--decider-url ""`, `--decider-url
http://example.com` with `DECIDER_API_KEY` set, `--decider-family human`,
`--decider-timeout 0`, `--decider-timeout 1e3`, `--decider-model x` with no URL,
`setup --decider-url http://127.0.0.1:9` (negative controls: `http://127.0.0.1:<port>`
with a key, `https://example.com` with a key, and `--decider-family gemini` are
accepted); scope of validation: `ADVERSARIAL_REVIEW_DECIDER_URL=ftp://x` with
`setup`, and with a non-loop `--prompt-only` run -> exit 0 and output identical to
the unset run (negative control: the same env value with a normal review -> exit
1); a sentinel `DECIDER_API_KEY` never appears in stdout, stderr, NDJSON or
config.json; stub 401, 422, 429 (with Retry-After: 1) then 200, persistent 529, a
hang past `--decider-timeout 1`, and a connection refused -> recorded `unavailable`
with the matching reason (or `answered` after the 429 retry), exit code and verdict
unchanged, one stderr unavailability line (negative control: all answered -> no
such line); a stub answering 307 to a second stub -> record `unavailable` with
reason `http-307`, exactly one hit on the first stub and zero on the second
(negative control: a 200 is answered); malformed answers (a `noul` of 1.5, an
unknown choice, a missing question id, a `probabilities` map with a fourth key, a
2 MiB body) -> `malformed-response` with exactly one stub hit each (not retried);
two responses identical except `confidence` 0.99 vs 0.01 -> byte-identical
records; circuit breaker and budget: a stub that hangs, a diff of 64 chunks, three
`--verify` findings and `--decider-timeout 1` -> exactly one question is attempted
(3 hits), every other record is `unavailable` with reason `circuit-open`, the
first reviewer request reaches the reviewer stub before the decider's first
request settles, and the decider adds at most `DECIDER_RUN_BUDGET_MS` plus a
stated tolerance to wall time (negative controls: with the breaker disabled by a
test seam the same run makes more than 3 hits; a stub that answers keeps the
breaker closed); a fake clock that exhausts `DECIDER_RUN_BUDGET_MS` -> remaining
records `budget-exhausted` with no request; chunking: an injection string in an
untracked file and one at byte 20 000 of a changed file's full content are each
sent in some chunk whose `file` is that path (negative control: a mutant splitting
only at `diff --git` attributes them to the wrong file and fails); a 70-chunk input
-> 64 asked, `truncated` 6; a token-shaped string in a finding's `evidence` -> that
finding's decider record is `skipped-secret` and the stub never receives the token
(negative control: a clean finding is sent); `--allow-secrets` with a
secret-bearing diff -> the stub receives no secret value, the chunk holding it is
`skipped-secret` and the other chunks are sent; a stub returning a `model` id that
contains a sentinel token -> emitted as the placeholder in `meta.decider.models`
and the finding's `decider.model` (negative control: `jev-latest` is emitted
verbatim); two stubs' model ids returned in either order -> `models` is the same
sorted list; a unit test with an injected fetch and base `http://decider.test` ->
exactly one notice per run, naming `decider.test` (negative control: `127.0.0.1`
and `[::1]` -> none); a loop of three review rounds against a non-loopback base ->
still one notice; `--decider-family anthropic` with `--builder anthropic` -> runs,
no refusal; a `--verify` run with four findings, one refuted by the LLM verifier
and one whose verify call times out -> the agreement table counts three (the
dropped one under the LLM outcome `refuted`) and `llm_unresolved` is 1 (negative
control: a mutant mapping `verify-error` to `verified` fails); an injection-category
finding on a file -> that chunk's `reviewer_injection_finding` is true; a MULTI run
-> the merged finding carries the representative's record (unit test of
`mergeProviderResults` with `deciderRecords`); every emitted document and event,
configured and unconfigured, validates against the schemas; the `--decider-*`
flags appear in `HELP_TEXT` only under "Optional: decision provider".

## Intended deltas (everything else is parity)

1. Independence is enforced fail-closed: same-family exits 1, and unknown independence
   (including an undeclared builder) exits 1, each with its own override flag (R1).
2. Default timeouts change (A2). Extended in v59 (P0 decision B5): `--timeout` is
   validated strictly, `^[0-9]+$` and 1..86400, in the same change (R5 numeric
   validation); `1e3`, `0x10`, ` 5 `, `0`, `-1`, `1.5`, an empty value and `86401` are
   each a usage error, exit 1, before any git access. Tests: each of those values;
   negative control: `--timeout 1` and `--timeout 86400` are accepted. CHANGELOG
   Breaking entry.
3. (withdrawn with A3)
4. No-progress matching is fuzzy (A4).
5. Untracked bytes count toward the budget (A5).
6. Injection attempts use category `injection` (R2).
7. (withdrawn; loop checkpoint behavior is unchanged, R4)
8. Emitted JSON gains `meta` (D1); config file is never written (C4) except by the
   operator-run `setup` command (delta 36, D9).
9. Working-tree payload is one combined diff (B5).
10. (withdrawn with D4)
11. (withdrawn with B1)
12. API calls for multiple providers/passes run concurrently (R5); results and exit
    codes are unchanged, stderr progress line order is not.
13. (withdrawn; SIGINT behavior is unchanged, R4)
14. System instruction omits the schema text for native structured-output API calls
    (B3); emitted results are unchanged.
15. `--verify` sends a redacted copy of findings to the verifier and re-scans the
    outbound verify payload for secrets (step 0 stage-order note). Test: a reviewer
    returns a token-shaped string in `evidence`; assert no verify request, log line,
    ledger entry, or emitted event contains it.
16. Log lines, error messages, and NDJSON events are secret-redacted at the output
    sink (A7).
17. The outbound secret scan covers the complete prompt, not only repository content.
    v59 (P0 decisions B6, Q5): the refusal names the source, focus text (argument N)
    or repository content (path), and never prints the value; resolution-stage
    failures now win over a secret refusal, pinned by parity row
    PREC-SECRET-VS-NOCONFIG, with a CHANGELOG note.
18. `--loop` (both scopes) requires `--loop-accept-rollback-limits` (R4).
19. Fewer successful providers than `--quorum` exits 1 unless
    `--allow-degraded-quorum` (R5).
20. (withdrawn with A8)
21. `loop_summary` gains `validated: false`; success wording changes (R4 limit 5).
22. Gateway model precedence becomes `--model` > config pin > diversity choice.
23. Cursor's builder family is unknown unless declared (C3).
24. A review failure inside a loop emits `loop_end` and `loop_summary` with exitReason
    `review-error` before exiting 1 (D1).
25. A working-tree loop is refused at startup when any untracked, non-ignored file
    exists (R4).
26. `redactSecretsInFindings` also covers `exploit_scenario`.
27. (withdrawn with A8)
31. The schema text placed in prompts omits `$schema` / `$id` / `$comment` (B3).
29. `buildVerifyPrompt` uses artifact wording for `--input` reviews (A10).
30. `--loop` together with `--input` is a usage error.
28. Restated in v59 (P0 decision Q1): `--model` together with ANY `--providers` value
    (a single entry, a list, or `auto`) stays a usage error, exit 1, exactly as in
    v2.11.0 (src/utils.js L477-479; R5). This KEEPS today's behavior rather than
    changing it, so it is pinned by three step 0 parity rows (the "usage errors"
    line of the step 0 matrix: one each for a single entry, a list and `auto`;
    their ids are assigned in the step 0 manifests) whose `futureDeltas` do not list
    28; they land in step 0 and no row is edited for it. Tests: each of the three -> exit 1,
    stderr names `--model` and `--providers`, zero provider calls; negative control:
    `--model x --provider openai` is accepted.
32. Quorum/providers validation is tightened (R5, P0 decision Q2). Each is a usage
    error, exit 1, stderr only. Checked by `parseArgs`, before any git access or
    call: `--quorum` not matching `^[0-9]+$` or below 1; `--quorum` > 1 without
    `--providers`; `gateway` or `vercel` as a `--providers` token. Checked by
    `selectProviders` after token resolution (which in v2.11.0 runs inside
    `runMultiProvider`, bin/cli.js L31-34, after the git context has been
    collected), so before any model call but not before git access, as R5 states:
    `--quorum` above the number of distinct explicit entries (after the synonym
    collapse `selectProviders` applies, src/llm.js L1803-1807), or above 3 for
    `auto`. The upper-bound tests therefore assert zero provider calls, not zero
    git calls. Tests: `--quorum 1e0`, `--quorum 2` alone, `--providers
    openai,gateway`, `--providers openai,gpt --quorum 2`, `--providers auto --quorum
    4` -> each exit 1; negative controls: `--quorum 1` alone, `--providers
    openai,anthropic --quorum 2` and `--providers auto --quorum 3` pass validation.
    Lands with delta 19. CHANGELOG Breaking entry.
33. A CLI unit of work (a review pass with its corrective retry and argv fallbacks,
    or one verify call) has ONE budget (R5 schedule, P0 decision Q6): a retry or
    fallback cannot extend it past `--timeout` (or `--verify-timeout`). Exit codes are
    unchanged, so delta 12's claim stands. The unit deadline is computed from an
    injectable monotonic clock seam so the tests are not wall-clock dependent. Test
    (fake clock): the first attempt consumes 0.8 x the budget and returns malformed
    output -> the corrective retry is spawned with a watchdog equal to the remaining
    0.2 x (asserted exactly on the value passed to the spawn), and when it overruns
    the pass fails with today's timeout message; negative control: the same mock
    answering valid JSON on the retry within the remainder succeeds. One subprocess
    smoke test with real time uses `--timeout 3` and a mock whose first run answers
    malformed output at 2.4 s and whose corrective retry hangs: the pass must end within 4.5 s (1.5 x
    `--timeout`, the stated tolerance), which v2.11.0's fresh per-spawn watchdog
    (about 5.4 s) fails. Parity row in the CLI-error manifest, `futureDeltas`
    [33]. CHANGELOG line.
34. `--loop` gains exitReason `thrash` (stalled weighted count with swapped findings,
    or hunk churn >= 50%), exit 2, checkpoint kept, recovery command printed (D7).
    Tests as listed in D7. CHANGELOG entry; README stop conditions gain `thrash`.
35. Single-reviewer `--loop` rotates its reviewer by default across a seeded shuffle
    of the R1-permitted pool and requires a clean confirmation review by the next
    provider before exiting `clean` (D8); that confirmation always runs, a gating
    one consumes a `--loop-max` unit, and the worst-case review count becomes
    `passes x (loopMax + 2)`. `--loop-reviewer fixed` or `--provider` restores
    v2.11.0. Tests as listed in D8. CHANGELOG Breaking entry.
36. New `adversarial-review setup [--refresh]` command writes a verified provider
    `inventory` to config.json; runs without it print one hint line; a leading
    `setup` argument is no longer focus text (D9). Tests as listed in D9. CHANGELOG
    Breaking entry naming the migration: a review whose focus text starts with
    `setup` is now written `adversarial-review -- setup ...`.
37. An OPTIONAL decision provider (`--decider-url` or `ADVERSARIAL_REVIEW_DECIDER_URL`,
    a `/v1/systemone` server such as Jev or OpenJev) is consulted in shadow mode at
    the injection pre-check and the verify stage, and its raw probabilities are
    recorded in `meta.decider` and per-finding `decider` records; it never changes
    findings, gating, the verdict or the exit code (D10, P0 decisions J1-J9). Without
    a configured decider every run is byte-identical to the same build without T99
    (J9): no request, no new output, no parity row edited. A configured decider never
    delays a reviewer, verify or fixer call and its total added time is capped by a
    run budget and a circuit breaker. Tests as listed in D10. CHANGELOG entry (not
    Breaking).
38. agy reviews whose prompt exceeds the platform argv limit run over stdin
    (`--input-format stream-json`) instead of exiting 1, but only when the installed
    agy supports it AND plan mode is attested for the run; otherwise the error
    stays, now naming the missing support or attestation (A11). Prompts within the
    limit are unchanged. CHANGELOG entry (Fixed).
39. `--loop` working-tree `fix` events and the human "Files modified:" line report every path whose
    content changed during the fix, including files that were already dirty before it (today an
    already-modified file is omitted, because only newly appearing `git status` lines are compared).
    Branch scope is unchanged. Ticket T118, step 2b. CHANGELOG entry (Fixed).
40. `--loop` working-tree rollback restores the user's index and worktree separately (from the
    checkpoint stash's index tree and worktree tree), preserving the staged/unstaged split. Today the
    per-file fallback (always taken, because the checkpoint re-applies the stash) writes the stashed
    worktree content into both. Ticket T119, step 2b. CHANGELOG entry (Fixed).
New flags: `--verify-timeout`, `--verify-max`, `--loop-fixer-family` (declares a custom fixer's family), `--builder`, `--allow-same-family`, `--allow-unverified-independence`,
`--allow-degraded-quorum`, `--loop-accept-rollback-limits`, `--concurrency`,
`--loop-fixer-timeout`, and from v59 `--loop-seed <n>` (D8; seeds the rotation
order), `--loop-reviewer rotate|fixed` (D8; `fixed` restores v2.11.0), plus the
`setup [--refresh]` subcommand (D9), and the optional D10 group `--decider-url <base>`,
`--decider-model <name>` (default `jev-latest`), `--decider-family
<anthropic|openai|gemini|unknown>` and `--decider-timeout <s>` (with the env vars
`ADVERSARIAL_REVIEW_DECIDER_URL` and `DECIDER_API_KEY`). `--concurrency` and `--loop-fixer-timeout`
change no parity row when unset. The other five exist because of deltas 1, 18, and
19, which change defaults: the change that lands delta 1 adds `--builder human` to
the invocation of every parity row (the suite runs outside any harness) and adds the
refusal rows; no expected result of an existing row changes other than through a
listed delta. v59: non-loop prompt-only parity rows are exempt from that `--builder human`
migration (R1, P0 decision B1); `--loop-seed`, `--loop-reviewer` and `setup` exist
because of deltas 35 and 36, and loop parity rows affected by delta 35 pass
`--loop-seed` for determinism. The `--decider-*` flags exist because of delta 37, are
listed in `HELP_TEXT` under "Optional: decision provider", are inert unless a decider
URL is configured, and change no parity row (J9).
Each delta ships with its own tests and updates the affected parity rows in the same
change.

## Sequencing

0. Parity suite (asserts v2.11.0 behavior only).
1. C2, then C1. Pure refactors; parity suite passes with zero edits. No delta lands
   before this step is complete.
2. Small independent deltas, each its own change editing its own parity rows:
   A2 (delta 2), A5 (delta 5), R2/A6 (delta 6), A7 (delta 16) immediately followed
   by delta 17 (full-prompt scan; A7's retry-feedback test asserts against that scan,
   so the two land back to back and that one test ships with delta 17), then
   delta 18, delta 25, delta 26, delta 29, delta 30, delta 21, then delta 24, in that order (delta 24's `loop_summary`
   carries the `validated` field delta 21 introduced; delta 21 adds only `validated` to `loop_summary`; `meta` on
   `loop_summary`, including `loop_accept_rollback_limits`, arrives in step 3).
3. R1/A1 + C3 + C4 + D1 + D2 + delta 19 + delta 28 together (one selection/provenance
   change; deltas 1, 8, 19, 22, 23, 28). Delta 19 lands here because it writes
   `meta.failed_reviewers` and `meta.allow_degraded_quorum`, which do not exist before
   D1. From v59 this step also carries delta 32 (quorum/providers validation, landing
   with delta 19) and D9 (delta 36, `setup` + inventory), which lands after C4 and
   co-lands with the single-reviewer C3/R1 candidate table that consumes it. Delta 28
   adds nothing to this step: it changes no behavior, and its three pinned rows land
   in step 0.
4. A4 (delta 4), then D7 (delta 34, thrash), then D8 (delta 35, reviewer rotation;
   its rounds feed both A4's matcher and D7's detectors), then R5/B2
   (delta 12) together with delta 33 (CLI unit budget). D7, D8 and D9 each need a P1
   spec and an agy spec review before build.
5. A9 (delta 15).
6. B3 (delta 14 and delta 31), B5 (delta 9), B7, C5-C10. From v59 this step also
   carries D10 (delta 37, optional decision provider in shadow mode, ticket T99),
   which lands after A9 (step 5, delta 15, whose redacted verify payload and status
   side array it reuses), D9 (step 3, whose `setup` it must never extend into
   probing), B3 (T105, whose pinned `llmCall` interface it shares) and C8 (T111,
   the `src/llm.js` split, from whose module T99 exports the retry helpers), and
   before the 3.0.0 release change (T114). A11 (delta 38, agy stdin transport,
   ticket T117) also lands in this step, after C5 (T108, whose classifier handles its
   error results) and before C8 (T111), so the `src/llm.js` split moves finished code. The plan's wave table and DAG therefore
   need the edges T105 -> T99 and T111 -> T99 in addition to T94, T98 -> T99. D10
   needs a P1 spec with a security lens and an agy spec review before build.
