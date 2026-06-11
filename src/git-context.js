import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

const MAX_INLINE_FILE_BYTES = 256 * 1024;

// Run git and fail CLOSED by default: a collection failure must surface as an
// error, never as silently-empty review input (an empty diff reads as "nothing
// to review" and would let a broken gate approve). `allowFail` is reserved for
// genuine probes where a non-zero exit is an expected answer (e.g. "is there
// an upstream?"), never for content collection.
function git(cwd, gitArgs, { allowFail = false } = {}) {
  try {
    return execFileSync("git", gitArgs, {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (err) {
    if (allowFail) return "";
    const stderr = err.stderr ? String(err.stderr).trim() : "";
    throw new Error(`git ${gitArgs.join(" ")} failed: ${err.message}${stderr ? `\n${stderr}` : ""}`);
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

function readFileInline(cwd, relPath) {
  const abs = path.resolve(cwd, relPath);
  if (!isInsideDir(cwd, abs)) {
    return { body: `### ${relPath}\n(skipped: path outside repository)`, bytes: 0 };
  }
  let stat;
  try {
    stat = fs.lstatSync(abs);
  } catch {
    return { body: `### ${relPath}\n(skipped: deleted, broken symlink, or unreadable)`, bytes: 0 };
  }
  if (stat.isSymbolicLink()) return { body: `### ${relPath}\n(skipped: symlink)`, bytes: 0 };
  if (stat.isDirectory()) return { body: `### ${relPath}\n(skipped: directory)`, bytes: 0 };
  if (stat.size > MAX_INLINE_FILE_BYTES) {
    return { body: `### ${relPath}\n(skipped: ${stat.size} bytes exceeds ${MAX_INLINE_FILE_BYTES} byte limit)`, bytes: 0 };
  }
  let buffer;
  try {
    buffer = fs.readFileSync(abs);
  } catch {
    return { body: `### ${relPath}\n(skipped: broken symlink or unreadable file)`, bytes: 0 };
  }
  if (!isProbablyText(buffer)) return { body: `### ${relPath}\n(skipped: binary file)`, bytes: 0 };
  return {
    body: `### ${relPath}\n\`\`\`\n${buffer.toString("utf8").trimEnd()}\n\`\`\``,
    bytes: stat.size
  };
}

function formatUntrackedFile(cwd, relPath) {
  return readFileInline(cwd, relPath).body;
}

function listUntracked(cwd) {
  return git(cwd, ["ls-files", "--others", "--exclude-standard"])
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Parse `git status --short` lines into post-change file paths.
// Rename entries look like "R  old -> new"; we want the new path.
function statusToPaths(status) {
  return status
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const rest = line.slice(3);
      const arrow = rest.indexOf(" -> ");
      return arrow === -1 ? rest : rest.slice(arrow + 4);
    })
    .filter(Boolean);
}

// Inline the full post-change content of changed files under a total byte
// budget. API providers cannot read the repository themselves; a -U<n> diff
// alone starves the reviewer of surrounding code.
function collectFullFiles(cwd, files, budgetBytes) {
  const bodies = [];
  const skipped = [];
  let spent = 0;
  for (const relPath of files) {
    if (spent >= budgetBytes) {
      skipped.push(relPath);
      continue;
    }
    const { body, bytes } = readFileInline(cwd, relPath);
    spent += bytes;
    bodies.push(body);
  }
  if (skipped.length) {
    bodies.push(`### (budget exhausted)\nFull content omitted for: ${skipped.join(", ")}`);
  }
  return bodies.join("\n\n");
}

function collectWorkingTree(cwd, { maxFiles, maxBytes, contextLines, includeFiles }) {
  const status = git(cwd, ["status", "--short", "--untracked-files=all"]).trim();
  const unified = `-U${contextLines}`;
  const stagedDiff = git(cwd, ["diff", "--cached", "--no-ext-diff", "--submodule=diff", unified]);
  const unstagedDiff = git(cwd, ["diff", "--no-ext-diff", "--submodule=diff", unified]);
  const untracked = listUntracked(cwd);
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], { allowFail: true }).trim() || "(detached)";

  const changedFiles = statusToPaths(status);
  const fileCount = changedFiles.length;
  const diffBytes = Buffer.byteLength(stagedDiff) + Buffer.byteLength(unstagedDiff);
  const includeDiff = fileCount <= maxFiles && diffBytes <= maxBytes;
  const isEmpty = fileCount === 0 && diffBytes === 0;

  let content;
  if (includeDiff) {
    const untrackedBody = untracked.map((f) => formatUntrackedFile(cwd, f)).join("\n\n");
    const parts = [
      section("Git Status", status),
      section("Staged Diff", stagedDiff),
      section("Unstaged Diff", unstagedDiff),
      section("Untracked Files", untrackedBody)
    ];
    if (includeFiles) {
      const tracked = changedFiles.filter((f) => !untracked.includes(f));
      parts.push(section("Changed File Contents (post-change)", collectFullFiles(cwd, tracked, maxBytes * 4)));
    }
    content = parts.join("\n");
  } else {
    content = [
      section("Git Status", status),
      section("Staged Diff Stat", git(cwd, ["diff", "--shortstat", "--cached"]).trim()),
      section("Unstaged Diff Stat", git(cwd, ["diff", "--shortstat"]).trim()),
      section("Changed Files", changedFiles.join("\n"))
    ].join("\n");
  }

  return {
    mode: "working-tree",
    label: `working tree on branch ${branch}`,
    fileCount,
    diffBytes,
    includeDiff,
    isEmpty,
    changedFiles,
    content
  };
}

function collectBranch(cwd, baseRef, { maxFiles, maxBytes, contextLines, includeFiles }) {
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], { allowFail: true }).trim() || "(detached)";
  const baseCommit = resolveCommit(cwd, baseRef, "base ref");
  const mergeBase = git(cwd, ["merge-base", baseCommit, "HEAD"]).trim();
  const range = `${mergeBase}...HEAD`;
  const unified = `-U${contextLines}`;
  const changed = git(cwd, ["diff", "--name-only", range]).split("\n").filter(Boolean);
  const logOut = git(cwd, ["log", "--oneline", "--decorate", range]).trim();
  const stat = git(cwd, ["diff", "--stat", range]).trim();
  const fullDiff = git(cwd, ["diff", "--no-ext-diff", "--submodule=diff", unified, range]);

  const fileCount = changed.length;
  const diffBytes = Buffer.byteLength(fullDiff);
  const includeDiff = fileCount <= maxFiles && diffBytes <= maxBytes;
  const isEmpty = fileCount === 0 && diffBytes === 0;

  let content;
  if (includeDiff) {
    const parts = [section("Commit Log", logOut), section("Diff Stat", stat), section("Branch Diff", fullDiff)];
    if (includeFiles) {
      parts.push(section("Changed File Contents (post-change)", collectFullFiles(cwd, changed, maxBytes * 4)));
    }
    content = parts.join("\n");
  } else {
    content = [section("Commit Log", logOut), section("Diff Stat", stat), section("Changed Files", changed.join("\n"))].join("\n");
  }

  return {
    mode: "branch",
    label: `branch ${branch} vs ${baseRef} (merge-base ${mergeBase})`,
    fileCount,
    diffBytes,
    includeDiff,
    isEmpty,
    changedFiles: changed,
    content
  };
}

