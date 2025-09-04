# CSS Snippets Manager

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![AI-authored](https://img.shields.io/badge/author-AI-orange.svg)](#)

## 简介（中文）
CSS Snippets Manager 是一个用于 Obsidian 的插件，旨在帮助用户管理本地与 GitHub 云端的 CSS 片段（snippets）。核心功能包括：

- 浏览、搜索与排序本地和云端 CSS 片段
- 从云端下载、上传、删除片段并支持增量同步与强制覆盖
- 在编辑器中新建/保存 CSS 片段并可自动启用或打开编辑器
- 实时获取云端文件列表（无缓存），并提供性能监控与错误提示

注意：本插件及其代码由 AI 自动生成与实现，100% 由 AI 完成（用于演示与说明）。

## 功能亮点（中文）
- 实时云端列表：每次刷新直接从 GitHub 拉取最新列表，保证数据最新
- 统一通知系统：操作反馈通过一致的通知接口显示，避免重复提示
- 自动/手动同步：支持自动同步、手动增量同步和冲突覆盖策略
- 易用的 UI 操作：在插件视图中可直接上传、下载、打开文件夹和编辑片段

## 通过 BRAT 安装（中文）
如果你使用 Obsidian 并安装了 BRAT（Browse Repositories And Themes 或类似功能的插件），可按下面步骤安装该插件：

1. 在 Obsidian 中打开设置 → Community plugins → 关闭 Safe mode（如果尚未关闭）。
2. 在 Community plugins 中搜索并安装 `BRAT`（或同类的“从 GitHub 安装”插件）。
3. 打开 BRAT 的界面或使用命令面板中的 BRAT 命令，选择“Install from GitHub”或“Install repository”。
4. 在弹出的输入框中粘贴本仓库的 GitHub 地址，例如：
   `https://github.com/WisOcean/CSS-Snippets-Manager`
5. 确认安装并在 Community plugins 列表中启用 `CSS Snippets Manager`。

如果 BRAT 不可用，可手动安装：将编译好的 `main.js`、`manifest.json` 与其他所需文件放入 Obsidian 配置目录下的 `plugins/<your-plugin-folder>/`，然后在 Community plugins 中启用。

## 构建与手动安装（中文）
如果你从源代码安装或想自行构建：

1. 在项目目录中安装依赖：

```bash
npm install
```

2. 构建生产文件：

```bash
npm run build
```

3. 将生成的 `main.js`、`manifest.json`、`styles.css`（如存在）复制到 Obsidian 插件目录：

```
<你的Obsidian配置目录>/plugins/css-snippets-manager/
```

4. 在 Obsidian 的 Community plugins 中启用插件。

## 仓库地址

```
https://github.com/WisOcean/CSS-Snippets-Manager
```

## 使用示例（中文）
1. 打开插件视图：命令面板 → "Open CSS Snippets Manager"
2. 点击云端标签页（Cloud），点击 "🔄 刷新" 获取实时云端列表
3. 选中某个片段：可直接下载、删除或打开编辑器进行修改
4. 使用同步按钮进行增量或强制同步；出现冲突时选择覆盖或跳过

## English — Overview
CSS Snippets Manager is an Obsidian plugin to manage local and GitHub-hosted CSS snippets. Main features:

- Browse, search and sort local and cloud snippets
- Download, upload, delete snippets and support incremental sync and force-overwrite
- Create and save snippets in an editor pane, with optional auto-enable and auto-open
- Real-time cloud list retrieval (no caching), performance metrics and robust error handling

Note: This plugin and its code were generated and implemented by AI. The implementation is 100% completed by AI (for demonstration and disclosure purposes).

## Features (English)
- Real-time cloud listing: always fetch the latest file list from GitHub
- Unified notifications: consistent user feedback and reduced duplicate messages
- Auto / manual sync: automatic sync, incremental sync, and conflict resolution options
- Convenient UI: upload/download/open folder/edit directly from the plugin view

## Install via BRAT (English)
If you use Obsidian and have BRAT (or a similar "Install from GitHub" helper plugin), install as follows:

1. In Obsidian: Settings → Community plugins → disable Safe mode (if not already off).
2. Install BRAT (or an equivalent plugin that allows installing from GitHub) from the Community plugins gallery.
3. Open BRAT (or trigger it via the command palette) and choose "Install from GitHub" or "Install repository".
4. Paste the repository URL, e.g. `https://github.com/WisOcean/CSS-Snippets-Manager` and confirm.
5. After installation, enable `CSS Snippets Manager` in Community plugins.

Manual install: copy the built `main.js`, `manifest.json`, and other required files into your Obsidian vault's `plugins/<your-plugin-folder>/` directory, then enable the plugin in Community plugins.

## Build & Manual Install (English)
If you prefer to build from source or install manually:

1. Install dependencies in the project folder:

```bash
npm install
```

2. Build production bundle:

```bash
npm run build
```

3. Copy the generated `main.js`, `manifest.json`, and (if present) `styles.css` into your Obsidian plugins folder:

```
<your-obsidian-config>/plugins/css-snippets-manager/
```

4. Enable the plugin in Obsidian's Community plugins.

## Repository

```
https://github.com/WisOcean/CSS-Snippets-Manager
```

## Quick usage example (English)
1. Open the plugin view: Command palette → "Open CSS Snippets Manager"
2. Switch to the Cloud tab and click "🔄 Refresh" to fetch real-time cloud list
3. Select a snippet to download, delete or open for editing
4. Use sync controls for incremental or force-overwrite sync; follow prompts on conflicts

## Support & License
- License: See `LICENSE` in this repository.
- For issues or feature requests, please open an issue on the repository.

## Contributing
欢迎提交 issue 或 PR。请在提交更改前确保代码通过本地构建（`npm install` + `npm run build`）。

## Security
如果你发现安全问题或敏感凭据泄露，请不要在 issue 中公开描述细节；可通过仓库提供的联系方式私下报告。

---

*This README is bilingual (中文 / English) and includes a disclosure that the plugin implementation is AI-authored.*
