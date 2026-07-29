<p align="center">
  <img src="media/icon.png" width="96" alt="Fast JSON & JSONL Viewer logo">
</p>

<h1 align="center">Fast JSON & JSONL Viewer</h1>

<p align="center">
  English · <a href="https://github.com/daucloud/vscode-json-viewer/blob/main/README.zh-CN.md">Simplified Chinese</a>
</p>

<p align="center">
  Understand JSON at a glance—and find the right record in gigabyte-scale JSONL or NDJSON without leaving VS Code.
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=daucloud.vscode-json-viewer"><img alt="VS Code Marketplace version" src="https://img.shields.io/visual-studio-marketplace/v/daucloud.vscode-json-viewer?style=flat-square&label=Marketplace"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=daucloud.vscode-json-viewer"><img alt="VS Code Marketplace installs" src="https://img.shields.io/visual-studio-marketplace/i/daucloud.vscode-json-viewer?style=flat-square"></a>
  <a href="https://github.com/daucloud/vscode-json-viewer/actions/workflows/ci.yml"><img alt="Continuous integration" src="https://github.com/daucloud/vscode-json-viewer/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/github/license/daucloud/vscode-json-viewer?style=flat-square"></a>
</p>

<p align="center">MIT License · Desktop / Remote Workspace Extension Host</p>

Fast JSON & JSONL Viewer is built for real-world data files. Explore JSON through a lazy-loaded tree and Inspector, or browse JSONL as a streaming virtual table. Parsing, indexing, filtering, and search run in isolated workers, while disk-backed indexes and UI virtualization keep memory usage and main-thread work under control.

