Release a new version of adversarial-review.

`main` is branch-protected (PR-only, linear history, required CI checks) and npm
publishing uses **OIDC trusted publishing** gated behind the `npm-publish` protected
environment. So a release is no longer a direct push to `main` — the version bump
goes through a PR, the tag triggers an environment-gated publish, and a human
approves the deployment. There are TWO human gates (PR merge, environment approval);
pause at each rather than trying to bypass them.

## Arguments

- $ARGUMENTS: Version bump type — "patch", "minor", or "major". Defaults to "minor" if not specified.

## Steps

1. **Determine the new version.** Read the current version from `package.json`. Apply the requested semver bump ($ARGUMENTS, default "minor") to compute `X.Y.Z`.

2. **Verify preconditions:**
   - On the `main` branch, working tree clean (`git status --porcelain` empty)
   - Up to date with remote (`git fetch` then confirm `HEAD..origin/main` is empty)
   - Tests pass (`npm test`)

3. **Create a release branch and bump the version** (do NOT commit to `main` — branch protection + the auto-mode classifier will block a direct push):
   - `git checkout -b chore/release-X.Y.Z`
   - Update the `"version"` field in `package.json`
   - Update `metadata.version` in `skills/adversarial-review/SKILL.md` frontmatter to match
   - Commit: `chore: bump version to X.Y.Z`
   - `git push -u origin chore/release-X.Y.Z`

4. **Open the bump PR** (`gh pr create --base main`) and **STOP — wait for the human to merge it.** CI (`test (18/20/22)`) must go green; the bump is code-free so it will. Do not self-merge. Tell the user the PR URL and that you'll continue once it's merged.

5. **After merge — tag the merged commit:**
   - `git checkout main && git pull --ff-only`
   - Confirm `package.json` version is now `X.Y.Z`
   - `git tag vX.Y.Z <merged-sha>` then `git push origin vX.Y.Z`
   - The remote prints `Cannot create ref due to creations being restricted` — that is the admin-only tag ruleset announcing itself; the tag still lands via admin bypass (`* [new tag]` confirms). Verify with `git ls-remote --tags origin vX.Y.Z`.

6. **The tag triggers `publish.yml`, which WAITS on the `npm-publish` environment gate.** Find the run (`gh run list --workflow=publish.yml`), give the user the run URL, and **STOP — wait for the human to approve the deployment** (UI "Review deployments" → approve `npm-publish`). The maintainer is the required reviewer; do not approve on their behalf with admin/`gh api`.

7. **After approval — watch the run to completion** (`gh run watch <id> --exit-status`). The workflow runs the ancestry check, `npm ci`, `npm test`, then `npm publish` via OIDC (no token — provenance is automatic).

8. **VERIFY the registry — never trust a green run alone** (a publish has silently failed before):
   - `npm view adversarial-review@X.Y.Z version` → `X.Y.Z`
   - `npm view adversarial-review dist-tags` → `latest: X.Y.Z`
   - Optionally confirm provenance: `npm view adversarial-review@X.Y.Z --json` includes `dist.attestations` with a SLSA `provenance` predicate.

9. **Confirm completion.** Summarize: previous → new version, tag, the npm `latest` + provenance status. If the publish failed on auth, the npm-side Trusted Publisher config or the deleted `NPM_TOKEN` is the likely cause — re-run the tag's workflow run with `gh run rerun <id>` after fixing (there is no `workflow_dispatch`).