// Collect the review context, mirroring the original collectReviewContext thresholds.
export function collectReviewContext(
  cwd,
  { scope = "auto", base = null, maxFiles = 50, maxBytes = 256 * 1024, contextLines = 10, includeFiles = false } = {}
) {
  let repoRoot;
  try {
    repoRoot = git(cwd, ["rev-parse", "--show-toplevel"]).trim();
  } catch {
    throw new Error("Not inside a git repository.");
  }

  const useBranch = scope === "branch" || (scope === "auto" && base);
  let resolvedBase = base;
  if (useBranch && !resolvedBase) {
    resolvedBase = git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD@{upstream}"], { allowFail: true }).trim();
    if (!resolvedBase) {
      const remoteHead = git(repoRoot, ["symbolic-ref", "refs/remotes/origin/HEAD"], { allowFail: true }).trim();
      if (remoteHead) {
        resolvedBase = remoteHead.split("/").pop();
      } else {
        const candidates = ["main", "develop", "master"];
        for (const candidate of candidates) {
          const verifyRef = git(repoRoot, ["show-ref", "--verify", `refs/heads/${candidate}`], { allowFail: true }).trim();
          if (verifyRef) {
            resolvedBase = candidate;
            break;
          }
        }
      }
    }
    if (!resolvedBase) {
      resolvedBase = "main";
    }
  }

  const options = { maxFiles, maxBytes, contextLines, includeFiles };
  const details = useBranch
    ? collectBranch(repoRoot, resolvedBase, options)
    : collectWorkingTree(repoRoot, options);

  const collectionGuidance = details.includeDiff
    ? "Use the repository context below as primary evidence."
    : "The repository context below is a lightweight summary. Inspect the target diff yourself with read-only git commands before finalizing findings.";

  return { repoRoot, collectionGuidance, ...details };
}