> Install it from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=daucloud.vscode-json-viewer), or run `code --install-extension daucloud.vscode-json-viewer`. Source code and issue tracking are available on [GitHub](https://github.com/daucloud/vscode-json-viewer).

## Why this viewer

| What you are working with | How Fast JSON & JSONL Viewer handles it |
| --- | --- |
| Everyday JSON | Read it as a structured tree with children loaded on demand instead of scanning wide walls of text |
| Deeply nested JSON | Navigate quickly with JSON Pointer paths, search, expansion depth controls, and the Inspector |
| Millions of JSONL / NDJSON records | See the first page immediately while a reusable line index is built on disk—without sending the whole file to the Webview |
| Small files that need changes | Edit within a safe size limit, with undo/redo, Save, Save As, and Hot Exit support |
| Production data or untrusted workspaces | File content is read as data only; no workspace code, network requests, or telemetry |

## See it in action

These screenshots show the extension running in a real VS Code Extension Development Host.

### JSON: lazy-loaded color tree and Inspector

![JSON lazy tree and Inspector](media/readme-json-tree.jpg)

Only visible tree nodes stay mounted. The Inspector shows the selected value's JSON Pointer, type, child count, and formatted Value Viewer, with actions for full-screen inspection, copying, source navigation, and editing.

### JSONL: virtual table and per-record JSON tree

![JSONL virtual table and row Inspector](media/readme-jsonl-table.jpg)

The table is virtualized both vertically and horizontally. Select a record to explore its complete structure in a JSON-style tree. The records table, selected-record tree, and Inspector start as equal-width panes; Selected record can still cover the complete Viewer in full-screen mode, and both nested splits remain freely resizable.

## Features

### JSON / `.json`

- Lazy-loaded, virtualized, syntax-colored JSON tree. Object and array children are requested in pages of up to 200 items.
- Search keys and values, expand to a chosen depth, collapse everything, or use **Expand all** with a safety limit.
- Inspector with JSON Pointer, type, child count, and a formatted Value Viewer, plus full-screen inspection, copy path, copy value, and source navigation actions.
- Keeps the standard text editor as the default for JSON. Right-click and choose **Open With → Fast JSON Viewer**, or run **Fast JSON Viewer: Open in Fast JSON Viewer**.
- Edit small files: change values, rename keys, add or remove nodes, undo/redo, Save, Save As, and restore Hot Exit backups.
- Preserves the original literal for unsafe integers, so `900719925474099312345` is never displayed as a rounded approximation.

### JSONL / NDJSON / `.jsonlines`

- Reads the first 200 records by default (configurable with `jsonl.pageSize`), then scans sequentially in the background to build a reusable on-disk line index.
- Virtualized table with schema sampling, resizable columns, keyboard navigation, and restored scroll position, while keeping the mounted DOM small.
- Full-text search over raw records and JSON Pointer field filters for equality, inequality, containment, comparison, existence, and null checks.
- Writes query matches to a temporary disk index for paging, progress reporting, and cancellation instead of keeping every result in memory.
- Opens any selected record as a complete JSON tree. View Selected record full screen for focused inspection, press `Esc` to restore the table, and keep expanded branches intact while resizing.
- Opens a valid single-record JSONL/NDJSON file directly as a regular JSON tree; malformed single records remain isolated in the JSONL diagnostic view.
- Large files are read-only and never loaded wholesale into the extension host or Webview. If the source changes externally, stale indexing stops immediately and the viewer asks to refresh.

### Automatic file-size modes

The defaults below are configurable. The editable limit for JSONL never exceeds 10 MiB.

| File type and size | Mode | Behavior |
| --- | --- | --- |
| JSON ≤ 10 MiB | Editable | Complete tree with Inspector editing |
| JSON 10–100 MiB | Read-only, lazy-loaded | Parsed in a worker; the Webview requests only expanded branches |
| JSON > 100 MiB | Safe preview | Skips full tree construction and shows truncated text, file details, and an **Open as Text** action |
| JSONL / NDJSON ≤ 10 MiB | Editable streaming mode | Table, record tree, and small-file editing |
| JSONL / NDJSON > 10 MiB | Read-only streaming mode | Shows the first page immediately, then indexes in the background for gigabyte-scale browsing |

## Getting started

### Install from the Marketplace

Search for **Fast JSON & JSONL Viewer** in the VS Code Extensions view, or run:

```bash
code --install-extension daucloud.vscode-json-viewer
```

Reload VS Code after installation. The extension requires VS Code `1.95+` and runs in desktop or Remote Workspace Extension Hosts. It is not currently available as a `vscode.dev` Web Extension.

### Build a VSIX from source

From the repository root:

```bash
npm ci
npm run package
```

Install the generated `.vsix` file, or run this from a shell in the repository root:

```bash
code --install-extension ./vscode-json-viewer-*.vsix
```

### Open a file

1. `.jsonl`, `.ndjson`, and `.jsonlines` files open in Fast JSONL Viewer by default.
2. For `.json`, right-click and choose **Open With → Fast JSON Viewer**, or run **Fast JSON Viewer: Open in Fast JSON Viewer**.
3. In the JSONL viewer, combine text search, field filters, and sorting. Select any record to inspect its nested structure.

JSON Pointer examples: `/user/id` and `/items/0/name`. Escape `/` in a property name as `~1`, and `~` as `~0`.

## Commands

Run these from the Command Palette (`⌘⇧P` / `Ctrl+Shift+P`):

| Command | Purpose |
| --- | --- |
| **Fast JSON Viewer: Open in Fast JSON Viewer** | Open the active JSON or JSONL file in the matching viewer |
| **Fast JSON Viewer: Refresh Viewer** | Reload the file and rebuild the current preview or index |
| **Fast JSON Viewer: Open as Text** | Open the file in VS Code's standard text editor |
| **Fast JSON Viewer: Clear Index Cache** | Remove locally cached JSONL line indexes |

## Settings

All settings use the `fastJsonViewer` prefix. File-size values are in MiB.

| Setting | Default | Description |
| --- | ---: | --- |
| `fastJsonViewer.editableMaxMB` | `10` | Maximum editable file size; JSONL/NDJSON also has a hard 10 MiB limit |
| `fastJsonViewer.maxJsonMB` | `100` | Largest file for a complete lazy JSON tree; larger files use the safe preview |
| `fastJsonViewer.jsonl.pageSize` | `200` | Maximum number of JSONL records returned per request |
| `fastJsonViewer.jsonl.schemaSampleRows` | `1000` | Number of records sampled to discover table columns |
| `fastJsonViewer.jsonl.maxLineMB` | `16` | Maximum record size for complete parsing; longer records appear as truncated rows |
| `fastJsonViewer.jsonl.sortMaxRows` | `1000000` | Largest result set eligible for global field sorting; filter larger data sets first |
| `fastJsonViewer.indexCacheMB` | `1024` | LRU limit for persistent JSONL line indexes; source content is never cached |

## Performance by design

Performance is an architectural constraint, not an afterthought:

- Parsing, line indexing, filtering, search, and sorting run in isolated `worker_threads`; a worker failure degrades only the active preview.
- Workers have V8 memory limits, and messages between the Webview and worker are kept to approximately 1 MiB or less.
- JSON trees load lazily by JSON Pointer. JSONL uses block indexes, variable-length line-size encoding, and temporary result indexes.
- TanStack Virtual mounts only visible rows and columns. Cancelling a search or filter releases the UI immediately while the worker cooperatively winds down.
- File size, mtime, and boundary fingerprints are checked around reads, indexing, and saves to prevent stale results or accidental overwrites after external changes.

The measurements below are gate samples from a local Apple Silicon machine running Node 22 on a local SSD (2026-07-28). Results vary with hardware, data shape, and system load.

| Scenario | Measured result |
| --- | ---: |
| First page from 100 MiB JSONL | `73.5 ms` |
| Index 100 MiB JSONL | `75.3 ms` |
| Filter 100 MiB JSONL by field | `624.2 ms` · `160.2 MB/s` |
| Query cancellation response | `5.0 ms` |
| Process RSS with 100 MiB JSONL | `253.4 MB` |
| Root available from 100 MiB JSON | `586.8 ms` |
| Peak RSS in 100 MiB JSON scenario | `632.1 MB` |
| First page from 1 GiB JSONL | `26.9 ms` |
| Filter 1 GiB JSONL by field | `4.122 s` · `248.4 MB/s` |
| Worker heap + external memory with 1 GiB JSONL | `40.3 MB` |

Reproduce locally:

```bash
npm run benchmark       # 100 MiB gate
npm run benchmark:10gb  # local/scheduled 10 GiB streaming run
```

Benchmark files are written to the system temporary directory and removed on completion or interruption.

The local release gate requires at least `100 MB/s`. Because disk and CPU performance varies on shared CI runners, CI uses a conservative `70 MB/s` floor while still checking first-page latency, filter latency, cancellation response, memory, and JSON root availability.

## Compatibility, security, and current limits

- Handles UTF-8 with or without BOM, LF and CRLF, a final line without a newline, blank lines, invalid JSONL records, oversized records, and multibyte characters.
- Uses strict JSON parsing. A malformed JSONL record is isolated instead of invalidating the file.
- Sends no network requests and includes no telemetry. File content is rendered as text under a strict Webview CSP.
- Supports VS Code Restricted Mode: the viewer does not run tasks, debug configurations, or workspace code.
- Supports desktop and Remote Workspace Extension Hosts only; `vscode.dev` Web Extensions are not supported.
- JMESPath is not currently included. Global sorting consumes resources proportional to the result count and requires filtering when the configured limit is exceeded.
- Large files on non-native local or remote file systems may fall back to the safe text preview if a streamable file descriptor is unavailable.

## Development and verification

If dependencies are already present, there is no need to reinstall them. Run `npm ci` only for a fresh workspace or after the lockfile changes.

```bash
npm ci
npm run check          # TypeScript type checking
npm test               # unit tests
npm run test:vscode    # VS Code integration tests
npm run build          # extension and worker bundles
npm run package        # checks, tests, builds, and packages the VSIX
```

Tests cover JSON Pointer handling, lazy subtree paging, copy budgets, message-size gates, arbitrary-precision numeric comparison, line indexing, cross-block newlines, multibyte UTF-8, BOM, blank/invalid/oversized records, field filters, sorting limits, cache invalidation, external changes, stale-query cancellation, and Webview state restoration. CI runs type checks, tests, builds, and VSIX packaging on macOS, Windows, and Linux, plus the 100 MiB performance gate on Linux. The 10 GiB benchmark runs on a schedule.

## Project and support

- [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=daucloud.vscode-json-viewer)
- [GitHub repository](https://github.com/daucloud/vscode-json-viewer)
- [Issues and feature requests](https://github.com/daucloud/vscode-json-viewer/issues)
- [Contributing guide](https://github.com/daucloud/vscode-json-viewer/blob/main/CONTRIBUTING.md)
- [Security policy](https://github.com/daucloud/vscode-json-viewer/blob/main/SECURITY.md)
- Maintainer release process: [`docs/RELEASE.md`](docs/RELEASE.md)

## License

[MIT](LICENSE)
