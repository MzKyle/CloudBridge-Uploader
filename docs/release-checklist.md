# Release Checklist

Use this checklist for `3.0.0-rc.4` soak testing and the later `3.0.0` decision.

## Code Gate

- [ ] typecheck
- [ ] lint
- [ ] tests
- [ ] build

## Packaging

- [ ] Windows installer install
- [ ] Windows app launch
- [ ] Linux app launch

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
- [ ] README version correct
- [ ] package version correct
- [ ] no real credentials in repository
- [ ] known limitations recorded
