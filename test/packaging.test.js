import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Regression: package.json `files` omitted prompt-template-artifact.md while
// buildArtifactPrompt loads it at runtime, so `--input` artifact mode threw
// ENOENT for every npm-installed user. A workspace-only test cannot catch a
// `files` omission — the file is present in the checkout and absent only from
// the tarball — so assert the allowlist covers everything the code reads.
test('published package ships every asset loaded at runtime', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const shipped = new Set(pkg.files);
  for (const asset of ['prompt-template.md', 'prompt-template-artifact.md', 'schema.json']) {
    assert.ok(
      shipped.has(asset),
      `package.json "files" must include ${asset} — it is read at runtime via loadAsset()`
    );
  }
});
