# Terminal

## Choose a shell

Set `T3CODE_TERMINAL_SHELL` in the environment that launches the T3 Code server
to choose the executable used for new terminals. Use an executable name or its
full path, without surrounding quotes or command-line arguments. An unset or
blank value keeps the platform default. If the executable cannot be started,
T3 Code tries its usual fallback shells.

On Windows, to use Git Bash from a standard Git for Windows installation, run
this in PowerShell:

```powershell
[Environment]::SetEnvironmentVariable('T3CODE_TERMINAL_SHELL', 'C:\Program Files\Git\bin\bash.exe', 'User')
```

Fully quit T3 Code, then reopen it from the Start menu and create a new terminal.
If the app still inherits the old environment, sign out of Windows and sign in
again. Git Bash starts as an interactive login shell. Use `bin\bash.exe`, not
`git-bash.exe`, which launches a separate terminal window.

To restore the default, remove the variable with the same command using `$null`
as its second argument, then restart T3 Code.

This setting belongs to the machine hosting the server, including when you
connect from another device. It does not change provider-run commands or the
shell used by automatic project setup and settle scripts.

## Terminal history

Each terminal keeps up to 5,000 lines and 8 MiB of scrollback on its environment
server. T3 Code removes the oldest output when either limit is reached. A long
line can be shortened at the start. New terminal output is not truncated.

These limits apply when you reconnect and when T3 Code restores saved terminal
history. A client can show less scrollback than the server keeps.

On web and desktop, use Shift+PageUp and Shift+PageDown to read scrollback
without leaving terminal input. Ctrl+Shift+Home and Ctrl+Shift+End jump to the
start and latest output; use Cmd instead of Ctrl on macOS. Full-screen terminal
programs keep these navigation keys.

To copy all retained output, choose Select all in the terminal's context menu,
then copy. Cmd+A on macOS and Ctrl+Shift+A elsewhere select the same output.
Ctrl+A still moves to the beginning of shell input on Windows and Linux.
Jump to latest in the context menu returns to the current output.

While a terminal is focused, use `Cmd+Shift+]` for the next terminal and `Cmd+Shift+[` for
the previous one on macOS. On Windows and Linux, use `Ctrl+Alt+]` and `Ctrl+Alt+[`. Cycling
wraps through tabs and split panes in the focused drawer or right panel. Rebind these
shortcuts in Settings > Keybindings.

On iPhone and iPad, long-press the terminal to paste or to choose Select Text.
Select Text shows the visible output, where you can copy text or tap a link.

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

## fish

T3 Code starts fish with `no-query-term`, avoiding startup waits for terminal
replies. This disables optional fish features that depend on those replies.
T3 Code's exported `fish_features` also hides any universal flags you set with
`set -U fish_features`.

To preserve those flags or enable queries with `query-term`, include them in
`fish_features` in the environment that launches T3 Code. A shell export applies
when you launch T3 Code from that shell; it does not configure a desktop app
launched from the Dock or Finder. Enabling queries can restore the startup wait.
