#!/usr/bin/env node

import { parseArgs, log, HELP_TEXT } from "../src/utils.js";
import { collectReviewContext } from "../src/git-context.js";
import { collectArtifactContext } from "../src/artifact-context.js";
import { configureLLM, selectProviders, underSatisfiedNotice } from "../src/llm.js";
import { scanForSecrets } from "../src/secrets.js";
import { toLedgerEntries, appendLedger } from "../src/findings-ledger.js";
import {
  buildPrompt,
  buildArtifactPrompt,
  runReview,
  runMultiProviderReview,
  resolveReachableProviders,
  mergeProviderResults,
  deriveQuorumVerdict,
  validateResult,
  verifyFindings,
  assessFindings,
  deriveVerdict,
  renderReport
} from "../src/review.js";
import { runLoop } from "../src/loop.js";

// Multi-provider review: fan the same prompt out to each selected provider
// independently, merge with cross-provider corroboration, and derive a
// quorum-aware verdict. Diversity, not count (ADR-0007).
async function runMultiProvider(args, context, prompt) {
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

  // API providers cannot inspect a non-inlinable diff. Rather than aborting the
  // whole diverse review, DROP those providers (loudly) and proceed with the CLI
  // providers — preserving the reviewer diversity that is actually reachable
  // (AC7 warn + proceed). Only abort if nothing usable remains. Shared with the
  // --loop multi-provider path (loop.js) so the guard cannot exist in one and not
  // the other (gh-9 P5#1).
  const { providers } = resolveReachableProviders(sel.providers, context, args);
  if (!providers.length) {
    log.error(
      "No usable providers: the diff is too large to inline and every selected provider is API-only.\n" +
        "Use a local CLI provider, raise --max-files/--max-bytes, narrow the scope, or pass --allow-summary-review."
    );
    process.exit(1);
  }

  log.info(`Multi-provider review: ${providers.map((p) => `${p.id}[${p.family}]`).join(", ")} (quorum ${args.quorum})`);

  const byId = new Map(providers.map((p) => [p.id, p.config]));
  let perProvider, failures;
  try {
    ({ perProvider, failures } = await runMultiProviderReview(providers, prompt, { passes: args.passes }));
  } catch (err) {
    log.error(err.message);
    process.exit(1);
  }
  // Degrade-and-proceed: a single provider's failure must not abort the run.
  for (const f of failures) {
    log.warn(`Provider ${f.provider} failed and was skipped: ${f.error}`);
  }
  if (!perProvider.length) {
    log.error("All selected providers failed to produce a review; cannot derive a verdict.");
    process.exit(1);
  }
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

  // R6 / AC7: emit a loud under-satisfied notice based on the EFFECTIVE provider
  // set (after reachability, API-drop, and runtime failures) vs the requested
  // diversity — so reduced diversity is never hidden, whatever caused it.
  // auto's contract is ">=2 distinct families"; explicit mode wants every
  // requested family. Use the matching denominator so a satisfied auto run (2
  // families) doesn't emit a spurious notice.
  const target = sel.auto ? 2 : sel.requestedCount;
  const effectiveNotice = underSatisfiedNotice({
    underSatisfied: perProvider.length < target,
    reachableCount: perProvider.length,
    requestedCount: target
  });
  if (effectiveNotice) log.warn(effectiveNotice);

  // Ground each provider's findings, then derive the quorum verdict from the
  // per-provider grounded confidences.
  for (const pp of perProvider) {
    const cfg = byId.get(pp.provider);
    pp.assessments = assessFindings(pp.result, context, { apiMode: cfg.provider !== "cli" });
  }
  const merged = mergeProviderResults(perProvider, {
    failOn: args.failOn,
    minConfidence: args.minConfidence
  });
  // Parity with the --passes merge path: never emit a cross-provider result that
  // doesn't satisfy the schema (a CI --json consumer must be able to trust it).
  const mergeErrors = validateResult(merged);
  if (mergeErrors.length) {
    log.error("Merged multi-provider result failed schema validation:\n  - " + mergeErrors.join("\n  - "));
    process.exit(1);
  }
  const derived = deriveQuorumVerdict(perProvider, {
    failOn: args.failOn,
    minConfidence: args.minConfidence,
    quorum: args.quorum
  });
  // The exit code is the quorum verdict; the JSON/report verdict AND summary must
  // match it. A single provider's prose summary can contradict the derived gate
  // (e.g. a provider says "approve"/"Safe to ship" but its findings gate locally),
  // so synthesize an unambiguous quorum-state summary instead of copying one.
  merged.verdict = derived.verdict;
  merged.summary =
    derived.verdict === "needs-attention"
      ? `${derived.flaggingCount} of ${perProvider.length} provider(s) raised gating findings ` +
        `(effective quorum ${derived.effectiveQuorum}). See findings below.`
      : `No provider's findings met the gate across ${perProvider.length} provider(s); approving.`;
  log.info(
    `Quorum verdict: ${derived.flaggingCount}/${perProvider.length} provider(s) flagged ` +
      `(effective quorum ${derived.effectiveQuorum} of requested ${derived.quorum}) → ${derived.verdict}`
  );

  // Surface grounding/hallucination warnings on the merged findings. apiMode is
  // based on providers that ACTUALLY produced results (a selected API provider may
  // have failed), so the strictness matches what really participated.
  const mergedAssessments = assessFindings(merged, context, {
    apiMode: perProvider.some((pp) => byId.get(pp.provider).provider !== "cli")
  });
  // Log grounding warnings to stderr (as the single-provider path does) so they
  // are visible even with --json. The quorum verdict already gated on each
  // provider's OWN assessment, so this merged note is informational — do not
  // claim it changed the gate (that would contradict the per-provider gating).
  mergedAssessments.forEach((a, i) => {
    for (const note of a.notes) {
      log.warn(`Finding "${merged.findings[i].title}": ${note} (grounding note — verify before relying on it).`);
    }
  });

  // Record the MERGED gating findings once (a corroborated finding is one entry),
  // using the merged grounding assessments. Ledger write failure is non-fatal.
  recordFindings(args, merged, mergedAssessments);

  if (args.json) {
    process.stdout.write(JSON.stringify(merged, null, 2) + "\n");
  } else {
    console.log(renderReport(merged, context, mergedAssessments, derived));
  }
  process.exit(derived.verdict === "needs-attention" ? 2 : 0);
}

