# Fast JSON & JSONL Viewer

一个面向大文件的 VS Code JSON / JSONL / NDJSON 查看器。JSON 使用按需展开的彩色树；JSONL 使用纵向与横向双虚拟化表格，并在侧栏按行展示完整 JSON 树。

扩展不发送网络请求、不包含遥测，只在桌面或远程 Workspace Extension Host 中运行。许可证为 MIT。

## 功能

- `.jsonl`、`.ndjson` 默认用 Viewer 打开；`.json` 通过 **Open With → Fast JSON Viewer** 手动进入。
- 小于等于 `10 MB` 的文件可编辑：修改键和值、添加/删除节点、撤销/重做、Save、Save As 与 Hot Exit 备份。
- `10–100 MB` JSON 在独立 Worker 中只读解析，Webview 每次最多获取 200 个子节点。
- 超过 `100 MB` 的 JSON 使用安全截断预览，不构建完整树。
- 大型 JSONL 完全流式处理。首屏直接读取前 200 条，后台建立磁盘行索引，源文件不会整体进入扩展宿主或 Webview。
- JSONL 支持原始行全文搜索，以及基于 JSON Pointer 的等于、不等于、包含、比较、存在和空值过滤。
- JSONL 的表格/详情、详情树/Inspector 两层分栏均可拖动；比例随当前 Viewer 状态恢复，也可用方向键微调或双击复位。
- Inspector 支持可靠复制 JSON Pointer 与值，成功或失败都会给出明确反馈。
- 查询命中项保存在临时磁盘索引中；排序默认只允许最多 100 万条结果。
- 支持 UTF-8 BOM、LF/CRLF、无末尾换行、空行、非法单行、无效 UTF-8 与超长记录。坏行独立标红。
- 不安全整数保留源字面量，避免 Viewer 将 `900719925474099312345` 显示成舍入值。

## 快速使用

1. 安装生成的 `.vsix`，或在本仓库运行 `npm install && npm run build` 后按 `F5` 启动 Extension Development Host。
2. 打开 JSONL/NDJSON 文件会自动进入表格 Viewer。
3. 对 JSON 文件运行命令 **Fast JSON Viewer: Open in Fast JSON Viewer**，或使用 **Open With**。
4. JSONL 中可组合全文搜索、字段过滤和字段排序；点击一行后在右侧展开该记录，拖动分隔条可调整各面板宽度。

JSON Pointer 示例：`/user/id`、`/items/0/name`。属性名中的 `/` 写成 `~1`，`~` 写成 `~0`。

## 设置

| 设置 | 默认值 | 说明 |
| --- | ---: | --- |
| `fastJsonViewer.editableMaxMB` | 10 | 可编辑文件上限；JSONL 始终不超过 10 MB |
| `fastJsonViewer.maxJsonMB` | 100 | 完整 JSON 树上限 |
| `fastJsonViewer.jsonl.pageSize` | 200 | 单次表格分页大小 |
| `fastJsonViewer.jsonl.schemaSampleRows` | 1000 | 自动发现列的采样行数 |
| `fastJsonViewer.jsonl.maxLineMB` | 16 | 单条记录完整解析上限 |
| `fastJsonViewer.jsonl.sortMaxRows` | 1000000 | 全局排序的最大结果数 |
| `fastJsonViewer.indexCacheMB` | 1024 | 持久行索引 LRU 上限 |

命令 **Fast JSON Viewer: Clear Index Cache** 可立即清理磁盘索引。打开中的 JSONL 可能需要刷新。

## 性能设计

- 解析、行索引、过滤、搜索和排序全部在有内存上限的 `worker_threads` 中执行。Worker 异常只影响当前预览。
- 行索引按 4096 行分块，长度采用变长整数编码；内存只保留稀疏块元数据和最多 32 个解码块。
- 索引以 URI、大小、mtime、inode（可用时）以及首尾 64 KB SHA-256 校验。
- 查询结果是定长的磁盘记录，不在内存中保存全部命中行。
- Webview 使用 TanStack Virtual；只挂载可见行和可见列，文件内容始终作为纯文本渲染。
- 单次 Worker → Webview 页面消息限制在约 1 MB 内。

本机 SSD 的 100 MiB 门禁结果（Apple Silicon，Node 22；数值会随硬件变化）：

| 场景 | 结果 |
| --- | ---: |
| JSONL 首屏 | 32 ms |
| JSONL 行索引 | 126 ms |
| JSONL 字段过滤 | 449 ms / 223 MB/s |
| 查询取消 | 5 ms |
| JSON 根节点 | 652 ms |
| JSON 场景 RSS | 681 MB |

同机 1 GiB JSONL 实测首屏 39 ms、过滤吞吐 215 MB/s，Worker heap + external 为 113 MB。运行 `npm run benchmark` 可复现 100 MB 基准；`npm run benchmark:10gb` 用于本地或定期 10 GB 流式测试。基准文件创建在系统临时目录并在结束或中断时删除。

## 开发与验证

```bash
npm install
npm run check
npm test
npm run build
npm run package
```

测试覆盖 JSON Pointer、直接定位懒子树分页、消息大小门禁、任意精度数字比较、行索引、跨 4 MB 块 CRLF、多字节 UTF-8、BOM、空/坏/超长记录、字段过滤、排序上限、缓存损坏和源文件变更。CI 在 macOS、Windows、Linux 执行类型检查、测试、构建与 VSIX 打包，并在 Linux 运行 100 MB 性能门禁。

## 安全与限制

- 仅支持 UTF-8；JSON 解析严格遵循 `JSON.parse`。
- 不支持 `vscode.dev` Web Extension，也不提供 JMESPath。
- 对非本地/非远程原生文件系统，大于编辑上限的文件可能退化为安全文本预览，因为无法获得可流式读取的文件描述符。
- 全局排序会消耗与结果行数成正比的内存，因此必须先将结果过滤到配置上限内。

## License

[MIT](LICENSE)
