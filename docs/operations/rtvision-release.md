# RTVision releases

RTVision releases are built from `rtvision` for Windows x64 and Linux x64. The
`RTVision release` workflow creates a draft GitHub release with installers,
updater metadata, checksums, standalone CLI archives, and the Node-based
`@rtvision/t3` npm tarball. Desktop installers are unsigned. The npm registry is reachable only on RTVision's network, so npm
publication runs locally.

Desktop and CLI builds load `.env.example` to enable upstream's production T3
Connect service. Its Clerk identifiers and relay URL are public build settings.

Run `node scripts/update-release-package-versions.ts <version>` with a new stable
version, commit the changes on `rtvision`, and push. Changing the server package
version triggers the workflow. Desktop and standalone executable updates use
archives from `RTVision/t3code`.
Windows desktop bundles the Linux archive for its WSL backend. Node/npm and OpenRC
installations keep using `@rtvision/t3` from `https://npm-registry.rtvision.com/`,
including its existing service entry paths. This preserves upgrades from 0.0.50 and
Alpine support; upstream's glibc executable does not run on musl. SSH connections
reuse complete Node installations and fall back to npm if an archive is unavailable
or cannot run on the host.

After the workflow succeeds, download the draft's assets on a machine that can
reach the registry. Use the actual version in place of `<version>`:

```sh
mkdir -p /tmp/rtvision-release-<version>
gh release download v<version> --repo RTVision/t3code --dir /tmp/rtvision-release-<version>
cd /tmp/rtvision-release-<version>
sha256sum --check SHA256SUMS
pnpm publish rtvision-t3-<version>.tgz --registry=https://npm-registry.rtvision.com/ --tag latest --no-git-checks
npm view @rtvision/t3@<version> version dist.integrity --registry=https://npm-registry.rtvision.com/
```

Confirm the published version and integrity match the tarball, and smoke-test a
clean Node installation, including the service preflight. Then edit the draft
release notes to describe the changes and publish the release:

```sh
gh release edit v<version> --repo RTVision/t3code --draft=false --latest
```

Publish npm first, then the GitHub release. The public release makes standalone
server updates and desktop updates available.
