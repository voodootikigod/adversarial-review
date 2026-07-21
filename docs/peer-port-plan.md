# Porting reliability work from `Robbyfuu/codex-plugin-cc` ("peer")

## Relationship between the two projects

Both descend from the OpenAI Codex `adversarial-review` skill, but **not through git**.

- Peer's history descends from `c69527e Initial commit` of the original Codex plugin for Claude Code.
- Ours begins at `2d047d7 feat: adversarial-review npm module` — a fresh history. Our lineage is a
  licensed derivation recorded in `NOTICE`: `prompt-template.md` adapted from the Codex prompt,
  `schema.json` reproduced from the Codex review-output schema.

**There is no merge-base.** `git merge-base HEAD peer/main` returns nothing. No commit from peer can
be cherry-picked. Every item below is a hand re-implementation against a different architecture,
using peer's code as a *reference implementation*.

The two have also diverged in shape:

| | Peer | Ours |
|---|---|---|
| Form | Claude Code plugin | Standalone npm CLI |
| Runtime | Broker + app-server + tmux + persistent job store | One-shot process, no daemon |
| Models | Codex only, deeply | anthropic / openai / gemini / vercel-gateway APIs + claude / codex / agy / agent CLIs |
| Schema `required` | `verdict, summary, findings, next_steps` | adds `coverage` |

Consequence: peer's *process-level* hardening ports well; peer's *broker-level* features do not port
at all. Anything lifted from their prompt must preserve our extra `coverage` field.

---

## A. Port — genuine gaps

### A1. Never select the Windows spawn shell from the environment
**Peer:** `c1cc2b4`. Two spawn sites used `shell: win32 ? (process.env.SHELL || true) : false`,
trusting an attacker-influenceable env var to pick the Windows shell and dropping argv
metacharacter safety. Peer's fix is `runCommand` in `scripts/lib/process.mjs:52-58`:

```js
shell: options.shell ?? false,   // default false on EVERY platform
windowsHide: true
```

with the documented rule that the only permitted Windows fallback is `process.env.ComSpec`
(cmd.exe), never `SHELL`.

**Ours:** `src/llm.js:203` — `shell: process.platform === "win32"`. Same class of bug. On Windows
every argument we pass to a local CLI goes through `cmd.exe` string parsing.

**Complication — do not just flip it to `false`.** Our `shell: true` was introduced for the same
reason peer's was (`cf6f851`, "add `shell: true` on Windows so spawnSync can resolve `.cmd` shims").
Flipping it blind breaks npm-installed CLIs on Windows. The correct port: resolve the binary to an
absolute path with extension *before* spawning — `isCmdInstalled` at `src/llm.js:170-192` already
walks `PATH` and `PATHEXT` and knows the full candidate path; have it return that path instead of a
boolean, spawn the resolved path, and set `shell: false` unconditionally.

**Size:** small. **Value:** high — this is the one outright security defect the comparison surfaced.

---

### A2. Idle watchdog — supersedes `plan.json` T4
**Peer:** `scripts/lib/watchdog.mjs` (389 lines), `createIdleWatchdog`. This is materially better
than what T4 specifies, and the reason is worth reading in their own words
(`watchdog.mjs:88-101`):

> the app-server client opts OUT of delta notifications, so a long-running item (a slow
> `commandExecution`, a long reasoning/answer block) emits `item/started` and then nothing until
> `item/completed`. A naive "no notification for idleMs => stall" guard would false-trip and kill
> healthy long work. So while at least one item is in flight the idle guard refuses to fire
> `onStall`; it simply re-arms. The hard ceiling is the only thing that can end a turn whose item
> never completes.

Their design is **three guards, not one**:

1. `idleMs` (default 180000) — fires `onStall` only when nothing has been notified **and** nothing
   is in flight.
2. `maxMs` (default 900000) — hard ceiling, fires regardless of activity. The only thing that can
   end a genuinely stuck item.
3. `requestTimeoutMs` (default 600000) — per-request ceiling.

