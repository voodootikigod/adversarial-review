import { execFileSync, spawn } from "child_process";
import { log, colors } from "./utils.js";
import { scanForSecrets } from "./secrets.js";
import { collectReviewContext } from "./git-context.js";
import {
  buildPrompt,
  runReview,
  runMultiProviderReview,
  resolveReachableProviders,
  mergeProviderResults,
  deriveQuorumVerdict,
  verifyFindings,
  assessFindings,
  deriveVerdict,
  renderReport,
  SEVERITY_RANK
} from "./review.js";
import { configureLLM, isCmdInstalled, selectProviders, underSatisfiedNotice } from "./llm.js";

// ─── Git helpers ──────────────────────────────────────────────────────────────

function gitRun(cwd, args, { allowFail = false } = {}) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 4 * 1024 * 1024
    }).trim();
  } catch (err) {
    if (allowFail) return "";
    const stderr = err.stderr ? String(err.stderr).trim() : "";
    throw new Error(`git ${args.join(" ")} failed: ${err.message}${stderr ? `\n${stderr}` : ""}`);
  }
}

// Snapshot the working tree for no-diff detection (diff + status).
function takeSnapshot(cwd) {
  const diff = gitRun(cwd, ["diff", "HEAD"], { allowFail: true });
  const status = gitRun(cwd, ["status", "--porcelain"], { allowFail: true });
  return diff + "\x00" + status;
}

// Find stash@{N} for a stash whose message contains stashName.
function findStashRef(cwd, stashName) {
  const list = gitRun(cwd, ["stash", "list", "--format=%gd %s"], { allowFail: true });
  for (const line of list.split("\n").filter(Boolean)) {
    const sp = line.indexOf(" ");
    const ref = sp === -1 ? line : line.slice(0, sp);
    const desc = sp === -1 ? "" : line.slice(sp + 1);
    if (desc.includes(stashName)) return ref;
  }
  return null;
}

// Create a stash checkpoint, then re-apply it so the working tree is unchanged.
// Returns the stash ref, or null if there was nothing to stash.
function createStashCheckpoint(cwd, stashName) {
  const status = gitRun(cwd, ["status", "--porcelain"], { allowFail: true });
  if (!status) return null;

  gitRun(cwd, ["stash", "push", "-m", stashName]);
  const ref = findStashRef(cwd, stashName);
  if (!ref) throw new Error(`Stash was created but cannot be found by name: ${stashName}`);

  // Re-apply so the working tree is back to the pre-stash state.
  gitRun(cwd, ["stash", "apply", "--index", ref]);
  return ref;
}

// Drop old checkpoint, create new one with the current state, re-apply.
function updateStashCheckpoint(cwd, oldRef, newStashName) {
  if (oldRef) {
    try { gitRun(cwd, ["stash", "drop", oldRef]); } catch { /* ignore drop failure */ }
  }
  return createStashCheckpoint(cwd, newStashName);
}

function dropStashCheckpoint(cwd, ref) {
  try { gitRun(cwd, ["stash", "drop", ref]); return true; } catch { return false; }
}

// Restore working tree from a stash checkpoint after a fixer error.
// Try stash pop --index first; fall back to per-file checkout on conflict.
function restoreFromStash(cwd, ref) {
  try {
    gitRun(cwd, ["stash", "pop", "--index", ref]);
    log.info("Restored working tree from stash checkpoint.");
    return;
  } catch {
    log.warn("Stash pop conflicted; falling back to per-file restore.");
  }

  const files = gitRun(cwd, ["stash", "show", "--name-only", ref], { allowFail: true })
    .split("\n").filter(Boolean);

  let restored = 0;
  for (const file of files) {
    try {
      gitRun(cwd, ["checkout", ref, "--", file]);
      restored++;
    } catch {
      log.warn(`Could not force-restore ${file}.`);
    }
  }
  dropStashCheckpoint(cwd, ref);
  log.info(`Force-restored ${restored}/${files.length} file(s) from stash checkpoint.`);
}

// ─── NDJSON output ────────────────────────────────────────────────────────────

function emitEvent(jsonMode, event) {
  if (jsonMode) process.stdout.write(JSON.stringify(event) + "\n");
}

