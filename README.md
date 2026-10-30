# dsh-workspace

[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/yh4922/dsh-workspace)
[![npm](https://img.shields.io/npm/v/@yh4922/dsh-workspace?logo=npm)](https://www.npmjs.com/package/@yh4922/dsh-workspace)

简体中文 | [English](./README.en.md)

DeepSeek Harness（DSH）的远程工作区插件：在 DSH 里管理 SSH 主机，打开远程终端、浏览和编辑远程文件、查看远程 Git，并把远程目录添加为工作区，让 Agent 的读写和命令都作用在远程机器上。

## 功能

- **主机管理**：多层分组、组默认值继承、跳板机链、SOCKS5 / HTTP 代理；首次连接记录主机指纹（TOFU），之后指纹变化会拦截
- **凭据保险箱**：密码、私钥等敏感字段用主密码加密（AES-256-GCM + scrypt）后保存在本机；可选「在本机记住」自动解锁（Windows 用 DPAPI 保护）
- **SSH 终端**：交互式终端，页面与侧边栏共用同一会话，断线自动重连
- **文件管理**（原「远程文件」，本地与远程工作区通用）：目录树、Monaco 编辑器（语法高亮、Ctrl+S 保存、冲突检测）、Markdown / HTML / 图片预览、右键菜单（新建 / 上传 / 下载 / 重命名 / 复制 / 粘贴 / 删除 / 复制路径）；可接管 DSH 自带的「文件」侧栏
- **Git 仓库**（原「远程 Git」，本地与远程工作区通用）：改动（暂存 / 放弃 / 提交）、diff、带分叉图的提交历史；可查看任意分支，本地分支不检出也能直接修改和提交
- **检查更新**：全局配置里一键检查 GitHub 最新版本并下载安装（GitHub 不通时回退 npm 官方源），也可上传离线 .tgz 包升级
- **添加工作区**：接管 DSH 的「添加工作区」弹窗，可选本机目录（快捷位置 + 盘符）或远程主机目录（按分组展示）
- **远程 Agent 工具**：远程工作区会话里，Agent 的 read / write / edit / glob / grep / bash 都在远程主机上执行，本地会话不受影响
- **侧边栏**：直接挂在 DSH 原生右侧栏，本地与远程工作区会话通用，详见下方「侧边栏」

## 侧边栏

右侧栏的全部能力由本插件直接注册到 DSH 原生右栏，不需要安装其他侧边栏插件。

- **文件管理**：文件名搜索、目录自动刷新、Git 状态着色（M / A / D / U 等徽标）、右键「在对话中引用」（@ 引用）、「打开方式」（系统默认应用、VS Code / Cursor / Zed、自定义 URL 模板）、拖放上传（文件夹保留目录结构）、Ctrl / Shift 多选与批量操作、多选「压缩并下载」ZIP
- **文件查看器**：聊天里的文件链接、交付卡片、@ 引用统一由插件查看器打开（本机与远程文件都可以）
  - 代码 / 文本：Monaco 编辑器（Ctrl+S 保存、冲突检测）
  - Markdown：预览 / 代码单栏切换（代码模式可编辑保存），支持代码高亮、Mermaid、KaTeX 公式、浮动目录；选中文字可「加入对话」
  - HTML：预览 / 源码双模式，默认沙箱，可临时解除沙箱
  - 其他格式由 file-viewer 渲染：PDF、Word（docx / doc / odt）、表格（xlsx / xls / csv / ods）、PPTX / ODP、音视频、压缩包（zip）等；`.ppt`、CAD 不支持预览，只提供下载；`.rtf` 按文本打开
- **Git 仓库**：改动、diff、提交历史之外，新增「AI 改动」页签，按本轮 / 全部会话列出模型改过的文件并可对比；diff 中的疑似密钥默认打码，可临时显示原文
- **任务**：当前任务树的后台任务（实时输出、终止）、子代理（树 / 拓扑图）、工作流运行与团队看板；可设置出现新子代理 / 后台任务时自动打开
- **侧边对话**：分叉当前会话，在右侧栏开一个不打断主对话的侧边对话；在线程列表里删除时会一并从左侧会话列表移除（DSH 归档）
- **终端**：远程工作区会话里，引导页的「新建终端」直接打开插件 SSH 终端（连到工作区主机、进入工作区目录）；本机会话保持 DSH 自带终端不变。此时引导页不再单独显示「SSH 终端」卡片，关闭该接管后恢复显示
- **标签右键菜单与固定标签**：右侧栏任意停靠标签的右键菜单增加「关闭左侧 / 右侧 / 其他 / 全部」（只作用于所在窗格、跳过固定标签）与「固定」，文件标签另有「复制路径」「在文件管理中显示」（远程工作区会话只有「复制路径」）；固定的标签排在窗格最左、不显示关闭按钮，打开侧边栏时自动补开，关闭即取消固定，按会话分别保存（终端、浏览器等可开多个的标签不能固定）
- **对外入口**
  - Agent 工具 `open_in_sidebar`：在当前会话右侧栏打开文件、文件夹或网页（远程会话按远程路径解析）
  - 浏览器端客户端服务 `dshWorkspace`，供其他插件调用：`openFile(path, { line?, mode? })`、`openTab(kind)`、`reveal(path)`
- **管理页**：「远程工作区 → 侧边栏」页签集中管理以上能力：各标签开关、文件关联、忽略规则、大文件阈值、HTML 沙箱默认值、`open_in_sidebar` 与任务页自动打开、远程工作区使用插件 SSH 终端、自定义 CSS、输入法守卫

### 与 dsh-better-sidebar 的关系

本插件已全部覆盖 [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) 的侧边栏功能，不再依赖它。两者同时启用会出现功能重叠，建议在「远程工作区 → 侧边栏」页签里一键禁用它（只禁用不卸载，可随时重新启用）。

## 依赖

| 依赖 | 说明 |
| --- | --- |
| DSH | `>= 0.1.5-rc.2`（同时兼容 0.1.x 与 0.2.x；开发基于 DSH Desktop 2.0.16 / 宿主 0.2.0-rc.1） |
| Node.js | `>= 20` |

## 安装

从 npm 安装最新版（命令不带版本号，自动装最新一版）：

```bash
dsh plugin --profile <profile> add @yh4922/dsh-workspace
```

也可以装 [Releases](https://github.com/yh4922/dsh-workspace/releases) 里的最新安装包，或下载后用本地路径安装（文件名带版本号）：

```bash
dsh plugin --profile <profile> add https://github.com/yh4922/dsh-workspace/releases/latest/download/dsh-workspace.tgz
dsh plugin --profile <profile> add /path/to/yh4922-dsh-workspace-<版本>.tgz
```

- `<profile>` 是要安装到的 profile，例如 `web`
- **升级**：先 `dsh plugin --profile <profile> remove @yh4922/dsh-workspace`，再用上面的命令安装。对同一个包/地址再装一次时，插件管理器判断不出这次装的是哪个包（依赖值没有变化），会回滚并提示「无法从依赖变更中确定安装了哪一个包」
- **0.7.7 及更早版本的用户**：当时的包名是 `dsh-workspace`，请先 `dsh plugin --profile <profile> remove dsh-workspace` 再装新包名；否则会同时存在两个包，运行的仍是旧代码
- **DSH Desktop**：`desktop` profile 不能用命令行管理，请在「插件管理」→「添加插件」里填入 `@yh4922/dsh-workspace` 或上面的地址；升级同样是先移除、再添加（插件管理里没有「更新」按钮）
- 本插件依赖 `ssh2`，其中有原生构建脚本。pnpm 拦下构建时，在插件管理的失败界面点「允许这些脚本并重试」；命令行安装则按提示放行 `ssh2`、`cpu-features`
- 不能直接从 Git 仓库地址安装：仓库里没有编译产物（`lib/`）

### 卸载

```bash
dsh plugin --profile <profile> remove dsh-workspace
```

> 在 DSH Desktop 运行时卸载或升级本插件，曾导致 DSH 崩溃。建议先退出 DSH 再操作。

## 使用

1. 左侧栏打开「远程工作区」，第一次使用时设置主密码
2. 新建主机（可以放进分组），点「测试连接」确认能连上
3. 在「主机 / 文件 / 终端 / 连接日志」几个页签里管理主机、浏览文件、打开终端
4. 点 DSH 的「添加工作区」（「全局配置」页签里的「接管『添加工作区』」需开启，默认开启），选择远程主机和目录，即可创建远程工作区
5. 在会话右侧栏可以打开「文件管理」「Git 仓库」「任务」「侧边对话」（本地与远程工作区都可用）；远程工作区会话还有「SSH 终端」。各标签可在「侧边栏」页签里开关
6. 「全局配置」页签里还有自动解锁开关，以及版本信息、[更新日志](./CHANGELOG.md)等链接

## 开发

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

- 真机集成测试默认跳过，设置 `DSHWS_IT=1` 并通过环境变量提供测试主机后运行 `pnpm test:it`
- 目前构建脚本（`scripts/`）没有放进仓库，单独克隆后暂时不能完整执行 `pnpm build`

### 打包与发布

| 命令 | 用途 |
| --- | --- |
| `npm run pack:dev` | 开发调试包：版本号为「下一个 patch-dev.时间戳」，只放在本机 `pack/`，不改 `package.json`、不推送 |
| `npm run release -- [patch\|minor\|major]` | 正式发布：累加版本号，把 `CHANGELOG.md` 的「未发布」定稿为新版本，构建打包，提交并推送 tag，创建附带安装包的 GitHub Release，并把同一个包发布到 npm |
| `npm run release -- --dry-run --allow-dirty` | 发布演练：只检查、构建和打包（不发 npm、不提交不推送），结束后还原 |

发布前要求：在 `main` 分支、没有未提交改动、与远程同步，「未发布」下已写好本次的更新日志，且本机已 `npm login`（发布到 `registry.npmjs.org`，未登录会在前置检查阶段直接失败）。

## 安全说明

- 凭据只保存在本机，并用主密码加密；主密码本身不落盘
- 远程工作区会话的系统提示词会要求 Agent：没有用户明确要求时，不执行 commit、push、`reset --hard`、rebase
- 远程命令不受本机沙箱约束，只读沙箱模式下会拒绝写入和 bash

## 许可证

MIT
