---
project: adversarial-review
registry: npm
package: adversarial-review
versionSource: package.json
bumpSites:
  - package.json:version
  - skills/adversarial-review/SKILL.md:metadata.version
  - .agents/skills/adversarial-review/SKILL.md:metadata.version
preconditions:
  - npm test
landing: pr
publishTrigger: tag
publishEnvironment: npm-publish
publishWorkflow: .github/workflows/publish.yml
verify:
  - npm view adversarial-review@{{version}} version
  - '[ "$(npm view adversarial-review dist-tags.latest)" = "{{version}}" ]'
---

**Two human gates. Pause at both.** `main` is branch-protected (PR-only, linear history,
required CI checks) and npm publishing uses OIDC trusted publishing behind the `npm-publish`
protected environment.

- The bump PR must be merged by the maintainer. CI is `test (18/20/22)`; the bump is code-free
  so it goes green. Do not self-merge.
- The publish deployment must be approved by the maintainer in the UI ("Review deployments" →
  approve `npm-publish`). Do not approve via admin or `gh api`.

**Expected-but-alarming:** pushing the tag prints `Cannot create ref due to creations being
restricted`. That is the admin-only tag ruleset announcing itself — the tag still lands via
admin bypass. `* [new tag]` plus `git ls-remote --tags origin v{{version}}` is the confirmation.
That bypass is on *tag creation only*; it is not a licence to bypass either human gate.

**The two SKILL.md files are one bump site in two places.** `skills/adversarial-review/SKILL.md`
and `.agents/skills/adversarial-review/SKILL.md` are held byte-for-byte identical by the drift
guard in `test/skill-assets.test.js`, so bumping one without the other turns the post-bump test
run red. `npm run sync-skill` only copies `references/` — it does *not* copy `SKILL.md`, so the
mirror is a manual `cp`. Both are declared in `bumpSites` above; before 2.10.0 only the first
was, and the release survived solely because the drift guard failed the tree for an unrelated
reason.

**No `changelogCommand` — `CHANGELOG.md` is hand-curated.** It was last cut into a version
heading at `[2.0.0]`, so `[Unreleased]` accumulated already-published entries from 2.1–2.9,
including a `### Breaking changes` heading that refers to **2.8.0**. Do not read that heading as
a major-bump signal: check `git tag --contains <sha>` before letting changelog text drive the
semver decision. 2.10.0 nearly shipped as 3.0.0 on exactly this.

Publishing is tokenless via OIDC — `NPM_TOKEN` was deliberately deleted — so provenance is
automatic; `npm view adversarial-review@{{version}} --json` should include `dist.attestations`
with a SLSA `provenance` predicate. The precondition asserts no repo-scoped `NPM_TOKEN` has
reappeared; if one has, someone re-introduced the long-lived credential OIDC exists to remove.

There is no `workflow_dispatch` — a failed publish is re-run with `gh run rerun <id>` on the
tag's run. If it failed on auth, suspect the npm-side Trusted Publisher config or the deleted
`NPM_TOKEN`.

A publish has silently failed behind a green run here before. This repo is why R3 exists.
