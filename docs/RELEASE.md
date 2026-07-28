# Release Checklist

Use this checklist to turn a local Fast JSON & JSONL Viewer checkout into a reviewable, installable, and reversible VS Code extension release.

## Release identity

- Version source of truth: `package.json`
- Package name: `vscode-json-viewer`
- Publisher: `daucloud`
- License: MIT
- Runtime: desktop and Remote Workspace Extension Hosts
- GitHub repository: `https://github.com/daucloud/vscode-json-viewer`
- Marketplace extension ID: `daucloud.vscode-json-viewer`

## 1. Freeze the release scope

1. Confirm that the version, product name, publisher, and license agree across `package.json`, `README.md`, `CHANGELOG.md`, and `LICENSE`.
2. Confirm that screenshots, the extension icon, and `syntaxes/` are committed. Do not commit generated test data, credentials, temporary indexes, or local `.vsix` files.
3. Inspect the working tree for unrelated changes. The release owner must explicitly keep, split, or remove them before packaging.
4. Re-read the compatibility, size-limit, and performance sections in [`README.md`](../README.md). Local benchmark samples must not be presented as universal guarantees.

## 2. Validate and package locally

Do not reinstall dependencies when the existing workspace and lockfile are already prepared. Use `npm ci` only for a clean environment or after dependency changes.

```bash
npm ci
npm run check
npm test
npm run test:vscode
npm run benchmark
npm run package
```

`npm run package` repeats type checking, unit tests, and the production build before invoking `vsce package --no-dependencies`. It creates `vscode-json-viewer-X.Y.Z.vsix` in the repository root.

To keep the package outside the repository, derive the filename from `package.json`:

```bash
VERSION=$(node -p "require('./package.json').version")
npx vsce package --no-dependencies --out "/tmp/vscode-json-viewer-${VERSION}.vsix"
unzip -l "/tmp/vscode-json-viewer-${VERSION}.vsix"
```

The VSIX should contain:

- `README.md`, `CHANGELOG.md`, `LICENSE`, `media/icon.png`, and the two README screenshots;
- `dist/` and `syntaxes/`;
- no `src/`, `test/`, `.vscode/`, `node_modules/`, source maps, benchmark fixtures, credentials, or local indexes.

Run `npx vsce ls` to preview the package file list. `.vscodeignore` excludes development-only files, but always perform a final `unzip -l` inspection.

Record the package checksum for the GitHub Release:

```bash
VERSION=$(node -p "require('./package.json').version")
shasum -a 256 "vscode-json-viewer-${VERSION}.vsix"
```

## 3. Smoke-test the packaged extension

Install the VSIX in a clean VS Code profile:

```bash
VERSION=$(node -p "require('./package.json').version")
code --install-extension "vscode-json-viewer-${VERSION}.vsix"
```

Verify at least these paths:

- `.jsonl`, `.ndjson`, and `.jsonlines` open in the JSONL Viewer by default; `.json` opens through **Open With → Fast JSON Viewer**.
- Small JSON files support value changes, key renames, node additions and deletions, undo/redo, Save, Save As, and restoration of unsaved Hot Exit state.
- Large JSON files use the read-only lazy tree; files above `maxJsonMB` use the safe preview and can open as text.
- Large JSONL files show the first page promptly, then support indexing, full-text search, JSON Pointer filtering, cancellation, and external-change warnings.
- A malformed JSONL row affects only that row. CRLF, BOM, a final line without a newline, multibyte characters, and oversized records behave as documented.
- JSON tree, table/details, and Tree/Inspector splits support dragging, double-click reset, and keyboard adjustment; state survives refreshes and tab switches.
- Value Viewer and Selected record full-screen modes open and close correctly with `Esc`.
- Restricted Mode permits read-only viewing without running tasks, debug configurations, or workspace code.

## 4. Performance gates

Run at least the 100 MiB gate on a local SSD for every release candidate:

```bash
npm run benchmark
```

Run the 10 GiB streaming scenario for scheduled validation or any release that changes indexing, scanning, filtering, cancellation, or large-file I/O:

```bash
npm run benchmark:10gb
```

The local throughput target is at least `100 MB/s`; shared GitHub runners use a conservative `70 MB/s` floor. Record the machine, Node.js version, fixture shape, and results. Do not compare absolute timings across different hardware as though they were equivalent.

## 5. Commit, review, and merge

1. Update `package.json`, `package-lock.json`, and `CHANGELOG.md` to the same version.
2. Commit only the intended release files and push a dedicated branch.
3. Open a pull request describing the user impact, root cause for fixes, compatibility considerations, and validation results.
4. Wait for macOS, Windows, Linux, Extension Host, packaging, and performance checks to pass.
5. Merge through the repository's normal protected-branch workflow.

After merging, update the local default branch and tag the exact merge commit:

```bash
VERSION=$(node -p "require('./package.json').version")
git switch main
git pull --ff-only origin main
git tag -a "v${VERSION}" -m "Fast JSON Viewer v${VERSION}"
git push origin "v${VERSION}"
```

## 6. Publish GitHub and Marketplace releases

Create a GitHub Release from the verified tag and attach the exact VSIX that passed validation. Include user-facing highlights, validation results, and the SHA-256 checksum.

Marketplace publishing requires an Azure DevOps account and a matching Marketplace Publisher:

1. Sign in at [Azure DevOps](https://dev.azure.com/) and create an organization if needed.
2. Open the [Visual Studio Marketplace publisher portal](https://marketplace.visualstudio.com/manage) and confirm Publisher ID `daucloud`, which must exactly match `package.json`.
3. Create a Personal Access Token with only **Marketplace → Manage** permission. Never place the token in the repository, documentation, terminal logs, or screenshots.
4. Authenticate locally with `npx vsce login daucloud`, or expose the token as `VSCE_PAT` from a controlled CI secret.
5. Publish the already-verified package:

   ```bash
   VERSION=$(node -p "require('./package.json').version")
   npx vsce publish --packagePath "vscode-json-viewer-${VERSION}.vsix"
   ```

The Marketplace does not allow an existing version to be overwritten. Any correction after publication requires a new version.

## 7. Verify publication and rollback readiness

- Confirm that the public Marketplace version list includes the new version; catalog propagation can take several minutes.
- Install by extension ID in a clean profile and verify the icon, README images, commands, editor priorities, and Hot Exit behavior.
- Confirm that the GitHub tag, Release asset, Marketplace package, and checksum all refer to the same build.
- Keep the previous stable VSIX and release notes available. If a regression is discovered, unpublish only when necessary and ship a corrected patch version instead of replacing an existing package.

## Final sign-off

- [ ] Version, Publisher, license, and changelog agree
- [ ] Type check, unit tests, Extension Host tests, and production build pass
- [ ] 100 MiB performance gate passes; 10 GiB results are recorded when required
- [ ] VSIX contents and SHA-256 checksum are verified
- [ ] Packaged-extension smoke test passes in a clean profile
- [ ] Pull request checks pass and the tagged commit is on `main`
- [ ] GitHub Release and Marketplace package use the same VSIX
- [ ] Marketplace installation, upgrade, uninstall, and rollback paths are verified
