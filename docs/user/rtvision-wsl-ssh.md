# RTVision T3 Code: SSH through WSL

This guide connects the RTVision Windows desktop app to a remote Linux host using
SSH credentials from a local WSL distro. Projects and agents run on the remote
host; WSL supplies the SSH configuration, keys, and agent.

The setup below was checked with RTVision desktop **0.0.41**, WSL **Debian**, and
an Alpine Linux SSH host on **September 8, 2026**. The remote server installation
and the desktop's generated launcher were verified, including an HTTP 200
startup check with temporary server data. A completed connection in the desktop
was not verified during that check.

## 1. Prepare the desktop and WSL

Install the **RTVision fork** of the Windows desktop app. Its updates come from
`RTVision/t3code`. A version number alone does not identify which fork is installed.

Inside the WSL distro you intend to use:

- Install OpenSSH client tools.
- Install a compatible Node.js: 22.16+ in the 22.x line, 23.11+ in the 23.x line,
  or 24.10 and later.
- Make sure your SSH config and keys are in that distro's `~/.ssh` directory.

For Debian, OpenSSH client tools can be installed with:

```bash
sudo apt-get update
sudo apt-get install openssh-client
```

Test the actual remote account from a WSL terminal, replacing the example:

```bash
ssh user@example.com
```

A named host in `~/.ssh/config` can also be used:

```sshconfig
Host work-server
    HostName example.com
    User your-remote-user
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes
```

Test it with `ssh work-server`. The matching public key must be authorized on the
remote account. If you use an SSH agent, your WSL login shell must set
`SSH_AUTH_SOCK` to the existing agent's socket. An agent started only in another
terminal may not be available to the desktop app.

## 2. Select WSL credentials in T3 Code

Open **Settings → Connections** in the Windows desktop app and select your distro
under **WSL backend**.

| Desktop configuration        | How SSH credentials are selected                                                        |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| WSL only enabled             | SSH automatically uses the selected WSL distro. The SSH credentials selector is hidden. |
| Windows and WSL both enabled | Set **SSH credentials → WSL** and confirm the restart.                                  |
| WSL backend off              | SSH uses Windows OpenSSH.                                                               |

Windows OpenSSH reads the Windows user's `.ssh` files. Selecting WSL makes SSH
use the selected distro's files instead.

The desktop automatically installs its bundled server inside **local WSL**.
Installing a server on an **SSH host** is a separate process, described below.

Saved SSH environments retain their credentials source, distro, and account.
When switching an existing environment from Windows credentials to WSL, remove
it while the original credentials source is selected, then switch and add it
again. Removing it may stop a remote server that T3 Code started.

## 3. Prepare the remote Linux host

The remote account needs compatible Node.js and npm, plus the provider CLIs and
authentication you intend to use there. Provider setup inside local WSL does not
install or authenticate providers on the SSH host.

Check Node from WSL through a non-interactive remote login shell:

```bash
ssh work-server 'sh -lc "command -v node && node --version && command -v npm"'
```

If Node is managed with nvm or another version manager, ensure it is available
in this shell. Native npm dependencies may also need Python, make, and a C++
compiler if a suitable prebuilt binary is unavailable.

Configure the fork's registry **on the remote host**:

```bash
npm config set @rtvision:registry https://npm-registry.rtvision.com/ --location=user
```

Check whether the version matching your desktop is available:

```bash
npm view @rtvision/t3@0.0.41 version \
  --registry=https://npm-registry.rtvision.com/
```

If it is available, continue to **Add the environment** below. The desktop's
0.0.41 SSH launcher requests that exact package from the mirror automatically.
It does not simply run whichever global `t3` executable is on `PATH`.

At the time of this setup, the mirror listed **0.0.40**, but requests for
**0.0.41** failed. The matching 0.0.41 package was available as a GitHub release
attachment. Use the following fallback only when the matching registry version
is unavailable.

## 4. Fallback: install the matching release attachment

On a machine with GitHub CLI access to `RTVision/t3code`, download the package and
checksums. The 0.0.41 release was a draft when checked, so access to the draft is
required.

