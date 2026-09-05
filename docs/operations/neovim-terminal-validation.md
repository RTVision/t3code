# Validate the external Neovim launcher

Validate the desktop integration through Settings → Editors and the Open menu.
The standalone harness below can isolate transport failures. Keep the feature PR
in draft until the packaged Windows and interactive SSH checks pass.

Build the Windows desktop from this branch using the normal desktop artifact
procedure. Use the resulting packaged executable: a development Node process
does not verify the shipped runtime or the external window's lifetime.

Create a private JSON request file on Windows. For direct WSL:

```json
{
  "version": 1,
  "id": "19541794-037e-4ac1-bccb-ed6fc9f2bcaa",
  "platform": "linux",
  "route": {
    "kind": "wsl",
    "distro": "Ubuntu",
    "user": "alice",
    "node": "/usr/bin/node"
  },
  "workspace": "/home/alice/project-worktree",
  "target": {
    "kind": "file",
    "path": "/home/alice/project-worktree/example.txt",
    "line": 2,
    "column": 5,
    "columnEncoding": "utf-16"
  }
}
```

Use the actual connected distro and account, and verify the absolute Node path
under that account first. The harness accepts an explicit runtime
path. Without it, the helper requires Node.js in the selected account’s login PATH.
An optional top-level `executable` specifies an absolute Neovim path. Otherwise
Neovim is resolved in the target's Bash login environment and checked with
`--version` before editing with its normal configuration.

For native Windows SSH, replace `route` with:

```json
{
  "kind": "ssh",
  "host": "saved-ssh-alias",
  "sshUser": "alice",
  "port": 2222,
  "remoteNode": "/usr/bin/node"
}
```

For SSH inside WSL, use `kind: "wsl-ssh"` and include both sets of fields. Alias
configuration, ProxyJump, keys and known hosts come from the selected account.
Do not supply passwords or keys in the request. For native Windows Neovim, use
`route: { "kind": "native" }`, `platform: "win32"` and Windows paths.

Run from PowerShell, replacing these paths with the packaged installation and
your request file:

```powershell
$runtime = 'C:\path\to\T3 Code (Alpha).exe'
$helper = 'C:\path\to\resources\neovim-terminal\spike.mjs'
$env:ELECTRON_RUN_AS_NODE = '1'
& $runtime $helper 'C:\path\to\request.json'
Remove-Item Env:ELECTRON_RUN_AS_NODE
```

The harness opens a new Windows Terminal window. It does not modify T3 settings
or connect to the app's managed SSH tunnel. It reports only terminal acceptance;
authentication and editor startup can still fail in the new window. The fixed
PowerShell wrapper holds failures until Enter is pressed.

Validate each route on the packaged Windows desktop:

1. Confirm exactly one new window, then close T3 Code and continue editing there.
   Check actual keyboard edits, not only a successful launch or rendered screen.
   The packaged Electron helper must open the Windows console input device for
   interactive children: PowerShell can give a GUI executable a pipe as stdin.
   Preparation still uses its separate stdin pipe.
2. Use the active worktree and two WSL distros/accounts. Changing WSL defaults
   must not redirect an explicit route.
3. Verify native SSH and WSL SSH alias, nondefault port, ProxyJump, key-passphrase,
   password and first-time host-key prompts. Failed authentication must remain
   visible. Do not weaken host-key checking to make a test pass.
4. Compare received filenames containing spaces, quotes, semicolons, dollar
   substitutions, backticks, Unicode, newlines, colons and leading dashes. Confirm
   that no extra command executes and keyboard input reaches Neovim normally.
5. On a second line containing `a雪😀z`, UTF-16 column 5 must select `z`, Neovim
   byte column 9. Verify normal configuration and plugin subprocess PATH.

In the integrated client, verify automatic discovery, explicit preference persistence,
Rescan after installation, and the unavailable/SSH sign-in states. Test the header,
Open keybinding, markdown file links, terminal links, diffs, changed files, file
preview and Settings file actions. Switch environments during a probe and reconnect:
neither stale results nor a previous launch should be replayed. A browser or older
desktop should explain the desktop capability limit for a remembered Neovim choice.

Staging uses private account-owned directories, removes consumed payloads before
starting Neovim, and bounds stale cleanup. Installation paths containing semicolons,
quotes or newlines are rejected by the Windows Terminal adapter.

Run focused local checks with:

```sh
vp test run apps/desktop/scripts/neovim-terminal/transport.test.mjs scripts/build-desktop-artifact.test.ts
T3CODE_TEST_NVIM=/absolute/path/to/nvim vp test run apps/desktop/scripts/neovim-terminal/transport.test.mjs
```

These tests prove local staging and argument behavior. They do not substitute for
the Windows, interactive SSH, packaging and lifetime checks above.
