# Releasing CloudBridge Uploader

CloudBridge Uploader releases are created from version tags. The release workflow validates the tag, builds native Windows and Linux packages, generates `SHA256SUMS.txt`, and creates the GitHub Release.

## Standard Flow

1. Merge release-ready work to `main`.
2. Wait for CI on `main` to pass.
3. Complete manual release acceptance.
4. Update `package.json`, `package-lock.json`, and release docs to the target version.
5. Commit the version change.
6. Wait for CI on `main` to pass again.
7. Tag the version commit.
8. Push the tag.

## Commands

Patch release:

```bash
npm version patch
git push origin main
git push origin vX.Y.Z
```

Minor release:

```bash
npm version minor
git push origin main
git push origin vX.Y.Z
```

Major release:

```bash
npm version major
git push origin main
git push origin vX.Y.Z
```

`npm version` updates `package.json` and `package-lock.json`, creates a version commit, and creates the matching git tag. Confirm the resulting version and tag before pushing.

## Release Assets

For `vX.Y.Z`, the workflow uploads:

- `CloudBridge-Uploader-X.Y.Z-windows-x64.exe`
- `CloudBridge-Uploader-X.Y.Z-linux-<arch>.AppImage`
- `CloudBridge-Uploader-X.Y.Z-linux-<arch>.deb`
- `SHA256SUMS.txt`

Windows installers are intentionally unsigned. Auto-update metadata is not part of the v3 release architecture; users update manually from GitHub Releases.
