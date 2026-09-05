# Terminal history

Each terminal keeps up to 5,000 lines and 8 MiB of scrollback on its environment
server. T3 Code removes the oldest output when either limit is reached. A long
line can be shortened at the start. New terminal output is not truncated.

These limits apply when you reconnect and when T3 Code restores saved terminal
history. A client can show less scrollback than the server keeps.

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
also needs Node.js in that login PATH for the launcher.

Remote projects must use a saved SSH environment configured in
**Settings → Connections**. The session uses that environment's native Windows
or WSL SSH credentials. If detection requires SSH sign-in, choose the labeled
**Check on open** option and authenticate in the new terminal. Changing the SSH
runner, WSL distro or account can require reconnecting the saved environment.

External terminal launching requires the Windows desktop app with terminal editor
support. Browser, mobile and older desktop clients retain their existing GUI
editor options; clients without terminal editor support explain that limit for a
saved Neovim choice.
