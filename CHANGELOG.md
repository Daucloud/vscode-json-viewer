# Change Log

## 0.1.0

- Initial release with lazy JSON trees, streaming JSONL/NDJSON tables, disk-backed indexes and small-file editing.
- Added persistent, keyboard-accessible splitters for JSONL table/details and tree/Inspector panes.
- Made Inspector path/value copying resilient across webview and extension-host clipboard implementations, with visible result feedback.
- Added a bounded **Expand all** action for JSON trees so normal documents can be fully opened without materializing unsafe large branches.
- Hardened external-change detection with source-size checks and first/last-block fingerprints, including lazy JSON requests after the initial parse.
- Kept indexes and temporary query result files of active JSONL sessions out of the global LRU eviction pass.
- Made client-side cancellation reject immediately while the worker finishes its cooperative cleanup in the background.
- Bounded the JSONL detail-tree cache by both entry count and source bytes to keep large-record browsing within the memory budget.
- Limited exact-number scans during JSONL queries to the requested sort/filter pointers.
- Added a bounded large-object key-list cache to speed repeated JSON tree paging without unbounded memory growth.
- Cancelled superseded JSONL scans per session and protected in-progress result files from cache eviction.
- Added a pre-save conflict check so local viewer edits cannot silently overwrite an externally changed file.
- Prevented inline-copy probing from serializing huge narrow JSON containers, and covered that shape in the 100 MB benchmark.
- Declared support for untrusted workspaces so read-only viewing works safely without requiring folder trust.
- Normalized persisted split positions against the actual editor width; keyboard accessibility values now match the visible JSONL/Inspector and JSON tree panes.
- Added roving keyboard navigation for JSON trees and JSONL records (arrows, Home/End, page movement, Enter/Space) plus accessible column-resize handles.
- Added a cancellable **Expand all** operation and removed an O(n²) queue walk from depth expansion.
- Cancelled stale JSONL row-detail requests during query changes/reset, and clearly marks restored or edited query controls as pending until they are run.
- Added a fast lexical guard for ordinary JSON numbers so JSONL filtering avoids a full numeric-literal visitor on every row; exact large-number preservation remains enabled when needed.
- Kept JSON/JSONL view components mounted across edits and refreshes, cancelling stale searches while avoiding unnecessary full UI remounts and preserving draft controls.
- Routed fire-and-forget toolbar actions through a visible error channel so failed saves, source reveals, and undo/redo operations no longer disappear as unhandled Webview rejections.
- Added a lightweight Worker-side edge-fingerprint monitor for remote Workspace files so in-flight indexing and queries stop after an external source change.
