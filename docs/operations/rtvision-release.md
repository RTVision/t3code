# RTVision releases

RTVision releases are built from `rtvision` for Windows x64 and Linux x64. The
`RTVision release` workflow creates a draft GitHub release with installers,
updater metadata, checksums, standalone CLI archives, and npm tarballs for the
`@rtvision/t3` launcher and each supported platform. Desktop installers
are unsigned. The npm registry is reachable only on RTVision's network, so npm
publication runs locally.

Desktop and CLI builds load `.env.example` to enable upstream's production T3
Connect service. Its Clerk identifiers and relay URL are public build settings.

Run `node scripts/update-release-package-versions.ts <version>` with a new stable
version, commit the changes on `rtvision`, and push. Changing the server package
version triggers the workflow. Desktop and standalone server updates use archives
from `RTVision/t3code`. Windows desktop bundles the Linux archive for its WSL backend.
The npm launcher installs its matching `@rtvision/t3-<platform>-<arch>` package from
`https://npm-registry.rtvision.com/`.

After the workflow succeeds, download the draft's assets on a machine that can
reach the registry. Use the actual version in place of `<version>`:

```sh
mkdir -p /tmp/rtvision-release-<version>
gh release download v<version> --repo RTVision/t3code --dir /tmp/rtvision-release-<version>
cd /tmp/rtvision-release-<version>
sha256sum --check SHA256SUMS
pnpm publish t3-linux-x64.tgz --registry=https://npm-registry.rtvision.com/ --tag latest --no-git-checks
pnpm publish t3-win32-x64.tgz --registry=https://npm-registry.rtvision.com/ --tag latest --no-git-checks
pnpm publish t3.tgz --registry=https://npm-registry.rtvision.com/ --tag latest --no-git-checks
npm view @rtvision/t3@<version> version dist.integrity --registry=https://npm-registry.rtvision.com/
```

Confirm each published version and integrity matches its tarball, and smoke-test a
clean installation of the launcher. Then edit the draft
release notes to describe the changes and publish the release:

```sh
gh release edit v<version> --repo RTVision/t3code --draft=false --latest
```

Publish platform npm packages before the launcher, then publish the GitHub release.
The launcher requires its exact platform package version; the public release makes
standalone server updates and desktop updates available.