```bash
mkdir -p /tmp/rtvision-t3-0.0.41
gh release download v0.0.41 --repo RTVision/t3code \
  --pattern rtvision-t3-0.0.41.tgz \
  --pattern SHA256SUMS \
  --dir /tmp/rtvision-t3-0.0.41
cd /tmp/rtvision-t3-0.0.41
sha256sum --check --ignore-missing SHA256SUMS
```

Confirm the package checksum passes, then copy it to the SSH host:

```bash
scp rtvision-t3-0.0.41.tgz work-server:/tmp/rtvision-t3-0.0.41.tgz
ssh work-server
```

Run the following **on the remote host** as the account T3 Code will connect as:

```bash
npm install --global --prefix "$HOME/.local" \
  /tmp/rtvision-t3-0.0.41.tgz --no-audit --no-fund

npm install --prefix "$HOME" --no-save --package-lock=false \
  --no-audit --no-fund "$HOME/.local/lib/node_modules/@rtvision/t3"
```

Both commands matter for this fallback. The first installs the verified package
under `~/.local`. The second makes it available in the remote home directory's
local npm package lookup, which the desktop's SSH launcher uses. In the checked
setup, this created `~/node_modules/@rtvision/t3` as a link to the installation.
A global installation by itself did **not** fix the connection.

For direct terminal use of `t3`, add this line to the remote account's `~/.profile`
if it is not already present:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Verify the exact package lookup, rather than only checking the global executable:

```bash
cd "$HOME"
npx --yes --registry=https://npm-registry.rtvision.com/ \
  --package=@rtvision/t3@0.0.41 -- t3 --version
```

Expected output: `t3 v0.0.41`. Repeat the matching-version check after a desktop
update; installing 0.0.41 does not satisfy a request for a different version.

## 5. Add the environment

In the desktop app, open **Settings → Connections → Add environment → SSH**.
Enter your SSH alias or hostname, and check the remote username and port.

T3 Code starts or reuses the remote server and sets up the SSH tunnel. Once
connected, add a project from the remote host and configure its providers.

The host dropdown reads named `Host` entries from the selected credentials
source's `~/.ssh/config`, including included config files, and readable hostnames
from `~/.ssh/known_hosts`. Wildcard aliases and hashed known-host entries are
skipped. Suggestions are not a network scan or a reachability check. You can
enter a hostname that is not in the list.

## Troubleshooting

| Symptom                                                                   | What to check                                                                                                                                                                                                        |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SSH credentials selector is missing                                       | It is hidden in WSL-only mode, where WSL is already selected automatically. Otherwise enable a WSL backend to expose it.                                                                                             |
| Error says `via Windows OpenSSH`                                          | The attempt is using Windows credentials. Select WSL, confirm the restart, and recreate a saved environment if it retained the old credentials source.                                                               |
| `Permission denied (publickey)` followed by a password prompt             | The offered key was not accepted. Check the remote username, selected credentials source, key, and agent. A remote login password cannot fix a connection where the server permits only public-key authentication.   |
| `No matching version found for @rtvision/t3@0.0.41`                       | Check the exact version in the RTVision mirror. If unavailable, use the matching release attachment and complete both fallback installation commands.                                                                |
| `t3 --version` works but adding still tries to download a missing version | A global executable is insufficient for the packaged 0.0.41 launcher. Run the exact `npx --package` verification from the remote home directory.                                                                     |
| Adding stays busy for about a minute                                      | Remote startup can wait about 60 seconds before reporting an installation or readiness failure. Read the resulting error; retries alone will not resolve it. Close and reopen the dialog after the attempt finishes. |

For more detail, inspect the remote account's
`~/.t3/ssh-launch/<connection-id>/server.log`. Logs may contain older attempts;
check the newest failure. On Windows, desktop SSH traces are normally under
`%USERPROFILE%\.t3\userdata\logs\desktop.trace.ndjson`. Do not share passwords,
private keys, or pairing tokens when reporting a problem.
