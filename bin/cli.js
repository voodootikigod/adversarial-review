#!/usr/bin/env node

import { parseArgs, log, HELP_TEXT } from "../src/utils.js";
import { collectReviewContext } from "../src/git-context.js";
import { configureLLM } from "../src/llm.js";
import { buildPrompt, runReview, renderReport } from "../src/review.js";

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  if (!["auto", "working-tree", "branch"].includes(args.scope)) {
    log.error(`Invalid --scope "${args.scope}". Use auto, working-tree, or branch.`);
    process.exit(1);
  }

  // 1. Collect git context.
  let context;
  try {
    context = collectReviewContext(process.cwd(), {
      scope: args.scope,
      base: args.base,
      maxFiles: args.maxFiles,
      maxBytes: args.maxBytes
    });
  } catch (err) {
    log.error(err.message);
    process.exit(1);
  }

  if (!context.content.replace(/\(none\)|##.*|```|\s/g, "").length) {
    log.warn("Nothing to review — the target scope appears empty.");
    process.exit(0);
  }

  // 2. Build the prompt.
  const prompt = buildPrompt(context, args.focus);

  if (args.promptOnly) {
    process.stdout.write(prompt + "\n");
    process.exit(0);
  }

  log.info(`Target: ${context.label}`);
  log.step(`${context.fileCount} file(s), ${context.diffBytes} diff bytes, mode: ${context.includeDiff ? "inline-diff" : "summary"}`);

  // 3. Configure the LLM and run the review.
  let config;
  try {
    config = configureLLM(args);
  } catch (err) {
    log.error(err.message);
    process.exit(1);
  }

  let result;
  try {
    result = await runReview(config, prompt);
  } catch (err) {
    log.error(err.message);
    process.exit(1);
  }

  // 4. Emit output.
  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    console.log(renderReport(result, context));
  }

  // Exit code conveys the verdict: 0 approve, 2 needs-attention.
  process.exit(result.verdict === "needs-attention" ? 2 : 0);
}

main().catch((err) => {
  log.errorTrace(err);
  process.exit(1);
});
