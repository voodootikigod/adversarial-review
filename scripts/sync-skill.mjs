import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function syncSkills(repoRoot = root) {
  // 1. Sync references to both adversarial-review locations
  const refFiles = ['prompt-template.md', 'prompt-template-artifact.md', 'schema.json'];
  const refDests = [
    'skills/adversarial-review/references',
    '.agents/skills/adversarial-review/references',
  ];
  for (const dest of refDests) {
    mkdirSync(join(repoRoot, dest), { recursive: true });
    for (const file of refFiles) {
      copyFileSync(join(repoRoot, file), join(repoRoot, dest, file));
    }
  }

  // 2. Sync skills/adversarial-review/SKILL.md to .agents/skills/adversarial-review/SKILL.md
  mkdirSync(join(repoRoot, '.agents/skills/adversarial-review'), { recursive: true });
  copyFileSync(
    join(repoRoot, 'skills/adversarial-review/SKILL.md'),
    join(repoRoot, '.agents/skills/adversarial-review/SKILL.md')
  );

  // 3. Sync skills/adversarial-review-loop/SKILL.md to .agents/skills/adversarial-review-loop/SKILL.md
  mkdirSync(join(repoRoot, '.agents/skills/adversarial-review-loop'), { recursive: true });
  copyFileSync(
    join(repoRoot, 'skills/adversarial-review-loop/SKILL.md'),
    join(repoRoot, '.agents/skills/adversarial-review-loop/SKILL.md')
  );

  // 4. Generate skills/arl/SKILL.md and .agents/skills/arl/SKILL.md from loop skill
  const loopContent = readFileSync(join(repoRoot, 'skills/adversarial-review-loop/SKILL.md'), 'utf8');

  let replacedName = false;
  const arlWithName = loopContent.replace(/^name:\s*adversarial-review-loop\b/m, () => {
    replacedName = true;
    return 'name: arl';
  });
  if (!replacedName) {
    throw new Error('sync-skill: failed to replace "name: adversarial-review-loop" with "name: arl"');
  }

  let replacedTrigger = false;
  const arlContent = arlWithName.replace(/Triggers on "arl",\s*/m, () => {
    replacedTrigger = true;
    return 'Triggers on "arl",\n  "/arl", ';
  });
  if (!replacedTrigger) {
    throw new Error('sync-skill: failed to insert "/arl" trigger in arl skill description');
  }

  // Safety assertions on generated content
  if (!/^name:\s*arl\b/m.test(arlContent)) {
    throw new Error('sync-skill: generated arl content missing "name: arl"');
  }
  if (!arlContent.includes('"/arl"')) {
    throw new Error('sync-skill: generated arl content missing "/arl" trigger');
  }

  mkdirSync(join(repoRoot, 'skills/arl'), { recursive: true });
  mkdirSync(join(repoRoot, '.agents/skills/arl'), { recursive: true });
  writeFileSync(join(repoRoot, 'skills/arl/SKILL.md'), arlContent, 'utf8');
  writeFileSync(join(repoRoot, '.agents/skills/arl/SKILL.md'), arlContent, 'utf8');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  syncSkills();
}
