# Temporary handoff: RTVision SSH pairing and package installation

**Next agent: remove this file before the final merge or marking the fix ready.**
The user explicitly requested committing this temporary handoff with the current
work. It is not permanent project documentation.

## Stopping point

The user asked to commit and push the work in progress, including this handoff.
The patch is **not ready to release**. No deployment, package publication, or PR
was requested. Finish the implementation and verification before release.

This worktree's starting commit is `f96464599` on
`t3code/fix-ssh-connection-timeout`. It predates and diverges from the shipped
fork's `v0.0.48` tag (`a76fd05c4cd20673db1a71be886bd259d77d0d3a`). Check the intended
integration branch and adapt the patch to its existing RTVision changes. Do not
replace newer release packaging or SSH code with this older checkout's versions.

## Diagnosis and operational workaround already applied

Windows desktop 0.0.48 connects through Debian WSL SSH to
`kalvens.rtvision.com` as `kalvens`. SSH login works. The desktop finds the
existing daemon and opens its tunnel, but `ssh/tunnel.issueRemotePairingToken`
repeatedly timed out after 60 seconds.

The running daemon was separately updated to 0.0.48. Its installed CLI is:

```text
~/.t3/runtime/versions/0.0.48/node_modules/t3/dist/bin.mjs
```

The desktop-generated `~/.t3/ssh-launch/14ccf8ad7d2d75ea/run-t3.sh` independently
runs npm exec/npx to locate `@rtvision/t3@0.0.48` before creating a pairing token.
It did not discover that installed runtime. npm repeatedly tried to resolve
incompatible Effect prereleases instead of reaching the CLI.

The published package pins direct Effect dependencies to `4.0.0-rc.112`, but
`@effect/platform-bun` allows a newer `@effect/platform-node-shared`. npm selected
rc.114, whose Effect peer requirement was unavailable during diagnosis. Published
workspace overrides did not protect consumers: npm only honors overrides in the
installation root, not inside installed dependencies.

Upstream also uses npx, but first tries a `t3` executable on PATH. RTVision commit
`63fe554c6721cd6dceb1582389cd6e14ec332447` removed that shortcut and selected the
fork package/registry explicitly. This is the **desktop-generated SSH launcher**,
not the OpenRC wrapper or daemon service-launcher process.

A reversible remote workaround changed this existing symlink:

```text
~/node_modules/@rtvision/t3
old target: ../../.local/lib/node_modules/@rtvision/t3
new target: /home/kalvens/.t3/runtime/versions/0.0.48/node_modules/t3
```

The original link pointed to 0.0.41. The daemon's own 0.0.48 installation was
already complete. The rollback record is on the remote host at
`/tmp/t3-ssh-link-repair-mNDHfC/rollback.json` if it still exists. No daemon restart
or database edit was performed for this workaround. The actual generated launcher
subsequently returned `t3 v0.0.48` in 1.915 seconds. A completed desktop pairing
has not been verified in this conversation.

Do not use HTTP 200 from `/api/health` as proof of health: in this build that path
falls through to frontend HTML. Process identity, runtime records, and the
authenticated daemon API are better evidence.

## Related handoff and existing remote work

The user also supplied `/tmp/t3code-service-update-handoff.md`. It is on
**kalvens.rtvision.com**, not in this WSL environment's `/tmp`.

Read it for the previous update investigation. Another agent installed 0.0.48 in
an isolated staging root with Effect overrides, validated the installation, and
activated it through the normal service update protocol. It reported that the
permanent package fix was pending.

The remote `/home/kalvens/t3code` checkout has substantial pre-existing dirty work.
Its SSH daemon-discovery changes prefer `~/.t3/runtime/server-runtime.json`, retain
daemon ownership during child restarts, and avoid starting a competing server.
They do not fix pairing CLI lookup or dependency locking. Preserve those changes;
this agent did not modify that remote checkout.

## Changes in this commit

- `packages/ssh/src/tunnel.ts`: before the existing executable/npm fallbacks,
  checks for the requested exact package and version under the pinned runtime
  directory. Requires the matching `.install-complete` sentinel, package name,
  package version, and CLI entry file; then executes that CLI through Node.
  Explicit `nodeScriptPath` overrides retain priority. Dist-tags use the existing
  fallback. No daemon lifecycle changes or new wire fields were added.
