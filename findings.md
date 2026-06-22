# Adversarial Review Findings — `--loop` Implementation

## Finding 1 — HIGH [data-loss] · `src/loop.js:58`

**`git stash push --include-untracked` removes untracked files; `git stash apply` may not restore them**

`createStashCheckpoint` runs:
```
git stash push --include-untracked -m <name>   ← deletes untracked files from working tree
git stash apply --index <ref>                  ← restores staged+unstaged; untracked restoration is version-dependent
```

The `--include-untracked` flag saves untracked files to the stash's third parent commit and **deletes them from the working tree**. Whether `git stash apply` restores them depends on git version — older releases (pre-2.23) do not restore the u-commit on `apply`. If the restore fails, the fixer runs against a working tree missing the user's untracked files, and the next review also misses them.

The fix is simple and eliminates the problem entirely: **remove `--include-untracked`**. Without it, untracked files are never touched by the stash push and remain in the working tree throughout the loop. The stash still captures staged + unstaged changes, which is all that's needed for checkpoint/restore.

**Fix:** Change line 58 from:
```js
gitRun(cwd, ["stash", "push", "--include-untracked", "-m", stashName]);
```
to:
```js
gitRun(cwd, ["stash", "push", "-m", stashName]);
```

---

## Finding 2 — MEDIUM [security] · `src/loop.js:437`

**`--loop-unsafe-allow-fix-secrets` cross-provider check skips auto-detected known fixers**

The provider-match guard gates on `args.loopFixer` (non-null only when `--loop-fixer` was explicitly passed):

```js
if (args.loopUnsafeAllowFixSecrets && args.loopFixer) {   // ← args.loopFixer is null for auto-detected
  const fixerProvider = FIXER_PROVIDER_MAP[args.loopFixer];
```

When the fixer is auto-detected (e.g., `codex` wins the probe), `args.loopFixer` is `null`, so the entire block is skipped. A user with `ANTHROPIC_API_KEY` (reviewer → Anthropic) and auto-detected `codex` (fixer → OpenAI) who passes `--loop-unsafe-allow-fix-secrets` gets no warning and no cross-provider error — secrets from the review findings are sent to OpenAI's fixer without disclosure.

**Fix:** Replace `args.loopFixer` with `fixerCmd` in the condition and the map lookup:
```js
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
```

---

## Finding 3 — LOW [observability] · `src/loop.js:379-387`

**`diffedFiles` reports false positives when a file's status code changes without content change**

`git status --porcelain` emits `XY filename` where XY is the two-character status code. `diffedFiles` compares status lines as strings, so a file that was `M  foo.js` (staged) and is now ` M foo.js` (unstaged) after the fixer appears as a "new" modification even though the content didn't change. The "Files modified" log line will list files that were already modified before the fix.

**Fix:** Compare filenames rather than full status lines:
```js
function diffedFiles(before, after) {
  if (before === after) return [];
  const parseFiles = s => new Set(
    (s.split("\x00")[1] || "").split("\n").filter(Boolean).map(l => l.slice(3).trim())
  );
  const beforeFiles = parseFiles(before);
  const afterFiles = parseFiles(after);
  return [...afterFiles].filter(f => !beforeFiles.has(f));
}
```
