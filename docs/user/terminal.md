# Terminal history

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
