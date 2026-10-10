import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
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

// AC2: package.json files contains 'skills/adversarial-review-loop/'; npm pack lists SKILL.md
test('package.json files includes skills/adversarial-review-loop/ and packs SKILL.md (AC2)', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const shipped = new Set(pkg.files);
  assert.ok(
    shipped.has('skills/adversarial-review-loop/'),
    'package.json "files" must include skills/adversarial-review-loop/'
  );

  const packOutput = execSync('npm pack --dry-run --json --ignore-scripts', { cwd: root, encoding: 'utf8' });
  const packInfo = JSON.parse(packOutput);
  const packedPaths = new Set(packInfo[0].files.map((f) => f.path));
  assert.ok(
    packedPaths.has('skills/adversarial-review-loop/SKILL.md'),
    'npm pack must include skills/adversarial-review-loop/SKILL.md'
  );
});
