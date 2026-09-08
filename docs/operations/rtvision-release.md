# RTVision releases

RTVision releases are built from `rtvision` for Windows x64 and Linux x64. The
`RTVision release` workflow creates a draft GitHub release with installers,
updater metadata, checksums, and the `@rtvision/t3` npm tarball. Desktop installers
are unsigned. The npm registry is reachable only on RTVision's network, so npm
publication runs locally.

Desktop and CLI builds load `.env.example` to enable upstream's production T3
Connect service. Its Clerk identifiers and relay URL are public build settings.

Run `node scripts/update-release-package-versions.ts <version>` with a new stable
version, commit the changes on `rtvision`, and push. Changing the server package
version triggers the workflow. Desktop updates use `RTVision/t3code`; server
updates install the same exact version of `@rtvision/t3` from
`https://npm-registry.rtvision.com/`.

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

Confirm the published version and integrity match the tarball. Then edit the draft
release notes to describe the changes and publish the release:

```sh
gh release edit v<version> --repo RTVision/t3code --draft=false --latest
```

Publish npm first. A released desktop client can request its exact server version;
that package must exist before desktop updates become visible.