// Consolidated terminal record (GitHub #11): one NDJSON line carrying exactly the
// fields a P6 `adlc gate-manifest record adversarial-review --evidence '...'` entry
// wants, so a consumer reads ONE line instead of correlating loop_end +
// review_result. `verdict` is DERIVED from exitReason — a loop that exits without
// reaching a clean review still has surviving gating findings, so only "clean" is
// an approve. `acceptedCount` is always 0: per ADLC toolkit.md, `accepted` =
// "findings acknowledged with documented justification", a human P6 decision the
// automated loop cannot make; it is emitted as 0 to keep the evidence string
// complete/copy-pastable, and the human overrides it when recording.
export function buildLoopSummary({ providers, iterations, exitReason, survivingCount }) {
  return {
    type: "loop_summary",
    providers,
    iterations,
    verdict: exitReason === "clean" ? "approve" : "needs-attention",
    exitReason,
    survivingCount,
    acceptedCount: 0
  };
}

// ─── Recovery command ─────────────────────────────────────────────────────────

function buildRecoveryCmd(stashName) {
  return (
    `# Restore checkpoint:\n` +
    `REF=$(git stash list --format='%gd %s' | grep '${stashName}' | awk '{print $1}'); ` +
    `git stash pop --index "$REF"`
  );
}

// ─── Fixer detection ─────────────────────────────────────────────────────────

function probeFixer(cmd) {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    try {
      execFileSync(cmd, ["-h"], { stdio: "ignore", timeout: 5000 });
      return true;
    } catch {
      return isCmdInstalled(cmd);
    }
  }
}

export function detectFixer(args) {
  if (args.loopFixer) {
    if (!isCmdInstalled(args.loopFixer)) {
      throw new Error(`--loop-fixer "${args.loopFixer}" not found in PATH.`);
    }
    return args.loopFixer;
  }
  for (const cmd of ["codex", "claude", "agy"]) {
    if (isCmdInstalled(cmd) && probeFixer(cmd)) return cmd;
  }
  throw new Error(
    "No fixer CLI found (tried codex, claude, agy).\n" +
    "Install one or specify --loop-fixer <cmd>."
  );
}

// Map known fixer CLIs to their provider family for the same-provider check.
// agy runs Gemini models, so it is the "gemini" family even though its CLI
// interface mirrors claude. The legacy `gemini` binary is deprecated and dropped.
export const FIXER_PROVIDER_MAP = { codex: "openai", claude: "anthropic", agy: "gemini" };

// ─── OS write constraint ──────────────────────────────────────────────────────

function probeLinuxConstraint() {
  try {
    execFileSync("unshare", ["--mount", "--user", "--map-root-user", "true"], {
      stdio: "ignore", timeout: 3000
    });
    return "unshare-user";
  } catch {}
  try {
    execFileSync("unshare", ["--mount", "true"], { stdio: "ignore", timeout: 3000 });
    return "unshare";
  } catch {}
  return null;
}

function probeOsConstraint(args) {
  const { platform } = process;
  if (platform === "win32") throw new Error("--loop is not supported on Windows.");

  if (platform === "darwin") {
    if (!args.loopUnsafe) {
      throw new Error(
        "--loop on macOS has no enforced write sandbox (sandbox-exec was removed in macOS 14+).\n" +
        "Pass --loop-unsafe to proceed, acknowledging the fixer has unrestricted write access."
      );
    }
    log.warn("macOS: running without write sandboxing (--loop-unsafe). Fixer has unrestricted write access.");
    return { mode: "advisory" };
  }

  // Linux
  const linuxMode = probeLinuxConstraint();
  if (!linuxMode) {
    if (!args.loopUnsafe) {
      throw new Error(
        "--loop on Linux requires write sandboxing (landlock or unshare --mount), but neither is available.\n" +
        "Pass --loop-unsafe to proceed without sandboxing."
      );
    }
    log.warn("Linux: running without write sandboxing (--loop-unsafe). Fixer has unrestricted write access.");
    return { mode: "none" };
  }
  return { mode: linuxMode };
}

// ─── Gating finding helpers ───────────────────────────────────────────────────

function getGatingFindings(result, assessments, args) {
  const threshold = SEVERITY_RANK[args.failOn || "medium"];
  const minConf = args.minConfidence ?? 0.5;
  return result.findings.filter((f, i) => {
    const conf = assessments?.[i]?.effectiveConfidence ?? f.confidence;
    return SEVERITY_RANK[f.severity] >= threshold && conf >= minConf;
  });
}

// Two findings match if they share file+category+title and lines are within 5 of each other
// (or both are file-level with line_start === 0).
function findingsMatch(a, b) {
  if (a.file !== b.file || a.category !== b.category || a.title !== b.title) return false;
  if (a.line_start === 0 || b.line_start === 0) return a.line_start === b.line_start;
  return Math.abs(a.line_start - b.line_start) <= 5;
}

function gatingSetsEqual(a, b) {
  if (a.length !== b.length) return false;
  return a.every(fa => b.some(fb => findingsMatch(fa, fb)));
}

