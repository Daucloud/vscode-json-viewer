# 发布清单

这份清单用于将 `Fast JSON & JSONL Viewer` 从本地工作区交付为可审阅、可安装、可回滚的 VS Code 扩展。

## 当前状态

- 扩展版本：`0.1.0`
- 包名：`vscode-json-viewer`
- Publisher：`daucloud`
- 许可证：MIT
- 目标运行环境：桌面和 Remote Workspace Extension Host
- GitHub：`https://github.com/daucloud/vscode-json-viewer`
- Marketplace 扩展 ID：`daucloud.vscode-json-viewer`

## 1. 发布前冻结

1. 确认 `package.json`、`README.md`、`CHANGELOG.md` 和 `LICENSE` 中的版本、名称和许可证一致。
2. 确认截图、图标和 `syntaxes/` 已纳入仓库；不要把测试数据、凭据、临时索引或本地 `.vsix` 提交进去。
3. 检查工作区是否存在与本次文档无关的未提交修改；先由负责人决定保留、提交或拆分，发布包不要意外带入这些改动。
4. 逐项阅读 [`README.md`](../README.md) 的兼容性、大小阈值和性能说明，确保没有把本机基准误写成硬性承诺。

## 2. 本地验证与打包

依赖和锁文件已经准备好时，不要重复安装；需要重新准备依赖时使用 `npm ci`。

```bash
npm ci
npm run check
npm test
npm run test:vscode
npm run build
npm run package
```

`npm run package` 会再次执行类型检查、单元测试、构建，并调用 `vsce package --no-dependencies` 生成 VSIX。也可以将产物写入临时目录，避免污染仓库：

```bash
npx vsce package --no-dependencies --out /tmp/fast-json-viewer-0.1.0.vsix
unzip -l /tmp/fast-json-viewer-0.1.0.vsix
```

核对 VSIX 内容时应看到：

- `README.md`、`LICENSE`、`media/icon.png` 和两张 README 截图；
- `dist/` 和 `syntaxes/`；
- 不包含 `src/`、`test/`、`.vscode/`、`node_modules/`、源码地图、性能生成文件或本地索引。

可用 `npx vsce ls` 在打包前预览文件清单。`.vscodeignore` 已将开发文档和源码排除在安装包之外，但发布前仍应通过 `unzip -l` 做最终核对。

## 3. 安装后的冒烟测试

在干净的 VS Code Profile 或 Extension Development Host 中安装 VSIX：

```bash
code --install-extension /tmp/fast-json-viewer-0.1.0.vsix
```

至少验证以下路径：

- `.jsonl`、`.ndjson`、`.jsonlines` 双击后进入 JSONL Viewer；`.json` 可通过 **Open With** 进入 JSON Viewer。
- 小 JSON 修改值、重命名键、添加/删除节点、撤销/重做、Save、Save As，以及关闭后恢复未保存内容。
- 大 JSON 进入只读懒加载；超过 `maxJsonMB` 的 JSON 显示安全预览并能打开文本。
- 大 JSONL 首屏迅速出现，索引、全文搜索、JSON Pointer 过滤、取消和外部修改提示均正常。
- 非法 JSONL 行只标红该行；CRLF、BOM、末行无换行、多字节字符和超长记录行为符合 README。
- JSON 树、表格/详情和 Inspector 分隔条可拖动、双击复位，刷新/切换标签后状态可恢复。
- 在不受信任工作区中可以只读查看，扩展不执行任务或调试代码。

## 4. 性能门禁

提交发布候选版本前，在本地 SSD 上至少运行：

```bash
npm run benchmark
npm run benchmark:10gb
```

100 MiB 基准用于每次候选版本检查；本地吞吐目标为 `100 MB/s` 以上，GitHub 共享 runner 使用 `70 MB/s` 的抗抖动下限。10 GiB 基准适合本地或定期运行。记录机器、Node 版本、文件形状和结果，不要直接比较不同硬件上的绝对时间。

## 5. Marketplace 发布

正式发布需要一个 Azure DevOps 账号和 Marketplace Publisher：

1. 在 [Azure DevOps](https://dev.azure.com/) 登录或创建组织。
2. 在 [Visual Studio Marketplace 管理页](https://marketplace.visualstudio.com/manage) 创建/确认 Publisher ID `daucloud`，使其与 `package.json` 的 `publisher` 完全一致。
3. 创建只授予 **Marketplace → Manage** 范围的 Personal Access Token（PAT）。不要把 PAT 写入仓库、README、终端日志或截图。
4. 在本机通过 `vsce` 登录：

   ```bash
   npx vsce login daucloud
   ```

   按提示粘贴 PAT；也可以在受控 CI Secret 中使用 `VSCE_PAT`。

5. 确认版本号已递增、CHANGELOG 已更新、VSIX 已做最终核对后，再执行：

   ```bash
   npx vsce publish --no-dependencies
   ```

Marketplace 不允许重复发布同一版本号。若要先做预发布验证，使用单独的预发布版本策略，不要覆盖已经发布的稳定版本。

发布后应在干净 Profile 中按扩展 ID 安装，检查图标、README 图片、命令、默认编辑器优先级以及卸载/升级后的 Hot Exit 行为。

## 6. Git 标签与 GitHub Release

待 Marketplace 冒烟测试通过后，再考虑：

```bash
git tag -a v0.1.0 -m "Release v0.1.0"
git push origin v0.1.0
```

GitHub Release 可附上与 Marketplace 相同的 VSIX 和变更摘要。推送前确认远端仓库、分支保护、作者信息和许可证显示正确。

## 发布前勾选

- [ ] 版本号、Publisher、许可证和变更记录一致
- [ ] `npm run check`、`npm test`、`npm run test:vscode` 通过
- [ ] 100 MiB 性能门禁通过；10 GiB 基准已记录（如本次发布要求）
- [ ] VSIX 文件清单已核对，无源码、凭据、测试数据或临时文件
- [ ] 本地安装冒烟测试通过
- [ ] Marketplace Publisher 和 PAT 权限已由负责人复核
- [ ] 发布后升级、卸载和回滚方案已准备
