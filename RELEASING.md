# Releasing

Releases are prepared locally from `main`, then published by GitHub Actions
from an immutable version tag. npm authentication uses the repository's
trusted publisher; there is no long-lived npm token.

1. Add user-facing release notes under `## Unreleased` in `CHANGELOG.md` and
   push all normal work to `main`.
2. From a clean, up-to-date checkout, preview the release:

   ```sh
   npm run release -- patch --dry-run
   ```

3. Run the release interactively:

   ```sh
   npm run release -- patch
   ```

   Use `minor` or `major` instead when appropriate. The command typechecks and
   tests, bumps `package.json` and `package-lock.json`, promotes the changelog,
   builds the package, updates the README CDN pin and SRI, validates the npm
   artifact, and shows the complete diff before asking for confirmation.

   Add `--yes` to skip that confirmation when running without a terminal, such
   as from an agent or a script. The diff is still printed, and every other
   check still gates the release: clean `main` matching `origin/main`, only the
   four release files touched, and CI green on the release commit before the
   tag is pushed.

After confirmation, the command pushes one `Release X.Y.Z` commit to `main`.
It waits for CI on that exact commit and only then pushes the annotated
`vX.Y.Z` tag. The tag-triggered Release workflow rebuilds and validates the
artifact, publishes that exact tarball to npm through OIDC, waits for the
registry integrity to become visible, and creates the GitHub release from the
changelog notes.

If the release commit was kept but pushing, CI, or tagging failed, correct the
external problem and continue without bumping again:

```sh
npm run release -- resume
```

Tags are never moved or force-pushed. If a tag workflow itself needs retrying,
rerun that workflow in GitHub Actions; publishing is idempotent only when the
already-published npm artifact has the exact expected integrity.
