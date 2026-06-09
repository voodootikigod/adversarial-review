import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Drift guard: the skill bundles copies of the review prompt + schema so the skills.sh
// skill is self-contained (Tier 3 — no shell/npm). These copies must stay byte-for-byte
// identical to the repo-root originals, or an installed skill reviews with a stale prompt.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const bundledAssets = [
  ['prompt-template.md', 'skills/adversarial-review/references/prompt-template.md'],
  ['schema.json', 'skills/adversarial-review/references/schema.json'],
];

for (const [original, bundled] of bundledAssets) {
  test(`bundled skill asset matches root: ${original}`, () => {
    const a = readFileSync(join(root, original), 'utf8');
    const b = readFileSync(join(root, bundled), 'utf8');
    assert.equal(
      b,
      a,
      `${bundled} has drifted from ${original}. Re-copy: cp ${original} ${bundled}`,
    );
  });
}