// ─── Fix prompt construction ──────────────────────────────────────────────────

function redactSecretsInFindings(findings) {
  return findings.map(f => {
    const out = { ...f };
    for (const field of ["title", "body", "evidence", "recommendation"]) {
      if (out[field]) {
        const hits = scanForSecrets(out[field]);
        if (hits.length) {
          out[field] = `[REDACTED: contains likely secret (${hits[0].pattern})]`;
        }
      }
    }
    return out;
  });
}

function getFixFiles(cwd, findings, args) {
  if (args.loopFixerScope === "unrestricted") {
    const cap = args.loopFixerFileCap || 100;
    const allFiles = gitRun(cwd, ["ls-files"], { allowFail: true }).split("\n").filter(Boolean);
    if (allFiles.length > cap) {
      log.warn(
        `Repo has ${allFiles.length} tracked files, exceeding --loop-fixer-file-cap ${cap}.\n` +
        `  Listing finding-cited files first, then filling to ${cap} alphabetically.`
      );
      const cited = new Set(findings.map(f => f.file).filter(Boolean));
      const rest = allFiles.filter(f => !cited.has(f));
      return [...cited, ...rest].slice(0, cap);
    }
    return allFiles;
  }

  // sc2: finding-cited files only
  const files = [...new Set(findings.map(f => f.file).filter(Boolean))];
  if (files.length === 0) {
    log.warn(
      "All gating findings cite no specific file. Fix prompt will list no files.\n" +
      "  Consider --loop-fixer-scope unrestricted."
    );
  }
  return files;
}

function buildFixPrompt(findings, files) {
  const lines = [
    "You are a code fixer. Resolve all adversarial review findings listed below by editing the repository files.",
    ""
  ];

  findings.forEach((f, i) => {
    lines.push(`## Finding ${i + 1}: ${f.title}`);
    lines.push(`Severity: ${f.severity} | Category: ${f.category}`);
    if (f.file) {
      const loc = f.line_start ? `${f.file}:${f.line_start}-${f.line_end}` : f.file;
      lines.push(`Location: ${loc}`);
    }
    if (f.body) lines.push(`Issue: ${f.body}`);
    if (f.recommendation) lines.push(`Fix: ${f.recommendation}`);
    lines.push("");
  });

  if (files.length) {
    lines.push("## Files to Edit", "");
    for (const f of files) lines.push(`- ${f}`);
    lines.push("");
  }

  lines.push("Only edit the files listed above.");
  return lines.join("\n");
}

// ─── Fixer spawning ───────────────────────────────────────────────────────────

// Build the command + args for the write-capable fixer invocation.
export function buildFixerCmd(fixerCmd, constraint) {
  let cmd, args;

  if (fixerCmd === "codex") {
    cmd = "codex";
    args = ["exec", "--ephemeral", "--ignore-rules", "-"];
  } else if (fixerCmd === "claude" || fixerCmd === "agy") {
    // agy is Claude-Code-compatible: same write-capable print-mode invocation.
    cmd = fixerCmd;
    args = ["--dangerously-skip-permissions", "-p", "-"];
  } else {
    // unknown custom CLI: try piping via stdin
    cmd = fixerCmd;
    args = ["-"];
  }

  // Wrap with unshare if available
  if (constraint.mode === "unshare-user") {
    return { cmd: "unshare", args: ["--mount", "--user", "--map-root-user", cmd, ...args] };
  }
  if (constraint.mode === "unshare") {
    return { cmd: "unshare", args: ["--mount", cmd, ...args] };
  }

  return { cmd, args };
}

// Spawn the fixer and return { promise, child }.
// Promise resolves to { success, timedOut, error, code, stderr }.
function spawnFixer(fixerCmd, prompt, cwd, constraint, timeoutMs) {
  const { cmd, args } = buildFixerCmd(fixerCmd, constraint);

  const child = spawn(cmd, args, {
    cwd,
    stdio: ["pipe", "ignore", "pipe"],
    detached: true // own process group for SIGKILL
  });

  const stderrChunks = [];
  child.stderr?.on("data", chunk => stderrChunks.push(chunk));

  try {
    child.stdin.write(prompt, "utf8");
    child.stdin.end();
  } catch { /* fixer may not read stdin; that's OK */ }

  const promise = new Promise(resolve => {
    let done = false;

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
      const stderr = Buffer.concat(stderrChunks).toString("utf8").slice(0, 2048);
      resolve({ timedOut: true, stderr });
    }, timeoutMs);

    child.on("close", code => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const stderr = Buffer.concat(stderrChunks).toString("utf8").slice(0, 2048);
      resolve(code === 0 ? { success: true, stderr } : { error: true, code, stderr });
    });

    child.on("error", err => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ error: true, code: -1, stderr: err.message });
    });
  });

  return { promise, child };
}

