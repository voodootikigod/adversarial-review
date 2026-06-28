#!/usr/bin/env node

import { parseArgs, log, HELP_TEXT } from "../src/utils.js";
import { collectReviewContext } from "../src/git-context.js";
import { configureLLM, selectProviders, underSatisfiedNotice } from "../src/llm.js";
import { scanForSecrets } from "../src/secrets.js";
import {
  buildPrompt,
  runReview,
  runMultiProviderReview,
  mergeProviderResults,
  deriveQuorumVerdict,
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

  // R6: warn + proceed when under-satisfied; never silently downgrade the verdict.
  const notice = underSatisfiedNotice(sel);
  if (notice) log.warn(notice);

  const apiWithoutDiff =
    !context.includeDiff && !args.allowSummaryReview && sel.providers.some((p) => p.config.provider !== "cli");
  if (apiWithoutDiff) {
    log.error(
      "The target diff is too large to inline, and API providers cannot inspect the repository themselves.\n" +
        "Use local CLI providers, raise --max-files/--max-bytes, narrow the scope, or pass --allow-summary-review."
    );
    process.exit(1);
  }

  log.info(`Multi-provider review: ${sel.providers.map((p) => `${p.id}[${p.family}]`).join(", ")} (quorum ${args.quorum})`);

  const byId = new Map(sel.providers.map((p) => [p.id, p.config]));
  let perProvider;
  try {
    perProvider = await runMultiProviderReview(sel.providers, prompt, { passes: args.passes });
    if (args.verify) {
      for (const pp of perProvider) {
        if (pp.result.findings.length) {
          log.step(`Verification pass (${pp.provider}): refuting ${pp.result.findings.length} finding(s)...`);
          const verified = await verifyFindings(byId.get(pp.provider), context, pp.result);
          pp.result = verified.result;
        }
      }
    }
  } catch (err) {
    log.error(err.message);
    process.exit(1);
  }

  // Ground each provider's findings, then derive the quorum verdict from the
  // per-provider grounded confidences.
  for (const pp of perProvider) {
    const cfg = byId.get(pp.provider);
    pp.assessments = assessFindings(pp.result, context, { apiMode: cfg.provider !== "cli" });
  }
  const merged = mergeProviderResults(perProvider);
  const derived = deriveQuorumVerdict(perProvider, {
    failOn: args.failOn,
    minConfidence: args.minConfidence,
    quorum: args.quorum
  });
  log.info(
    `Quorum verdict: ${derived.flaggingCount}/${sel.providers.length} provider(s) flagged ` +
      `(quorum ${derived.quorum}) → ${derived.verdict}`
  );

  if (args.json) {
    process.stdout.write(JSON.stringify(merged, null, 2) + "\n");
  } else {
    console.log(renderReport(merged, context, null, derived));
  }
  process.exit(derived.verdict === "needs-attention" ? 2 : 0);
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

  // 1. Collect git context. Collection failures exit 1 — a gate must never
  // approve because it silently failed to gather the change.
  let context;
  try {
    context = collectReviewContext(process.cwd(), {
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

  // 2. Build the prompt.
  const prompt = buildPrompt(context, args.focus);

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

  // 5. Emit output. --json stays schema-pure (the validated model result,
  // untouched); grounding and derivation details go to stderr.
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
