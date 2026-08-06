## Summary

<!-- What changed, and why is this the right change? -->

## Related issue

<!-- Use "Closes #123" when this PR fully resolves an issue. -->

## User-visible impact

<!-- Describe the affected JSON/JSONL workflow, file sizes, and any compatibility implications. -->

## Verification

<!-- Check completed items. Explain anything intentionally not run. -->

- [ ] `npm run check`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `npm run test:vscode` when VS Code lifecycle, editing, backup, or restored Webview state changed
- [ ] `npm run benchmark` when parsing, indexing, querying, virtualization, or another performance-sensitive path changed

## Evidence

<!-- Add screenshots or recordings for visible UI changes. Add before/after timings and memory measurements for performance changes. Remove this section when not applicable. -->

## Checklist

- [ ] The change is focused and does not include unrelated generated files, caches, credentials, or VSIX packages.
- [ ] Tests cover new behavior and relevant boundary cases.
- [ ] Documentation and settings descriptions are updated when user-facing behavior changed.
- [ ] Large files remain isolated from the extension host and Webview, and file content is still rendered as plain text.

See [CONTRIBUTING.md](https://github.com/Daucloud/vscode-json-viewer/blob/main/CONTRIBUTING.md) for the complete contribution and performance guidelines.
