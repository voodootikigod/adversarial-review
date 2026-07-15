import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Drift guard: skill bundles must stay byte-for-byte identical to repo-root originals.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const assets = [
  'prompt-template.md',
  'prompt-template-artifact.md',
  'schema.json',
];

const skillDirs = [
  'skills/adversarial-review/references',
  '.agents/skills/adversarial-review/references',
];

for (const dir of skillDirs) {
  for (const name of assets) {
    test(`bundled skill asset matches root: ${dir}/${name}`, () => {
      const original = join(root, name);
      const bundled = join(root, dir, name);
      assert.ok(existsSync(bundled), `${bundled} is missing — run npm run sync-skill`);
      const a = readFileSync(original, 'utf8');
      const b = readFileSync(bundled, 'utf8');
      assert.equal(
        b,
        a,
        `${bundled} has drifted from ${name}. Re-copy: npm run sync-skill`,
      );
    });
  }
}
