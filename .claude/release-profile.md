---
project: adversarial-review
registry: npm
package: adversarial-review
versionSource: package.json
bumpSites:
  - package.json:version
  - skills/adversarial-review/SKILL.md:metadata.version
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

Publishing is tokenless via OIDC — `NPM_TOKEN` was deliberately deleted — so provenance is
automatic; `npm view adversarial-review@{{version}} --json` should include `dist.attestations`
with a SLSA `provenance` predicate. The precondition asserts no repo-scoped `NPM_TOKEN` has
reappeared; if one has, someone re-introduced the long-lived credential OIDC exists to remove.

There is no `workflow_dispatch` — a failed publish is re-run with `gh run rerun <id>` on the
tag's run. If it failed on auth, suspect the npm-side Trusted Publisher config or the deleted
`NPM_TOKEN`.

A publish has silently failed behind a green run here before. This repo is why R3 exists.
