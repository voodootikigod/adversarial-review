import { execFileSync, spawn } from "child_process";
import { log, colors } from "./utils.js";
import { scanForSecrets } from "./secrets.js";
import { collectReviewContext } from "./git-context.js";
import {
  buildPrompt,
  runReview,
  verifyFindings,
  assessFindings,
  deriveVerdict,
  renderReport,
  SEVERITY_RANK
} from "./review.js";
import { configureLLM, isCmdInstalled } from "./llm.js";

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

function detectFixer(args) {
  if (args.loopFixer) {
    if (!isCmdInstalled(args.loopFixer)) {
      throw new Error(`--loop-fixer "${args.loopFixer}" not found in PATH.`);
    }
    return args.loopFixer;
  }
  for (const cmd of ["codex", "claude", "gemini"]) {
    if (isCmdInstalled(cmd) && probeFixer(cmd)) return cmd;
  }
  throw new Error(
    "No fixer CLI found (tried codex, claude, gemini).\n" +
    "Install one or specify --loop-fixer <cmd>."
  );
}

// Map known fixer CLIs to their provider family for the same-provider check.
const FIXER_PROVIDER_MAP = { codex: "openai", claude: "anthropic", gemini: "gemini" };

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
function buildFixerCmd(fixerCmd, constraint) {
  let cmd, args;

  if (fixerCmd === "codex") {
    cmd = "codex";
    args = ["exec", "--ephemeral", "--ignore-rules", "-"];
  } else if (fixerCmd === "claude") {
    cmd = "claude";
    args = ["--dangerously-skip-permissions", "-p", "-"];
  } else {
    // gemini or custom: try piping via stdin
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

  // Configure reviewer LLM
  let reviewConfig;
  try {
    reviewConfig = configureLLM(args);
  } catch (err) {
    log.error(err.message);
    process.exit(1);
  }

  // Validate --loop-unsafe-allow-fix-secrets provider match for known fixers
  if (args.loopUnsafeAllowFixSecrets) {
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

    // Run review
    const prompt = buildPrompt(context, args.focus);
    let result;
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

    const gatings = getGatingFindings(result, assessments, args);

    // ── Condition 1: Clean ──────────────────────────────────────────────────
    if (gatings.length === 0) {
      emitEvent(args.json, { type: "review_result", result, iteration: fixCount + 1 });
      if (stashRef && dropStashCheckpoint(cwd, stashRef)) {
        log.success("Stash checkpoint dropped (clean exit — changes preserved in working tree).");
      } else if (fixCount === 0 && !args.json) {
        log.success("clean on first review — no fix iterations ran.");
      }
      emitEvent(args.json, { type: "loop_end", exitReason: "clean", iterations: fixCount, stashRef: null });
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
      process.exit(2);
    }

    // ── Condition 4: No-diff ────────────────────────────────────────────────
    if (snapshotBefore === snapshotAfter) {
      log.warn("Fixer made no changes to the working tree.");
      emitEvent(args.json, { type: "review_result", result: lastResult, iteration: fixCount + 1 });
      emitEvent(args.json, { type: "loop_end", exitReason: "no-diff", iterations: fixCount, stashRef });
      if (stashRef) log.warn(buildRecoveryCmd(stashName));
      process.exit(2);
    }

    // Advance to next iteration
    fixCount++;
    priorGatingSets.push(gatings);
  }
}
