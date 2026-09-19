# 历史、存储与清理

## Storage

SQLite 保存：

- settings
- upload groups
- tasks
- task files
- task destinations
- task file destinations
- history

## Cleanup

CleanupService 只处理 safe candidate：

1. refresh group files
2. recalculate UploadGroup
3. DB safety check
4. cleanup claim
5. claim 后再次 refresh/recalculate
6. 文件系统未发现未登记内容
7. path safety check
8. remove directory
9. mark cleaned

若 claim 后发现新内容或未完成状态，cleanup 释放 claim 并保留目录。
