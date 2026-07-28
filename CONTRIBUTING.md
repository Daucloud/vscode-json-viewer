# Contributing

Thank you for improving Fast JSON & JSONL Viewer. The project prioritizes responsiveness on large files, bounded memory use, and data safety. Feature changes should keep those properties measurable and regression-tested.

## Before you start

- Node.js 20+
- VS Code 1.95+
- npm, using the committed `package-lock.json`

Prepare a fresh workspace with:

```bash
npm ci
npm run build
```

Press `F5` to launch an Extension Development Host. `.jsonl`, `.ndjson`, and `.jsonlines` files open in the Viewer by default. Open `.json` files through **Open With → Fast JSON Viewer**.

## Submitting changes

1. Open an issue first, or explain the problem, expected behavior, and relevant file sizes in the pull request.
2. Keep each change focused. Do not commit generated fixtures, index caches, credentials, or local VSIX packages.
3. Add boundary-case tests when changing parsing, indexing, query, editing, or virtualization behavior.
4. Run the standard checks before committing:

   ```bash
   npm run check
   npm test
   npm run build
   ```

5. Also run the Extension Host suite when changing the VS Code lifecycle, editing and backup behavior, or restored Webview state:

   ```bash
   npm run test:vscode
   ```

6. Run `npm run benchmark` when changing a performance-sensitive path. Include the machine, Node.js version, fixture shape, and before/after measurements in the pull request. Use `npm run benchmark:10gb` for the 10 GiB streaming scenario.

## Design constraints

- Never send an entire large source file to the extension host or Webview.
- Keep file parsing, indexing, searching, filtering, and sorting inside isolated workers.
- Keep individual worker-to-Webview messages near or below 1 MiB, and mount only visible content in the Webview.
- Render all file content as plain text. Do not add remote scripts, content execution, telemetry, or unnecessary network requests.
- An external source-file change must invalidate stale indexes and queries. Save operations must never silently overwrite an external change.
- A malformed row, oversized row, or worker failure should degrade only the affected record or active preview.

## Pull request description

Include at least:

- what changed and why;
- the user-visible impact;
- test and performance results;
- compatibility, memory, or index-format implications;
- screenshots for visible UI changes.

By contributing, you agree that your contribution is licensed under the project [MIT License](LICENSE).
