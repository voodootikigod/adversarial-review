import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

// AC1: SKILL.md pair identity for BOTH skills with negative control on a temp copy
const skillPairs = [
  'adversarial-review',
  'adversarial-review-loop',
];

for (const skill of skillPairs) {
  test(`SKILL.md pair is byte-identical: ${skill} (AC1)`, () => {
    const rootCopy = join(root, 'skills', skill, 'SKILL.md');
    const agentsCopy = join(root, '.agents', 'skills', skill, 'SKILL.md');
    assert.ok(existsSync(rootCopy), `${rootCopy} must exist`);
    assert.ok(existsSync(agentsCopy), `${agentsCopy} must exist`);
    const a = readFileSync(rootCopy);
    const b = readFileSync(agentsCopy);
    assert.ok(
      a.equals(b),
      `${agentsCopy} has drifted from ${rootCopy}. Both copies must be byte-identical.`
    );

    // Negative control on a temp copy: single-byte difference must fail identity assertion
    const tmpDir = mkdtempSync(join(tmpdir(), 'skill-test-'));
    try {
      const tempPath = join(tmpDir, 'SKILL.md');
      const mutated = Buffer.from(a);
      mutated[0] ^= 1;
      writeFileSync(tempPath, mutated);
      const readBack = readFileSync(tempPath);
      assert.throws(
        () => {
          assert.ok(a.equals(readBack), 'expected temp copy with 1-byte difference to fail');
        },
        assert.AssertionError,
        'negative control: one-byte difference on temp copy must fail identity assertion'
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
}

function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) throw new Error('No frontmatter found in file');
  const yaml = match[1];
  const result = {};
  let currentKey = null;
  let multiline = null;

  for (const rawLine of yaml.split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, '');
    if (multiline) {
      if (/^\s{2,}/.test(line)) {
        multiline.lines.push(line.trim());
        continue;
      } else {
        result[multiline.key] = multiline.lines.join(' ');
        multiline = null;
      }
    }
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const topKv = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (topKv) {
      currentKey = topKv[1];
      let val = topKv[2].trim();
      if (val === '>-' || val === '|' || val === '>') {
        multiline = { key: currentKey, lines: [] };
      } else if (val === 'true') {
        result[currentKey] = true;
      } else if (val === 'false') {
        result[currentKey] = false;
      } else if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        result[currentKey] = val.slice(1, -1);
      } else if (val === '') {
        result[currentKey] = {};
      } else {
        result[currentKey] = val;
      }
      continue;
    }

    if (currentKey && typeof result[currentKey] === 'object' && /^\s{2,}/.test(line)) {
      const nestedKv = line.trim().match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
      if (nestedKv) {
        let nVal = nestedKv[2].trim();
        if (
          (nVal.startsWith('"') && nVal.endsWith('"')) ||
          (nVal.startsWith("'") && nVal.endsWith("'"))
        ) {
          nVal = nVal.slice(1, -1);
        } else if (nVal === 'true') {
          nVal = true;
        } else if (nVal === 'false') {
          nVal = false;
        }
        result[currentKey][nestedKv[1]] = nVal;
      }
    }
  }
  if (multiline) {
    result[multiline.key] = multiline.lines.join(' ');
  }
  return result;
}