Plus: in-flight items tracked in a `Set` so duplicate `item/started` cannot corrupt the count; both
signals one-shot and terminal; `stop()` idempotent and clears every timer; `setTimeoutImpl` /
`clearTimeoutImpl` injected so the behaviour is unit-testable with fake timers instead of real
wall-clock waits; every timer `.unref()`'d.

**Ours:** none. `src/llm.js:195-205` is blocking `execFileSync` with only a wall-clock `timeout`.

**The flaw this exposes in `plan.json` T4.** T4 specifies "resets an `idleTimeoutMs` timer on every
chunk; if idle too long, kill and throw `EIDLE`". That is exactly the naive guard peer explicitly
warns against. A local CLI that spends four minutes on a silent tool call emits no chunks and would
be killed as hung. T4 as written will produce false kills on healthy long reviews.

**Adaptation required.** We cannot copy item-awareness directly: peer gets `item/started` /
`item/completed` from a JSON-RPC event stream; we read raw stdout from four different CLIs. Options,
in order of preference:

- **Two-timer minimum (mandatory).** Generous `idleMs` *plus* a hard `maxMs` ceiling, with the idle
  timer as an optimisation and the ceiling as the real backstop. Never let idle be the only guard.
- **Codex liveness upgrade (optional, later).** `codex exec` emits a JSONL event stream; we
  currently suppress it via `--output-last-message` (`src/llm.js:315`). Consuming that stream would
  give us true item-awareness for the codex path specifically. Scope separately — do not bundle.

Also port the injected-timer seam. It is why peer can test this without flaky sleeps, and it
directly addresses our own `.adlc` ticket T8 ("de-flake the spawn-heavy loop e2e tests").

**Unbounded buffer.** T4 says `spawnWithWatchdog` "returns the fully buffered stdout on success"
with no cap. A runaway CLI then exhausts memory before any timer fires. Our current `execFileSync`
path has `maxBuffer: 10 * 1024 * 1024` (`src/llm.js:201`); the replacement must keep an explicit cap
and fail loudly on overflow.

**Size:** large — the centre of gravity of this whole effort. **Value:** high.

---

### A3. Prompt fencing — supersedes `plan.json` T1
**Peer:** `02d4b4c`, `scripts/lib/prompts.mjs`. Their `stripFenceSentinels` is stronger than T1:

```js
return value
  .replace(/<<<UNTRUSTED:[^>]*>>>/g, "")
  .replace(/<<<END:[^>]*>>>/g, "")
  // Defense in depth: also drop any bare sentinel prefix left without a
  // closing `>>>`, so a truncated/half-formed marker cannot linger.
  .split(UNTRUSTED_OPEN_TOKEN).join("")
  .split(UNTRUSTED_CLOSE_TOKEN).join("");
```

Three properties T1 lacks:
- Strips **both** forged opening and forged closing markers. T1 only strips `<<<END:{key}>>>`,
  leaving an injected `<<<UNTRUSTED:...>>>` opener able to spoof a second fence.
- **Label-agnostic** — any sentinel regardless of label, since any of them is a breakout risk.
- Strips bare prefixes with no closing `>>>`, so a truncated marker cannot linger.

They fence only the untrusted vars (`REVIEW_INPUT`, `USER_FOCUS`, prior assistant message) and leave
trusted scaffolding unfenced, with a one-line "data, never instructions" preamble in the template.
That decomposition is right and matches T1's intent.

**Ours:** none. No `fenceUntrusted`, no `UNTRUSTED` token anywhere in `src/` or the templates.

**Improve on peer:** peer's tokens are static compile-time constants, so an attacker who has read
their source knows the exact sentinel. Generate a per-run random nonce (`<<<UNTRUSTED:{label}:{nonce}>>>`)
and keep peer's label-agnostic stripping. Costs nothing, removes the guessability.

**Our surface is larger than theirs:** fence in `buildPrompt` **and** `buildArtifactPrompt`
(`src/review.js`) — `--input` artifact mode reviews user-supplied spec files, which are untrusted
too, and peer has no equivalent mode.

