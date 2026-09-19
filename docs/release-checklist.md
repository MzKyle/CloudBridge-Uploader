# Release Checklist

Use this checklist for `3.0.0-rc.5` soak testing and the later `3.0.0` decision.

## Code Gate

- [x] typecheck
- [x] lint
- [x] tests
- [x] build

## Packaging

- [ ] Windows native package via release workflow
- [ ] Windows installer install
- [ ] Windows app launch
- [x] Linux native package assets generated
- [ ] Linux app launch
  - NOT EXECUTED — no Linux GUI final install smoke in this environment

## Product Smoke

- [ ] create S3-compatible connection
- [ ] create Aliyun OSS connection
- [ ] create UploadRule
- [ ] multi-root Dry Run
- [ ] upload sample data
- [ ] restart recovery
- [ ] retry failed destination
- [ ] edit Rule after task created
- [ ] seal UploadGroup
- [ ] cleanup safety

## Release Hygiene

- [ ] logs checked
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
- [ ] RC GitHub pre-release created by tag workflow
- [ ] Final Release Acceptance PASS
- [ ] Stable `v3.0.0` promotion
