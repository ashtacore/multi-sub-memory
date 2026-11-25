# CI and releases

Pull requests and pushes to `main` run GitHub Actions CI on Ubuntu and Windows
with Node 22. CI runs `npm ci`, `npm run check`, the Node test suite, and
`npm pack --dry-run`. Run the same commands locally to verify a change. Set
`NODE_OPTIONS=--disable-warning=ExperimentalWarning` for the test command on
Node 22 so the SQLite warning stays out of CLI stderr assertions.

## Design rules and why

- `npm run check` checks JavaScript syntax under `bin/`, `src/`, `test/`, and
  `scripts/` and verifies that the package's executable targets exist.
- The release workflow runs only on a `v*` tag push or manual dispatch. Manual
  dispatch defaults to a dry run that ends after verification. A publishing run
  requires the selected tag, if any, to match `v` followed by the package version.
  When dispatched on a branch, the workflow uses that version tag and creates it
  from the verified commit if it does not already exist.
- The publishing job requires the `NPM_TOKEN` Actions secret and a public source
  repository for [npm provenance](https://docs.npmjs.com/generating-provenance-statements/).
  After npm publish succeeds, the job creates or updates the corresponding
  GitHub Release.
- [Issue #30](https://github.com/ashtacore/multi-sub-memory/issues/30) tracks the
  Electron `.exe` and `.AppImage` build and upload job.
