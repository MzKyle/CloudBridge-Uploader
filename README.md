# CloudBridge Uploader

[English](README.md) | [简体中文](README.zh-CN.md)

![CloudBridge Uploader](docs/assets/cover.svg)

CloudBridge Uploader is a rule-driven desktop uploader for reliably discovering,
mapping, uploading, recovering and cleaning local data across one or more
object-storage connections.

It is built around the current v3 model:

```text
Source Roots
-> UploadRule
-> Discovery
-> UploadGroup
-> UploadTask
-> Path Mapping
-> CloudConnection(s)
-> Completion Policy
-> Cleanup Policy
```

[Read the documentation](docs/README.md)

## Product Model

- **UploadRule** defines source roots, discovery patterns, file filters, path mapping,
  destination connections, completion policy, and cleanup policy.
- **UploadGroup** is the discovered unit that can be sealed before cleanup.
- **UploadTask** uploads one discovered task directory and keeps a snapshot of the rule
  that created it.
- **CloudConnection** is the destination identity. Tasks and files are keyed by
  `connectionId`, so retrying one destination does not resend files already completed
  by another destination.
- **Path Mapping** renders object keys from the rule snapshot and discovered variables.

Date folders and work-session layouts are supported through discovery rules, but they
are examples of the model rather than hard-coded product assumptions.

## Supported Destinations

The current code supports:

- Aliyun OSS
- S3-compatible object storage

S3-compatible storage can include MinIO, Tencent TurboS3, or another compatible S3
endpoint, depending on the endpoint behavior and credentials. Connection tests verify
basic bucket access; they do not replace a real upload smoke test.

## Quick Start

1. Create a Cloud Connection.
2. Test the connection.
3. Create an Upload Rule.
4. Add one or more Source Roots.
5. Configure Discovery.
6. Configure Path Mapping.
7. Select one or more Destination Connections.
8. Run Dry Run.
9. Save the rule.
10. Let the Scanner discover data.
11. Start Upload.
12. Review History and cleanup results.

## Reliability Model

CloudBridge Uploader uses SQLite persistence for tasks, files, destinations, settings,
and upload groups. It keeps per-connection state, isolates retries by `connectionId`,
reconciles unfinished tasks on startup, verifies file stability with size and mtime,
stores task rule snapshots, and requires sealed upload groups before cleanup.

The cleanup path is fail-safe: cleanup claims a group, blocks scanner mutation for that
group, refreshes and validates state again, rejects unsafe paths, and only then removes
local data. This is not an exactly-once distributed system; interrupted work is recovered
from persisted state and retried safely.

## Common Commands

```bash
npm install
npm run dev
npm run typecheck
npm run lint
npm test
npm run build
npm run build:linux
npm run build:win
```

Build output is written to `dist/`. The current release candidate version is
`3.0.0-rc.5`.

## Packaging

`electron-builder.yml` keeps the v3 packaging targets:

- Windows: NSIS x64
- Linux: AppImage x64 and deb x64

`better-sqlite3` is unpacked from ASAR for native runtime loading.

## License

This project is licensed under the [MIT License](LICENSE).
