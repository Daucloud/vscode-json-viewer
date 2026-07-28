# Security Policy

## Supported versions

Security fixes target the latest stable version available on the VS Code Marketplace. If you use an older version, upgrade first and confirm that the issue still occurs.

## Reporting a vulnerability privately

Use GitHub [Private vulnerability reporting](https://github.com/daucloud/vscode-json-viewer/security/advisories/new) for security issues. Do not open a public issue before the report has been assessed.

Please include, where possible:

- the affected extension and VS Code versions;
- whether the issue occurs locally, in a Remote Workspace, or on a virtual file system;
- a minimal reproducer or a safe way to generate one;
- the expected impact and observable result;
- any known mitigations.

Do not submit real credentials, personal information, or production data. If reproduction depends on a sensitive sample, describe its structure first so a safe transfer method can be arranged.

The maintainer will acknowledge the report, assess impact, and coordinate remediation and disclosure timing as soon as practical. Please avoid publishing exploit details before a fix is available.

## Security boundaries

The extension does not execute workspace code, send telemetry or file content, or load remote Webview resources. Large-file parsing and queries run in memory-limited workers; a worker failure should degrade only the active preview.

The following are generally not considered security vulnerabilities, though public bug reports are still welcome:

- performance degradation beyond documented file-size or line-length limits;
- unsupported encodings or the unsupported `vscode.dev` Web Extension environment;
- malformed JSON/JSONL input that is already reported as invalid;
- display-only defects that cannot cause data disclosure, content execution, or file corruption.
