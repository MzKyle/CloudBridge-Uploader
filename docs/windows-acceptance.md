# Windows rc.6 acceptance

Date: 2026-10-05 (Asia/Shanghai). Version: `3.0.0-rc.6`.

Windows platform acceptance: **PASS** for the checks below. Live cloud endpoint
acceptance remains outstanding; this record does not promote the release to stable.

## Published package verification

The [rc.6 release](https://github.com/MzKyle/CloudBridge-Uploader/releases/tag/v3.0.0-rc.6)
was published successfully. Windows and Linux CI passed, and the
[release workflow](https://github.com/MzKyle/CloudBridge-Uploader/actions/runs/37277532964)
passed all validation, packaging and Windows smoke gates.

The publicly downloadable Windows installer was downloaded, checked against
`SHA256SUMS.txt`, installed and subjected to all 11 smoke checks again: **PASS**.
Silent uninstall also passed. Evidence: `.acceptance/windows-WZddRh/result.json`.

Published installer SHA256:

```text
a0f2b814ce7546fa178be7e7cf757823bbefccc3b5e691b44d7823cc68804b5a
```

## Environment and artifact

- Microsoft Windows 11 Home China, build `10.0.26300`, x64.
- Node `22.23.3`, npm `10.9.9`, Electron `33.4.11`.
- Native NSIS installer: `CloudBridge-Uploader-3.0.0-rc.6-windows-x64.exe`.
- Installed to a path containing Chinese characters and spaces; tests launched the
  installed executable and loaded dependencies from the packaged ASAR.
- An isolated `--user-data-dir` prevented tests from using the user's database.

## Verified

- Typecheck, lint, 108 automated tests, and native Windows packaging.
- NSIS installation and application launch; packaged SQLite migrations and DPAPI
  encryption/decryption of stored test credentials.
- NSIS silent uninstall exited successfully and removed the installed executable.
- Task, rule, cloud connection, history, and settings navigation.
- Creating S3 and OSS connections through the UI; S3 connection success and failure.
- Two source roots, trailing separators, mixed slash styles, Unicode and spaces.
- Rule dry run, scanner discovery, file stability, and disk usage.
- Actual S3 SDK requests to a local protocol fixture, including 6 MiB multipart
  uploads. Received file contents were compared byte for byte.
- One destination returning AccessDenied while another finishes; retry uploads
  only the failed destination.
- Restart recovery and credential decryption; existing tasks keep the creation-time
  rule snapshot after the rule is edited.
- Abrupt process exit during an outstanding upload request; restart resets the
  task to pending and upload succeeds after explicit queue start.
- Manual folder addition, pause/resume, manual group sealing, history rendering,
  and preservation of source roots while cleanup is disabled.
- Close hides the window; launching a second instance restores the same window.
- No renderer exceptions, startup failures or unhandled main-process exceptions.
- Cleanup policy and path safety regression tests, including Windows junctions.

## Fixes made during acceptance

- Replaced string slicing with native relative-path calculation. A source ending
  in a separator previously changed `first.txt` into `irst.txt` and truncated the
  first character of Unicode directory names.
- Preserve drive/share roots in task, group and disk path normalization. Containment
  checks now use path-relative boundaries, including Windows case handling.
- Load the real tray icon from packaged resources and align the Windows app ID
  with the installer. Startup error messages show the actual log directory.
- Windows cleanup tests use directory junctions so standard users do not require
  symbolic-link privileges.
- Added `npm run smoke:win` and made it a gate before release asset upload.

## Reproduce

```powershell
npm ci
npm run typecheck
npm run lint
npm test
npm run build:win
npm run smoke:win
# After NSIS installation:
npm run smoke:win -- "C:\path\to\云桥上传器.exe"
```

Results, process logs, screenshots and disposable profiles are written under
`.acceptance/windows-*/`. The successful installed-app run is
`.acceptance/windows-LRAXZm/result.json`. CI preserves its own results in the
`windows-acceptance` artifact.

If electron-builder's winCodeSign cache extraction fails because macOS symlinks
require privileges, extract the downloaded `winCodeSign-2.6.0.7z` into
`%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0`, excluding
`darwin` and `linux` entries, then rebuild. Keep Windows resource editing enabled.
Stop development app processes before native-module rebuilds: Windows locks the
loaded `better_sqlite3.node` file.

## Scope limits

The test service uses local S3 protocol responses and test credentials. Real Aliyun
OSS, MinIO, TurboS3 and other remote endpoints have not been connected in this
Windows session. The installer is unsigned. Interactive installer wizard clicks,
tray menu clicks, live UNC shares and long-path/locked-source-file behavior were
not manually tested. Linux acceptance was reported by the user and was not
repeated locally on this Windows machine; cross-platform CI remains required.
