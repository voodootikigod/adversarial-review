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
releaseNotes: awk '/^## \[{{version}}\]/{f=1;next} /^## \[/{f=0} f' CHANGELOG.md
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

**`releaseNotes` extracts the changelog section, so the GitHub Release mirrors `CHANGELOG.md`.**
Added after 2.11.0, whose Release body is a generated commit list that disagrees with the curated
`[2.11.0]` entry describing the same release. The awk range stops at the next `## [` heading, so
it captures exactly one version's section. It fails closed: Step 12 requires non-empty output, so
a changelog missing a `## [X.Y.Z]` heading for the version being cut aborts the Release rather
than publishing an empty one — which also means **the changelog section must be written before
the tag**, not after.

**No `changelogCommand` — `CHANGELOG.md` is hand-curated.** It was last cut into a version
heading at `[2.0.0]`, so `[Unreleased]` accumulated already-published entries from 2.1–2.9,
including a `### Breaking changes` heading that refers to **2.8.0**. Do not read that heading as
a major-bump signal: check `git tag --contains <sha>` before letting changelog text drive the
semver decision. 2.10.0 nearly shipped as 3.0.0 on exactly this.

**The npm Trusted Publisher is configured and confirmed.** The maintainer confirmed it directly
after the 2.11.0 release (2026-09-05), and 2.10.0 and 2.11.0 both published through it. The
conformance checker cannot see npm-side config — an absent token and a missing trusted publisher
are indistinguishable from the repo — so Step 8 has this record to rely on instead of asking
again. Re-confirm only if a publish fails on auth, which is the symptom of that config changing.

Publishing is tokenless via OIDC — `NPM_TOKEN` was deliberately deleted — so provenance is
automatic; `npm view adversarial-review@{{version}} --json` should include `dist.attestations`
with a SLSA `provenance` predicate. **Provenance is the observable proof the OIDC path was taken**:
2.11.0's attestation is what retroactively answered the trusted-publisher question above. The precondition asserts no repo-scoped `NPM_TOKEN` has
reappeared; if one has, someone re-introduced the long-lived credential OIDC exists to remove.

There is no `workflow_dispatch` — a failed publish is re-run with `gh run rerun <id>` on the
tag's run. If it failed on auth, suspect the npm-side Trusted Publisher config or the deleted
`NPM_TOKEN`.

A publish has silently failed behind a green run here before. This repo is why R3 exists.
