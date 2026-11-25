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
  dispatch defaults to a dry run that ends after verification. A tag must match
  `v` followed by the package version, including for dry runs on a tag.
  When dispatched on a branch, the workflow uses that version tag and creates it
  from the verified commit if it does not already exist.
- The npm publishing job requires the `NPM_TOKEN` Actions secret. It publishes
  with public access in either case and adds
  [npm provenance](https://docs.npmjs.com/generating-provenance-statements/) when
  the source repository is public.
- After npm publishes the package, a separate job creates or updates the
  corresponding GitHub Release. Use **Re-run failed jobs** to retry a failed
  GitHub Release while keeping the successful npm publish.
- [Issue #30](https://github.com/ashtacore/multi-sub-memory/issues/30) tracks the
  Electron `.exe` and `.AppImage` build and upload job.
