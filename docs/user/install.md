# Install T3 Code

T3 Code runs coding agents on your computer (or server) and lets you control them from the desktop app, web app, or mobile app. Install T3 Code on the machine where your agents will run first.

## Requirements

The `@rtvision/t3` npm package runs on Node.js 22.19+ in the 22.x line,
23.11+ in the 23.x line, or 24.10 and later. Install Node.js and npm on the
server and connect to RTVision's network to reach its npm registry. The desktop
app includes its server runtime.

SSH hosts use a standalone archive when it is available and compatible. Hosts
such as Alpine need Node.js and npm for the fallback installation.

You need at least one installed, authenticated coding agent (provider) before starting a thread. You can launch T3 Code first and set up providers from the [Welcome page](./welcome-page.md) or **Settings → Providers**.

## Command line

Run the RTVision CLI with Node.js and npm:

```bash
npx --registry=https://npm-registry.rtvision.com/ @rtvision/t3@latest
```

If you already have the RTVision `t3` command on your PATH, use it directly.

| Task                          | Command                                                                 |
| ----------------------------- | ----------------------------------------------------------------------- |
| Start server and open web app | `t3` (or `t3 ./my-project`)                                             |
| Start server without browser  | `t3 serve`                                                              |
| Set up remote access          | `t3 up` ([Remote access](./remote-access.md))                           |
| Run in the background         | `t3 service install` ([Background service](./background-service.md))    |
| Update                        | `t3 update`                                                             |
| Reclaim database space        | `t3 doctor` ([Details](./background-service.md#reclaim-database-space)) |
| Uninstall                     | `t3 uninstall`                                                          |

If `t3` reports a server is already running, connect with `t3 pair` or pass a separate `--base-dir`. Run `t3 --help` for all commands.

## Desktop app

Download the Windows x64 or Linux x64 installer from
[RTVision GitHub Releases](https://github.com/RTVision/t3code/releases).
Desktop installers are unsigned.

### The `t3` command

The desktop app bundles `t3` and sets it up on first launch (manage anytime under **Settings → About → t3 command**). Use **Add to PATH** if needed, then open a new terminal.

- **Open a folder in the running desktop app**: Run `t3 app` (or `t3 app ../my-project`) from a terminal, or drag folders from your file manager onto the desktop sidebar.

### Windows Subsystem for Linux

Select a WSL distro in **Settings → Sharing & access** to run agents and projects inside WSL (install provider CLIs inside that distro). T3 Code manages its own server runtime inside WSL automatically.

The bundled Linux runtime needs `libatomic.so.1`. On Debian or Ubuntu, install
it inside the WSL distro with `sudo apt-get update && sudo apt-get install libatomic1`.
If a startup failure switched the app to Windows, re-enable the WSL backend in
**Settings → Sharing & access** after installing the library.

## Mobile app

Install from the [App Store](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824) or [Google Play](https://play.google.com/store/apps/details?id=com.t3tools.t3code) (QR codes are also in **Settings → About → Mobile app**). The mobile app connects to a server on another machine via [remote access](./remote-access.md).

- Store builds work with both Stable and Nightly servers. Optional Android beta APKs are under [Android beta releases](https://github.com/RTVision/t3code/releases?q=android-beta-).
- If the mobile app crashes on launch, open **Settings → Diagnostics** on the next launch to copy recent startup crash reports.

## Providers

Open **Settings → Providers** (web or desktop), select the environment, and enable the providers you use. Installation and sign-in always happen on the **environment's machine**.

| Provider         | Install and authenticate                                                                                                 | Guide                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| **Codex**        | Connect with ChatGPT in Settings, or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`. | [Codex](./providers-codex.md)             |
| **Claude**       | Install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`.                               | [Claude](./providers-claude.md)           |
| **Cursor**       | Sign in in Settings or install [Cursor CLI](https://cursor.com/cli) and run `agent login`.                               | [Cursor](./cursor.md)                     |
| **Grok Build**   | Install [Grok Build CLI](https://x.ai/cli) and run `grok login`.                                                         | [Grok](./providers-grok.md)               |
| **Antigravity**  | Install managed runtime and sign in with Google in Settings.                                                             | [Antigravity](./providers-antigravity.md) |
| **OpenCode**     | Install [OpenCode](https://opencode.ai) and run `opencode auth login`.                                                   | [OpenCode](./providers-opencode.md)       |
| **Kiro**         | Install [Kiro CLI](https://kiro.dev/docs/cli/) and run `kiro-cli login`.                                                 | [Kiro](./providers-kiro.md)               |
| **Pi**           | Install [Pi](./providers-pi.md) (Node.js 22.19+) and run `pi` → `/login`.                                                | [Pi](./providers-pi.md)                   |
| **Muse Code**    | Install [Muse Code](https://dev.meta.ai/docs/muse-code) and run `muse login`.                                            | [Muse Code](./providers-muse.md)          |
| **fx**           | Install [fx](https://fx.sh) and run `fx login`.                                                                          | [fx](./providers-fx.md)                   |
| **ACP Registry** | Add GitHub Copilot and other agents in **Settings → Providers → Add provider → Show more**.                              | [ACP](./providers-acp.md)                 |

- **Binary path**: If a CLI isn't on the server's `PATH` (common with version managers), set **Binary path** in the provider's settings.
- **Updates**: Click **Update now** on outdated provider cards (supports Homebrew, mise `latest`, npm/pnpm/Yarn/Bun/Volta/Vite+, or the CLI's own updater; update Nix, Chocolatey, or pinned mise installs manually).
- **Multiple instances**: Add extra provider instances for separate accounts, API keys, or custom endpoints (mark secret env vars as sensitive).

### Provider check timeouts

If a working CLI times out during T3 Code's readiness check, increase its probe deadline (in milliseconds) in the server's environment (or systemd override / `service.env`) and restart:

```bash
T3CODE_CODEX_PROBE_TIMEOUT_MS=60000 T3CODE_CLAUDE_PROBE_TIMEOUT_MS=60000 t3 serve
```

| Provider     | Environment variable                   |
| ------------ | -------------------------------------- |
| Codex        | `T3CODE_CODEX_PROBE_TIMEOUT_MS`        |
| Claude       | `T3CODE_CLAUDE_PROBE_TIMEOUT_MS`       |
| Cursor       | `T3CODE_CURSOR_PROBE_TIMEOUT_MS`       |
| Antigravity  | `T3CODE_ANTIGRAVITY_PROBE_TIMEOUT_MS`  |
| Grok         | `T3CODE_GROK_PROBE_TIMEOUT_MS`         |
| Kiro         | `T3CODE_KIRO_PROBE_TIMEOUT_MS`         |
| fx           | `T3CODE_FX_PROBE_TIMEOUT_MS`           |
| Pi           | `T3CODE_PI_PROBE_TIMEOUT_MS`           |
| Muse Code    | `T3CODE_MUSE_PROBE_TIMEOUT_MS`         |
| OpenCode     | `T3CODE_OPENCODE_PROBE_TIMEOUT_MS`     |
| ACP Registry | `T3CODE_ACP_REGISTRY_PROBE_TIMEOUT_MS` |

## Next steps

- [User guide index](./README.md): overview of how T3 Code works.
- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): control when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Updating T3 Code](./updating.md): keep apps, servers, and providers up to date.
