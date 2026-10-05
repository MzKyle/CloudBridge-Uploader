# Release Checklist

Use this checklist for `3.0.0-rc.6` soak testing and the later `3.0.0` decision.
Windows evidence: [2026-10-05 acceptance](windows-acceptance.md).

## Code Gate

- [x] typecheck
- [x] lint
- [x] tests
- [x] build

## Packaging

- [x] Windows native package via release workflow
- [x] Windows installer install (native NSIS, Chinese/space installation path)
- [x] Windows app launch (installed executable, isolated profile)
- [x] Windows installer uninstall
- [x] Linux native package assets generated
- [ ] Linux app launch
  - Prior Linux acceptance was reported by the user; not repeated on this Windows host.

## Product Smoke

- [x] create S3-compatible connection
- [x] create Aliyun OSS connection (configuration only)
- [x] create UploadRule
- [x] multi-root Dry Run
- [x] upload sample data (local S3 protocol fixture, including multipart)
- [x] restart recovery (including abrupt exit during upload)
- [x] retry failed destination
- [x] edit Rule after task created
- [x] seal UploadGroup
- [x] cleanup safety (automated policy, traversal and junction checks)
- [ ] live S3/OSS upload with production endpoint credentials

## Release Hygiene

- [x] logs checked
- [x] README version correct
- [x] package version correct
- [x] no real credentials in repository
- [x] known limitations recorded

## Release Engineering

- [x] release workflow added
- [x] tag/package version gate added
- [x] package-lock version gate added
- [x] SHA256SUMS excludes itself and includes release assets only
- [x] `better-sqlite3` remains unpacked from `app.asar`
- [x] RC GitHub pre-release created by tag workflow
- [ ] Final Release Acceptance PASS
- [ ] Stable `v3.0.0` promotion
