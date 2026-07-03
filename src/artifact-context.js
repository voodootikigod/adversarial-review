import fs from "fs";
import path from "path";

// Wrap a body in a titled fenced section, mirroring git-context's `section`.
function section(title, body) {
  return `### ${title}\n\`\`\`\n${(body && body.trimEnd()) || "(empty)"}\n\`\`\`\n`;
}

function isProbablyText(buffer) {
  // A NUL byte in the first 8KB is treated as a binary signal.
  return !buffer.subarray(0, 8192).includes(0);
}

// Read one artifact file the user named explicitly. Unlike git-context's
// untracked-file inlining, the path is user-provided (trusted), so it is not
// restricted to inside the repo. Every "cannot fully review this file" case
// THROWS rather than silently skipping it: a gate must never review a partial or
// empty target and then "approve". There is deliberately NO total byte budget or
// partial-drop path (unlike diff mode, which has a summary fallback) — the
// per-file `cap` is the only bound, and a file over it is an error, not a silent
// skip. `statSync` (NOT lstatSync) follows symlinks so the cap sees the TARGET's
// size, not the (tiny) symlink's.
function readArtifactFile(cwd, relPath, cap) {
  const abs = path.resolve(cwd, relPath);
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new Error(`--input file not found or unreadable: ${relPath}`);
  }
  if (stat.isDirectory()) {
    throw new Error(`--input path is a directory, not a file: ${relPath}`);
  }
  if (stat.size > cap) {
    throw new Error(
      `--input file too large to review inline: ${relPath} (${stat.size} bytes > ${cap} byte cap; raise --max-bytes to review it).`
    );
  }
  let buffer;
  try {
    buffer = fs.readFileSync(abs);
  } catch {
    throw new Error(`--input file not found or unreadable: ${relPath}`);
  }
  if (!isProbablyText(buffer)) {
    throw new Error(`--input file is binary, cannot review as an artifact: ${relPath}`);
  }
  const text = buffer.toString("utf8");
  return { body: section(relPath, text), contentBytes: text.trim().length };
}

// Collect an artifact review context from explicit --input files. The returned
// shape is compatible with collectReviewContext (src/git-context.js) so the rest
// of the pipeline — buildArtifactPrompt, assessFindings, deriveVerdict, render —
// is reused unchanged. `changedFiles` is the input list so the grounding
// file-citation check treats a finding citing an input file as in-scope, and
// `includeDiff` is always true (the artifact IS the inlined content; there is no
// git fallback to "inspect it yourself").
export function collectArtifactContext(cwd, files, { maxBytes = 256 * 1024 } = {}) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("No --input files provided.");
  }

  const bodies = [];
  let contentBytesTotal = 0;
  let totalBytes = 0;
  for (const relPath of files) {
    const { body, contentBytes } = readArtifactFile(cwd, relPath, maxBytes);
    bodies.push(body);
    contentBytesTotal += contentBytes;
    totalBytes += Buffer.byteLength(body);
  }

  // FAIL CLOSED: the user explicitly named these files expecting a review. Every
  // per-file "cannot review" case already threw; the only remaining empty case is
  // files that exist but contain no text. If NONE has reviewable content, a gate
  // must NOT approve having reviewed nothing — surface it as an error (exit 1),
  // never a silent empty-scope "approve". (This is why there is no isEmpty=true
  // path for artifacts: an empty artifact target is an error, not a clean review.)
  if (contentBytesTotal === 0) {
    throw new Error(
      `No reviewable content in --input file(s): ${files.join(", ")} — every file was empty.`
    );
  }

  const label =
    files.length === 1 ? `artifact ${files[0]}` : `${files.length} artifact file(s): ${files.join(", ")}`;

  return {
    mode: "artifact",
    label,
    fileCount: files.length,
    diffBytes: totalBytes,
    includeDiff: true,
    isEmpty: false,
    changedFiles: [...files],
    content: bodies.join("\n"),
    collectionGuidance:
      "The artifact below is the complete review target. Judge it only from its own text; do not assume unstated requirements are handled elsewhere."
  };
}
