# 贡献指南

感谢你改进 Fast JSON & JSONL Viewer。这个项目优先保证大文件下的响应速度、内存边界和数据安全；功能变化应尽量保持这些约束可测量、可回归。

## 开始之前

- Node.js 20+
- VS Code 1.95+
- npm（使用仓库中的 `package-lock.json`）

首次准备工作区：

```bash
npm ci
npm run build
```

按 `F5` 启动 Extension Development Host。`.jsonl`、`.ndjson` 和 `.jsonlines` 默认进入 Viewer；`.json` 通过 **Open With → Fast JSON Viewer** 打开。

## 提交变更

1. 先创建 Issue 或在 Pull Request 中说明问题、预期行为和文件规模。
2. 将变更保持在单一主题内，不要混入生成数据、索引缓存、凭据或本地 VSIX。
3. 修改解析、索引、查询或虚拟化逻辑时，为边界情况补充测试。
4. 提交前运行：

   ```bash
   npm run check
   npm test
   npm run build
   ```

5. 涉及 VS Code 生命周期、编辑/备份或 Webview 状态时，再运行：

   ```bash
   npm run test:vscode
   ```

6. 涉及性能路径时运行 `npm run benchmark`，并在 Pull Request 中注明机器、Node 版本、样本形状和前后结果。10 GiB 流式测试使用 `npm run benchmark:10gb`。

## 设计约束

- 不把大型源文件整体发送到扩展宿主或 Webview。
- 文件解析、索引、搜索、过滤和排序保持在隔离 Worker 中。
- Worker → Webview 的单次消息保持在约 1 MiB 内，Webview 只挂载可见内容。
- 所有文件内容按纯文本渲染；不要引入远程脚本、内容执行、遥测或无必要的网络请求。
- 源文件外部变化必须使旧索引/查询失效；保存不能静默覆盖外部修改。
- 错误行、超长行和 Worker 异常应只降级当前记录或当前预览。

## Pull Request 说明

请至少包含：

- 变更内容与原因；
- 用户可见影响；
- 测试与性能结果；
- 对兼容性、内存或索引格式的影响；
- UI 变化截图（如适用）。

提交贡献即表示你同意按本项目的 [MIT License](LICENSE) 授权该贡献。