// AC3: Frontmatter parsing and validation for adversarial-review-loop
test('adversarial-review-loop frontmatter parses and meets AC3', () => {
  const skillPath = join(root, 'skills', 'adversarial-review-loop', 'SKILL.md');
  assert.ok(existsSync(skillPath), `${skillPath} must exist`);
  const content = readFileSync(skillPath, 'utf8');
  const fm = parseFrontmatter(content);
  assert.equal(fm.name, 'adversarial-review-loop');
  assert.equal(fm['user-invocable'], true);
  assert.equal(fm.license, 'Apache-2.0');

  // argument-hint lists --max-rounds, --max-time, and --test
  const argHint = fm['argument-hint'] || '';
  assert.ok(argHint.includes('--max-rounds'), 'argument-hint must list --max-rounds');
  assert.ok(argHint.includes('--max-time'), 'argument-hint must list --max-time');
  assert.ok(argHint.includes('--test'), 'argument-hint must list --test');

  // description contains the literal tokens: arl, review and fix until clean, converge the review, and --loop
  const desc = fm.description || '';
  assert.ok(desc.includes('arl'), 'description must contain "arl"');
  assert.ok(
    desc.includes('review and fix until clean'),
    'description must contain "review and fix until clean"'
  );
  assert.ok(
    desc.includes('converge the review'),
    'description must contain "converge the review"'
  );
  assert.ok(desc.includes('--loop'), 'description must contain "--loop"');

  // metadata.version equals package.json version
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.ok(fm.metadata, 'metadata block must be present in frontmatter');
  assert.equal(
    fm.metadata.version,
    pkg.version,
    'metadata.version must equal package.json version'
  );
});

// AC4: Required headings and literal strings in adversarial-review-loop/SKILL.md
test('adversarial-review-loop contains required headings and literal strings (AC4)', () => {
  const skillPath = join(root, 'skills', 'adversarial-review-loop', 'SKILL.md');
  assert.ok(existsSync(skillPath), `${skillPath} must exist`);
  const content = readFileSync(skillPath, 'utf8');

  const requiredHeadings = [
    'Arguments',
    'Preconditions',
    'Independence',
    'Gating set',
    'Fix step',
    'Validation',
    'Rebuttal',
    'Progress accounting',
    'Stops and checkpoints',
    'Branch mode',
    'Report',
    'Output discipline',
  ];

  for (const heading of requiredHeadings) {
    const headingPattern = new RegExp(`^#+\\s+.*\\b${heading.replace(/\s+/g, '\\s+')}\\b`, 'm');
    assert.ok(headingPattern.test(content), `SKILL.md must contain heading: ${heading}`);
  }

  const requiredLiterals = [
    '--max-rounds',
    '--max-time',
    '20',
    '2h',
    'three consecutive',
    'no-independent-reviewer',
    'converged-with-accepted',
    'checkpoint-time',
    'out of change set',
    'independence overridden',
    '--no-gpg-sign',
    'Never `git add -A`',
    '.stdout.json',
    '.stderr.txt',
    '"mode": "arl"',
  ];

  for (const literal of requiredLiterals) {
    assert.ok(content.includes(literal), `SKILL.md must contain literal string: ${literal}`);
  }
});

// AC5: README and adversarial-review SKILL.md reposition --loop and name arl
test('README and adversarial-review SKILL.md reposition --loop and name arl (AC5)', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  // README L45-70 install section names both skills
  const installSection = readme.slice(0, 3000);
  assert.ok(installSection.includes('adversarial-review'), 'README install section must mention adversarial-review');
  assert.ok(installSection.includes('adversarial-review-loop'), 'README install section must mention adversarial-review-loop');

  // "Loop mode" section opening paragraph contains adversarial-review-loop and unattended
  const loopModeIdx = readme.indexOf('## Loop mode');
  assert.ok(loopModeIdx !== -1, 'README must contain "## Loop mode"');
  const loopModeSection = readme.slice(loopModeIdx, loopModeIdx + 1500);
  assert.ok(loopModeSection.includes('adversarial-review-loop'), 'Loop mode section must mention adversarial-review-loop');
  assert.ok(loopModeSection.includes('unattended'), 'Loop mode section must mention unattended');

  // Both copies of adversarial-review SKILL.md contain adversarial-review-loop in --loop bullet,
  // where "not for use inside an agent session" precedes "unattended"
  const advReviewCopies = [
    join(root, 'skills', 'adversarial-review', 'SKILL.md'),
    join(root, '.agents', 'skills', 'adversarial-review', 'SKILL.md'),
  ];
  for (const copyPath of advReviewCopies) {
    assert.ok(existsSync(copyPath), `${copyPath} must exist`);
    const copyContent = readFileSync(copyPath, 'utf8');
    assert.ok(copyContent.includes('adversarial-review-loop'), `${copyPath} must mention adversarial-review-loop`);

    const loopLine = copyContent
      .split('\n')
      .find((line) => line.includes('`--loop`') && line.includes('adversarial-review-loop'));
    assert.ok(loopLine, `${copyPath} must have a --loop bullet mentioning adversarial-review-loop`);
    const notForUseIdx = loopLine.indexOf('not for use inside an agent session');
    const unattendedIdx = loopLine.indexOf('unattended');
    assert.ok(notForUseIdx !== -1, `${copyPath} --loop bullet must contain "not for use inside an agent session"`);
    assert.ok(unattendedIdx !== -1, `${copyPath} --loop bullet must contain "unattended"`);
    assert.ok(notForUseIdx < unattendedIdx, `"not for use inside an agent session" must precede "unattended" in ${copyPath}`);
  }
});

