# 测试验收流程

## Code Gate

- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm test`
- [ ] `npm run build`

## Reliability Smoke

- [ ] interrupted upload startup recovery
- [ ] completed destination 不重传
- [ ] failed destination retry isolation
- [ ] mid-upload source mutation 重新上传最新稳定版本
- [ ] UploadRule snapshot 不被后续规则编辑影响
- [ ] sealed UploadGroup cleanup safety
- [ ] cleanup race abort

## Product Smoke

- [ ] create Aliyun OSS connection
- [ ] create S3-compatible connection
- [ ] create UploadRule
- [ ] multi-root Dry Run
- [ ] upload sample data
- [ ] restart recovery
- [ ] History result visible
- [ ] cleanup safety checked