// ─── Detect which files changed between two snapshots ─────────────────────────

function diffedFiles(before, after) {
  if (before === after) return [];
  const afterStatus = (after.split("\x00")[1] || "").split("\n").filter(Boolean);
  const beforeStatus = new Set((before.split("\x00")[1] || "").split("\n").filter(Boolean));
  return afterStatus
    .filter(l => !beforeStatus.has(l))
    .map(l => l.slice(3).trim())
    .filter(Boolean);
}

// ─── Multi-provider review round (--loop --providers) ──────────────────────────

// Run one review round across every reachable provider, then merge and derive a
// quorum-aware verdict — the loop-mode counterpart of bin/cli.js's runMultiProvider.
// Reuses the same review.js primitives (runMultiProviderReview, mergeProviderResults,
// deriveQuorumVerdict) so the loop and non-loop gates share one quorum semantics.
// Returns { result, assessments, derived, perProvider }. Throws when no provider
// produced a review, so the caller aborts rather than approving on silence.
export async function runProviderRound(providers, context, prompt, args, reviewFn = runReview) {
  const { perProvider, failures } = await runMultiProviderReview(
    providers, prompt, { passes: args.passes }, reviewFn
  );
  for (const f of failures) {
    log.warn(`Provider ${f.provider} failed and was skipped: ${f.error}`);
  }
  if (!perProvider.length) {
    throw new Error("All selected providers failed to produce a review; cannot derive a verdict.");
  }

  const byId = new Map(providers.map((p) => [p.id, p.config]));

  if (args.verify) {
    for (const pp of perProvider) {
      if (pp.result.findings.length) {
        log.step(`Verification pass (${pp.provider}): refuting ${pp.result.findings.length} finding(s)...`);
        try {
          const verified = await verifyFindings(byId.get(pp.provider), context, pp.result);
          pp.result = verified.result;
        } catch (err) {
          log.warn(`Verification for ${pp.provider} failed; keeping unverified findings: ${err.message}`);
        }
      }
    }
  }

  for (const pp of perProvider) {
    const cfg = byId.get(pp.provider);
    pp.assessments = assessFindings(pp.result, context, { apiMode: cfg.provider !== "cli" });
  }

  const merged = mergeProviderResults(perProvider, {
    failOn: args.failOn,
    minConfidence: args.minConfidence
  });
  const mergedAssessments = assessFindings(merged, context, {
    apiMode: perProvider.some((pp) => byId.get(pp.provider).provider !== "cli")
  });
  const derived = deriveQuorumVerdict(perProvider, {
    failOn: args.failOn,
    minConfidence: args.minConfidence,
    quorum: args.quorum
  });
  // The exit gate is the quorum verdict; keep the merged report's verdict/summary
  // in lockstep so a single provider's prose can never contradict the derived gate.
  merged.verdict = derived.verdict;
  merged.summary =
    derived.verdict === "needs-attention"
      ? `${derived.flaggingCount} of ${perProvider.length} provider(s) raised gating findings ` +
        `(effective quorum ${derived.effectiveQuorum}). See findings below.`
      : `No provider's findings met the gate across ${perProvider.length} provider(s); approving.`;

  return { result: merged, assessments: mergedAssessments, derived, perProvider };
}

// ─── Main loop ────────────────────────────────────────────────────────────────