// AC6: CHANGELOG [Unreleased] has Added and Changed entries for adversarial-review-loop
test('CHANGELOG [Unreleased] contains Added and Changed entries for arl (AC6)', () => {
  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  const unreleasedIdx = changelog.indexOf('## [Unreleased]');
  assert.ok(unreleasedIdx !== -1, 'CHANGELOG must contain "## [Unreleased]"');
  const nextSectionMatch = changelog.slice(unreleasedIdx + 15).match(/## \[\d+\.\d+\.\d+\]/);
  const unreleasedEnd = nextSectionMatch
    ? unreleasedIdx + 15 + nextSectionMatch.index
    : changelog.length;
  const unreleasedContent = changelog.slice(unreleasedIdx, unreleasedEnd);

  const addedIdx = unreleasedContent.indexOf('### Added');
  const changedIdx = unreleasedContent.indexOf('### Changed');
  assert.ok(addedIdx !== -1, 'Unreleased must contain "### Added"');
  assert.ok(changedIdx !== -1, 'Unreleased must contain "### Changed"');

  const addedSection = unreleasedContent.slice(addedIdx, changedIdx);
  const changedSection = unreleasedContent.slice(changedIdx);

  assert.ok(
    addedSection.includes('adversarial-review-loop'),
    'Added section under [Unreleased] must mention adversarial-review-loop'
  );
  assert.ok(
    changedSection.includes('adversarial-review-loop'),
    'Changed section under [Unreleased] must mention adversarial-review-loop'
  );
});

// AC7: skills-lock.json parses and contains adversarial-review-loop
test('skills-lock.json parses and contains adversarial-review-loop (AC7)', () => {
  const lockPath = join(root, 'skills-lock.json');
  assert.ok(existsSync(lockPath), 'skills-lock.json must exist');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  assert.ok(lock.skills, 'skills-lock.json must have skills property');
  assert.ok(
    lock.skills['adversarial-review-loop'],
    'skills-lock.json must contain entry for adversarial-review-loop'
  );
});

// AC10 (D25): src/llm.js identity and fallback strings pin.
// The arl Independence section parses these literal strings from review stderr to identify
// the reviewer family and detect fallback. If they change in src/llm.js, this test fails
// so the skill text is updated to match.
test('src/llm.js contains reviewer identity and fallback strings (AC10 / D25)', () => {
  const llmPath = join(root, 'src', 'llm.js');
  assert.ok(existsSync(llmPath), 'src/llm.js must exist');
  const llmContent = readFileSync(llmPath, 'utf8');
  const pinnedStrings = [
    'Using local CLI agent:',
    'Using LLM provider:',
    'fell back to',
  ];
  for (const s of pinnedStrings) {
    assert.ok(
      llmContent.includes(s),
      `src/llm.js must contain pinned string "${s}" (dependent: arl Independence section)`
    );
  }
});
