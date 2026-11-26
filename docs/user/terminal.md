# Terminal

T3 Code includes integrated terminals running on the environment's host machine, with persistent scrollback across reconnects.

## Choose a shell

Set `T3CODE_TERMINAL_SHELL` in the T3 server's environment to an executable name or full path (no quotes or arguments) to override the platform default shell for new terminals. This does not affect agent commands or project setup/settle scripts.

Example for Git Bash on Windows (PowerShell, then fully quit and reopen T3 Code):

```powershell
[Environment]::SetEnvironmentVariable('T3CODE_TERMINAL_SHELL', 'C:\Program Files\Git\bin\bash.exe', 'User')
```

> Note: Use `bin\bash.exe`, not `git-bash.exe`. Remove with `$null` to restore the default.

## Scrollback and navigation

Each terminal retains up to **5,000 lines** and **8 MiB** of scrollback on the server.

| Action                     | macOS                              | Windows / Linux                            |
| -------------------------- | ---------------------------------- | ------------------------------------------ |
| Scroll page up/down        | `Shift+PageUp` / `Shift+PageDown`  | `Shift+PageUp` / `Shift+PageDown`          |
| Jump to start / latest     | `Cmd+Shift+Home` / `Cmd+Shift+End` | `Ctrl+Shift+Home` / `Ctrl+Shift+End`       |
| Select all retained output | `Cmd+A`                            | `Ctrl+Shift+A` (`Ctrl+A` stays shell home) |
| Next / previous terminal   | `Cmd+Shift+]` / `Cmd+Shift+[`      | `Ctrl+Alt+]` / `Ctrl+Alt+[`                |

On iOS/iPadOS, long-press the terminal to paste or choose **Select Text**.

## Open Neovim in a separate window

On the Windows desktop app, install Windows Terminal and install Neovim in the
project's environment. Choose **Neovim (Terminal)** from the Open editor menu.
Subsequent editor actions use that choice for the environment, including file
links and file positions. Project opens use the active worktree. The separate
terminal session continues when you close T3 Code.

**Settings → Editors** lets you change the preferred editor, rescan after an
installation, or set an absolute Neovim executable path for an environment.
Detection and launch use the target account's Bash login PATH for WSL and Linux
SSH environments; interactive-only shell aliases are not supported. The account
also needs Node.js for the launcher. WSL uses the connected backend's Node.js
runtime when available; SSH hosts need Node.js in the account's login PATH.

Remote projects must use a saved SSH environment configured in
**Settings → Connections**. The session uses that environment's native Windows
or WSL SSH credentials. If detection requires SSH sign-in, choose the labeled
**Check on open** option and authenticate in the new terminal. Changing the SSH
runner, WSL distro or account can require reconnecting the saved environment.
SSH may ask for authentication twice: once to prepare the helper and once to open
the editor session.

External terminal launching requires the Windows desktop app with terminal editor
support. Browser, mobile and older desktop clients retain their existing GUI
editor options; clients without terminal editor support explain that limit for a
saved Neovim choice.

## fish shell

T3 Code launches `fish` with `no-query-term` to avoid startup delays, which overrides universal `fish_features`. To keep custom flags or re-enable `query-term`, export `fish_features` in the environment that launches T3 Code.