export async function runLoop(cwd, args) {
  // Scope block: --loop only supports working-tree
  if (args.scope === "branch") {
    log.error(
      "--loop is incompatible with --scope branch.\n" +
      "The fixer writes to the working tree but branch scope reviews committed content.\n" +
      "Use --scope working-tree (or omit --scope) instead."
    );
    process.exit(1);
  }
  if (args.base) {
    log.error(
      "--loop is incompatible with --base <ref>.\n" +
      "Use --scope working-tree to review working tree changes."
    );
    process.exit(1);
  }

  // Detect fixer
  let fixerCmd;
  try {
    fixerCmd = detectFixer(args);
  } catch (err) {
    log.error(err.message);
    process.exit(1);
  }

  // Probe OS write constraint
  let constraint;
  try {
    constraint = probeOsConstraint(args);
  } catch (err) {
    log.error(err.message);
    process.exit(1);
  }

  // Configure reviewer(s). Multi-provider (--providers) resolves a diverse set;
  // single-provider resolves one config. In --providers mode we do NOT also run
  // the single-provider auto-detect (it can fail — e.g. no default provider — even
  // when the requested set is reachable, which would abort a valid multi-provider
  // loop).
  let reviewConfig = null;
  let providerSet = null;
  if (args.providers) {
    let sel;
    try {
      sel = selectProviders(args);
    } catch (err) {
      log.error(err.message);
      process.exit(1);
    }
    if (!sel.providers.length) {
      log.error(
        "None of the requested providers are reachable (no API key and no installed CLI).\n" +
          "Set an API key, install a local CLI agent (claude/codex/agy), or use --provider for single-provider review."
      );
      process.exit(1);
    }
    providerSet = sel;
    // AC3 / "no silent downgrade": if fewer families are reachable than requested,
    // say so loudly and proceed with what is available — never masquerade a reduced
    // set as the full diversity that was asked for.
    const notice = underSatisfiedNotice(sel);
    if (notice) log.warn(notice);
    log.info(
      `Multi-provider loop: ${sel.providers.map((p) => `${p.id}[${p.family}]`).join(", ")} (quorum ${args.quorum})`
    );
  } else {
    try {
      reviewConfig = configureLLM(args);
    } catch (err) {
      log.error(err.message);
      process.exit(1);
    }
  }

  // Provider labels for the consolidated loop_summary (GitHub #11): the multi
  // set's ids, or the single reviewer's concrete identity (cli command name for
  // local agents, provider name for APIs).
  const providerLabels = providerSet
    ? providerSet.providers.map((p) => p.id)
    : [reviewConfig.provider === "cli" ? reviewConfig.cliCmd : reviewConfig.provider];

  // Validate --loop-unsafe-allow-fix-secrets provider match for known fixers.
  if (args.loopUnsafeAllowFixSecrets) {
    if (providerSet) {
      // The fix prompt carries the MERGED findings from every reviewer; bypassing
      // redaction could send one provider's finding text to a fixer from a different
      // provider. Rather than reason about which families overlap, refuse the bypass
      // in multi-provider mode (redaction still runs — the loop is not blocked).
      log.error(
        "--loop-unsafe-allow-fix-secrets is not supported with --providers: merged findings can " +
          "originate from a provider other than the fixer. Drop the flag to run with redaction, " +
          "or use single-provider --loop."
      );
      process.exit(1);
    }
    const fixerProvider = FIXER_PROVIDER_MAP[fixerCmd];
    if (!fixerProvider) {
      log.warn(
        "--loop-unsafe-allow-fix-secrets: cannot verify provider match for custom fixer — " +
        "bypassing fix prompt secret scan at your own risk."
      );
    } else {
      const reviewerProvider = reviewConfig.provider === "cli" ? null : reviewConfig.provider;
      if (reviewerProvider && fixerProvider !== reviewerProvider) {
        log.error(
          `--loop-unsafe-allow-fix-secrets: fixer provider (${fixerProvider}) differs from ` +
          `reviewer provider (${reviewerProvider}). Refusing to bypass secret scan across providers.`
        );
        process.exit(1);
      }
    }
  }

  const loopMax = args.loopMax ?? 3;
  const fixerTimeoutMs = (args.timeout ?? 120) * 2 * 1000;
  const timestamp = Date.now();
  const stashBaseName = `adversarial-review-loop-${timestamp}`;

  // Print loop header
  log.info(
    `Loop: scope=working-tree, fixer=${fixerCmd}, sandbox=${constraint.mode}, ` +
    `max-iterations=${loopMax}`
  );
  log.step(
    `Worst-case budget: ${args.passes * (loopMax + 1)} review call(s), ${loopMax} fix call(s)`
  );

  if (args.json) {
    emitEvent(true, {
      type: "loop_start",
      scope: "working-tree",
      fixerCmd,
      constraintMode: constraint.mode,
      loopMax
    });
  }

  // Loop state
  let stashRef = null;
  let stashName = null;
  let fixCount = 0;
  const priorGatingSets = [];
  let lastResult = null;

  // SIGINT handler: kill fixer, print stash info, exit 1
  let currentFixerChild = null;
  process.on("SIGINT", () => {
    process.stderr.write("\n");
    log.warn("Interrupted.");
    if (currentFixerChild) {
      try { process.kill(-currentFixerChild.pid, "SIGKILL"); } catch {}
      const deadline = Date.now() + 1000;
      while (Date.now() < deadline) {
        try { gitRun(cwd, ["status", "--porcelain"]); break; } catch { /* retry */ }
      }
    }
    if (stashRef) {
      log.warn(`Stash checkpoint: ${stashRef}`);
      log.warn(buildRecoveryCmd(stashName));
    }
    process.exit(1);
  });

  // ─── Loop body ──────────────────────────────────────────────────────────────
  while (true) {
    const reviewLabel = fixCount === 0
      ? "Initial review"
      : `Post-fix review (after ${fixCount} fix${fixCount > 1 ? "es" : ""})`;

    if (!args.json) {
      console.error(`\n${colors.bold(`─── ${reviewLabel} ───`)}`);
    }

    // Collect working-tree context
    let context;
    try {
      context = collectReviewContext(cwd, {
        scope: "working-tree",
        maxFiles: args.maxFiles,
        maxBytes: args.maxBytes,
        contextLines: args.contextLines,
        includeFiles: args.includeFiles
      });
    } catch (err) {
      log.error(`Context collection failed: ${err.message}`);
      if (stashRef) log.warn(buildRecoveryCmd(stashName));
      process.exit(1);
    }

    if (context.isEmpty && fixCount === 0) {
      emitEvent(args.json, { type: "review_result", result: null, iteration: 1 });
      emitEvent(args.json, { type: "loop_end", exitReason: "clean", iterations: 0, stashRef: null });
      emitEvent(args.json, buildLoopSummary({ providers: providerLabels, iterations: 0, exitReason: "clean", survivingCount: 0 }));
      log.success("clean on first review — nothing to review in the working tree.");
      process.exit(0);
    }

    // Secret scan on review payload
    const secretHits = scanForSecrets(context.content);
    if (secretHits.length && !args.allowSecrets) {
      log.error(
        "Review payload appears to contain secrets. Pass --allow-secrets to override."
      );
      if (stashRef) log.warn(buildRecoveryCmd(stashName));
      process.exit(1);
    }

    // Run review: single-provider, or a multi-provider fan-out + quorum when
    // --providers is set. Both paths produce `result` (the report/ledger payload)
    // and `gatings` (the findings the fixer must resolve this round).
    const prompt = buildPrompt(context, args.focus);
    let result, gatings;
    if (providerSet) {
      // API providers cannot inspect a diff too large to inline; each round's
      // context can differ (fixes may shrink or grow the working-tree diff), so
      // this is re-resolved every round exactly like the non-loop --providers
      // path (gh-9 P5#1 — this loop previously skipped the check entirely and
      // fanned out to whichever providers were selected at loop start, regardless
      // of round size).
      const { providers: roundProviders } = resolveReachableProviders(providerSet.providers, context, args);
      if (!roundProviders.length) {
        log.error(
          "No usable providers: the diff is too large to inline and every selected provider is API-only.\n" +
            "Use a local CLI provider, raise --max-files/--max-bytes, narrow the scope, or pass --allow-summary-review."
        );
        if (stashRef) log.warn(buildRecoveryCmd(stashName));
        process.exit(1);
      }
      let round;
      try {
        round = await runProviderRound(roundProviders, context, prompt, args);
      } catch (err) {
        log.error(`Review failed: ${err.message}`);
        if (stashRef) log.warn(buildRecoveryCmd(stashName));
        process.exit(1);
      }
      result = round.result;
      lastResult = result;
      emitEvent(args.json, { type: "review", iteration: fixCount + 1, findingCount: result.findings.length });

      // Grounding notes go to stderr so they surface under --json too.
      round.assessments.forEach((a, i) => {
        for (const note of a.notes) {
          log.warn(`Finding "${result.findings[i].title}": ${note} (grounding note — verify before relying on it).`);
        }
      });
      log.info(
        `Quorum verdict: ${round.derived.flaggingCount}/${round.perProvider.length} provider(s) flagged ` +
          `(effective quorum ${round.derived.effectiveQuorum} of requested ${round.derived.quorum}) → ${round.derived.verdict}`
      );
      if (!args.json) console.log(renderReport(result, context, round.assessments, round.derived));

      // The quorum verdict is the gate. Only when it gates do we hand findings to
      // the fixer; when quorum is not met (approve) the round is clean even if a
      // lone provider flagged — matching non-loop --providers quorum semantics.
      gatings = round.derived.verdict === "needs-attention"
        ? getGatingFindings(result, round.assessments, args)
        : [];
    } else {
      try {
        result = await runReview(reviewConfig, prompt, { passes: args.passes });
      } catch (err) {
        log.error(`Review failed: ${err.message}`);
        if (stashRef) log.warn(buildRecoveryCmd(stashName));
        process.exit(1);
      }

      // Verification pass
      if (args.verify && result.findings.length) {
        log.step(`Verification pass: refuting ${result.findings.length} finding(s)...`);
        try {
          const verified = await verifyFindings(reviewConfig, context, result);
          result = verified.result;
          if (verified.dropped) log.info(`Verification dropped ${verified.dropped} finding(s).`);
        } catch (err) {
          log.warn(`Verification pass failed: ${err.message} — using unverified findings.`);
        }
      }

      lastResult = result;
      emitEvent(args.json, { type: "review", iteration: fixCount + 1, findingCount: result.findings.length });

      const assessments = assessFindings(result, context, { apiMode: reviewConfig.provider !== "cli" });
      assessments.forEach((a, i) => {
        for (const note of a.notes) {
          log.warn(`Finding "${result.findings[i].title}": ${note} — confidence halved for gating.`);
        }
      });

      const derived = deriveVerdict(result, assessments, {
        failOn: args.failOn,
        minConfidence: args.minConfidence
      });

      if (!args.json) console.log(renderReport(result, context, assessments, derived));

      gatings = getGatingFindings(result, assessments, args);
    }

    // ── Condition 1: Clean ──────────────────────────────────────────────────
    if (gatings.length === 0) {
      emitEvent(args.json, { type: "review_result", result, iteration: fixCount + 1 });
      if (stashRef && dropStashCheckpoint(cwd, stashRef)) {
        log.success("Stash checkpoint dropped (clean exit — changes preserved in working tree).");
      } else if (fixCount === 0 && !args.json) {
        log.success("clean on first review — no fix iterations ran.");
      }
      emitEvent(args.json, { type: "loop_end", exitReason: "clean", iterations: fixCount, stashRef: null });
      emitEvent(args.json, buildLoopSummary({ providers: providerLabels, iterations: fixCount, exitReason: "clean", survivingCount: 0 }));
      process.exit(0);
    }

    // ── Condition 2: No-progress ────────────────────────────────────────────
    const matchedIdx = priorGatingSets.findIndex(prior => gatingSetsEqual(gatings, prior));
    if (matchedIdx !== -1) {
      emitEvent(args.json, { type: "review_result", result, iteration: fixCount + 1 });
      log.error(`No progress — gating findings unchanged from iteration ${matchedIdx + 1}.`);
      if (args.loopFixerScope !== "unrestricted") {
        log.info("Tip: --loop-fixer-scope unrestricted gives the fixer access to all repo files.");
      }
      emitEvent(args.json, {
        type: "loop_end",
        exitReason: "no-progress",
        matchedIteration: matchedIdx + 1,
        iterations: fixCount,
        stashRef
      });
      emitEvent(args.json, buildLoopSummary({ providers: providerLabels, iterations: fixCount, exitReason: "no-progress", survivingCount: gatings.length }));
      if (stashRef) log.warn(buildRecoveryCmd(stashName));
      process.exit(2);
    }

    // ── Condition 3: Ceiling (all N fix iterations done, this is the final review) ──
    if (fixCount >= loopMax) {
      emitEvent(args.json, { type: "review_result", result, iteration: fixCount + 1 });
      log.error(`Loop ceiling reached (${loopMax} fix iterations). Unresolved gating findings remain.`);
      emitEvent(args.json, {
        type: "loop_end",
        exitReason: "ceiling",
        iterations: fixCount,
        stashRef
      });
      emitEvent(args.json, buildLoopSummary({ providers: providerLabels, iterations: fixCount, exitReason: "ceiling", survivingCount: gatings.length }));
      if (stashRef) log.warn(buildRecoveryCmd(stashName));
      process.exit(2);
    }

    // ── Prepare fix ──────────────────────────────────────────────────────────

    // Create or update stash checkpoint before each fix
    if (fixCount === 0) {
      stashName = `${stashBaseName}-iter0`;
      try {
        stashRef = createStashCheckpoint(cwd, stashName);
      } catch (err) {
        log.error(`Failed to create stash checkpoint: ${err.message}\nAborting to avoid losing your changes.`);
        process.exit(1);
      }
      if (stashRef) {
        log.step(`Stash checkpoint: ${stashRef}`);
        log.step(buildRecoveryCmd(stashName));
        emitEvent(args.json, { type: "stash_created", stashRef, stashName, recoveryCmd: buildRecoveryCmd(stashName) });
      } else {
        log.warn("Nothing to stash — no checkpoint created (no auto-restore on fixer error).");
      }
    } else if (stashRef) {
      const newStashName = `${stashBaseName}-iter${fixCount}`;
      try {
        const newRef = updateStashCheckpoint(cwd, stashRef, newStashName);
        if (newRef) {
          stashRef = newRef;
          stashName = newStashName;
          log.step(`Stash checkpoint updated: ${stashRef}`);
          log.step(buildRecoveryCmd(stashName));
        }
      } catch (err) {
        // Drop failure: find the highest-N checkpoint by name prefix
        log.warn(`Stash update failed: ${err.message}`);
        const list = gitRun(cwd, ["stash", "list", "--format=%gd %s"], { allowFail: true });
        for (const line of list.split("\n").filter(Boolean).reverse()) {
          const sp = line.indexOf(" ");
          const ref = line.slice(0, sp);
          const desc = line.slice(sp + 1);
          if (desc.includes(stashBaseName)) {
            stashRef = ref;
            stashName = desc;
            log.warn(`Using fallback checkpoint: ${stashRef}`);
            break;
          }
        }
      }
    }

    // Snapshot before fixer
    const snapshotBefore = takeSnapshot(cwd);

    // Build and (optionally) redact the fix prompt
    let fixGatings = gatings;
    if (args.loopUnsafeAllowFixSecrets) {
      // already validated provider match above — no redaction
    } else {
      fixGatings = redactSecretsInFindings(gatings);
    }

    const fixFiles = getFixFiles(cwd, gatings, args);
    const fixPrompt = buildFixPrompt(fixGatings, fixFiles);

    log.step(`Fix ${fixCount + 1}/${loopMax}: running ${fixerCmd}...`);
    if (fixFiles.length) log.substep(`Files targeted: ${fixFiles.join(", ")}`);

    const { promise: fixerPromise, child: fixerChild } = spawnFixer(
      fixerCmd, fixPrompt, cwd, constraint, fixerTimeoutMs
    );
    currentFixerChild = fixerChild;
    const fixerResult = await fixerPromise;
    currentFixerChild = null;

    const snapshotAfter = takeSnapshot(cwd);
    const filesModified = diffedFiles(snapshotBefore, snapshotAfter);

    if (!args.json) {
      log.step(`Files modified: ${filesModified.length ? filesModified.join(", ") : "(none)"}`);
      if (fixerResult.stderr) log.substep(`Fixer stderr: ${fixerResult.stderr.trimEnd()}`);
    }

    emitEvent(args.json, {
      type: "fix",
      iteration: fixCount + 1,
      fixerCmd,
      filesTargeted: fixFiles,
      filesModified,
      stashRef
    });

    // ── Condition 5/6: Fixer error or timeout ───────────────────────────────
    if (fixerResult.error || fixerResult.timedOut) {
      const exitReason = fixerResult.timedOut ? "fixer-timeout" : "fixer-error";
      const hasPartial = snapshotBefore !== snapshotAfter;

      if (hasPartial && stashRef) {
        log.warn("Fixer left partial changes — restoring from stash checkpoint...");
        restoreFromStash(cwd, stashRef);
      } else if (hasPartial) {
        log.warn("Fixer left partial changes but no checkpoint exists — manual cleanup may be needed.");
      }

      if (fixerResult.timedOut) {
        log.error(`Fixer timed out after ${fixerTimeoutMs / 1000}s.`);
      } else {
        log.error(`Fixer exited with code ${fixerResult.code}.`);
      }
      if (fixerResult.stderr) log.error(`Fixer stderr:\n${fixerResult.stderr.trimEnd()}`);

      emitEvent(args.json, { type: "review_result", result: lastResult, iteration: fixCount + 1 });
      emitEvent(args.json, {
        type: "loop_end",
        exitReason,
        iterations: fixCount,
        stashRef: hasPartial ? null : stashRef,
        fixerStderr: fixerResult.stderr
      });
      emitEvent(args.json, buildLoopSummary({ providers: providerLabels, iterations: fixCount, exitReason, survivingCount: gatings.length }));
      process.exit(2);
    }

    // ── Condition 4: No-diff ────────────────────────────────────────────────
    if (snapshotBefore === snapshotAfter) {
      log.warn("Fixer made no changes to the working tree.");
      emitEvent(args.json, { type: "review_result", result: lastResult, iteration: fixCount + 1 });
      emitEvent(args.json, { type: "loop_end", exitReason: "no-diff", iterations: fixCount, stashRef });
      emitEvent(args.json, buildLoopSummary({ providers: providerLabels, iterations: fixCount, exitReason: "no-diff", survivingCount: gatings.length }));
      if (stashRef) log.warn(buildRecoveryCmd(stashName));
      process.exit(2);
    }

    // Advance to next iteration
    fixCount++;
    priorGatingSets.push(gatings);
  }
}
