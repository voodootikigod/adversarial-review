import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// 1. Sync references to both adversarial-review locations
const refFiles = ['prompt-template.md', 'prompt-template-artifact.md', 'schema.json'];
const refDests = [
  'skills/adversarial-review/references',
  '.agents/skills/adversarial-review/references',
];
for (const dest of refDests) {
  mkdirSync(join(root, dest), { recursive: true });
  for (const file of refFiles) {
    copyFileSync(join(root, file), join(root, dest, file));
  }
}

// 2. Sync skills/adversarial-review/SKILL.md to .agents/skills/adversarial-review/SKILL.md
mkdirSync(join(root, '.agents/skills/adversarial-review'), { recursive: true });
copyFileSync(
  join(root, 'skills/adversarial-review/SKILL.md'),
  join(root, '.agents/skills/adversarial-review/SKILL.md')
);

// 3. Sync skills/adversarial-review-loop/SKILL.md to .agents/skills/adversarial-review-loop/SKILL.md
mkdirSync(join(root, '.agents/skills/adversarial-review-loop'), { recursive: true });
copyFileSync(
  join(root, 'skills/adversarial-review-loop/SKILL.md'),
  join(root, '.agents/skills/adversarial-review-loop/SKILL.md')
);

// 4. Generate skills/arl/SKILL.md and .agents/skills/arl/SKILL.md from loop skill
const loopContent = readFileSync(join(root, 'skills/adversarial-review-loop/SKILL.md'), 'utf8');
const arlContent = loopContent.replace(
  /^name:\s*adversarial-review-loop\b/m,
  'name: arl'
).replace(
  /Triggers on "arl",\s*/m,
  'Triggers on "arl",\n  "/arl", '
);

mkdirSync(join(root, 'skills/arl'), { recursive: true });
mkdirSync(join(root, '.agents/skills/arl'), { recursive: true });
writeFileSync(join(root, 'skills/arl/SKILL.md'), arlContent, 'utf8');
writeFileSync(join(root, '.agents/skills/arl/SKILL.md'), arlContent, 'utf8');