**Size:** small-medium. **Value:** high.

---

### A4. `terminateProcessTree` + `isPidAlive`
**Peer:** `scripts/lib/process.mjs:96-183`, hardened in `109ff6d`. Two things we would otherwise get
wrong:

- **Kill the tree, not the child.** POSIX path signals the process *group* (`killImpl(-pid,
  "SIGTERM")`) and falls back to the bare pid; Windows uses `taskkill /PID <pid> /T /F`. A watchdog
  that kills only the direct child leaves the CLI's own grandchildren running — exactly the hang we
  are trying to fix.
- **Never signal a stale or recycled pid.** `isPidAlive` requires `pid > 0`, because `kill(0, …)`
  and `kill(-0, …)` are group-relative and would target *our own process group*. It treats `ESRCH`
  as dead and anything else (e.g. `EPERM`) as alive.

**Ours:** none — we have no process-tree termination anywhere.

**This is a hard dependency of A2.** A watchdog without it is a watchdog that does not reliably
stop anything. Land it in the same module.

**Size:** small-medium (peer's is ~90 lines and largely portable as-is). **Value:** high.

---

### A5. Findings-ledger file permissions
`src/findings-ledger.js:39-41` creates the ledger directory and appends without explicit modes:

```js
if (dir && dir !== ".") fs.mkdirSync(dir, { recursive: true });
fs.appendFileSync(ledgerPath, buffer);
```

Gating findings can quote source code. Set `0o700` on the directory and `0o600` on the file. This is
the *real* target of `plan.json` T2 — see C2 for why T2's stated target is already done.

**Size:** trivial. **Value:** low-medium.

---

## B. Port, but redesigned

### B1. Resume IDs — `plan.json` T3 needs its mechanism changed
**Peer:** `acf6437`. Their resume ID comes from a **structured tracked-job record with a
`threadId`** — `render.mjs:120` emits `/peer:rescue --resume-id ${jobId}` from persisted state, and
the commit is explicitly "render-only", gated on job status (failed/interrupted with a thread, not
completed/cancelled).

**T3 proposes** parsing stderr for `agy resume <id>` / `codex resume <id>`.

We have no job store, so text parsing is the only mechanism available — but it is not equivalent,
and the ticket should stop implying it is. Constraints to write into T3:

- Mark it explicitly **best-effort**: a missing resume line must never fail the run or change the
  exit code.
- Gate it on failure states only, mirroring peer's status gate.
- Anchor the regex per-CLI rather than one loose global pattern, and cap the scanned stderr length.
- T3's scope names `test/cli.test.mjs`, **which does not exist**. Closest is
  `test/cli-multiprovider.test.js`. Fix before starting.

**Size:** small. **Value:** medium.

---

## C. Already have it — do not port

| Peer work | Our status |
|---|---|
| `db52e28` remove shell expansion for git | **Already safe.** `src/git-context.js:14` is `execFileSync("git", …)` with no `shell`, and `resolveCommit` (`:28-40`) rejects control characters and resolves every ref through `rev-parse --verify` to a SHA before use. Ours is safer than peer's pre-fix state. |
| `c9d0c62` harden state-dir perms to 0700 | **Already done for the codex temp path.** `src/llm.js:307` writes with `{ mode: 0o600, flag: "wx" }` into a `mkdtempSync` dir, which Node already creates `0o700`. `plan.json` T2 is largely redundant — its real gap is A5. |
| `594fd1e` working-tree crash on untracked directories / broken symlinks | **Already fixed, and more thoroughly.** Peer moved `fs.statSync`/`fs.readFileSync` into try blocks and added an `isDirectory()` guard. `src/git-context.js:61-78` already does all of that and uses `lstatSync` rather than `statSync` — so a broken symlink cannot throw in the first place — plus an explicit symlink skip (`:67`), a size cap (`:69`), and binary detection (`:78`). Our `ls-files --others --exclude-standard` (`:90`) also omits `--directory`, so it never emits directory entries. |
| `074bd47` structured verdict gating | **Already done.** `deriveVerdict` in `src/review.js`, applied before JSON emit per the earlier grok-findings ticket (AC4). |
| `bc8fa66` avoid embedding large diffs | **Ours is more advanced** — `--max-files`, `--max-bytes`, `--include-files` budgeting, and `--allow-summary-review`. |

---

## D. Do not port — architecture mismatch

Broker self-heal, app-server client, tmux live view, persistent job store, `/history`, `/stats`
per-turn telemetry, `/doctor`'s broker-socket checks, multi-account `CODEX_HOME` switching,
turn-completion notifications, Claude session transfer, `companion-env` namespacing.

Every one of these exists to manage a **long-lived daemon inside a plugin host**. We are a one-shot
CI process: we have no turns to meter, no sockets to heal, no jobs to reconcile, and no session to
transfer. Porting any of it means inventing the daemon first. Reject on sight.

---

## E. Peer-inspired, but new work — decide separately

- **`--doctor` preflight.** Peer's `0ac09c5` health check is the one *feature* idea worth stealing.
  Adapted for us it is not a broker check but a provider preflight: which API keys are present,
  which local CLIs resolve, whether the git repo/base ref is valid — exit non-zero with actionable
  diagnostics. High value for CI, where the common failure is a misconfigured runner producing an
  opaque error. Not in `plan.json`; propose adding.
- **`--stream`** (`plan.json` T6, partial): keep. It pairs naturally with A2, since the watchdog
  already has the chunks in hand.
- **`--profile <name>`** (`plan.json` T6, partial): **drop.** T6 says the flag "should override
  config loading logic" — but we have **no config-file mechanism at all** (no cosmiconfig, no rc
  file, no `package.json` key; `HELP_TEXT` documents none). The flag would override nothing. If
  profiles are wanted, that is a config-system design task, not a flag.

