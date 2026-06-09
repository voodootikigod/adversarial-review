Release a new version of adversarial-review.

## Arguments

- $ARGUMENTS: Version bump type — "patch", "minor", or "major". Defaults to "minor" if not specified.

## Steps

1. **Determine the new version.** Read the current version from `package.json`. Apply the requested semver bump ($ARGUMENTS, default "minor") to compute the new version number.

2. **Verify preconditions:**
   - Working tree is clean (`git status --porcelain` is empty)
   - On the `main` branch
   - Up to date with remote (`git pull --dry-run` shows no changes)
   - Tests pass (`npm test`)

3. **Bump version:**
   - Update the `"version"` field in `package.json`
   - Update `metadata.version` in `skills/adversarial-review/SKILL.md` frontmatter to match the new version

4. **Commit the version bump:**
   ```
   chore: bump version to X.Y.Z
   ```

5. **Create the version tag:** `vX.Y.Z`

6. **Push commit and tag:**
   ```
   git push origin main
   git push origin vX.Y.Z
   ```

7. **Confirm completion.** Print a summary of:
   - Previous version → new version
   - Tag created
   - Remind the user that the GitHub Actions publish workflow (`.github/workflows/publish.yml`, triggered on `v*` tags) will handle the npmjs release automatically.