- `packages/ssh/src/installedRuntime.test.ts`: executes generated shell scripts
  against temporary fixtures. Covers pairing argument preservation, paths with
  spaces, incomplete/wrong installations, desktop version changes, explicit
  overrides, and dist-tags.
- `apps/server/scripts/cliShrinkwrap.ts`: generates a package lock in an isolated
  temporary root using resolved Effect overrides. Uses npm lock-only resolution
  with optional dependencies and scripts disabled. Exposes a temporary shrinkwrap
  overlay that restores any original after success, failure, or interruption.
- `apps/server/scripts/cli.ts`: generates the lock during preparation and exposes
  it as `npm-shrinkwrap.json` during the existing publish operation. The helper
  uses `publishConfig.registry` when provided, allowing the fork's newer manifest
  to select its registry.
- `apps/server/scripts/cliShrinkwrap.test.ts`: tests shrinkwrap cleanup/restoration
  on success, failure, and interruption.

Removing Effect dependencies from the published manifest was considered but not
implemented. Bun execution still dynamically imports the external Bun adapters;
trimming them solely because Node bundles Effect could break that runtime.

## Verification so far and known failures

The focused test command was:

```sh
PATH=/tmp/node-v24.13.1-linux-x64/bin:$PATH \
  /home/kalvens/t3code/node_modules/.bin/vp test run \
  packages/ssh/src/installedRuntime.test.ts \
  packages/ssh/src/runnerProcess.test.ts \
  packages/ssh/src/tunnel.test.ts \
  apps/server/scripts/cliShrinkwrap.test.ts
```

Result: **22 passed, 4 failed**.

- Two existing `runnerProcess.test.ts` cases failed because the sandbox rejected
  their localhost listeners with `listen EPERM`. Rerun these with appropriate
  tool escalation; the tests own their temporary processes.
- Two new installed-runtime tests returned empty stdout: the matching runtime
  case and the explicit script override case. The npm fallback cases passed.
  This is unresolved. Even a standalone generated runner with an explicit
  temporary CLI containing `process.stdout.write("explicit override")` exited 0
  with empty stdout/stderr. Investigate the generated shell with `sh -x`, argument
  handling, and the test environment before attributing it to the new discovery
  code. Do not weaken the assertions to make it pass.
- The shrinkwrap lifecycle tests and existing tunnel tests passed.
- Targeted lint initially could not load its plugin because its local Effect
  dependency was unavailable. Dependency links were added afterward; lint has not
  been rerun. No typecheck has been completed.
- No actual release lock generation, tarball install, or npm-exec validation has
  been completed for the new packaging implementation.

This worktree initially lacked node_modules. For focused testing, gitignored
links reuse the matching beta.103 dependencies in local `/home/kalvens/t3code`.
The worktree root node_modules is a real directory with dependency symlinks and
local Vite caches, so caches do not write into the shared checkout. Package,
scripts, and lint-plugin node_modules links point to the corresponding existing
installation. These links are not part of the commit. The v0.0.48 source uses
Effect rc.112 instead; validate against the eventual integration branch's own
dependencies as well.

## Remaining work

1. Resolve the empty-output runner failures and rerun focused tests.
2. Verify actual shrinkwrap generation from the target release manifest. Confirm
   npm honors its Effect versions under both aliased daemon installs and npx.
3. Pack a real fixture/release tarball and confirm `npm-shrinkwrap.json` is
   included despite `files: ["dist"]`, with optional dependency metadata for
   Linux, Windows, and macOS preserved. Confirm lock generation invokes no native
   build scripts, while actual installation still builds/loads native modules.
4. Review registry handling, supported npm versions, Windows command launching,
   and lock generation failure/interruption behavior. Add meaningful coverage
   where needed; current tests only cover overlay restoration.
5. Run targeted lint and typecheck, plus CLI startup/preflight checks against
   disposable state. No repo-wide checks, live database writes, or browser use.
6. Integrate with the fork's current release and existing daemon-discovery work.
   Published 0.0.48 is not repaired by repository changes; consumers need a new
   release. Do not publish or open a PR without the user's authorization.
7. **Remove this handoff file before the final merge.**
