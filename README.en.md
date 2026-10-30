# dsh-workspace

[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/yh4922/dsh-workspace)
[![npm](https://img.shields.io/npm/v/@yh4922/dsh-workspace?logo=npm)](https://www.npmjs.com/package/@yh4922/dsh-workspace)

[简体中文](./README.md) | English

A remote workspace plugin for DeepSeek Harness (DSH). It manages SSH hosts inside DSH, opens remote terminals, lets you browse and edit remote files and inspect remote Git, and adds remote directories as workspaces, so the Agent's file operations and commands run on the remote machine.

## Features

- **Host management**: nested groups, group defaults inheritance, jump host chains, SOCKS5 / HTTP proxies; host key fingerprints are recorded on first connect (TOFU) and changes are blocked afterwards
- **Credential vault**: passwords, private keys and other secrets are encrypted with a master password (AES-256-GCM + scrypt) and stored locally; optional "remember on this machine" auto-unlock (protected by DPAPI on Windows)
- **SSH terminal**: interactive terminal shared between the page and the sidebar, with automatic reconnect
- **Files** (formerly Remote files; works in local and remote workspaces): file tree, Monaco editor (syntax highlighting, Ctrl+S to save, conflict detection), Markdown / HTML / image preview, context menu (new / upload / download / rename / copy / paste / delete / copy path); can take over the built-in DSH Files sidebar
- **Git repository** (formerly Remote Git; works in local and remote workspaces): changes (stage / discard / commit), diff, commit history with a branch graph; view any branch, and edit and commit to local branches without checking them out
- **Updates**: check GitHub for the latest version and install it from the Settings tab (falls back to the npm registry), or upload an offline .tgz package
- **Add workspace**: takes over DSH's "Add workspace" dialog, letting you pick a local folder (quick places + drives) or a folder on a remote host (grouped by host group)
- **Remote Agent tools**: in a remote workspace session, the Agent's read / write / edit / glob / grep / bash run on the remote host; local sessions are unaffected
- **Sidebar**: built directly into the native DSH right sidebar, for local and remote workspace sessions alike; see "Sidebar" below

## Sidebar

Everything in the right sidebar is registered by this plugin directly in the native DSH right sidebar; no other sidebar plugin is needed.

- **Files**: file name search, automatic folder refresh, Git status colors (M / A / D / U badges and more), "Reference in chat" (@ references) in the context menu, "Open with" (system default app, VS Code / Cursor / Zed, custom URL templates), drag-and-drop upload (folders keep their structure), Ctrl / Shift multi-select with batch actions, "Compress and download" ZIP for a multi-selection
- **File viewer**: file links in chat, deliverable cards and @ references all open in the plugin's viewer (local and remote files alike)
  - Code / text: Monaco editor (Ctrl+S to save, conflict detection)
  - Markdown: single-pane preview / code switch (code mode is editable and savable), with code highlighting, Mermaid, KaTeX math and a floating outline; selected text can be added to the chat
  - HTML: preview / source modes, sandboxed by default, with a temporary sandbox unlock
  - Other formats are rendered by file-viewer: PDF, Word (docx / doc / odt), spreadsheets (xlsx / xls / csv / ods), PPTX / ODP, audio / video, archives (zip) and more; `.ppt` and CAD cannot be previewed and are offered as downloads only; `.rtf` opens as text
- **Git repository**: besides changes, diff and history, a new "AI changes" tab lists the files the model changed in this turn / the whole session and lets you diff them; suspected secrets in diffs are masked by default and can be revealed temporarily
- **Tasks**: background jobs of the current task tree (live output, kill), subagents (tree / graph view), workflow runs and the team board; optionally opens automatically when a new subagent or background job appears
- **Side chat**: fork the current conversation into a side chat in the right sidebar without interrupting the main one; deleting one from the thread list also removes it from the session list on the left (DSH archives it)
- **Terminal**: in a remote workspace session, "New terminal" on the guide page opens the plugin's SSH terminal (connected to the workspace host, in the workspace folder); local sessions keep the DSH terminal unchanged. While this is on, the guide page no longer shows a separate "SSH terminal" card; turning it off brings the card back
- **Tab context menu and pinned tabs**: the right-click menu of any docked right-sidebar tab gains "Close to the left / right / others / all" (within its pane, skipping pinned tabs) and "Pin", plus "Copy path" and "Reveal in file manager" for file tabs (remote-workspace sessions only get "Copy path"); pinned tabs stay leftmost in their pane without a close button, reopen when the sidebar opens, are unpinned when closed, and are kept per session (tabs that can open several times, such as terminals and browsers, cannot be pinned)
- **Entry points**
  - Agent tool `open_in_sidebar`: opens a file, folder or web page in the right sidebar of the current session (remote sessions resolve remote paths)
  - Browser-side client service `dshWorkspace` for other plugins: `openFile(path, { line?, mode? })`, `openTab(kind)`, `reveal(path)`
- **Management page**: the "Remote workspace → Sidebar" tab manages all of the above: tab switches, file associations, ignore rules, large file threshold, default HTML sandbox, `open_in_sidebar` and task page auto-open, the plugin SSH terminal for remote workspaces, custom CSS and the IME guard

### Relationship with dsh-better-sidebar

This plugin now covers all sidebar features of [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) and no longer depends on it. Running both leads to overlapping features; disabling it with one click in the "Remote workspace → Sidebar" tab is recommended (it is only disabled, not uninstalled, and can be re-enabled at any time).

## Requirements

| Requirement | Notes |
| --- | --- |
| DSH | `>= 0.1.5-rc.2` (both 0.1.x and 0.2.x; developed against DSH Desktop 2.0.16 / host 0.2.0-rc.1) |
| Node.js | `>= 20` |

## Installation

Install the latest version from npm (the command carries no version number and always resolves to the newest release):

```bash
dsh plugin --profile <profile> add @yh4922/dsh-workspace
```

You can also install the latest package from [Releases](https://github.com/yh4922/dsh-workspace/releases), or download it and install from a local path (that file name contains the version):

```bash
dsh plugin --profile <profile> add https://github.com/yh4922/dsh-workspace/releases/latest/download/dsh-workspace.tgz
dsh plugin --profile <profile> add /path/to/yh4922-dsh-workspace-<version>.tgz
```

- `<profile>` is the profile to install into, e.g. `web`
- **Upgrading**: run `dsh plugin --profile <profile> remove @yh4922/dsh-workspace` first, then install with the command above. Installing the same package or URL again leaves the dependency value unchanged, so the plugin manager rolls the change back with "Which package was installed cannot be told from the dependency change."
- **Coming from 0.7.7 or earlier**: the package name was `dsh-workspace` back then — run `dsh plugin --profile <profile> remove dsh-workspace` before installing the new name, otherwise both packages stay installed and the old code keeps running
- **DSH Desktop**: the `desktop` profile cannot be managed from the CLI; use "Plugin manager" → "Add plugin" and enter `@yh4922/dsh-workspace` or the URL above. Upgrading means removing the plugin and adding it again — the plugin manager has no "Update" button
- This plugin depends on `ssh2`, which has native build scripts. If pnpm blocks them, click "Allow these scripts and retry" in the plugin manager; on the CLI, approve `ssh2` and `cpu-features` when prompted
- Installing directly from the Git repository URL does not work: the repository does not contain build output (`lib/`)

### Uninstall

```bash
dsh plugin --profile <profile> remove dsh-workspace
```

> Uninstalling or upgrading this plugin while DSH Desktop is running has crashed DSH before. Quit DSH first.

## Usage

1. Open "Remote workspace" from the left sidebar and set a master password on first use
2. Create a host (optionally in a group) and click "Test connection"
3. Use the Hosts / Files / Terminals / Connection log tabs to manage hosts, browse files and open terminals
4. Click DSH's "Add workspace" ("Take over Add workspace" in the Settings tab must be on; it is on by default), pick a remote host and folder to create a remote workspace
5. Open "Files", "Git repository", "Tasks" and "Side chat" from the right sidebar in any session (local or remote workspace); remote workspace sessions also have "SSH terminal". Each tab can be switched on or off in the Sidebar tab
6. The Settings tab also has the auto-unlock switch, version info and links such as the [changelog](./CHANGELOG.md) (in Chinese)

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

- Integration tests against real hosts are skipped by default; set `DSHWS_IT=1` and provide the test host through environment variables, then run `pnpm test:it`
- The build scripts (`scripts/`) are not in the repository yet, so a fresh clone cannot run the full `pnpm build`

### Packaging and releasing

| Command | Purpose |
| --- | --- |
| `npm run pack:dev` | Development package: version is "next patch-dev.timestamp", kept only in the local `pack/`; `package.json` is not changed and nothing is pushed |
| `npm run release -- [patch\|minor\|major]` | Release: bump the version, finalize the "未发布" (Unreleased) section of `CHANGELOG.md`, build and pack, commit and push the tag, create a GitHub Release with the package attached, and publish the same package to npm |
| `npm run release -- --dry-run --allow-dirty` | Rehearsal: checks, builds and packs only (no npm publish, nothing committed or pushed); files are restored afterwards |

Before releasing: be on `main` with no uncommitted changes, in sync with the remote, with the release notes written under "未发布", and with `npm login` done on this machine (publishing goes to `registry.npmjs.org`; without a login the release fails at the pre-flight checks).

## Security

- Credentials are stored only on this machine, encrypted with the master password; the master password itself is never written to disk
- The system prompt of remote workspace sessions tells the Agent not to commit, push, `reset --hard` or rebase unless the user explicitly asks
- Remote commands are not confined by the local sandbox; in read-only sandbox mode writes and bash are rejected

## License

MIT
