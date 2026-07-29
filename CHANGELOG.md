# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

No unreleased changes.

## 0.2.3 — 2026-07-29

### Inspector and value experience

- Replaced Inspector JSON Pointer output with jq-ready paths while retaining JSON Pointer internally for lazy loading and source navigation.
- Unified scalar value viewing and editing in one panel, with strict JSON-literal editing and shared inline/full-screen state.
- Decoded JSON string escapes for natural display and formatted objects/arrays without rounding unsafe integer literals.
- Added a draggable, keyboard-accessible, persisted Value panel height with double-click reset.
- Changed the default JSONL layout to equal-width records, tree, and Inspector panes, with independent persistence for the nested JSONL split.

## 0.2.2 — 2026-07-28

### Documentation

- Converted the default changelog, contributing guide, security policy, and maintainer release guide to English.
- Kept the Simplified Chinese README as an optional translation while making every default documentation entry point English-first.
- Removed stale release-version examples from the README and release guide.

## 0.2.1 — 2026-07-28

### Viewing experience

- Upgraded the Inspector Value Preview to a formatted Value Viewer with a full-screen mode and `Esc` to exit.
- Made Selected record full screen cover the complete Viewer instead of only enlarging the details side of the split.

### Editing reliability

- Apply Value, Add, Delete, and Rename now refresh only the affected node, container page, or JSONL table row, preserving expansion, selection, and scroll state.
- Added a lightweight document-state message for dirty-state changes instead of triggering a complete bootstrap after every edit.
- Fixed JSONL property and array-item additions being formatted across multiple lines and then producing an `Expected property name or '}'` diagnostic; edited records now remain on one physical line.

## 0.2.0 — 2026-07-28

### JSONL experience

- Preserved expanded branches in Selected record when the editor window is resized.
- Opened JSONL/NDJSON files containing exactly one valid physical record as a complete JSON tree; malformed single records remain in the row-diagnostic view.
- Added Maximize and Restore actions for Selected record, including `Esc` to leave focus mode without losing tree state.
- Changed the default table/details ratio from `72/28` to `62/38` and substantially widened the drag range for both the outer split and the Tree/Inspector split.
- Prevented temporary narrow layouts from overwriting saved split ratios, so the previous layout returns when space is restored.

### Marketplace

- Expanded search keywords for JSON, JSONL, NDJSON, large files, tree browsing, logs, and data viewing.
- Refined the extension description and added the Data Science category to improve discovery for long-tail Marketplace searches.

## 0.1.1 — 2026-07-28

### Documentation and release

- Made the default README and Marketplace product description fully English.
- Added a separate Simplified Chinese README with clear language links between both versions.
- Refined the VSIX file list so the Marketplace package contains the English README while the Chinese translation remains available on GitHub.

## 0.1.0 — 2026-07-28

Initial release with a lazy JSON tree, a streaming JSONL/NDJSON table, and small-file editing.

### Product capabilities

- Added a lazy JSON tree, Inspector, JSON Pointer paths, source navigation, and small-file editing.
- Added a virtualized JSONL/NDJSON table, per-record JSON tree, schema sampling, full-text search, JSON Pointer filters, and result sorting.
- Added disk-backed line indexes and temporary query-result indexes with paging, progress, and cancellation.
- Added automatic editable, read-only lazy, and safe text-preview modes based on file size.
- Added support for UTF-8 BOM, LF/CRLF, a final line without a newline, blank lines, malformed JSONL records, oversized records, multibyte characters, and exact unsafe-integer literals.

### Performance and reliability

- Moved parsing, indexing, filtering, searching, and sorting into isolated workers with V8 memory limits, so a worker failure affects only the active preview.
- Added external-change detection using source size, mtime, inode where available, and boundary-block fingerprints to prevent stale trees and indexes.
- Added continuous boundary-fingerprint checks for Remote Workspace files while indexing and querying; stale tasks stop immediately and prompt for a refresh.
- Implemented a block-based JSONL index with variable-length line-size encoding, sparse in-memory checkpoints, and bounded decoded-block caching.
- Wrote query matches to temporary disk indexes instead of retaining every hit in memory, and protected active session indexes from global LRU eviction.
- Added bounded LRUs for JSONL detail trees, object-key lists, and large-object data to prevent duplicate requests and unbounded growth.
- Made cancellation return to the client immediately while the worker cleans up cooperatively, and cancelled stale row-detail requests when switching queries.
- Revalidated the on-disk source before saving, rejected overwrites after external changes, and used same-directory temporary files, sync, and atomic replacement for local saves.
- Added a fast lexical path for common JSON numbers and precise big-integer comparison only when required.

### Interaction and accessibility

- Added bounded **Expand all** with cancellation while retaining Collapse all and expand-to-depth controls.
- Added draggable, double-click-resettable, and keyboard-adjustable splits for the JSON tree, JSONL table/details view, and Inspector.
- Added arrow-key, Home/End, PageUp/PageDown, Enter, and Space navigation for JSON tree nodes and JSONL records.
- Added accessible column-resize handles, explicit copy success/failure feedback, and consistent action-error messages.
- Preserved expansion paths, selected rows, column widths, filters, and scroll position across editor switches, refreshes, and queries without using `retainContextWhenHidden`.
- Added a high-contrast Marketplace icon and declared read-only support for untrusted workspaces.

### Testing and release engineering

- Added tests for JSON Pointer behavior, lazy subtree paging, line-index encoding, cross-block newlines, BOM, malformed and oversized records, filters, large integers, and cache invalidation.
- Added VS Code integration coverage for editing, undo/redo, save, backup, large-file read-only modes, external changes, stale-query cancellation, worker-crash fallback, and Webview state restoration.
- Added 100 MiB JSON/JSONL and 10 GiB JSONL performance benchmarks with CI gates.
- Completed extension branding, MIT licensing, VSIX packaging, and Marketplace metadata.