// Append gating findings to the ADLC findings ledger when --findings-ledger is
// set. Never fatal: the verdict/exit code is the product, the ledger is a side
// effect, so a write error only warns.
function recordFindings(args, result, assessments) {
  if (!args.findingsLedger) return;
  try {
    const entries = toLedgerEntries(result, assessments, {
      failOn: args.failOn,
      minConfidence: args.minConfidence
    });
    appendLedger(args.findingsLedger, entries);
  } catch (err) {
    log.warn(`Could not write findings ledger "${args.findingsLedger}": ${err.message}`);
  }
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  if (args.errors.length) {
    log.error(args.errors.join("\n"));
    process.exit(1);
  }

  if (!["auto", "working-tree", "branch"].includes(args.scope)) {
    log.error(`Invalid --scope "${args.scope}". Use auto, working-tree, or branch.`);
    process.exit(1);
  }

  // Loop mode: hand off entirely to the loop orchestrator.
  if (args.loop) {
    await runLoop(process.cwd(), args);
    return;
  }

  if (args.base && args.scope === "working-tree") {
    log.warn("--base is ignored when --scope working-tree is set; reviewing the working tree.");
  }

  // 1. Collect the review context. --input reviews artifact files (specs,
  // tickets, rail-sets); otherwise collect the git diff/branch. Collection
  // failures exit 1 — a gate must never approve because it silently failed to
  // gather the target.
  let context;
  try {
    context = args.input
      ? collectArtifactContext(process.cwd(), args.input, { maxBytes: args.maxBytes })
      : collectReviewContext(process.cwd(), {
          scope: args.scope,
          base: args.base,
          maxFiles: args.maxFiles,
          maxBytes: args.maxBytes,
          contextLines: args.contextLines,
          includeFiles: args.includeFiles
        });
  } catch (err) {
    log.error(err.message);
    process.exit(1);
  }

  // 2. Build the prompt — artifact charter for --input, diff charter otherwise.
  const prompt = args.input
    ? buildArtifactPrompt(context, args.focus)
    : buildPrompt(context, args.focus);

  if (context.isEmpty) {
    // --prompt-only prints the template even on an empty scope so callers can
    // verify the template is well-formed without needing staged changes.
    if (args.promptOnly) {
      process.stdout.write(prompt + "\n");
      process.exit(0);
    }
    if (args.failOnEmpty) {
      log.error("Nothing to review — the target scope is empty (--fail-on-empty set).");
      process.exit(1);
    }
    log.warn("Nothing to review — the target scope appears empty.");
    log.warn("In CI, pass --fail-on-empty so a misconfigured base ref cannot silently pass the gate.");
    process.exit(0);
  }

  // Secret scan: the payload leaves the machine for a third-party provider.
  const secretHits = scanForSecrets(context.content);
  if (secretHits.length) {
    for (const hit of secretHits) {
      log.warn(`Possible secret in review payload: ${hit.pattern} (${hit.sample})`);
    }
    if (!args.promptOnly && !args.allowSecrets) {
      log.error(
        "Refusing to send the review payload to an external model provider because it appears to contain secrets.\n" +
          "Remove the secrets from the change (and rotate them if they were ever committed),\n" +
          "or pass --allow-secrets to send anyway."
      );
      process.exit(1);
    }
  }

  if (args.promptOnly) {
    process.stdout.write(prompt + "\n");
    process.exit(0);
  }

  log.info(`Target: ${context.label}`);
  log.step(`${context.fileCount} file(s), ${context.diffBytes} diff bytes, mode: ${context.includeDiff ? "inline-diff" : "summary"}`);

  // Multi-provider mode (--providers): independent fan-out + merge + quorum.
  if (args.providers) {
    await runMultiProvider(args, context, prompt);
    return;
  }

  // 3. Configure the LLM and run the review.
  let config;
  try {
    config = configureLLM(args);
  } catch (err) {
    log.error(err.message);
    process.exit(1);
  }

  if (!context.includeDiff && config.provider !== "cli" && !args.allowSummaryReview) {
    log.error(
      "The target diff is too large to inline, and API providers cannot inspect the repository themselves.\n" +
        "Use a local CLI provider, raise --max-files/--max-bytes, narrow the review scope, or pass --allow-summary-review to explicitly accept a summary-only API review."
    );
    process.exit(1);
  }

  let result;
  try {
    result = await runReview(config, prompt, { passes: args.passes });

    if (args.verify && result.findings.length) {
      log.step(`Verification pass: trying to refute ${result.findings.length} finding(s)...`);
      const verified = await verifyFindings(config, context, result);
      result = verified.result;
      if (verified.dropped) {
        log.info(`Verification dropped ${verified.dropped} finding(s) that could not be defended.`);
      }
    }
  } catch (err) {
    log.error(err.message);
    process.exit(1);
  }

  // 4. Ground findings against what we know for certain, then derive the
  // verdict deterministically from the surviving findings.
  const assessments = assessFindings(result, context, { apiMode: config.provider !== "cli" });
  assessments.forEach((a, i) => {
    for (const note of a.notes) {
      log.warn(`Finding "${result.findings[i].title}": ${note} — confidence halved for gating.`);
    }
  });
  const derived = deriveVerdict(result, assessments, {
    failOn: args.failOn,
    minConfidence: args.minConfidence
  });
  if (derived.verdict !== result.verdict) {
    log.warn(`Model verdict was "${result.verdict}"; the gate derived "${derived.verdict}" from the findings (--fail-on ${args.failOn}, --min-confidence ${args.minConfidence}).`);
  }

  recordFindings(args, result, assessments);

  // 5. Emit output. Align JSON verdict with the derived gate (same as multi-provider
  // mode) so CI consumers that parse review.json.verdict cannot disagree with exit code.
  // Model disagreement remains on stderr via the warn above.
  result.verdict = derived.verdict;
  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    console.log(renderReport(result, context, assessments, derived));
  }

  // Exit code conveys the derived verdict: 0 approve, 2 needs-attention.
  process.exit(derived.verdict === "needs-attention" ? 2 : 0);
}

main().catch((err) => {
  log.errorTrace(err);
  process.exit(1);
});
