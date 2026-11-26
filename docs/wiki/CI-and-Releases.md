# CI and releases

Pull requests and pushes to `main` run GitHub Actions CI on Ubuntu and Windows
with Node 22. CI runs `npm ci`, `npm run check`, the Node test suite, and
`npm pack --dry-run`. Run the same commands locally to verify a change. Set
`NODE_OPTIONS=--disable-warning=ExperimentalWarning` for the test command on
Node 22 so the SQLite warning stays out of CLI stderr assertions.

## Design rules and why

- `npm run check` checks JavaScript syntax under `bin/`, `hooks/`, `src/`, `test/`,
  and `scripts/` and verifies that the package's executable targets exist.
- The release workflow runs only on a `v*` tag push or manual dispatch. Manual
  dispatch defaults to a dry run that verifies the package and smoke-tests
  desktop builds. A tag must match
  `v` followed by the package version, including for dry runs on a tag.
  When dispatched on a branch, the workflow uses that version tag and creates it
  from the verified commit if it does not already exist.
- The npm publishing job requires the `NPM_TOKEN` Actions secret. It publishes
  with public access in either case and adds
  [npm provenance](https://docs.npmjs.com/generating-provenance-statements/) when
  the source repository is public.
- After npm publishes the package, a separate job creates or updates the
  corresponding GitHub Release. It checks that the remote version tag resolves
  to the commit published to npm before creating or updating the release.
  Use **Re-run failed jobs** to retry a failed GitHub Release while keeping the
  successful npm publish.
- Windows and Linux runners build and smoke-test the standalone desktop
  packages from the verified commit before npm publishes. Authorized releases
  attach the Windows installer, Windows portable executable, and Linux AppImage
  to the GitHub Release. Electron dependencies live in the desktop package.
