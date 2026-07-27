# 安全策略

## 支持范围

安全修复面向当前 Marketplace 最新版本。旧版本用户应先升级并确认问题是否仍然存在。

## 私密报告漏洞

请使用 GitHub 的 [Private vulnerability reporting](https://github.com/daucloud/vscode-json-viewer/security/advisories/new) 提交安全问题，不要先创建公开 Issue。

报告中请尽量包含：

- 受影响的扩展和 VS Code 版本；
- 本地、Remote Workspace 或虚拟文件系统环境；
- 最小复现文件或生成方式；
- 预期影响与可观察结果；
- 已知缓解方式。

请勿提交真实凭据、个人信息或生产数据。若复现依赖敏感样本，请先说明数据结构，再协商安全传输方式。

收到报告后，维护者会尽快确认、评估影响并协调修复与披露时间。修复发布前请避免公开利用细节。

## 安全边界

扩展不执行工作区代码，不发送遥测或文件内容，也不加载远程 Webview 资源。大型文件解析和查询在有内存上限的 Worker 中运行；异常只应降级当前预览。

以下情况通常不属于安全漏洞，但仍欢迎通过公开 Issue 反馈：

- 超出文档大小或行长上限后的性能下降；
- 不受支持的编码或 `vscode.dev` Web Extension；
- 已明确提示的非法 JSON/JSONL 输入；
- 仅影响展示、不导致数据泄露、内容执行或文件损坏的问题。