---

## Revised ticket set and sequencing

`plan.json`'s six tickets become five, reordered around the real dependency: **A4 is a prerequisite
of A2**, which `plan.json` does not model at all.

| New | Replaces | Title | Files |
|---|---|---|---|
| P1 | T1 | Prompt fencing, peer-strength stripping + per-run nonce | `src/review.js`, `prompt-template*.md`, `test/review.test.js` |
| P2 | — *(new)* | `spawn-safe.js`: resolved-path spawn, `shell:false`, `isPidAlive`, `terminateProcessTree` | `src/spawn-safe.js`, `src/llm.js:170-205`, tests |
| P3 | T4 | Watchdog: idle **+ hard ceiling**, bounded buffer, injected timers | `src/exec-watchdog.js`, tests |
| P4 | T3 | Best-effort resume IDs on failure | `src/loop.js`, `bin/cli.js`, `test/loop-summary.test.mjs` |
| P5 | T5, T6, T2 | Integrate watchdog + `--stream` into LLM invocation; ledger perms | `src/llm.js`, `src/utils.js`, `src/findings-ledger.js`, tests |

**Dropped:** T2 as scoped (redundant — see C2; its live remnant A5 folds into P5).
`--profile` from T6 (nothing to override).

### Waves

```
Wave 1 — parallel, disjoint files
  P1  fencing            src/review.js + templates
  P2  spawn-safe         src/spawn-safe.js (new) + llm.js spawn sites
  P4  resume IDs         src/loop.js + bin/cli.js   (fix the test path first)

Wave 2 — depends on P2
  P3  watchdog           src/exec-watchdog.js, built on P2's terminateProcessTree

Wave 3 — depends on P2 + P3
  P5  integration        src/llm.js + --stream + ledger perms
```

P1, P2 and P4 touch disjoint files and are safe to run in parallel worktrees. P3 and P5 must be
sequential — both land in `src/llm.js`, and running them concurrently guarantees a conflict.

### Gate

`plan.json`'s gate is `{"build": "npm run test", "test": "npm test"}` — the same command twice, so
there is no independent build/lint check. Give the gate a real second dimension or drop the
duplicate field.
