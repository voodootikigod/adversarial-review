import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

const MAX_UNTRACKED_BYTES = 256 * 1024;

function git(cwd, gitArgs, { allowFail = false } = {}) {
  try {
    return execFileSync("git", gitArgs, {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch (err) {
    if (allowFail) return "";
    throw new Error(`git ${gitArgs.join(" ")} failed: ${err.message}`);
  }
}

function resolveCommit(cwd, ref, label = "ref") {
  if (typeof ref !== "string" || !ref.trim()) {
    throw new Error(`Missing git ${label}.`);
  }
  if (/[\0\r\n]/.test(ref)) {
    throw new Error(`Invalid git ${label}: contains control characters.`);
  }
  const commit = git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { allowFail: true }).trim();
  if (!commit) {
    throw new Error(`Invalid git ${label}: ${ref}`);
  }
  return commit;
}

function isInsideDir(parent, child) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function section(title, body) {
  return `## ${title}\n\n\`\`\`\n${(body && body.trim()) || "(none)"}\n\`\`\`\n`;
}

function isProbablyText(buffer) {
  // Treat a NUL byte in the first 8KB as a binary signal.
  const slice = buffer.subarray(0, 8192);
  return !slice.includes(0);
}

function formatUntrackedFile(cwd, relPath) {
  const abs = path.resolve(cwd, relPath);
  if (!isInsideDir(cwd, abs)) {
    return `### ${relPath}\n(skipped: path outside repository)`;
  }
  let stat;
  try {
    stat = fs.lstatSync(abs);
  } catch {
    return `### ${relPath}\n(skipped: broken symlink or unreadable file)`;
  }
  if (stat.isSymbolicLink()) return `### ${relPath}\n(skipped: symlink)`;
  if (stat.isDirectory()) return `### ${relPath}\n(skipped: directory)`;
  if (stat.size > MAX_UNTRACKED_BYTES) {
    return `### ${relPath}\n(skipped: ${stat.size} bytes exceeds ${MAX_UNTRACKED_BYTES} byte limit)`;
  }
  let buffer;
  try {
    buffer = fs.readFileSync(abs);
  } catch {
    return `### ${relPath}\n(skipped: broken symlink or unreadable file)`;
  }
  if (!isProbablyText(buffer)) return `### ${relPath}\n(skipped: binary file)`;
  return `### ${relPath}\n\`\`\`\n${buffer.toString("utf8").trimEnd()}\n\`\`\``;
}

function listUntracked(cwd) {
  return git(cwd, ["ls-files", "--others", "--exclude-standard"], { allowFail: true })
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function collectWorkingTree(cwd, { maxFiles, maxBytes }) {
  const status = git(cwd, ["status", "--short", "--untracked-files=all"], { allowFail: true }).trim();
  const stagedDiff = git(cwd, ["diff", "--cached", "--no-ext-diff", "--submodule=diff"], { allowFail: true });
  const unstagedDiff = git(cwd, ["diff", "--no-ext-diff", "--submodule=diff"], { allowFail: true });
  const untracked = listUntracked(cwd);
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], { allowFail: true }).trim() || "(detached)";

  const fileCount = status.split("\n").filter(Boolean).length;
  const diffBytes = Buffer.byteLength(stagedDiff) + Buffer.byteLength(unstagedDiff);
  const includeDiff = fileCount <= maxFiles && diffBytes <= maxBytes;

  let content;
  if (includeDiff) {
    const untrackedBody = untracked.map((f) => formatUntrackedFile(cwd, f)).join("\n\n");
    content = [
      section("Git Status", status),
      section("Staged Diff", stagedDiff),
      section("Unstaged Diff", unstagedDiff),
      section("Untracked Files", untrackedBody)
    ].join("\n");
  } else {
    content = [
      section("Git Status", status),
      section("Staged Diff Stat", git(cwd, ["diff", "--shortstat", "--cached"], { allowFail: true }).trim()),
      section("Unstaged Diff Stat", git(cwd, ["diff", "--shortstat"], { allowFail: true }).trim()),
      section("Changed Files", status.split("\n").map((l) => l.slice(3)).filter(Boolean).join("\n"))
    ].join("\n");
  }

  return {
    mode: "working-tree",
    label: `working tree on branch ${branch}`,
    fileCount,
    diffBytes,
    includeDiff,
    content
  };
}

function collectBranch(cwd, baseRef, { maxFiles, maxBytes }) {
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], { allowFail: true }).trim() || "(detached)";
  const baseCommit = resolveCommit(cwd, baseRef, "base ref");
  const mergeBase = git(cwd, ["merge-base", baseCommit, "HEAD"]).trim();
  const range = `${mergeBase}...HEAD`;
  const changed = git(cwd, ["diff", "--name-only", range], { allowFail: true }).split("\n").filter(Boolean);
  const logOut = git(cwd, ["log", "--oneline", "--decorate", range], { allowFail: true }).trim();
  const stat = git(cwd, ["diff", "--stat", range], { allowFail: true }).trim();
  const fullDiff = git(cwd, ["diff", "--no-ext-diff", "--submodule=diff", range], { allowFail: true });

  const fileCount = changed.length;
  const diffBytes = Buffer.byteLength(fullDiff);
  const includeDiff = fileCount <= maxFiles && diffBytes <= maxBytes;

  const content = includeDiff
    ? [section("Commit Log", logOut), section("Diff Stat", stat), section("Branch Diff", fullDiff)].join("\n")
    : [section("Commit Log", logOut), section("Diff Stat", stat), section("Changed Files", changed.join("\n"))].join("\n");

  return {
    mode: "branch",
    label: `branch ${branch} vs ${baseRef} (merge-base ${mergeBase})`,
    fileCount,
    diffBytes,
    includeDiff,
    content
  };
}

// Collect the review context, mirroring the original collectReviewContext thresholds.
export function collectReviewContext(cwd, { scope = "auto", base = null, maxFiles = 50, maxBytes = 256 * 1024 } = {}) {
  let repoRoot;
  try {
    repoRoot = git(cwd, ["rev-parse", "--show-toplevel"]).trim();
  } catch {
    throw new Error("Not inside a git repository.");
  }

  const useBranch = scope === "branch" || (scope === "auto" && base);
  let resolvedBase = base;
  if (useBranch && !resolvedBase) {
    resolvedBase =
      git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD@{upstream}"], { allowFail: true }).trim() || "main";
  }

  const details = useBranch
    ? collectBranch(repoRoot, resolvedBase, { maxFiles, maxBytes })
    : collectWorkingTree(repoRoot, { maxFiles, maxBytes });

  const collectionGuidance = details.includeDiff
    ? "Use the repository context below as primary evidence."
    : "The repository context below is a lightweight summary. Inspect the target diff yourself with read-only git commands before finalizing findings.";

  return { repoRoot, collectionGuidance, ...details };
}
