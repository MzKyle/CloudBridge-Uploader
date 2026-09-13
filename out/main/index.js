"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const electron = require("electron");
const path = require("path");
const Database = require("better-sqlite3");
const fs = require("fs");
const log = require("electron-log");
const uuid = require("uuid");
const promises = require("fs/promises");
const chokidar = require("chokidar");
const events = require("events");
const child_process = require("child_process");
const ssh2 = require("ssh2");
const https = require("https");
const clientS3 = require("@aws-sdk/client-s3");
const libStorage = require("@aws-sdk/lib-storage");
const nodeHttpHandler = require("@smithy/node-http-handler");
const os = require("os");
const is = {
  dev: !electron.app.isPackaged
};
const platform = {
  isWindows: process.platform === "win32",
  isMacOS: process.platform === "darwin",
  isLinux: process.platform === "linux"
};
const electronApp = {
  setAppUserModelId(id) {
    if (platform.isWindows)
      electron.app.setAppUserModelId(is.dev ? process.execPath : id);
  },
  setAutoLaunch(auto) {
    if (platform.isLinux)
      return false;
    const isOpenAtLogin = () => {
      return electron.app.getLoginItemSettings().openAtLogin;
    };
    if (isOpenAtLogin() !== auto) {
      electron.app.setLoginItemSettings({
        openAtLogin: auto,
        path: process.execPath
      });
      return isOpenAtLogin() === auto;
    } else {
      return true;
    }
  },
  skipProxy() {
    return electron.session.defaultSession.setProxy({ mode: "direct" });
  }
};
const optimizer = {
  watchWindowShortcuts(window, shortcutOptions) {
    if (!window)
      return;
    const { webContents } = window;
    const { escToCloseWindow = false, zoom = false } = shortcutOptions || {};
    webContents.on("before-input-event", (event, input) => {
      if (input.type === "keyDown") {
        if (!is.dev) {
          if (input.code === "KeyR" && (input.control || input.meta))
            event.preventDefault();
        } else {
          if (input.code === "F12") {
            if (webContents.isDevToolsOpened()) {
              webContents.closeDevTools();
            } else {
              webContents.openDevTools({ mode: "undocked" });
              console.log("Open dev tool...");
            }
          }
        }
        if (escToCloseWindow) {
          if (input.code === "Escape" && input.key !== "Process") {
            window.close();
            event.preventDefault();
          }
        }
        if (!zoom) {
          if (input.code === "Minus" && (input.control || input.meta))
            event.preventDefault();
          if (input.code === "Equal" && input.shift && (input.control || input.meta))
            event.preventDefault();
        }
      }
    });
  },
  registerFramelessWindowIpc() {
    electron.ipcMain.on("win:invoke", (event, action) => {
      const win = electron.BrowserWindow.fromWebContents(event.sender);
      if (win) {
        if (action === "show") {
          win.show();
        } else if (action === "showInactive") {
          win.showInactive();
        } else if (action === "min") {
          win.minimize();
        } else if (action === "max") {
          const isMaximized = win.isMaximized();
          if (isMaximized) {
            win.unmaximize();
          } else {
            win.maximize();
          }
        } else if (action === "close") {
          win.close();
        }
      }
    });
  }
};
const IPC = {
  // 任务管理
  TASK_LIST: "task:list",
  TASK_GET: "task:get",
  TASK_ADD_FOLDER: "task:add-folder",
  TASK_PAUSE: "task:pause",
  TASK_RESUME: "task:resume",
  TASK_CANCEL: "task:cancel",
  TASK_RETRY: "task:retry",
  TASK_SKIP: "task:skip",
  TASK_RESTORE: "task:restore",
  TASK_DETAIL: "task:detail",
  TASK_PROGRESS: "task:progress",
  // push from main
  TASK_STATUS_CHANGE: "task:status-change",
  // push from main
  TASK_DESTINATION_CHANGE: "task:destination-change",
  // 上传队列
  UPLOAD_QUEUE_STATUS: "upload-queue:status",
  UPLOAD_QUEUE_START: "upload-queue:start",
  UPLOAD_QUEUE_STOP: "upload-queue:stop",
  UPLOAD_QUEUE_EVENT: "upload-queue:event",
  // 日期目录汇总
  DAY_FOLDER_LIST: "day-folder:list",
  DAY_FOLDER_DELETE: "day-folder:delete",
  DAY_FOLDER_IGNORE: "day-folder:ignore",
  DAY_FOLDER_RESTORE: "day-folder:restore",
  DAY_FOLDER_EVENT: "day-folder:event",
  // 扫描器
  SCANNER_STATUS: "scanner:status",
  SCANNER_TRIGGER: "scanner:trigger",
  SCANNER_START: "scanner:start",
  SCANNER_STOP: "scanner:stop",
  SCANNER_EVENT: "scanner:event",
  // push from main
  // 数采模式
  DATA_COLLECT_LIST: "data-collect:list",
  DATA_COLLECT_RUN: "data-collect:run",
  DATA_COLLECT_RESULT: "data-collect:result",
  // push from main
  // 设置
  SETTINGS_GET_ALL: "settings:get-all",
  SETTINGS_SAVE: "settings:save",
  SETTINGS_TEST_OSS: "settings:test-oss",
  SETTINGS_TEST_TENCENT_S3: "settings:test-tencent-s3",
  UPLOAD_PATH_PREVIEW: "upload:path-preview",
  // 项目插件
  CAPABILITY_LIST: "capability:list",
  CAPABILITY_PROFILE_STATUS: "capability:profile-status",
  CAPABILITY_TASK_RUNS: "capability:task-runs",
  PLUGIN_LIST: "plugin:list",
  PLUGIN_PROFILE_STATUS: "plugin:profile-status",
  PLUGIN_TASK_RUNS: "plugin:task-runs",
  // OSS 浏览器工具插件
  OSS_BROWSER_LIST: "oss-browser:list",
  OSS_BROWSER_HEAD: "oss-browser:head",
  OSS_BROWSER_GET_IMAGE: "oss-browser:get-image",
  OSS_BROWSER_OPEN_PREVIEW_WINDOW: "oss-browser:open-preview-window",
  // 通用转换工具
  GENERIC_CONVERTER_STATUS: "generic-converter:status",
  GENERIC_CONVERTER_START: "generic-converter:start",
  GENERIC_CONVERTER_STOP: "generic-converter:stop",
  GENERIC_CONVERTER_SCAN_NOW: "generic-converter:scan-now",
  GENERIC_CONVERTER_EVENT: "generic-converter:event",
  // SSH / rsync
  SSH_LIST_MACHINES: "ssh:list-machines",
  SSH_ADD_MACHINE: "ssh:add-machine",
  SSH_UPDATE_MACHINE: "ssh:update-machine",
  SSH_DELETE_MACHINE: "ssh:delete-machine",
  SSH_TEST_CONNECTION: "ssh:test-connection",
  RSYNC_START: "rsync:start",
  RSYNC_STOP: "rsync:stop",
  RSYNC_PROGRESS: "rsync:progress",
  // push from main
  SFTP_START: "sftp:start",
  SFTP_STOP: "sftp:stop",
  SFTP_PROGRESS: "sftp:progress",
  // push from main
  // 历史
  HISTORY_LIST: "history:list",
  HISTORY_CLEAR: "history:clear",
  HISTORY_DELETE: "history:delete",
  // 磁盘用量
  DISK_USAGE: "disk:usage",
  // 窗口
  WINDOW_TOGGLE: "window:toggle",
  WINDOW_MINI_MONITOR: "window:mini-monitor",
  // 对话框
  DIALOG_SELECT_FOLDER: "dialog:select-folder",
  DIALOG_SELECT_DIRECTORY: "dialog:select-directory"
};
const DATE_FOLDER_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
function parseDateFolderName(name) {
  const match = DATE_FOLDER_PATTERN.exec(name);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(year, month - 1, day);
  if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) {
    return null;
  }
  parsed.setHours(0, 0, 0, 0);
  return parsed;
}
function isDateFolderName(name) {
  return parseDateFolderName(name) !== null;
}
function joinOssPath(...parts) {
  return parts.flatMap((part) => (part || "").replace(/\\/g, "/").split("/")).map((part) => part.trim()).filter((part) => part.length > 0 && part !== ".").join("/");
}
function buildUploadRelativePath(dateFolder, childFolder) {
  return joinOssPath(dateFolder, childFolder);
}
function pathSegments$2(directoryPath) {
  return directoryPath.replace(/\\/g, "/").split("/").map((part) => part.trim()).filter((part) => part.length > 0 && part !== ".");
}
function deriveDateScopedUploadRelativePath(directoryPath) {
  const segments = pathSegments$2(directoryPath);
  const folderName = segments.at(-1);
  if (!folderName) return null;
  if (isDateFolderName(folderName)) {
    return folderName;
  }
  const parentName = segments.at(-2);
  if (parentName && isDateFolderName(parentName)) {
    return buildUploadRelativePath(parentName, folderName);
  }
  return null;
}
function buildOssKey(prefix, uploadRelativePath, fileRelativePath) {
  return joinOssPath(prefix, uploadRelativePath, fileRelativePath);
}
let db = null;
const DATA_MIGRATION_DATE_PATHS = "data-migration:date-upload-paths:v1";
const DATA_MIGRATION_DESTINATIONS = "data-migration:task-destinations:v1";
function getDb() {
  if (!db) {
    throw new Error("数据库未初始化");
  }
  return db;
}
function initDatabase() {
  const dbPath = path.join(electron.app.getPath("userData"), "uploader.db");
  log.info("数据库路径:", dbPath);
  db = new Database(dbPath);
  db.pragma("busy_timeout = 30000");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  log.info("开始检查数据库结构");
  runMigrations(db);
  reconcileStartupState(db);
  log.info("数据库初始化完成");
}
function runMigrations(db2) {
  db2.exec(`
    CREATE TABLE IF NOT EXISTS day_folders (
      id TEXT PRIMARY KEY,
      folder_path TEXT NOT NULL UNIQUE,
      folder_name TEXT NOT NULL,
      date_value TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'collecting',
      child_folders_json TEXT NOT NULL DEFAULT '[]',
      total_children INTEGER NOT NULL DEFAULT 0,
      completed_children INTEGER NOT NULL DEFAULT 0,
      total_files INTEGER NOT NULL DEFAULT 0,
      uploaded_files INTEGER NOT NULL DEFAULT 0,
      total_bytes INTEGER NOT NULL DEFAULT 0,
      uploaded_bytes INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      ignored INTEGER NOT NULL DEFAULT 0,
      profile_id TEXT,
      group_key TEXT,
      variables_json TEXT NOT NULL DEFAULT '{}',
      upload_group_status TEXT NOT NULL DEFAULT 'open',
      discovered_at TEXT,
      sealed_at TEXT,
      cleanable_at TEXT,
      cleaned_at TEXT
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      folder_path TEXT NOT NULL,
      folder_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      total_files INTEGER NOT NULL DEFAULT 0,
      uploaded_files INTEGER NOT NULL DEFAULT 0,
      total_bytes INTEGER NOT NULL DEFAULT 0,
      uploaded_bytes INTEGER NOT NULL DEFAULT 0,
      oss_prefix TEXT,
      upload_target_mode TEXT NOT NULL DEFAULT 'aliyun',
      day_folder_id TEXT,
      upload_relative_path TEXT NOT NULL DEFAULT '',
      error_message TEXT,
      source_type TEXT NOT NULL DEFAULT 'local',
      source_machine_id TEXT,
      profile_id TEXT,
      profile_name TEXT,
      profile_snapshot_json TEXT,
      group_variables_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY (day_folder_id) REFERENCES day_folders(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS task_files (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      file_size INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      oss_key TEXT,
      upload_id TEXT,
      error_message TEXT,
      mtime_ms INTEGER NOT NULL DEFAULT 0,
      last_seen_at TEXT,
      source_status TEXT NOT NULL DEFAULT 'present',
      stable_count INTEGER NOT NULL DEFAULT 0,
      retry_count INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS task_destinations (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      prefix TEXT NOT NULL DEFAULT '',
      upload_relative_path TEXT NOT NULL DEFAULT '',
      path_mode TEXT NOT NULL DEFAULT 'target-root',
      object_key_template TEXT,
      total_files INTEGER NOT NULL DEFAULT 0,
      uploaded_files INTEGER NOT NULL DEFAULT 0,
      total_bytes INTEGER NOT NULL DEFAULT 0,
      uploaded_bytes INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE(task_id, provider),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS task_file_destinations (
      id TEXT PRIMARY KEY,
      task_file_id TEXT NOT NULL,
      task_destination_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      object_key TEXT,
      planned_object_key TEXT,
      upload_id TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(task_file_id, provider),
      FOREIGN KEY (task_file_id) REFERENCES task_files(id) ON DELETE CASCADE,
      FOREIGN KEY (task_destination_id) REFERENCES task_destinations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_task_files_task_id ON task_files(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_files_status ON task_files(status);
    CREATE INDEX IF NOT EXISTS idx_task_destinations_task_id ON task_destinations(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_destinations_provider_status ON task_destinations(provider, status);
    CREATE INDEX IF NOT EXISTS idx_task_file_destinations_task_file_id ON task_file_destinations(task_file_id);
    CREATE INDEX IF NOT EXISTS idx_task_file_destinations_destination_id ON task_file_destinations(task_destination_id);
    CREATE INDEX IF NOT EXISTS idx_day_folders_status ON day_folders(status);

    CREATE TABLE IF NOT EXISTS task_plugin_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      category TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      error_message TEXT,
      summary_json TEXT,
      staging_path TEXT,
      artifacts_json TEXT,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_task_plugin_runs_task_id ON task_plugin_runs(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_plugin_runs_plugin_status ON task_plugin_runs(plugin_id, status);

    CREATE TABLE IF NOT EXISTS ssh_machines (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL DEFAULT 22,
      username TEXT NOT NULL,
      auth_type TEXT NOT NULL DEFAULT 'key',
      private_key_path TEXT,
      encrypted_password TEXT,
      remote_dir TEXT NOT NULL,
      local_dir TEXT NOT NULL,
      bw_limit INTEGER NOT NULL DEFAULT 5000,
      cpu_nice INTEGER NOT NULL DEFAULT 19,
      transfer_mode TEXT NOT NULL DEFAULT 'rsync',
      profile_id TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_sync_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const taskColumns = db2.pragma("table_info(tasks)");
  if (!taskColumns.some((c) => c.name === "day_folder_id")) {
    db2.exec(`ALTER TABLE tasks ADD COLUMN day_folder_id TEXT REFERENCES day_folders(id) ON DELETE SET NULL`);
    log.info("迁移: tasks 表添加 day_folder_id 列");
  }
  if (!taskColumns.some((c) => c.name === "upload_relative_path")) {
    db2.exec(`ALTER TABLE tasks ADD COLUMN upload_relative_path TEXT NOT NULL DEFAULT ''`);
    log.info("迁移: tasks 表添加 upload_relative_path 列");
  }
  if (!taskColumns.some((c) => c.name === "upload_target_mode")) {
    db2.exec(`ALTER TABLE tasks ADD COLUMN upload_target_mode TEXT NOT NULL DEFAULT 'aliyun'`);
    log.info("迁移: tasks 表添加 upload_target_mode 列");
  }
  if (!taskColumns.some((c) => c.name === "profile_id")) {
    db2.exec(`ALTER TABLE tasks ADD COLUMN profile_id TEXT`);
    log.info("迁移: tasks 表添加 profile_id 列");
  }
  if (!taskColumns.some((c) => c.name === "profile_name")) {
    db2.exec(`ALTER TABLE tasks ADD COLUMN profile_name TEXT`);
    log.info("迁移: tasks 表添加 profile_name 列");
  }
  if (!taskColumns.some((c) => c.name === "profile_snapshot_json")) {
    db2.exec(`ALTER TABLE tasks ADD COLUMN profile_snapshot_json TEXT`);
    log.info("迁移: tasks 表添加 profile_snapshot_json 列");
  }
  if (!taskColumns.some((c) => c.name === "group_variables_json")) {
    db2.exec(`ALTER TABLE tasks ADD COLUMN group_variables_json TEXT NOT NULL DEFAULT '{}'`);
    log.info("迁移: tasks 表添加 group_variables_json 列");
  }
  db2.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_day_folder_id ON tasks(day_folder_id)`);
  const taskDestinationColumns = db2.pragma("table_info(task_destinations)");
  const addedDestinationUploadPath = !taskDestinationColumns.some(
    (c) => c.name === "upload_relative_path"
  );
  if (addedDestinationUploadPath) {
    db2.exec(`ALTER TABLE task_destinations ADD COLUMN upload_relative_path TEXT NOT NULL DEFAULT ''`);
    log.info("迁移: task_destinations 表添加 upload_relative_path 列");
  }
  if (!taskDestinationColumns.some((c) => c.name === "path_mode")) {
    db2.exec(`ALTER TABLE task_destinations ADD COLUMN path_mode TEXT NOT NULL DEFAULT 'target-root'`);
    log.info("迁移: task_destinations 表添加 path_mode 列");
  }
  if (!taskDestinationColumns.some((c) => c.name === "object_key_template")) {
    db2.exec(`ALTER TABLE task_destinations ADD COLUMN object_key_template TEXT`);
    log.info("迁移: task_destinations 表添加 object_key_template 列");
  }
  const taskFileDestinationColumns = db2.pragma("table_info(task_file_destinations)");
  if (!taskFileDestinationColumns.some((c) => c.name === "planned_object_key")) {
    db2.exec(`ALTER TABLE task_file_destinations ADD COLUMN planned_object_key TEXT`);
    log.info("迁移: task_file_destinations 表添加 planned_object_key 列");
  }
  const dayFolderColumns = db2.pragma("table_info(day_folders)");
  if (!dayFolderColumns.some((c) => c.name === "ignored")) {
    db2.exec(`ALTER TABLE day_folders ADD COLUMN ignored INTEGER NOT NULL DEFAULT 0`);
    log.info("迁移: day_folders 表添加 ignored 列");
  }
  const dayFolderAdditions = [
    ["profile_id", "TEXT"],
    ["group_key", "TEXT"],
    ["variables_json", `TEXT NOT NULL DEFAULT '{}'`],
    ["upload_group_status", `TEXT NOT NULL DEFAULT 'open'`],
    ["discovered_at", "TEXT"],
    ["sealed_at", "TEXT"],
    ["cleanable_at", "TEXT"],
    ["cleaned_at", "TEXT"]
  ];
  for (const [name, definition] of dayFolderAdditions) {
    if (!dayFolderColumns.some((column) => column.name === name)) {
      db2.exec(`ALTER TABLE day_folders ADD COLUMN ${name} ${definition}`);
      log.info(`迁移: day_folders 表添加 ${name} 列`);
    }
  }
  db2.exec(`
    UPDATE day_folders
    SET group_key = COALESCE(group_key, date_value),
        variables_json = CASE
          WHEN variables_json IS NULL OR variables_json = '{}' THEN
            '{"date":"' || replace(date_value, '"', '\\"') || '"}'
          ELSE variables_json
        END,
        upload_group_status = CASE
          WHEN status IN ('completed', 'completed_with_skips')
            AND (upload_group_status IS NULL OR upload_group_status = '' OR upload_group_status = 'open') THEN 'sealed'
          WHEN status = 'blocked'
            AND (upload_group_status IS NULL OR upload_group_status = '' OR upload_group_status = 'open') THEN 'error'
          WHEN status = 'processing'
            AND (upload_group_status IS NULL OR upload_group_status = '' OR upload_group_status = 'open') THEN 'closing'
          WHEN upload_group_status IS NULL OR upload_group_status = '' THEN 'open'
          ELSE upload_group_status
        END,
        discovered_at = COALESCE(discovered_at, created_at),
        sealed_at = CASE
          WHEN sealed_at IS NULL AND status IN ('completed', 'completed_with_skips') THEN completed_at
          ELSE sealed_at
        END
  `);
  db2.exec(`
    UPDATE tasks
    SET group_variables_json = COALESCE((
      SELECT variables_json
      FROM day_folders
      WHERE day_folders.id = tasks.day_folder_id
    ), group_variables_json, '{}')
    WHERE day_folder_id IS NOT NULL
      AND (group_variables_json IS NULL OR group_variables_json = '{}')
  `);
  db2.exec(`
    CREATE INDEX IF NOT EXISTS idx_day_folders_upload_group_status
    ON day_folders(upload_group_status)
  `);
  const taskFileColumns = db2.pragma("table_info(task_files)");
  const taskFileAdditions = [
    ["mtime_ms", `INTEGER NOT NULL DEFAULT 0`],
    ["last_seen_at", `TEXT`],
    ["source_status", `TEXT NOT NULL DEFAULT 'present'`],
    ["stable_count", `INTEGER NOT NULL DEFAULT 0`],
    ["retry_count", `INTEGER NOT NULL DEFAULT 0`],
    ["next_retry_at", `TEXT`]
  ];
  for (const [name, definition] of taskFileAdditions) {
    if (!taskFileColumns.some((column) => column.name === name)) {
      db2.exec(`ALTER TABLE task_files ADD COLUMN ${name} ${definition}`);
      log.info(`迁移: task_files 表添加 ${name} 列`);
    }
  }
  ensureUniqueTaskFilePathIndex(db2);
  db2.exec(`
    CREATE INDEX IF NOT EXISTS idx_task_files_retry
    ON task_files(status, next_retry_at)
  `);
  db2.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);
  db2.exec(`
    CREATE INDEX IF NOT EXISTS idx_task_files_task_status
    ON task_files(task_id, status, source_status)
  `);
  db2.exec(`
    CREATE INDEX IF NOT EXISTS idx_task_file_destinations_status_file
    ON task_file_destinations(status, task_file_id)
  `);
  if (!isDataMigrationDone(db2, DATA_MIGRATION_DATE_PATHS)) {
    const incompleteTasks = db2.prepare(
      `SELECT id, folder_path, source_type, source_machine_id, upload_relative_path
       FROM tasks
       WHERE status != 'completed'`
    ).all();
    const findRemoteDirectory = db2.prepare(
      "SELECT remote_dir FROM ssh_machines WHERE id = ?"
    );
    const updateUploadRelativePath = db2.prepare(
      `UPDATE tasks
       SET upload_relative_path = ?, updated_at = ?
       WHERE id = ?`
    );
    let migratedDatePaths = 0;
    for (const task of incompleteTasks) {
      let uploadRelativePath = null;
      if (task.source_type === "rsync" && task.source_machine_id) {
        const machine = findRemoteDirectory.get(task.source_machine_id);
        uploadRelativePath = machine ? deriveDateScopedUploadRelativePath(machine.remote_dir) : null;
      }
      uploadRelativePath ||= deriveDateScopedUploadRelativePath(task.folder_path);
      if (uploadRelativePath && task.upload_relative_path !== uploadRelativePath) {
        updateUploadRelativePath.run(
          uploadRelativePath,
          (/* @__PURE__ */ new Date()).toISOString(),
          task.id
        );
        migratedDatePaths++;
      }
    }
    if (migratedDatePaths > 0) {
      log.info(`日期层路径迁移完成: ${migratedDatePaths} 个未完成任务`);
    }
    markDataMigrationDone(db2, DATA_MIGRATION_DATE_PATHS);
  }
  if (addedDestinationUploadPath) {
    db2.exec(`
      UPDATE task_destinations
      SET upload_relative_path = COALESCE((
        SELECT upload_relative_path
        FROM tasks
        WHERE tasks.id = task_destinations.task_id
      ), '')
    `);
    log.info("迁移: 已回填任务目标上传相对路径");
  }
  if (!isDataMigrationDone(db2, DATA_MIGRATION_DESTINATIONS)) {
    const migratedDestinations = db2.prepare(
      `INSERT OR IGNORE INTO task_destinations (
        id, task_id, provider, status, prefix, total_files, uploaded_files,
        total_bytes, uploaded_bytes, error_message, created_at, updated_at,
        completed_at, upload_relative_path, path_mode, object_key_template
      )
      SELECT lower(hex(randomblob(16))), id, 'aliyun', status, COALESCE(oss_prefix, ''),
        total_files, uploaded_files, total_bytes, uploaded_bytes, error_message,
        created_at, updated_at, completed_at, COALESCE(upload_relative_path, ''),
        'target-root', NULL
      FROM tasks t
      WHERE NOT EXISTS (
        SELECT 1 FROM task_destinations existing WHERE existing.task_id = t.id
      )`
    ).run().changes;
    const migratedFileDestinations = db2.prepare(
      `INSERT OR IGNORE INTO task_file_destinations (
        id, task_file_id, task_destination_id, provider, status, object_key,
        upload_id, error_message, created_at, updated_at
      )
      SELECT lower(hex(randomblob(16))), tf.id, td.id, 'aliyun', tf.status,
        tf.oss_key, tf.upload_id, tf.error_message, tf.created_at, tf.updated_at
      FROM tasks t
      INNER JOIN task_files tf ON tf.task_id = t.id
      INNER JOIN task_destinations td
        ON td.task_id = t.id AND td.provider = 'aliyun'
      WHERE t.status != 'completed'
        AND NOT EXISTS (
        SELECT 1
        FROM task_file_destinations existing
        WHERE existing.task_file_id = tf.id
      )`
    ).run().changes;
    if (migratedDestinations > 0 || migratedFileDestinations > 0) {
      log.info(
        `双云任务迁移完成: ${migratedDestinations} 个任务目标, ${migratedFileDestinations} 个文件目标`
      );
    }
    markDataMigrationDone(db2, DATA_MIGRATION_DESTINATIONS);
  }
  const columns = db2.pragma("table_info(ssh_machines)");
  const hasTransferMode = columns.some((c) => c.name === "transfer_mode");
  if (!hasTransferMode) {
    db2.exec(`ALTER TABLE ssh_machines ADD COLUMN transfer_mode TEXT NOT NULL DEFAULT 'rsync'`);
    log.info("迁移: ssh_machines 表添加 transfer_mode 列");
  }
  const sshColumnsAfterTransfer = db2.pragma("table_info(ssh_machines)");
  if (!sshColumnsAfterTransfer.some((c) => c.name === "profile_id")) {
    db2.exec(`ALTER TABLE ssh_machines ADD COLUMN profile_id TEXT`);
    log.info("迁移: ssh_machines 表添加 profile_id 列");
  }
}
function isDataMigrationDone(db2, key) {
  const row = db2.prepare("SELECT value FROM app_meta WHERE key = ?").get(key);
  return row?.value === "done";
}
function markDataMigrationDone(db2, key) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  db2.prepare(
    `INSERT INTO app_meta (key, value, updated_at)
     VALUES (?, 'done', ?)
     ON CONFLICT(key) DO UPDATE SET value = 'done', updated_at = ?`
  ).run(key, now, now);
}
function ensureUniqueTaskFilePathIndex(db2) {
  const existing = db2.prepare(
    `SELECT 1
     FROM sqlite_master
     WHERE type = 'index' AND name = 'idx_task_files_task_path'`
  ).get();
  if (existing) return;
  log.info("迁移: 开始创建任务文件路径索引");
  try {
    db2.exec(`
      CREATE UNIQUE INDEX idx_task_files_task_path
      ON task_files(task_id, relative_path)
    `);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.toLowerCase().includes("unique constraint failed")) {
      throw error;
    }
    log.warn("迁移: 发现重复任务文件记录，开始清理");
    const transaction = db2.transaction(() => {
      db2.exec(`
        DELETE FROM task_files
        WHERE rowid NOT IN (
          SELECT MIN(rowid)
          FROM task_files
          GROUP BY task_id, relative_path
        )
      `);
      db2.exec(`
        CREATE UNIQUE INDEX idx_task_files_task_path
        ON task_files(task_id, relative_path)
      `);
    });
    transaction();
  }
  log.info("迁移: 任务文件路径索引创建完成");
}
function reconcileStartupState(db2) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  db2.prepare(
    `UPDATE task_files
     SET status = 'pending', updated_at = ?
     WHERE status = 'uploading'`
  ).run(now);
  db2.prepare(
    `UPDATE task_file_destinations
     SET status = 'pending', updated_at = ?
     WHERE status = 'uploading'`
  ).run(now);
  const monitorableTasks = db2.prepare(
    `SELECT id, folder_path
     FROM tasks
     WHERE source_type IN ('local', 'rsync')
       AND status NOT IN ('completed', 'synced', 'skipped')`
  ).all();
  const resetTasks = db2.prepare(
    `UPDATE tasks
     SET status = 'pending', error_message = NULL,
         completed_at = NULL, updated_at = ?
     WHERE status NOT IN ('completed', 'synced', 'skipped')`
  );
  const resetDestinations = db2.prepare(
    `UPDATE task_destinations
     SET status = CASE
           WHEN status IN ('completed', 'synced') THEN status
           WHEN status IN ('uploading', 'scanning', 'retrying', 'failed', 'paused') THEN 'pending'
           ELSE 'pending'
         END,
         error_message = NULL,
         completed_at = CASE
           WHEN status IN ('completed', 'synced') THEN completed_at
           ELSE NULL
         END,
         updated_at = ?
     WHERE task_id IN (
       SELECT id FROM tasks WHERE status NOT IN ('completed', 'synced', 'skipped')
     )`
  );
  const resetAllActiveFiles = db2.prepare(
    `UPDATE task_files
     SET status = 'pending',
         error_message = NULL, retry_count = 0, next_retry_at = NULL,
         updated_at = ?
     WHERE source_status = 'present'
       AND status IN ('uploading', 'failed')
       AND task_id IN (
         SELECT id FROM tasks WHERE status NOT IN ('completed', 'synced', 'skipped')
       )`
  );
  const resetAllActiveFileDestinations = db2.prepare(
    `UPDATE task_file_destinations
     SET status = 'pending', error_message = NULL, updated_at = ?
     WHERE status IN ('uploading', 'failed')
       AND task_file_id IN (
         SELECT tf.id
         FROM task_files tf
         INNER JOIN tasks t ON t.id = tf.task_id
         WHERE tf.source_status = 'present'
           AND t.status NOT IN ('completed', 'synced', 'skipped')
       )`
  );
  const skipTask = db2.prepare(
    `UPDATE tasks
     SET status = 'skipped', error_message = '源目录已删除',
         completed_at = ?, updated_at = ?
     WHERE id = ?`
  );
  const skipDestinations = db2.prepare(
    `UPDATE task_destinations
     SET status = CASE
           WHEN status IN ('completed', 'synced') THEN status
           ELSE 'skipped'
         END,
         error_message = CASE
           WHEN status IN ('completed', 'synced') THEN error_message
           ELSE '源目录已删除'
         END,
         completed_at = COALESCE(completed_at, ?), updated_at = ?
     WHERE task_id = ?`
  );
  const transaction = db2.transaction(() => {
    for (const task of monitorableTasks) {
      if (!fs.existsSync(task.folder_path)) {
        skipTask.run(now, now, task.id);
        skipDestinations.run(now, now, task.id);
      }
    }
    resetTasks.run(now);
    resetDestinations.run(now);
    resetAllActiveFiles.run(now);
    resetAllActiveFileDestinations.run(now);
  });
  transaction();
}
const DEFAULT_UPLOAD_PATH_MODE = "target-root";
const DEFAULT_UPLOAD_PATH_SEGMENT_COUNT = 2;
const UPLOAD_PATH_MODES = /* @__PURE__ */ new Set([
  "target-root",
  "date-workdir",
  "keep-source",
  "last-segments",
  "template"
]);
function normalizeUploadPathMode(value) {
  return typeof value === "string" && UPLOAD_PATH_MODES.has(value) ? value : DEFAULT_UPLOAD_PATH_MODE;
}
function normalizeUploadPathSegmentCount(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_UPLOAD_PATH_SEGMENT_COUNT;
  return Math.max(0, Math.min(20, Math.floor(parsed)));
}
function normalizeUploadPathConfig(config) {
  return {
    ...config,
    pathMode: normalizeUploadPathMode(config.pathMode),
    pathSegmentCount: normalizeUploadPathSegmentCount(config.pathSegmentCount)
  };
}
function getProviderUploadPathConfig(settings, provider) {
  const config = provider === "aliyun" ? settings.oss : settings.tencentS3;
  return normalizeUploadPathConfig(config);
}
function resolveProviderUploadRelativePaths(settings, providers, context) {
  const paths = {};
  for (const provider of providers) {
    paths[provider] = resolveUploadRelativePath(
      getProviderUploadPathConfig(settings, provider),
      context
    );
  }
  return paths;
}
function firstProviderUploadRelativePath(providers, paths, fallback = "") {
  for (const provider of providers) {
    const path2 = paths[provider];
    if (path2 !== void 0) return path2;
  }
  return fallback;
}
function resolveUploadRelativePath(config, context) {
  const normalized = normalizeUploadPathConfig(
    config
  );
  const sourcePath = context.sourcePath;
  if (normalized.pathMode === "target-root" || normalized.pathMode === "template") return "";
  if (normalized.pathMode === "date-workdir") {
    const dateName = context.variables?.date || context.dateName;
    const workDirName = context.variables?.workDir || context.variables?.session || context.workDirName;
    if (dateName && workDirName) {
      return joinOssPath(dateName, workDirName);
    }
    return deriveDateScopedUploadRelativePath(sourcePath) || (context.fallbackDirectoryPath ? deriveDateScopedUploadRelativePath(context.fallbackDirectoryPath) : null) || lastPathSegment(sourcePath);
  }
  if (normalized.pathMode === "keep-source") {
    const basePath = context.basePath || parentDirectoryPath(sourcePath);
    return relativePathFromBase$1(sourcePath, basePath);
  }
  if (normalized.pathSegmentCount <= 0) return "";
  return joinOssPath(...pathSegments$1(sourcePath).slice(-normalized.pathSegmentCount));
}
function relativePathFromBase$1(sourcePath, basePath) {
  const source = pathSegments$1(sourcePath);
  const base = pathSegments$1(basePath);
  if (source.length === 0) return "";
  let index = 0;
  while (index < source.length && index < base.length && segmentEquals$2(source[index], base[index])) {
    index++;
  }
  if (index === base.length && index < source.length) {
    return joinOssPath(...source.slice(index));
  }
  return lastPathSegment(sourcePath);
}
function pathSegments$1(path2) {
  return path2.replace(/\\/g, "/").split("/").map((part) => part.trim()).filter((part) => part.length > 0 && part !== ".");
}
function parentDirectoryPath(path2) {
  const segments = pathSegments$1(path2);
  return joinOssPath(...segments.slice(0, -1));
}
function lastPathSegment(path2) {
  return pathSegments$1(path2).at(-1) || "";
}
function segmentEquals$2(a, b) {
  if (a.endsWith(":") || b.endsWith(":")) return a.toLowerCase() === b.toLowerCase();
  return a === b;
}
function providersForMode(mode) {
  if (mode === "both") return ["aliyun", "tencent"];
  return [mode];
}
function providerForConnectionId(connectionId) {
  const normalized = connectionId.trim().toLowerCase();
  if (normalized === "aliyun" || normalized === "aliyun-oss") return "aliyun";
  if (normalized === "tencent" || normalized === "tencent-s3" || normalized === "tencent-turbos3") {
    return "tencent";
  }
  return null;
}
function destinationsForProviders(providers) {
  return providersForMode(modeForProviders(providers)).map((provider) => ({
    connectionId: provider,
    required: true
  }));
}
function providersForDestinations(destinations) {
  const providers = Array.from(
    new Set(
      (destinations || []).map((destination) => providerForConnectionId(destination.connectionId)).filter((provider) => Boolean(provider))
    )
  );
  return providers.length > 0 ? providersForMode(modeForProviders(providers)) : [];
}
function providersForProfile(profile) {
  const providers = providersForDestinations(profile.destinations);
  return providers.length > 0 ? providers : providersForMode(profile.targetMode);
}
function modeForProviders(providers) {
  const set = new Set(providers);
  if (set.has("aliyun") && set.has("tencent")) return "both";
  return set.has("tencent") ? "tencent" : "aliyun";
}
function getUploadTargetSnapshot(settings, context) {
  return getUploadTargetSnapshotForProviders(
    providersForMode(settings.cloud.targetMode),
    settings,
    context
  );
}
function getUploadTargetSnapshotForProviders(providers, settings, context) {
  const uploadRelativePaths = context ? resolveProviderUploadRelativePaths(settings, providers, context) : {};
  return {
    mode: modeForProviders(providers),
    prefixes: {
      aliyun: settings.oss.prefix || "",
      tencent: settings.tencentS3.prefix || ""
    },
    uploadRelativePaths,
    uploadRelativePath: firstProviderUploadRelativePath(
      providers,
      uploadRelativePaths,
      ""
    ),
    pathModes: {
      aliyun: settings.oss.pathMode,
      tencent: settings.tencentS3.pathMode
    },
    objectKeyTemplates: {}
  };
}
function deriveLogicalFileStatus(statuses) {
  if (statuses.length > 0 && statuses.every((status) => status === "completed")) {
    return "completed";
  }
  if (statuses.some((status) => status === "failed")) return "failed";
  if (statuses.length > 0 && statuses.every((status) => status === "skipped")) {
    return "skipped";
  }
  if (statuses.some((status) => status === "uploading")) return "uploading";
  return "pending";
}
function rowToDestination(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    provider: row.provider,
    status: row.status,
    prefix: row.prefix || "",
    uploadRelativePath: row.upload_relative_path ?? "",
    pathMode: row.path_mode || "target-root",
    objectKeyTemplate: row.object_key_template || null,
    totalFiles: row.total_files,
    uploadedFiles: row.uploaded_files,
    totalBytes: row.total_bytes,
    uploadedBytes: row.uploaded_bytes,
    errorMessage: row.error_message || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at || null
  };
}
function rowToFileDestination(row) {
  return {
    id: row.id,
    taskFileId: row.task_file_id,
    taskDestinationId: row.task_destination_id,
    provider: row.provider,
    status: row.status,
    objectKey: row.object_key || null,
    plannedObjectKey: row.planned_object_key || null,
    uploadId: row.upload_id || null,
    errorMessage: row.error_message || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
class TaskDestinationRepo {
  ensureForTask(taskId, mode, prefixes, initialStatus = "pending", uploadRelativePaths = {}, pathModes = {}, objectKeyTemplates = {}) {
    const db2 = getDb();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const stmt = db2.prepare(
      `INSERT OR IGNORE INTO task_destinations (
        id, task_id, provider, status, prefix, upload_relative_path,
        path_mode, object_key_template,
        created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const completedAt = initialStatus === "completed" || initialStatus === "failed" || initialStatus === "skipped" ? now : null;
    const transaction = db2.transaction(() => {
      for (const provider of providersForMode(mode)) {
        stmt.run(
          uuid.v4(),
          taskId,
          provider,
          initialStatus,
          prefixes[provider] || "",
          uploadRelativePaths[provider] ?? "",
          pathModes[provider] || "target-root",
          objectKeyTemplates[provider] ?? null,
          now,
          now,
          completedAt
        );
      }
    });
    transaction();
    return this.listByTask(taskId);
  }
  listByTask(taskId) {
    return getDb().prepare("SELECT * FROM task_destinations WHERE task_id = ? ORDER BY provider").all(taskId).map(rowToDestination);
  }
  listByTaskIds(taskIds) {
    const result = /* @__PURE__ */ new Map();
    const uniqueIds = Array.from(new Set(taskIds)).filter(Boolean);
    if (uniqueIds.length === 0) return result;
    const chunkSize = 500;
    for (let index = 0; index < uniqueIds.length; index += chunkSize) {
      const chunk = uniqueIds.slice(index, index + chunkSize);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = getDb().prepare(
        `SELECT *
           FROM task_destinations
           WHERE task_id IN (${placeholders})
           ORDER BY task_id, provider`
      ).all(...chunk);
      for (const row of rows) {
        const destination = rowToDestination(row);
        const destinations = result.get(destination.taskId) || [];
        destinations.push(destination);
        result.set(destination.taskId, destinations);
      }
    }
    return result;
  }
  get(taskId, provider) {
    const row = getDb().prepare("SELECT * FROM task_destinations WHERE task_id = ? AND provider = ?").get(taskId, provider);
    return row ? rowToDestination(row) : null;
  }
  updateStatus(taskId, provider, status, errorMessage) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const completedAt = status === "completed" || status === "failed" || status === "skipped" ? now : null;
    getDb().prepare(
      `UPDATE task_destinations
         SET status = ?, error_message = ?, updated_at = ?, completed_at = ?
         WHERE task_id = ? AND provider = ?`
    ).run(status, errorMessage || null, now, completedAt, taskId, provider);
  }
  updateUploadRelativePath(taskId, provider, uploadRelativePath) {
    getDb().prepare(
      `UPDATE task_destinations
         SET upload_relative_path = ?, updated_at = ?
         WHERE task_id = ? AND provider = ?`
    ).run(uploadRelativePath, (/* @__PURE__ */ new Date()).toISOString(), taskId, provider);
  }
  updateIncompleteStatuses(taskId, status, errorMessage) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const completedAt = status === "completed" || status === "failed" || status === "skipped" ? now : null;
    getDb().prepare(
      `UPDATE task_destinations
         SET status = ?, error_message = ?, updated_at = ?, completed_at = ?
         WHERE task_id = ? AND status NOT IN ('completed', 'synced', 'skipped')`
    ).run(status, errorMessage || null, now, completedAt, taskId);
  }
  setTotals(taskId, provider, totalFiles, totalBytes) {
    getDb().prepare(
      `UPDATE task_destinations
         SET total_files = ?, total_bytes = ?, updated_at = ?
         WHERE task_id = ? AND provider = ?`
    ).run(totalFiles, totalBytes, (/* @__PURE__ */ new Date()).toISOString(), taskId, provider);
  }
  updateProgress(taskId, provider, uploadedFiles, uploadedBytes) {
    getDb().prepare(
      `UPDATE task_destinations
         SET uploaded_files = ?, uploaded_bytes = ?, updated_at = ?
         WHERE task_id = ? AND provider = ?`
    ).run(uploadedFiles, uploadedBytes, (/* @__PURE__ */ new Date()).toISOString(), taskId, provider);
  }
  ensureForTaskFiles(taskId) {
    const db2 = getDb();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    db2.prepare(
      `INSERT OR IGNORE INTO task_file_destinations (
        id, task_file_id, task_destination_id, provider, status, created_at, updated_at
      )
      SELECT lower(hex(randomblob(16))), tf.id, td.id, td.provider, 'pending', ?, ?
      FROM task_files tf
      INNER JOIN task_destinations td ON td.task_id = tf.task_id
      WHERE tf.task_id = ?`
    ).run(now, now, taskId);
  }
  replacePlannedObjectKeys(taskId, plannedKeysByRelativePath) {
    const db2 = getDb();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    db2.exec(`
      CREATE TEMP TABLE IF NOT EXISTS tmp_planned_object_keys (
        relative_path TEXT PRIMARY KEY,
        object_key TEXT NOT NULL
      )
    `);
    const insertPlannedKey = db2.prepare(
      `INSERT OR REPLACE INTO tmp_planned_object_keys (relative_path, object_key)
       VALUES (?, ?)`
    );
    const clearStale = db2.prepare(
      `UPDATE task_file_destinations
       SET planned_object_key = NULL, updated_at = ?
       WHERE id IN (
         SELECT tfd.id
         FROM task_file_destinations tfd
         INNER JOIN task_files tf ON tf.id = tfd.task_file_id
         LEFT JOIN tmp_planned_object_keys planned
           ON planned.relative_path = tf.relative_path
         WHERE tf.task_id = ?
           AND tfd.planned_object_key IS NOT NULL
           AND planned.relative_path IS NULL
       )`
    );
    const updateChanged = db2.prepare(
      `UPDATE task_file_destinations
       SET planned_object_key = (
           SELECT planned.object_key
           FROM task_files tf
           INNER JOIN tmp_planned_object_keys planned
             ON planned.relative_path = tf.relative_path
           WHERE tf.id = task_file_destinations.task_file_id
         ),
         updated_at = ?
       WHERE task_file_id IN (
         SELECT tf.id
         FROM task_files tf
         INNER JOIN tmp_planned_object_keys planned
           ON planned.relative_path = tf.relative_path
         WHERE tf.task_id = ?
       )
       AND (
         planned_object_key IS NULL
         OR planned_object_key != (
           SELECT planned.object_key
           FROM task_files tf
           INNER JOIN tmp_planned_object_keys planned
             ON planned.relative_path = tf.relative_path
           WHERE tf.id = task_file_destinations.task_file_id
         )
       )`
    );
    const transaction = db2.transaction(() => {
      db2.prepare("DELETE FROM tmp_planned_object_keys").run();
      for (const [relativePath, objectKey] of plannedKeysByRelativePath) {
        insertPlannedKey.run(relativePath, objectKey);
      }
      clearStale.run(now, taskId);
      updateChanged.run(now, taskId);
      db2.prepare("DELETE FROM tmp_planned_object_keys").run();
    });
    transaction();
  }
  listFileTargets(taskId, provider) {
    const providerCondition = provider ? "AND tfd.provider = ?" : "";
    const params = [taskId];
    if (provider) params.push(provider);
    const rows = getDb().prepare(
      `SELECT tfd.*, tf.task_id, tf.relative_path, tf.file_size,
          tf.mtime_ms, tf.retry_count, tf.next_retry_at,
          tf.source_status, tf.stable_count
         FROM task_file_destinations tfd
         INNER JOIN task_files tf ON tf.id = tfd.task_file_id
         WHERE tf.task_id = ? ${providerCondition}
         ORDER BY tf.created_at, tfd.provider`
    ).all(...params);
    return rows.map((row) => ({
      ...rowToFileDestination(row),
      taskId: row.task_id,
      relativePath: row.relative_path,
      fileSize: row.file_size,
      mtimeMs: Number(row.mtime_ms || 0),
      retryCount: Number(row.retry_count || 0),
      nextRetryAt: row.next_retry_at || null,
      sourceStatus: row.source_status || "present",
      stableCount: Number(row.stable_count || 0)
    }));
  }
  listReadyFileTargets(taskId, requiredStableChecks, now = (/* @__PURE__ */ new Date()).toISOString()) {
    const rows = getDb().prepare(
      `SELECT tfd.*, tf.task_id, tf.relative_path, tf.file_size,
          tf.mtime_ms, tf.retry_count, tf.next_retry_at,
          tf.source_status, tf.stable_count
         FROM task_file_destinations tfd
         INNER JOIN task_files tf ON tf.id = tfd.task_file_id
         WHERE tf.task_id = ?
           AND tfd.status = 'pending'
           AND tf.source_status = 'present'
           AND tf.stable_count >= ?
           AND (tf.next_retry_at IS NULL OR tf.next_retry_at <= ?)
         ORDER BY tf.created_at, tfd.provider`
    ).all(taskId, requiredStableChecks, now);
    return rows.map((row) => ({
      ...rowToFileDestination(row),
      taskId: row.task_id,
      relativePath: row.relative_path,
      fileSize: row.file_size,
      mtimeMs: Number(row.mtime_ms || 0),
      retryCount: Number(row.retry_count || 0),
      nextRetryAt: row.next_retry_at || null,
      sourceStatus: row.source_status || "present",
      stableCount: Number(row.stable_count || 0)
    }));
  }
  summarizeFileTargets(taskId, provider, now = (/* @__PURE__ */ new Date()).toISOString()) {
    const row = getDb().prepare(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(tf.file_size), 0) AS total_bytes,
         SUM(CASE WHEN tfd.status = 'completed' THEN 1 ELSE 0 END) AS uploaded,
         COALESCE(SUM(CASE WHEN tfd.status = 'completed' THEN tf.file_size ELSE 0 END), 0) AS uploaded_bytes,
         SUM(CASE WHEN tfd.status = 'failed' THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN tfd.status = 'pending' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN tfd.status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
         SUM(CASE
           WHEN tfd.status = 'pending'
            AND tf.next_retry_at IS NOT NULL
            AND tf.next_retry_at > ?
           THEN 1 ELSE 0 END) AS retry_waiting
       FROM task_file_destinations tfd
       INNER JOIN task_files tf ON tf.id = tfd.task_file_id
       WHERE tf.task_id = ? AND tfd.provider = ?`
    ).get(now, taskId, provider);
    return {
      total: row.total || 0,
      totalBytes: row.total_bytes || 0,
      uploaded: row.uploaded || 0,
      uploadedBytes: row.uploaded_bytes || 0,
      failed: row.failed || 0,
      pending: row.pending || 0,
      skipped: row.skipped || 0,
      retryWaiting: row.retry_waiting || 0
    };
  }
  listFailedFileTargetExamples(taskId, provider, limit = 3) {
    const rows = getDb().prepare(
      `SELECT tf.relative_path, tfd.error_message
       FROM task_file_destinations tfd
       INNER JOIN task_files tf ON tf.id = tfd.task_file_id
       WHERE tf.task_id = ? AND tfd.provider = ? AND tfd.status = 'failed'
       ORDER BY tf.created_at
       LIMIT ?`
    ).all(taskId, provider, Math.max(1, limit));
    return rows.map((row) => ({
      relativePath: row.relative_path,
      errorMessage: row.error_message || null
    }));
  }
  updateFileStatus(id, status, objectKey, uploadId, errorMessage) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    getDb().prepare(
      `UPDATE task_file_destinations
         SET status = ?, object_key = COALESCE(?, object_key),
           upload_id = COALESCE(?, upload_id), error_message = ?, updated_at = ?
         WHERE id = ?`
    ).run(status, objectKey || null, uploadId || null, errorMessage || null, now, id);
  }
  recalculateLogicalFile(taskFileId) {
    const rows = getDb().prepare("SELECT status FROM task_file_destinations WHERE task_file_id = ?").all(taskFileId);
    const statuses = rows.map((row) => row.status);
    const status = deriveLogicalFileStatus(statuses);
    getDb().prepare("UPDATE task_files SET status = ?, updated_at = ? WHERE id = ?").run(status, (/* @__PURE__ */ new Date()).toISOString(), taskFileId);
    return status;
  }
  recalculateProgress(taskId, provider) {
    const row = getDb().prepare(
      `SELECT
         COUNT(*) AS total_files,
         COALESCE(SUM(tf.file_size), 0) AS total_bytes,
         SUM(CASE WHEN tfd.status = 'completed' THEN 1 ELSE 0 END) AS uploaded_files,
         COALESCE(SUM(CASE WHEN tfd.status = 'completed' THEN tf.file_size ELSE 0 END), 0) AS uploaded_bytes
       FROM task_file_destinations tfd
       INNER JOIN task_files tf ON tf.id = tfd.task_file_id
       WHERE tf.task_id = ? AND tfd.provider = ?`
    ).get(taskId, provider);
    this.setTotals(
      taskId,
      provider,
      row.total_files || 0,
      row.total_bytes || 0
    );
    this.updateProgress(
      taskId,
      provider,
      row.uploaded_files || 0,
      row.uploaded_bytes || 0
    );
  }
  resetFailed(taskId, provider) {
    const db2 = getDb();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const providerCondition = provider ? "AND provider = ?" : "";
    const destinationParams = [now, taskId];
    const fileParams = [now, taskId];
    if (provider) {
      destinationParams.push(provider);
      fileParams.push(provider);
    }
    db2.prepare(
      `UPDATE task_destinations
       SET status = CASE
             WHEN status IN ('completed', 'synced') THEN status
             ELSE 'pending'
           END,
         error_message = NULL,
         completed_at = CASE
           WHEN status IN ('completed', 'synced') THEN completed_at
           ELSE NULL
         END,
         updated_at = ?
       WHERE task_id = ? ${providerCondition}`
    ).run(...destinationParams);
    db2.prepare(
      `UPDATE task_file_destinations
       SET status = CASE WHEN status = 'completed' THEN status ELSE 'pending' END,
         error_message = NULL, updated_at = ?
       WHERE task_file_id IN (SELECT id FROM task_files WHERE task_id = ?)
       ${providerCondition}`
    ).run(...fileParams);
    const fileRows = db2.prepare("SELECT id FROM task_files WHERE task_id = ?").all(taskId);
    for (const row of fileRows) this.recalculateLogicalFile(row.id);
  }
}
let instance$o = null;
function getTaskDestinationRepo() {
  if (!instance$o) instance$o = new TaskDestinationRepo();
  return instance$o;
}
function normalizeFolderPath$1(p) {
  return path.normalize(p).replace(/[\\/]+$/, "");
}
function rowToTask(row, destinations) {
  const profileSnapshot = typeof row.profile_snapshot_json === "string" && row.profile_snapshot_json ? safeParseProfile$1(row.profile_snapshot_json) : null;
  return {
    id: row.id,
    folderPath: row.folder_path,
    folderName: row.folder_name,
    status: row.status,
    totalFiles: row.total_files,
    uploadedFiles: row.uploaded_files,
    totalBytes: row.total_bytes,
    uploadedBytes: row.uploaded_bytes,
    ossPrefix: row.oss_prefix || "",
    uploadTargetMode: row.upload_target_mode || "aliyun",
    destinations: destinations ?? getTaskDestinationRepo().listByTask(row.id),
    dayFolderId: row.day_folder_id || null,
    uploadRelativePath: row.upload_relative_path ?? row.folder_name,
    errorMessage: row.error_message || null,
    sourceType: row.source_type,
    sourceMachineId: row.source_machine_id || null,
    profileId: row.profile_id || null,
    profileName: row.profile_name || null,
    profileSnapshot,
    groupVariables: safeParseVariables$1(row.group_variables_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at || null
  };
}
function safeParseProfile$1(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
function safeParseVariables$1(value) {
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).map(([key, item]) => [key, String(item)])
    );
  } catch {
    return {};
  }
}
const UPLOAD_QUEUE_CANDIDATE_STATUSES = [
  "pending",
  "scanning",
  "uploading",
  "retrying",
  "failed",
  "paused"
];
function rowToTaskFile(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    relativePath: row.relative_path,
    fileSize: row.file_size,
    status: row.status,
    ossKey: row.oss_key || null,
    uploadId: row.upload_id || null,
    errorMessage: row.error_message || null,
    mtimeMs: Number(row.mtime_ms || 0),
    lastSeenAt: row.last_seen_at || null,
    sourceStatus: row.source_status || "present",
    stableCount: Number(row.stable_count || 0),
    retryCount: Number(row.retry_count || 0),
    nextRetryAt: row.next_retry_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
class TaskRepo {
  rowsToTasks(rows) {
    const destinationsByTask = getTaskDestinationRepo().listByTaskIds(
      rows.map((row) => row.id)
    );
    return rows.map(
      (row) => rowToTask(row, destinationsByTask.get(row.id) || [])
    );
  }
  listByStatus(status) {
    return this.listByQuery(status ? { status } : void 0);
  }
  listByQuery(query) {
    const db2 = getDb();
    if (query?.statuses?.length) {
      const statuses = Array.from(new Set(query.statuses));
      const placeholders = statuses.map(() => "?").join(",");
      const rows2 = db2.prepare(
        `SELECT * FROM tasks
           WHERE status IN (${placeholders})
           ORDER BY created_at DESC`
      ).all(...statuses);
      return this.rowsToTasks(rows2);
    }
    if (query?.status) {
      const rows2 = db2.prepare("SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC").all(query.status);
      return this.rowsToTasks(rows2);
    }
    const rows = db2.prepare("SELECT * FROM tasks ORDER BY created_at DESC").all();
    return this.rowsToTasks(rows);
  }
  listContinuouslyMonitored(groupKey) {
    const params = [];
    const groupCondition = groupKey ? "AND COALESCE(df.group_key, df.date_value) = ?" : "";
    if (groupKey) params.push(groupKey);
    const rows = getDb().prepare(
      `SELECT t.*
       FROM tasks t
       INNER JOIN day_folders df ON df.id = t.day_folder_id
       WHERE t.source_type = 'local'
         AND t.day_folder_id IS NOT NULL
         ${groupCondition}
         AND t.status NOT IN ('skipped', 'paused', 'completed')
       ORDER BY t.created_at ASC`
    ).all(...params);
    return this.rowsToTasks(rows);
  }
  listContinuouslyMonitoredTaskIds(groupKey) {
    const params = [];
    const groupCondition = groupKey ? "AND COALESCE(df.group_key, df.date_value) = ?" : "";
    if (groupKey) params.push(groupKey);
    const rows = getDb().prepare(
      `SELECT t.id
       FROM tasks t
       INNER JOIN day_folders df ON df.id = t.day_folder_id
       WHERE t.source_type = 'local'
         AND t.day_folder_id IS NOT NULL
         ${groupCondition}
         AND t.status NOT IN ('skipped', 'paused', 'completed')
       ORDER BY t.created_at ASC`
    ).all(...params);
    return rows.map((row) => row.id);
  }
  listRunnable(now = (/* @__PURE__ */ new Date()).toISOString(), limit) {
    const params = [now];
    const boundedLimit = typeof limit === "number" && limit > 0 ? Math.floor(limit) : null;
    const limitClause = boundedLimit ? "LIMIT ?" : "";
    if (boundedLimit) params.push(boundedLimit);
    const rows = getDb().prepare(
      `SELECT DISTINCT t.*
       FROM tasks t
       INNER JOIN task_files tf ON tf.task_id = t.id
       INNER JOIN task_file_destinations tfd ON tfd.task_file_id = tf.id
       WHERE t.status IN ('pending', 'retrying')
         AND tf.source_status = 'present'
         AND tf.stable_count >= CASE WHEN t.source_type = 'local' THEN 2 ELSE 1 END
         AND (tf.next_retry_at IS NULL OR tf.next_retry_at <= ?)
         AND tfd.status = 'pending'
       ORDER BY t.created_at ASC
       ${limitClause}`
    ).all(...params);
    return this.rowsToTasks(rows);
  }
  getById(id) {
    const db2 = getDb();
    const row = db2.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    return row ? rowToTask(row) : null;
  }
  getByFolderPath(folderPath) {
    const db2 = getDb();
    const normalized = normalizeFolderPath$1(folderPath);
    const row = db2.prepare("SELECT * FROM tasks WHERE folder_path = ? ORDER BY created_at DESC LIMIT 1").get(normalized);
    return row ? rowToTask(row) : null;
  }
  /**
   * Find the task whose folderPath is a parent directory of the given file path.
   * Returns the most specific match (longest folderPath).
   */
  findTaskContainingFile(filePath) {
    const db2 = getDb();
    const normalized = path.normalize(filePath);
    const rows = db2.prepare("SELECT * FROM tasks ORDER BY length(folder_path) DESC").all();
    const tasks = this.rowsToTasks(rows);
    return tasks.find((t) => {
      const fp = t.folderPath;
      return normalized.startsWith(fp + "/") || normalized.startsWith(fp + "\\");
    }) || null;
  }
  create(params) {
    const db2 = getDb();
    const id = uuid.v4();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const normalizedPath = normalizeFolderPath$1(params.folderPath);
    const uploadTargetMode = params.uploadTargetMode || "aliyun";
    const uploadRelativePath = params.uploadRelativePath ?? params.folderName;
    const destinationUploadRelativePaths = params.destinationUploadRelativePaths || Object.fromEntries(
      providersForMode(uploadTargetMode).map((provider) => [
        provider,
        uploadRelativePath
      ])
    );
    db2.prepare(
      `INSERT INTO tasks (
        id, folder_path, folder_name, status, oss_prefix, upload_target_mode,
        day_folder_id, upload_relative_path, source_type, source_machine_id,
        profile_id, profile_name, profile_snapshot_json, group_variables_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      normalizedPath,
      params.folderName,
      params.ossPrefix || "",
      uploadTargetMode,
      params.dayFolderId || null,
      uploadRelativePath,
      params.sourceType || "local",
      params.sourceMachineId || null,
      params.profileId || null,
      params.profileName || null,
      params.profileSnapshot ? JSON.stringify(params.profileSnapshot) : null,
      JSON.stringify(params.groupVariables || {}),
      now,
      now
    );
    getTaskDestinationRepo().ensureForTask(
      id,
      uploadTargetMode,
      params.destinationPrefixes || { aliyun: params.ossPrefix || "" },
      "pending",
      destinationUploadRelativePaths,
      params.destinationPathModes,
      params.destinationObjectKeyTemplates
    );
    return this.getById(id);
  }
  updateDayFolderId(id, dayFolderId) {
    getDb().prepare(
      `UPDATE tasks
       SET day_folder_id = ?, updated_at = ?
       WHERE id = ?`
    ).run(dayFolderId, (/* @__PURE__ */ new Date()).toISOString(), id);
  }
  updateDayFolderMetadata(id, dayFolderId, uploadRelativePath) {
    getDb().prepare(
      `UPDATE tasks
       SET day_folder_id = ?, upload_relative_path = ?, updated_at = ?
       WHERE id = ?`
    ).run(dayFolderId, uploadRelativePath, (/* @__PURE__ */ new Date()).toISOString(), id);
  }
  updateGroupVariables(id, variables) {
    getDb().prepare(
      `UPDATE tasks
       SET group_variables_json = ?, updated_at = ?
       WHERE id = ?`
    ).run(JSON.stringify(variables), (/* @__PURE__ */ new Date()).toISOString(), id);
  }
  updateUploadRelativePath(id, uploadRelativePath) {
    getDb().prepare(
      `UPDATE tasks
       SET upload_relative_path = ?, updated_at = ?
       WHERE id = ?`
    ).run(uploadRelativePath, (/* @__PURE__ */ new Date()).toISOString(), id);
  }
  listByDayFolder(dayFolderId) {
    const rows = getDb().prepare(
      "SELECT * FROM tasks WHERE day_folder_id = ? ORDER BY created_at DESC"
    ).all(dayFolderId);
    return this.rowsToTasks(rows);
  }
  updateStatus(id, status, errorMessage) {
    const db2 = getDb();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const completedAt = status === "completed" || status === "failed" || status === "skipped" ? now : null;
    db2.prepare(
      "UPDATE tasks SET status = ?, error_message = ?, updated_at = ?, completed_at = ? WHERE id = ?"
    ).run(status, errorMessage || null, now, completedAt, id);
  }
  retry(id, provider) {
    getTaskDestinationRepo().resetFailed(id, provider);
    getDb().prepare(
      `UPDATE task_files
       SET retry_count = 0, next_retry_at = NULL, error_message = NULL,
           status = CASE
             WHEN source_status = 'present' AND status != 'completed' THEN 'pending'
             ELSE status
           END,
           updated_at = ?
       WHERE task_id = ?`
    ).run((/* @__PURE__ */ new Date()).toISOString(), id);
    this.updateStatus(id, "pending");
  }
  resumeForUpload(id) {
    const task = this.getById(id);
    if (!task) return;
    if (task.status === "failed" || task.status === "paused" || task.status === "retrying") {
      this.retry(id);
    }
  }
  resumeManyForUpload(ids) {
    for (const id of Array.from(new Set(ids))) {
      this.resumeForUpload(id);
    }
  }
  skip(id, reason = "用户跳过") {
    const db2 = getDb();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const transaction = db2.transaction(() => {
      db2.prepare(
        `UPDATE tasks
         SET status = 'skipped', error_message = ?, completed_at = ?, updated_at = ?
         WHERE id = ?`
      ).run(reason, now, now, id);
      db2.prepare(
        `UPDATE task_destinations
         SET status = CASE WHEN status IN ('completed', 'synced') THEN status ELSE 'skipped' END,
             error_message = CASE WHEN status IN ('completed', 'synced') THEN error_message ELSE ? END,
             completed_at = COALESCE(completed_at, ?), updated_at = ?
         WHERE task_id = ?`
      ).run(reason, now, now, id);
      db2.prepare(
        `UPDATE task_file_destinations
         SET status = CASE WHEN status = 'completed' THEN status ELSE 'skipped' END,
             error_message = CASE WHEN status = 'completed' THEN error_message ELSE ? END,
             updated_at = ?
         WHERE task_file_id IN (SELECT id FROM task_files WHERE task_id = ?)`
      ).run(reason, now, id);
      db2.prepare(
        `UPDATE task_files
         SET status = CASE WHEN status = 'completed' THEN status ELSE 'skipped' END,
             error_message = CASE WHEN status = 'completed' THEN error_message ELSE ? END,
             next_retry_at = NULL, updated_at = ?
         WHERE task_id = ?`
      ).run(reason, now, id);
    });
    transaction();
  }
  restore(id) {
    const db2 = getDb();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const transaction = db2.transaction(() => {
      db2.prepare(
        `UPDATE tasks
         SET status = 'scanning', error_message = NULL, completed_at = NULL, updated_at = ?
         WHERE id = ?`
      ).run(now, id);
      db2.prepare(
        `UPDATE task_destinations
         SET status = CASE WHEN status = 'skipped' THEN 'pending' ELSE status END,
             error_message = NULL,
             completed_at = CASE WHEN status = 'skipped' THEN NULL ELSE completed_at END,
             updated_at = ?
         WHERE task_id = ?`
      ).run(now, id);
      db2.prepare(
        `UPDATE task_file_destinations
         SET status = CASE
               WHEN status = 'skipped'
                AND task_file_id IN (
                  SELECT id FROM task_files
                  WHERE task_id = ? AND source_status = 'present'
                )
               THEN 'pending'
               ELSE status
             END,
             error_message = NULL, updated_at = ?
         WHERE task_file_id IN (SELECT id FROM task_files WHERE task_id = ?)`
      ).run(id, now, id);
      db2.prepare(
        `UPDATE task_files
         SET status = CASE
               WHEN status = 'skipped' AND source_status = 'present' THEN 'pending'
               ELSE status
             END,
             retry_count = 0, next_retry_at = NULL, error_message = NULL,
             updated_at = ?
         WHERE task_id = ?`
      ).run(now, id);
    });
    transaction();
  }
  updateProgress(id, uploadedFiles, uploadedBytes) {
    const db2 = getDb();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    db2.prepare(
      "UPDATE tasks SET uploaded_files = ?, uploaded_bytes = ?, updated_at = ? WHERE id = ?"
    ).run(uploadedFiles, uploadedBytes, now, id);
  }
  setTotals(id, totalFiles, totalBytes) {
    const db2 = getDb();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    db2.prepare(
      "UPDATE tasks SET total_files = ?, total_bytes = ?, updated_at = ? WHERE id = ?"
    ).run(totalFiles, totalBytes, now, id);
  }
  // ---- task_files ----
  createFile(taskId, relativePath, fileSize, mtimeMs = 0) {
    const db2 = getDb();
    const id = uuid.v4();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    db2.prepare(
      `INSERT INTO task_files (
        id, task_id, relative_path, file_size, status, mtime_ms,
        last_seen_at, source_status, stable_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?, 'present', 1, ?, ?)`
    ).run(id, taskId, relativePath, fileSize, mtimeMs, now, now, now);
    return rowToTaskFile(db2.prepare("SELECT * FROM task_files WHERE id = ?").get(id));
  }
  bulkCreateFiles(taskId, files) {
    const db2 = getDb();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const stmt = db2.prepare(
      `INSERT OR IGNORE INTO task_files (
        id, task_id, relative_path, file_size, status, mtime_ms,
        last_seen_at, source_status, stable_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?, 'present', 1, ?, ?)`
    );
    const transaction = db2.transaction(() => {
      for (const f of files) {
        stmt.run(
          uuid.v4(),
          taskId,
          f.relativePath,
          f.fileSize,
          f.mtimeMs || 0,
          now,
          now,
          now
        );
      }
    });
    transaction();
  }
  listFiles(taskId, status) {
    const db2 = getDb();
    if (status) {
      return db2.prepare("SELECT * FROM task_files WHERE task_id = ? AND status = ?").all(taskId, status).map(rowToTaskFile);
    }
    return db2.prepare("SELECT * FROM task_files WHERE task_id = ?").all(taskId).map(rowToTaskFile);
  }
  summarizeFiles(taskId) {
    const row = getDb().prepare(
      `SELECT
         COUNT(*) AS total_files,
         COALESCE(SUM(file_size), 0) AS total_bytes,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_files,
         COALESCE(SUM(CASE WHEN status = 'completed' THEN file_size ELSE 0 END), 0) AS completed_bytes,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_files,
         SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped_files
       FROM task_files
       WHERE task_id = ?`
    ).get(taskId);
    return {
      totalFiles: row.total_files || 0,
      totalBytes: row.total_bytes || 0,
      completedFiles: row.completed_files || 0,
      completedBytes: row.completed_bytes || 0,
      failedFiles: row.failed_files || 0,
      skippedFiles: row.skipped_files || 0
    };
  }
  listFileDetails(taskId) {
    const files = this.listFiles(taskId);
    const destinations = getTaskDestinationRepo().listFileTargets(taskId);
    const destinationsByFile = /* @__PURE__ */ new Map();
    for (const destination of destinations) {
      const list = destinationsByFile.get(destination.taskFileId) || [];
      list.push(destination);
      destinationsByFile.set(destination.taskFileId, list);
    }
    return files.map((file) => ({
      ...file,
      destinations: (destinationsByFile.get(file.id) || []).map(({ taskId: _taskId, relativePath: _path, fileSize: _size, ...destination }) => destination)
    }));
  }
  reconcileFiles(taskId, files, requiredStableChecks, options = {}) {
    const db2 = getDb();
    const task = this.getById(taskId);
    if (!task || task.status === "skipped" || task.status === "paused") {
      return this.emptyReconcileResult();
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const tempTable = this.createReconcileTempTable();
    const quotedTempTable = this.quoteIdentifier(tempTable);
    let hasPlannedObjectKeys = false;
    let changed = false;
    try {
      this.insertReconcileBatch(quotedTempTable, files, (hasPlannedObjectKey) => {
        hasPlannedObjectKeys = hasPlannedObjectKeys || hasPlannedObjectKey;
      });
      changed = this.applyReconcileTempChanges(
        taskId,
        quotedTempTable,
        now,
        Math.max(1, requiredStableChecks)
      );
    } catch (error) {
      db2.prepare(`DROP TABLE IF EXISTS ${quotedTempTable}`).run();
      throw error;
    }
    try {
      return this.completeReconcileFromTempTable(
        task,
        quotedTempTable,
        now,
        Math.max(1, requiredStableChecks),
        changed,
        options.replacePlannedObjectKeys ?? hasPlannedObjectKeys
      );
    } finally {
      db2.prepare(`DROP TABLE IF EXISTS ${quotedTempTable}`).run();
    }
  }
  async reconcileFileBatches(taskId, fileBatches, requiredStableChecks, options = {}) {
    const db2 = getDb();
    const task = this.getById(taskId);
    if (!task || task.status === "skipped" || task.status === "paused") {
      return this.emptyReconcileResult();
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const tempTable = this.createReconcileTempTable();
    const quotedTempTable = this.quoteIdentifier(tempTable);
    let hasPlannedObjectKeys = false;
    let changed = false;
    try {
      for await (const batch of fileBatches) {
        this.insertReconcileBatch(quotedTempTable, batch, (hasPlannedObjectKey) => {
          hasPlannedObjectKeys = hasPlannedObjectKeys || hasPlannedObjectKey;
        });
      }
      changed = this.applyReconcileTempChanges(
        taskId,
        quotedTempTable,
        now,
        Math.max(1, requiredStableChecks)
      );
      return this.completeReconcileFromTempTable(
        task,
        quotedTempTable,
        now,
        Math.max(1, requiredStableChecks),
        changed,
        options.replacePlannedObjectKeys ?? hasPlannedObjectKeys
      );
    } finally {
      db2.prepare(`DROP TABLE IF EXISTS ${quotedTempTable}`).run();
    }
  }
  insertReconcileBatch(quotedTempTable, files, onPlannedObjectKeyPresence) {
    const insert = getDb().prepare(
      `INSERT OR REPLACE INTO ${quotedTempTable} (
        relative_path, file_size, mtime_ms, planned_object_key
      ) VALUES (?, ?, ?, ?)`
    );
    let hasPlannedObjectKey = false;
    const transaction = getDb().transaction(() => {
      for (const file of files) {
        if (Object.prototype.hasOwnProperty.call(file, "plannedObjectKey")) {
          hasPlannedObjectKey = true;
        }
        insert.run(
          file.relativePath,
          file.size,
          file.mtimeMs,
          file.plannedObjectKey || null
        );
      }
    });
    transaction();
    onPlannedObjectKeyPresence(hasPlannedObjectKey);
  }
  applyReconcileTempChanges(taskId, quotedTempTable, now, requiredStableChecks) {
    const db2 = getDb();
    let changed = false;
    const transaction = db2.transaction(() => {
      db2.prepare(
        `UPDATE task_file_destinations
         SET status = 'pending', object_key = NULL, upload_id = NULL,
             error_message = NULL, updated_at = ?
         WHERE status != 'uploading'
           AND task_file_id IN (
             SELECT tf.id
             FROM task_files tf
             INNER JOIN ${quotedTempTable} scanned
               ON scanned.relative_path = tf.relative_path
             WHERE tf.task_id = ?
               AND (
                 tf.file_size != scanned.file_size
                 OR tf.mtime_ms != scanned.mtime_ms
                 OR tf.source_status = 'missing'
               )
           )`
      ).run(now, taskId);
      db2.prepare(
        `UPDATE task_files
         SET last_seen_at = ?,
             source_status = 'present',
             stable_count = MIN(stable_count + 1, ?),
             updated_at = ?
         WHERE task_id = ?
           AND source_status = 'present'
           AND stable_count < ?
           AND EXISTS (
             SELECT 1
             FROM ${quotedTempTable} scanned
             WHERE scanned.relative_path = task_files.relative_path
               AND task_files.file_size = scanned.file_size
               AND task_files.mtime_ms = scanned.mtime_ms
           )`
      ).run(now, requiredStableChecks, now, taskId, requiredStableChecks);
      const changedRows = db2.prepare(
        `UPDATE task_files
         SET file_size = (
             SELECT scanned.file_size
             FROM ${quotedTempTable} scanned
             WHERE scanned.relative_path = task_files.relative_path
           ),
           mtime_ms = (
             SELECT scanned.mtime_ms
             FROM ${quotedTempTable} scanned
             WHERE scanned.relative_path = task_files.relative_path
           ),
           last_seen_at = ?,
           source_status = 'present',
           stable_count = 1,
           status = 'pending',
           error_message = NULL,
           retry_count = 0,
           next_retry_at = NULL,
           updated_at = ?
         WHERE task_id = ?
           AND EXISTS (
             SELECT 1
             FROM ${quotedTempTable} scanned
             WHERE scanned.relative_path = task_files.relative_path
               AND (
                 task_files.file_size != scanned.file_size
                 OR task_files.mtime_ms != scanned.mtime_ms
                 OR task_files.source_status = 'missing'
               )
           )`
      ).run(now, now, taskId).changes;
      const insertedRows = db2.prepare(
        `INSERT INTO task_files (
          id, task_id, relative_path, file_size, status, mtime_ms,
          last_seen_at, source_status, stable_count, created_at, updated_at
        )
        SELECT lower(hex(randomblob(16))), ?, scanned.relative_path,
          scanned.file_size, 'pending', scanned.mtime_ms, ?, 'present',
          1, ?, ?
        FROM ${quotedTempTable} scanned
        LEFT JOIN task_files existing
          ON existing.task_id = ?
         AND existing.relative_path = scanned.relative_path
        WHERE existing.id IS NULL`
      ).run(taskId, now, now, now, taskId).changes;
      db2.prepare(
        `UPDATE task_file_destinations
         SET status = CASE WHEN status = 'completed' THEN status ELSE 'skipped' END,
             error_message = CASE WHEN status = 'completed' THEN error_message ELSE '源文件已删除' END,
             updated_at = ?
         WHERE status != 'uploading'
           AND task_file_id IN (
             SELECT tf.id
             FROM task_files tf
             LEFT JOIN ${quotedTempTable} scanned
               ON scanned.relative_path = tf.relative_path
             WHERE tf.task_id = ?
               AND tf.source_status != 'missing'
               AND scanned.relative_path IS NULL
           )`
      ).run(now, taskId);
      const missingRows = db2.prepare(
        `UPDATE task_files
         SET source_status = 'missing',
             status = CASE WHEN status = 'completed' THEN status ELSE 'skipped' END,
             error_message = CASE WHEN status = 'completed' THEN error_message ELSE '源文件已删除' END,
             next_retry_at = NULL,
             updated_at = ?
         WHERE task_id = ?
           AND source_status != 'missing'
           AND NOT EXISTS (
             SELECT 1
             FROM ${quotedTempTable} scanned
             WHERE scanned.relative_path = task_files.relative_path
           )`
      ).run(now, taskId).changes;
      changed = changedRows > 0 || insertedRows > 0 || missingRows > 0;
    });
    transaction();
    return changed;
  }
  completeReconcileFromTempTable(task, quotedTempTable, now, requiredStableChecks, changed, shouldReplacePlannedObjectKeys) {
    const db2 = getDb();
    const taskId = task.id;
    const destinationRepo = getTaskDestinationRepo();
    destinationRepo.ensureForTaskFiles(taskId);
    if (shouldReplacePlannedObjectKeys) {
      this.replacePlannedObjectKeysFromTempTable(taskId, quotedTempTable, now);
    }
    const counts = db2.prepare(
      `SELECT
         COUNT(*) AS total_files,
         COALESCE(SUM(file_size), 0) AS total_bytes,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS uploaded_files,
         COALESCE(SUM(CASE WHEN status = 'completed' THEN file_size ELSE 0 END), 0) AS uploaded_bytes,
         SUM(CASE
           WHEN source_status = 'present'
            AND stable_count >= ?
            AND status IN ('pending', 'failed')
            AND (next_retry_at IS NULL OR next_retry_at <= ?)
           THEN 1 ELSE 0 END) AS ready_files,
         SUM(CASE
           WHEN source_status = 'present' AND stable_count < ?
           THEN 1 ELSE 0 END) AS unstable_files,
         SUM(CASE
           WHEN source_status = 'present'
            AND status = 'pending'
            AND next_retry_at IS NOT NULL
            AND next_retry_at > ?
           THEN 1 ELSE 0 END) AS retry_waiting_files,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_files,
         SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped_files
       FROM task_files
       WHERE task_id = ?`
    ).get(
      requiredStableChecks,
      now,
      requiredStableChecks,
      now,
      taskId
    );
    db2.prepare(
      `UPDATE tasks
       SET total_files = ?, total_bytes = ?, uploaded_files = ?, uploaded_bytes = ?,
           updated_at = ?
       WHERE id = ?`
    ).run(
      counts.total_files || 0,
      counts.total_bytes || 0,
      counts.uploaded_files || 0,
      counts.uploaded_bytes || 0,
      now,
      taskId
    );
    for (const destination of destinationRepo.listByTask(taskId)) {
      destinationRepo.recalculateProgress(taskId, destination.provider);
      const summary = destinationRepo.summarizeFileTargets(
        taskId,
        destination.provider,
        now
      );
      if (summary.failed > 0) {
        destinationRepo.updateStatus(
          taskId,
          destination.provider,
          "failed",
          "存在需要处理的上传失败文件"
        );
      } else if (summary.pending > 0) {
        destinationRepo.updateStatus(
          taskId,
          destination.provider,
          summary.retryWaiting > 0 ? "retrying" : "pending"
        );
      } else if (summary.total > 0) {
        destinationRepo.updateStatus(
          taskId,
          destination.provider,
          task.sourceType === "local" && task.dayFolderId ? "synced" : "completed"
        );
      }
    }
    const latest = this.getById(taskId);
    if (latest && latest.status !== "uploading") {
      if ((counts.failed_files || 0) > 0) {
        this.updateStatus(taskId, "failed", "存在需要处理的上传失败文件");
      } else if ((counts.ready_files || 0) > 0) {
        this.updateStatus(taskId, "pending");
      } else if ((counts.retry_waiting_files || 0) > 0) {
        this.updateStatus(taskId, "retrying");
      } else if ((counts.unstable_files || 0) > 0) {
        this.updateStatus(taskId, "scanning");
      } else {
        this.updateStatus(
          taskId,
          task.sourceType === "local" && task.dayFolderId ? "synced" : "completed"
        );
      }
    }
    return {
      changed,
      readyFiles: counts.ready_files || 0,
      unstableFiles: counts.unstable_files || 0,
      failedFiles: counts.failed_files || 0,
      skippedFiles: counts.skipped_files || 0
    };
  }
  createReconcileTempTable() {
    const name = `tmp_reconcile_files_${uuid.v4().replace(/-/g, "")}`;
    getDb().exec(`
      CREATE TEMP TABLE ${this.quoteIdentifier(name)} (
        relative_path TEXT PRIMARY KEY,
        file_size INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        planned_object_key TEXT
      )
    `);
    return name;
  }
  replacePlannedObjectKeysFromTempTable(taskId, quotedTempTable, now) {
    const db2 = getDb();
    const transaction = db2.transaction(() => {
      db2.prepare(
        `UPDATE task_file_destinations
         SET planned_object_key = NULL, updated_at = ?
         WHERE planned_object_key IS NOT NULL
           AND id IN (
             SELECT tfd.id
             FROM task_file_destinations tfd
             INNER JOIN task_files tf ON tf.id = tfd.task_file_id
             LEFT JOIN ${quotedTempTable} scanned
               ON scanned.relative_path = tf.relative_path
              AND scanned.planned_object_key IS NOT NULL
             WHERE tf.task_id = ?
               AND scanned.relative_path IS NULL
           )`
      ).run(now, taskId);
      db2.prepare(
        `UPDATE task_file_destinations
         SET planned_object_key = (
             SELECT scanned.planned_object_key
             FROM task_files tf
             INNER JOIN ${quotedTempTable} scanned
               ON scanned.relative_path = tf.relative_path
             WHERE tf.id = task_file_destinations.task_file_id
               AND scanned.planned_object_key IS NOT NULL
           ),
           updated_at = ?
         WHERE task_file_id IN (
           SELECT tf.id
           FROM task_files tf
           INNER JOIN ${quotedTempTable} scanned
             ON scanned.relative_path = tf.relative_path
           WHERE tf.task_id = ?
             AND scanned.planned_object_key IS NOT NULL
         )
         AND (
           planned_object_key IS NULL
           OR planned_object_key != (
             SELECT scanned.planned_object_key
             FROM task_files tf
             INNER JOIN ${quotedTempTable} scanned
               ON scanned.relative_path = tf.relative_path
             WHERE tf.id = task_file_destinations.task_file_id
               AND scanned.planned_object_key IS NOT NULL
           )
         )`
      ).run(now, taskId);
    });
    transaction();
  }
  emptyReconcileResult() {
    return {
      changed: false,
      readyFiles: 0,
      unstableFiles: 0,
      failedFiles: 0,
      skippedFiles: 0
    };
  }
  quoteIdentifier(identifier) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
      throw new Error(`Invalid SQL identifier: ${identifier}`);
    }
    return `"${identifier}"`;
  }
  markFileChanged(fileId, fileSize, mtimeMs) {
    const db2 = getDb();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const transaction = db2.transaction(() => {
      db2.prepare(
        `UPDATE task_files
         SET file_size = ?, mtime_ms = ?, stable_count = 1,
             status = 'pending', source_status = 'present',
             error_message = NULL, retry_count = 0, next_retry_at = NULL,
             last_seen_at = ?, updated_at = ?
         WHERE id = ?`
      ).run(fileSize, mtimeMs, now, now, fileId);
      db2.prepare(
        `UPDATE task_file_destinations
         SET status = 'pending', object_key = NULL, upload_id = NULL,
             error_message = NULL, updated_at = ?
         WHERE task_file_id = ?`
      ).run(now, fileId);
    });
    transaction();
  }
  scheduleRetry(fileId, errorMessage, nextRetryAt) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    getDb().prepare(
      `UPDATE task_files
       SET status = 'pending', retry_count = retry_count + 1,
           next_retry_at = ?, error_message = ?, updated_at = ?
       WHERE id = ?`
    ).run(nextRetryAt, errorMessage, now, fileId);
    const row = getDb().prepare(
      "SELECT retry_count FROM task_files WHERE id = ?"
    ).get(fileId);
    return row.retry_count;
  }
  clearRetry(fileId) {
    getDb().prepare(
      `UPDATE task_files
       SET retry_count = 0, next_retry_at = NULL, error_message = NULL,
           updated_at = ?
       WHERE id = ?`
    ).run((/* @__PURE__ */ new Date()).toISOString(), fileId);
  }
  recalculateProgress(taskId) {
    const row = getDb().prepare(
      `SELECT
         COUNT(*) AS total_files,
         COALESCE(SUM(file_size), 0) AS total_bytes,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS uploaded_files,
         COALESCE(SUM(CASE WHEN status = 'completed' THEN file_size ELSE 0 END), 0) AS uploaded_bytes
       FROM task_files
       WHERE task_id = ?`
    ).get(taskId);
    getDb().prepare(
      `UPDATE tasks
       SET total_files = ?, total_bytes = ?, uploaded_files = ?,
           uploaded_bytes = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      row.total_files || 0,
      row.total_bytes || 0,
      row.uploaded_files || 0,
      row.uploaded_bytes || 0,
      (/* @__PURE__ */ new Date()).toISOString(),
      taskId
    );
  }
  updateFileStatus(fileId, status, ossKey, uploadId, errorMessage) {
    const db2 = getDb();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    db2.prepare(
      "UPDATE task_files SET status = ?, oss_key = COALESCE(?, oss_key), upload_id = COALESCE(?, upload_id), error_message = ?, updated_at = ? WHERE id = ?"
    ).run(status, ossKey || null, uploadId || null, errorMessage || null, now, fileId);
  }
  getUnfinishedTasks() {
    const db2 = getDb();
    const rows = db2.prepare(
      `SELECT * FROM tasks
       WHERE status IN ('pending', 'uploading', 'scanning', 'retrying', 'failed', 'paused')
       ORDER BY created_at ASC`
    ).all();
    return this.rowsToTasks(rows);
  }
  listPendingUploadTaskIds() {
    const placeholders = UPLOAD_QUEUE_CANDIDATE_STATUSES.map(() => "?").join(",");
    const rows = getDb().prepare(
      `SELECT id FROM tasks
       WHERE status IN (${placeholders})
       ORDER BY created_at ASC`
    ).all(...UPLOAD_QUEUE_CANDIDATE_STATUSES);
    return rows.map((row) => row.id);
  }
  listPendingUploadTaskIdsByDayFolderIds(dayFolderIds) {
    const uniqueIds = Array.from(new Set(dayFolderIds)).filter(Boolean);
    if (uniqueIds.length === 0) return [];
    const folderPlaceholders = uniqueIds.map(() => "?").join(",");
    const statusPlaceholders = UPLOAD_QUEUE_CANDIDATE_STATUSES.map(() => "?").join(",");
    const rows = getDb().prepare(
      `SELECT id FROM tasks
       WHERE day_folder_id IN (${folderPlaceholders})
         AND status IN (${statusPlaceholders})
       ORDER BY created_at ASC`
    ).all(...uniqueIds, ...UPLOAD_QUEUE_CANDIDATE_STATUSES);
    return rows.map((row) => row.id);
  }
  listMonitorableLocalUnfinishedTasks() {
    const rows = getDb().prepare(
      `SELECT * FROM tasks
       WHERE source_type = 'local'
         AND day_folder_id IS NOT NULL
         AND status NOT IN ('completed', 'synced', 'skipped')
       ORDER BY created_at ASC`
    ).all();
    return this.rowsToTasks(rows);
  }
  listUnfinishedTaskIds() {
    const rows = getDb().prepare(
      `SELECT id FROM tasks
       WHERE status IN ('pending', 'uploading', 'scanning', 'retrying', 'failed', 'paused')
       ORDER BY created_at ASC`
    ).all();
    return rows.map((row) => row.id);
  }
  getCompletedForCleanup(retentionDays) {
    const db2 = getDb();
    const cutoff = new Date(Date.now() - retentionDays * 864e5).toISOString();
    const rows = db2.prepare(
      `SELECT * FROM tasks
       WHERE status = 'completed'
         AND (source_type = 'rsync' OR (source_type = 'local' AND day_folder_id IS NULL))
         AND completed_at IS NOT NULL AND completed_at < ?
       ORDER BY completed_at ASC`
    ).all(cutoff);
    return this.rowsToTasks(rows);
  }
}
let instance$n = null;
function getTaskRepo() {
  if (!instance$n) instance$n = new TaskRepo();
  return instance$n;
}
const GENERIC_CONVERTER_EXTENSION_ID = "generic-converter";
const DEFAULT_GENERIC_CONVERTER_CONFIG = {
  enabled: false,
  pythonPath: "python3",
  monitorScriptPath: "",
  converterScriptPath: "",
  dataRoot: "",
  outputRoot: "",
  deviceCode: "G26",
  stableSeconds: 300,
  pollIntervalSeconds: 30,
  retryFailed: false,
  env: {},
  extraArgs: [],
  outputDirectoryTemplate: "{outputRoot}/{date}",
  outputBatchNameTemplate: "{deviceCode}_{startTs}_{endTs}",
  outputFileNameTemplate: "{batchName}.mcap",
  outputBatchNamePattern: "^[^/]+_\\d{17}Z8_\\d{17}Z8$"
};
function isRecord$2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function normalizeString(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}
function normalizeNumber(value, fallback, min, max) {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}
function normalizeStringArray$1(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}
function normalizeEnv(value) {
  if (!isRecord$2(value)) return {};
  return Object.fromEntries(
    Object.entries(value).map(([key, envValue]) => [key.trim(), String(envValue)]).filter(([key]) => key.length > 0)
  );
}
function validRegex(value) {
  try {
    new RegExp(value);
    return true;
  } catch {
    return false;
  }
}
function normalizeGenericConverterConfig(rawConfig) {
  const raw = isRecord$2(rawConfig) ? rawConfig : {};
  const fallback = DEFAULT_GENERIC_CONVERTER_CONFIG;
  const outputBatchNamePattern = normalizeString(
    raw.outputBatchNamePattern,
    fallback.outputBatchNamePattern
  );
  return {
    enabled: raw.enabled === true,
    pythonPath: normalizeString(raw.pythonPath, fallback.pythonPath) || fallback.pythonPath,
    monitorScriptPath: normalizeString(raw.monitorScriptPath),
    converterScriptPath: normalizeString(raw.converterScriptPath),
    dataRoot: normalizeString(raw.dataRoot),
    outputRoot: normalizeString(raw.outputRoot),
    deviceCode: normalizeString(raw.deviceCode, fallback.deviceCode) || fallback.deviceCode,
    stableSeconds: normalizeNumber(raw.stableSeconds, fallback.stableSeconds, 0, 86400),
    pollIntervalSeconds: normalizeNumber(
      raw.pollIntervalSeconds,
      fallback.pollIntervalSeconds,
      1,
      86400
    ),
    retryFailed: raw.retryFailed === true,
    env: normalizeEnv(raw.env),
    extraArgs: normalizeStringArray$1(raw.extraArgs),
    outputDirectoryTemplate: normalizeString(
      raw.outputDirectoryTemplate,
      fallback.outputDirectoryTemplate
    ) || fallback.outputDirectoryTemplate,
    outputBatchNameTemplate: normalizeString(
      raw.outputBatchNameTemplate,
      fallback.outputBatchNameTemplate
    ) || fallback.outputBatchNameTemplate,
    outputFileNameTemplate: normalizeString(
      raw.outputFileNameTemplate,
      fallback.outputFileNameTemplate
    ) || fallback.outputFileNameTemplate,
    outputBatchNamePattern: validRegex(outputBatchNamePattern) ? outputBatchNamePattern : fallback.outputBatchNamePattern
  };
}
function genericConverterConfigFromExtensions(extensions) {
  return normalizeGenericConverterConfig(
    extensions?.configs?.[GENERIC_CONVERTER_EXTENSION_ID]
  );
}
function mergeWorkDirNamePattern(currentPattern, outputBatchNamePattern) {
  const current = currentPattern?.trim();
  const output = outputBatchNamePattern.trim();
  if (!output) return current || "";
  if (!current) return output;
  if (current === output || current.includes(output)) return current;
  return `(?:${current})|(?:${output})`;
}
function applyGenericConverterScanHandoff(profile, config) {
  if (!config.enabled || !config.outputRoot) return profile;
  const providers = providersForProfile(profile);
  const providerDirectories = {
    aliyun: [...profile.scan.providerDirectories.aliyun || []],
    tencent: [...profile.scan.providerDirectories.tencent || []]
  };
  const sourceRoots = profile.source?.roots?.length ? [...profile.source.roots] : profile.source?.root ? [profile.source.root] : [];
  for (const provider of providers) {
    if (!providerDirectories[provider].includes(config.outputRoot)) {
      providerDirectories[provider].push(config.outputRoot);
    }
  }
  if (!sourceRoots.includes(config.outputRoot)) {
    sourceRoots.push(config.outputRoot);
  }
  return {
    ...profile,
    source: {
      root: sourceRoots[0] || "",
      roots: sourceRoots
    },
    scan: {
      ...profile.scan,
      providerDirectories,
      workDirNamePattern: mergeWorkDirNamePattern(
        profile.scan.workDirNamePattern,
        config.outputBatchNamePattern
      )
    },
    discovery: {
      ...profile.discovery,
      taskRegex: mergeWorkDirNamePattern(
        profile.discovery.taskRegex || profile.scan.workDirNamePattern,
        config.outputBatchNamePattern
      ),
      taskPattern: profile.discovery.taskRegex ? void 0 : profile.discovery.taskPattern
    }
  };
}
const UPLOAD_PIPELINE_IDS = {
  STANDARD_UPLOAD: "standard-upload",
  SANY_MODULE1_UPLOAD: "sany-module1-upload"
};
const EXTENSION_IDS = {
  WEBHOOK_NOTIFIER: "webhook-notifier",
  OSS_BROWSER: "oss-browser",
  GENERIC_CONVERTER: "generic-converter"
};
const PLUGIN_IDS = {
  MODULE1_PREUPLOAD: "module1-preupload",
  WEBHOOK_NOTIFIER: EXTENSION_IDS.WEBHOOK_NOTIFIER,
  OSS_BROWSER: EXTENSION_IDS.OSS_BROWSER,
  GENERIC_CONVERTER: EXTENSION_IDS.GENERIC_CONVERTER
};
const BUILTIN_UPLOAD_PIPELINES = [
  {
    id: UPLOAD_PIPELINE_IDS.STANDARD_UPLOAD,
    name: "通用上传",
    version: "1.0.0",
    category: "pipeline",
    description: "扫描原始源目录，并使用当前 Profile 的路径规则生成对象 Key。"
  },
  {
    id: UPLOAD_PIPELINE_IDS.SANY_MODULE1_UPLOAD,
    name: "Legacy SANY Module1 数据采集上传",
    version: "1.0.0",
    category: "pipeline",
    description: "Legacy: 复制到 staging 后按 SANY Module1 规则清理、分类、生成 manifest 和对象 Key。",
    legacy: true
  }
];
const BUILTIN_EXTENSIONS = [
  {
    id: EXTENSION_IDS.WEBHOOK_NOTIFIER,
    name: "Webhook 通知",
    version: "1.0.0",
    category: "notification",
    description: "任务完成或失败后向配置的 HTTP Webhook 发送通知。"
  },
  {
    id: EXTENSION_IDS.OSS_BROWSER,
    name: "OSS 浏览器",
    version: "1.0.0",
    category: "tool",
    description: "使用当前 Profile 的阿里云 OSS 配置只读浏览对象并预览图片。"
  },
  {
    id: EXTENSION_IDS.GENERIC_CONVERTER,
    name: "通用转换工具",
    version: "1.0.0",
    category: "tool",
    description: "按 Profile 启动外部监控转换脚本，转换产物继续由现有上传配置处理。"
  }
];
const DEFAULT_PROFILE_UPLOAD_PIPELINE = {
  id: UPLOAD_PIPELINE_IDS.STANDARD_UPLOAD,
  config: {}
};
const DEFAULT_PROFILE_EXTENSIONS = {
  enabledIds: [],
  configs: {
    [EXTENSION_IDS.WEBHOOK_NOTIFIER]: {
      url: "",
      headers: {},
      enabled: false
    },
    [EXTENSION_IDS.OSS_BROWSER]: {
      enabled: false
    },
    [EXTENSION_IDS.GENERIC_CONVERTER]: {
      ...DEFAULT_GENERIC_CONVERTER_CONFIG
    }
  }
};
const DEFAULT_PROFILE_PLUGINS = {
  enabledPluginIds: [],
  order: [
    PLUGIN_IDS.MODULE1_PREUPLOAD,
    PLUGIN_IDS.WEBHOOK_NOTIFIER,
    PLUGIN_IDS.OSS_BROWSER,
    PLUGIN_IDS.GENERIC_CONVERTER
  ],
  configs: {
    [PLUGIN_IDS.MODULE1_PREUPLOAD]: {
      stationPrefix: "station2"
    },
    [PLUGIN_IDS.WEBHOOK_NOTIFIER]: {
      url: "",
      headers: {},
      enabled: false
    },
    [PLUGIN_IDS.OSS_BROWSER]: {
      enabled: false
    },
    [PLUGIN_IDS.GENERIC_CONVERTER]: {
      ...DEFAULT_GENERIC_CONVERTER_CONFIG
    }
  }
};
const BUILTIN_UPLOAD_PIPELINE_ID_SET = new Set(BUILTIN_UPLOAD_PIPELINES.map((pipeline) => pipeline.id));
const BUILTIN_EXTENSION_ID_SET = new Set(BUILTIN_EXTENSIONS.map((extension) => extension.id));
const LEGACY_PLUGIN_ID_SET = /* @__PURE__ */ new Set([
  PLUGIN_IDS.MODULE1_PREUPLOAD,
  ...BUILTIN_EXTENSIONS.map((extension) => extension.id)
]);
function isBuiltinUploadPipelineId(id) {
  return BUILTIN_UPLOAD_PIPELINE_ID_SET.has(id);
}
function isBuiltinExtensionId(id) {
  return BUILTIN_EXTENSION_ID_SET.has(id);
}
function isBuiltinPluginId(id) {
  return LEGACY_PLUGIN_ID_SET.has(id);
}
const DEFAULT_WORK_DIR_NAME_PATTERN = "^\\d{2}-\\d{2}-\\d{2}$";
const DEFAULT_UPLOAD_PROFILE_ID = "default";
const DEFAULT_SETTINGS = {
  scan: {
    directories: [],
    providerDirectories: {
      aliyun: [],
      tencent: []
    },
    intervalSeconds: 30,
    workDirNamePattern: DEFAULT_WORK_DIR_NAME_PATTERN
  },
  upload: {
    maxConcurrentTasks: 4,
    maxFilesPerTask: 12,
    maxConcurrentUploads: 12,
    multipartThreshold: 100 * 1024 * 1024,
    // 100MB
    startAfterTime: "20:30",
    endBeforeTime: "23:59"
  },
  cloud: {
    targetMode: "aliyun"
  },
  oss: {
    endpoint: "",
    bucket: "",
    region: "",
    prefix: "",
    pathMode: "target-root",
    pathSegmentCount: 2,
    accessKeyId: "",
    accessKeySecret: ""
  },
  tencentS3: {
    endpoint: "",
    bucket: "",
    region: "",
    prefix: "",
    pathMode: "target-root",
    pathSegmentCount: 2,
    accessKeyId: "",
    accessKeySecret: "",
    allowInsecureTls: false
  },
  profiles: [
    {
      id: DEFAULT_UPLOAD_PROFILE_ID,
      name: "默认归档",
      enabled: true,
      source: {
        root: "",
        roots: []
      },
      destinations: [
        {
          connectionId: "aliyun",
          required: true
        }
      ],
      pathMapping: {
        mode: "keep-relative"
      },
      discovery: {
        groupPattern: "{date:yyyy-MM-dd}",
        taskPattern: "{session:HH-mm-ss}",
        recursive: false
      },
      completion: {
        mode: "rollover"
      },
      cleanup: {
        enabled: false,
        retentionDays: 7,
        onlyAfterSealed: true
      },
      targetMode: "aliyun",
      filter: {
        whitelist: [],
        blacklist: [],
        regex: [],
        suffixes: []
      },
      scan: {
        providerDirectories: {
          aliyun: [],
          tencent: []
        },
        workDirNamePattern: DEFAULT_WORK_DIR_NAME_PATTERN
      },
      providers: {
        aliyun: {
          prefix: "",
          pathMode: "target-root",
          pathSegmentCount: 2,
          objectKeyTemplate: "{relativePath}"
        },
        tencent: {
          prefix: "",
          pathMode: "target-root",
          pathSegmentCount: 2,
          objectKeyTemplate: "{relativePath}"
        }
      },
      uploadPipeline: DEFAULT_PROFILE_UPLOAD_PIPELINE,
      extensions: DEFAULT_PROFILE_EXTENSIONS
    }
  ],
  activeProfileId: DEFAULT_UPLOAD_PROFILE_ID,
  filter: {
    whitelist: [],
    blacklist: [],
    regex: [],
    suffixes: []
  },
  webhook: {
    url: "",
    headers: {},
    enabled: false
  },
  hotkey: "CommandOrControl+Shift+U",
  stability: {
    checkIntervalMs: 5e3,
    checkCount: 2
  },
  log: {
    directory: "",
    // 空字符串表示使用默认 userData/logs
    maxDays: 30
  },
  dataCollect: {
    enabled: false
  },
  cleanup: {
    enabled: false,
    retentionDays: 7,
    onlyAfterSealed: true
  }
};
const MARKER_FILES = {
  TMP_UPLOAD: "tmp_upload.json",
  PROCESS_TASK: "process_task.json",
  DAY_UPLOAD: "day_upload.json"
};
const CLOUD_PROVIDERS = ["aliyun", "tencent"];
function emptyProviderDirectories() {
  return {
    aliyun: [],
    tencent: []
  };
}
function normalizeScanDirectory(directory) {
  const trimmed = directory.trim().replace(/[\\/]+$/, "");
  if (!trimmed) return "";
  const parts = trimmed.split(/[\\/]+/);
  const last = parts[parts.length - 1];
  if (last && isDateFolderName(last) && parts.length > 1) {
    return trimmed.slice(0, trimmed.length - last.length).replace(/[\\/]+$/, "");
  }
  return trimmed;
}
function normalizeScanDirectories(directories) {
  return Array.from(
    new Set(
      directories.map(normalizeScanDirectory).filter(Boolean)
    )
  );
}
function normalizeSourceDirectory(directory) {
  return directory.trim().replace(/[\\/]+$/, "");
}
function normalizeSourceDirectories(directories) {
  return Array.from(
    new Set(
      directories.map(normalizeSourceDirectory).filter(Boolean)
    )
  );
}
function normalizeProviderDirectories(providerDirectories) {
  return {
    aliyun: normalizeScanDirectories(providerDirectories?.aliyun ?? []),
    tencent: normalizeScanDirectories(providerDirectories?.tencent ?? [])
  };
}
function migrateLegacyScanDirectories(legacyDirectories, targetMode) {
  const normalized = normalizeScanDirectories(legacyDirectories);
  const providerDirectories = emptyProviderDirectories();
  for (const provider of providersForMode(targetMode)) {
    providerDirectories[provider] = normalized;
  }
  return providerDirectories;
}
function normalizeScanConfig(scan, targetMode) {
  const hasProviderDirectories = Boolean(
    scan.providerDirectories && CLOUD_PROVIDERS.some(
      (provider) => scan.providerDirectories[provider]?.length > 0
    )
  );
  const providerDirectories = hasProviderDirectories ? normalizeProviderDirectories(scan.providerDirectories) : migrateLegacyScanDirectories(scan.directories ?? [], targetMode);
  const directories = normalizeScanDirectories([
    ...providerDirectories.aliyun,
    ...providerDirectories.tencent
  ]);
  return {
    ...scan,
    directories,
    providerDirectories
  };
}
function getActiveProfileScanRoots(profiles) {
  const roots = /* @__PURE__ */ new Map();
  for (const profile of profiles) {
    if (!profile.enabled) continue;
    const activeProviders = providersForProfile(profile);
    const sourceRoots = getProfileSourceDirectoriesForProviders(profile, activeProviders);
    for (const directory of sourceRoots) {
      const key = scanDirectoryKey(directory);
      const current = roots.get(key);
      if (current) {
        if (current.profileId === profile.id) {
          current.providers = providersForMode(modeForProviders([
            ...current.providers,
            ...activeProviders
          ]));
        }
        continue;
      }
      roots.set(key, {
        directory,
        providers: activeProviders,
        profileId: profile.id,
        profileName: profile.name
      });
    }
  }
  return Array.from(roots.values());
}
function getProfileWatchedDirectoriesByProvider(profiles) {
  const result = emptyProviderDirectories();
  for (const root of getActiveProfileScanRoots(profiles)) {
    for (const provider of root.providers) {
      if (!result[provider].includes(root.directory)) {
        result[provider].push(root.directory);
      }
    }
  }
  return result;
}
function scanDirectoryKey(directory) {
  return normalizeScanDirectory(directory).replace(/\\/g, "/");
}
function getProfileSourceDirectories(profile) {
  const sourceRoots = normalizeSourceDirectories(
    profile.source?.roots?.length ? profile.source.roots : profile.source?.root ? [profile.source.root] : []
  );
  if (sourceRoots.length > 0) return sourceRoots;
  const providerDirectories = normalizeProviderDirectories(
    profile.scan?.providerDirectories
  );
  return normalizeScanDirectories([
    ...providerDirectories.aliyun,
    ...providerDirectories.tencent
  ]);
}
function getProfileSourceDirectoriesForProviders(profile, activeProviders) {
  const sourceRoots = normalizeSourceDirectories(
    profile.source?.roots?.length ? profile.source.roots : profile.source?.root ? [profile.source.root] : []
  );
  if (sourceRoots.length > 0) return sourceRoots;
  const providerDirectories = normalizeProviderDirectories(
    profile.scan?.providerDirectories
  );
  return normalizeSourceDirectories(
    activeProviders.flatMap((provider) => providerDirectories[provider])
  );
}
const TEMPLATE_TOKEN_PATTERN = /\{([A-Za-z_][A-Za-z0-9_]*)(?::([^}]+))?\}/g;
const FORMAT_TOKENS = [
  ["yyyy", "\\d{4}"],
  ["yy", "\\d{2}"],
  ["MM", "\\d{2}"],
  ["dd", "\\d{2}"],
  ["HH", "\\d{2}"],
  ["mm", "\\d{2}"],
  ["ss", "\\d{2}"]
];
function compileDiscoveryPattern(pattern) {
  const source = pattern.trim().replace(/\\/g, "/");
  if (!source) throw new Error("Discovery pattern 不能为空");
  let body = "";
  let cursor = 0;
  for (const match of source.matchAll(TEMPLATE_TOKEN_PATTERN)) {
    body += escapeRegex(source.slice(cursor, match.index));
    const name = match[1];
    const format = match[2];
    body += `(?<${name}>${format ? compileFormat(format) : "[^/]+"})`;
    cursor = (match.index || 0) + match[0].length;
  }
  body += escapeRegex(source.slice(cursor));
  return new RegExp(`^${body}$`);
}
function matchDiscoveryPattern(pattern, value) {
  return matchDiscoveryRegex(compileDiscoveryPattern(pattern), value);
}
function matchDiscoveryRegex(regex, value) {
  const compiled = typeof regex === "string" ? new RegExp(regex) : regex;
  const match = compiled.exec(normalizeDiscoveryPath(value));
  if (!match) return null;
  return { variables: normalizeGroups(match.groups || {}) };
}
function matchDiscoveryRule(config, kind, value) {
  const regex = kind === "group" ? config.groupRegex : config.taskRegex;
  if (regex?.trim()) return matchDiscoveryRegex(regex.trim(), value);
  const pattern = kind === "group" ? config.groupPattern : config.taskPattern;
  if (pattern?.trim()) return matchDiscoveryPattern(pattern.trim(), value);
  return { variables: {} };
}
function extractDiscoveryVariables(config, sourceRoot, taskPath) {
  const relativePath = relativeDiscoveryPath(taskPath, sourceRoot);
  if (!relativePath) return {};
  const segments = relativePath.split("/").filter(Boolean);
  const variables = {};
  const groupDepth = config.groupPattern ? discoveryPatternDepth(config.groupPattern) : config.groupRegex ? 1 : 0;
  if ((config.groupPattern || config.groupRegex) && groupDepth > 0) {
    const groupPath = segments.slice(0, groupDepth).join("/");
    const groupMatch = matchDiscoveryRule(config, "group", groupPath);
    if (!groupMatch) return {};
    Object.assign(variables, groupMatch.variables);
  }
  const taskPathSegments = groupDepth > 0 ? segments.slice(groupDepth) : segments;
  if ((config.taskPattern || config.taskRegex) && taskPathSegments.length > 0) {
    const taskMatch = matchDiscoveryRule(config, "task", taskPathSegments.join("/"));
    if (!taskMatch) return variables;
    Object.assign(variables, taskMatch.variables);
  }
  return variables;
}
function discoveryPatternDepth(pattern) {
  const normalized = pattern?.trim().replace(/\\/g, "/") || "";
  if (!normalized) return 0;
  return normalized.split("/").filter(Boolean).length;
}
function relativeDiscoveryPath(path2, basePath) {
  const pathSegments2 = normalizeDiscoveryPath(path2).split("/").filter(Boolean);
  const baseSegments = normalizeDiscoveryPath(basePath).split("/").filter(Boolean);
  let index = 0;
  while (index < pathSegments2.length && index < baseSegments.length && segmentEquals$1(pathSegments2[index], baseSegments[index])) {
    index++;
  }
  if (index === baseSegments.length && index < pathSegments2.length) {
    return pathSegments2.slice(index).join("/");
  }
  return "";
}
function segmentEquals$1(a, b) {
  if (a.endsWith(":") || b.endsWith(":")) return a.toLowerCase() === b.toLowerCase();
  return a === b;
}
function normalizeDiscoveryPath(path2) {
  return path2.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}
function compileFormat(format) {
  let body = "";
  let cursor = 0;
  while (cursor < format.length) {
    const token = FORMAT_TOKENS.find(([name]) => format.startsWith(name, cursor));
    if (token) {
      body += token[1];
      cursor += token[0].length;
      continue;
    }
    body += escapeRegex(format[cursor]);
    cursor++;
  }
  return body;
}
function normalizeGroups(groups) {
  return Object.fromEntries(
    Object.entries(groups).filter((entry) => typeof entry[1] === "string")
  );
}
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const DEFAULT_OBJECT_KEY_TEMPLATE = "{relativePath}";
const DEFAULT_DISCOVERY_CONFIG = {
  groupPattern: "{date:yyyy-MM-dd}",
  taskPattern: "{session:HH-mm-ss}",
  recursive: false
};
const DEFAULT_COMPLETION_POLICY = { mode: "rollover" };
const DEFAULT_CLEANUP_POLICY = {
  enabled: false,
  retentionDays: 7,
  onlyAfterSealed: true
};
const BUILTIN_TEMPLATE_VARIABLES = /* @__PURE__ */ new Set([
  "profile",
  "provider",
  "date",
  "yy",
  "yyyy",
  "MM",
  "dd",
  "workDir",
  "session",
  "HH",
  "mm",
  "ss",
  "folderName",
  "sourceRelativePath",
  "sourceLast1",
  "sourceLast2",
  "sourceLast3",
  "relativePath",
  "filename",
  "stem",
  "ext"
]);
function normalizeProfiles(settings) {
  const fallbackProfile = createDefaultProfileFromSettings(settings);
  const rawProfiles = Array.isArray(settings.profiles) ? settings.profiles : [];
  const profiles = [];
  const seen = /* @__PURE__ */ new Set();
  for (const rawProfile of rawProfiles) {
    const profile = normalizeProfile(rawProfile, fallbackProfile);
    if (seen.has(profile.id)) continue;
    seen.add(profile.id);
    profiles.push(profile);
  }
  if (profiles.length === 0) {
    profiles.push(fallbackProfile);
    seen.add(fallbackProfile.id);
  }
  let activeProfileId = typeof settings.activeProfileId === "string" && seen.has(settings.activeProfileId) ? settings.activeProfileId : profiles[0].id;
  if (!profiles.some((profile) => profile.enabled && profile.id === activeProfileId)) {
    activeProfileId = profiles.find((profile) => profile.enabled)?.id || profiles[0].id;
  }
  return { profiles, activeProfileId };
}
function getProfileById(settings, profileId) {
  const normalized = normalizeProfiles(settings);
  return normalized.profiles.find((profile) => profile.id === profileId) || normalized.profiles.find((profile) => profile.id === normalized.activeProfileId) || normalized.profiles[0];
}
function extractProfilePathVariables(profile, sourcePath, fallbackBasePath) {
  const roots = getProfileSourceDirectories(profile).sort((a, b) => b.length - a.length);
  for (const root of roots) {
    if (!isPathUnderRoot(sourcePath, root)) continue;
    const variables = extractDiscoveryVariables(profile.discovery, root, sourcePath);
    if (Object.keys(variables).length > 0) return variables;
  }
  return fallbackBasePath ? extractDiscoveryVariables(profile.discovery, fallbackBasePath, sourcePath) : {};
}
function resolveProfileUploadSnapshot(profile, context, requestedProviders) {
  const providers = requestedProviders?.length ? requestedProviders : providersForProfile(profile);
  const uploadRelativePaths = {};
  const pathModes = {};
  const objectKeyTemplates = {};
  const legacyProviders = {
    aliyun: normalizeProfileProviderConfig(profile.providers?.aliyun),
    tencent: normalizeProfileProviderConfig(profile.providers?.tencent)
  };
  const prefixes = {
    aliyun: legacyProviders.aliyun.prefix,
    tencent: legacyProviders.tencent.prefix
  };
  for (const provider of providers) {
    const providerConfig = legacyUploadPathConfigForSnapshot(
      profile.pathMapping,
      legacyProviders[provider]
    );
    const normalized = normalizeUploadPathConfig(
      providerConfig
    );
    uploadRelativePaths[provider] = resolveUploadRelativePath(
      providerConfig,
      context
    );
    pathModes[provider] = normalized.pathMode;
    objectKeyTemplates[provider] = normalized.pathMode === "template" ? providerConfig.objectKeyTemplate || "" : null;
  }
  return {
    mode: modeForProviders(providers),
    prefixes,
    uploadRelativePaths,
    uploadRelativePath: firstResolvedPath(providers, uploadRelativePaths),
    profileId: profile.id,
    profileName: profile.name,
    profileSnapshot: profile,
    pathModes,
    objectKeyTemplates
  };
}
function renderObjectKey(destination, context) {
  const pathMode = destination.pathMode || "target-root";
  if (pathMode !== "template") {
    return buildOssKey(
      destination.prefix,
      destination.uploadRelativePath,
      context.relativePath
    );
  }
  const template = destination.objectKeyTemplate || "";
  const templateErrors = validateObjectKeyTemplate(template, context.variables);
  if (templateErrors.length > 0) {
    throw new Error(templateErrors.join("；"));
  }
  const variables = buildObjectKeyVariables(destination.provider, context);
  const rendered = template.replace(/\{([A-Za-z0-9_]+)\}/g, (_match, name) => {
    return variables[name] ?? "";
  });
  const normalized = joinOssPath(rendered);
  const keyErrors = validateObjectKeyValue(normalized);
  if (keyErrors.length > 0) {
    throw new Error(keyErrors.join("；"));
  }
  return joinOssPath(destination.prefix, normalized);
}
function buildObjectKeyVariables(provider, context) {
  const relativePath = normalizeObjectPath(context.relativePath);
  const fileName = pathSegments(relativePath).at(-1) || "";
  const dotIndex = fileName.lastIndexOf(".");
  const ext = dotIndex > 0 ? fileName.slice(dotIndex) : "";
  const stem = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
  const sourceSegments = pathSegments(context.sourcePath);
  const folderName = context.folderName || sourceSegments.at(-1) || "";
  const discoveryVariables = context.variables || {};
  const legacyDate = discoveryVariables.date || context.dateName || "";
  const legacyWorkDir = discoveryVariables.workDir || discoveryVariables.session || context.workDirName || "";
  const dateParts = parseDateParts(legacyDate);
  const timeParts = parseTimeParts(legacyWorkDir);
  const sourceRelativePath = context.basePath ? relativePathFromBase(context.sourcePath, context.basePath) : folderName;
  return {
    ...discoveryVariables,
    profile: context.profileName || "",
    provider,
    date: legacyDate,
    yy: dateParts.yy,
    yyyy: dateParts.yyyy,
    MM: dateParts.MM,
    dd: dateParts.dd,
    workDir: legacyWorkDir || folderName,
    session: discoveryVariables.session || legacyWorkDir,
    HH: timeParts.HH,
    mm: timeParts.mm,
    ss: timeParts.ss,
    folderName,
    sourceRelativePath,
    sourceLast1: sourceSegments.at(-1) || "",
    sourceLast2: sourceSegments.slice(-2).join("/"),
    sourceLast3: sourceSegments.slice(-3).join("/"),
    relativePath,
    filename: fileName,
    stem,
    ext
  };
}
function validateObjectKeyTemplate(template, variables = {}) {
  const errors = [];
  const trimmed = template.trim();
  if (!trimmed) errors.push("对象 Key 模板不能为空");
  if (isAbsolutePath(trimmed)) errors.push("对象 Key 模板不能使用绝对路径");
  const unknownVariables = Array.from(
    new Set(
      [...trimmed.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1]).filter((name) => !BUILTIN_TEMPLATE_VARIABLES.has(name) && !(name in variables))
    )
  );
  if (unknownVariables.length > 0) {
    errors.push(`未知模板变量: ${unknownVariables.join(", ")}`);
  }
  if (pathSegments(trimmed).includes("..")) {
    errors.push("对象 Key 模板不能包含 .. 路径段");
  }
  return errors;
}
function validateObjectKeyValue(key) {
  const errors = [];
  const trimmed = key.trim();
  if (!trimmed) errors.push("对象 Key 渲染结果不能为空");
  if (isAbsolutePath(trimmed)) errors.push("对象 Key 渲染结果不能是绝对路径");
  if (pathSegments(trimmed).includes("..")) {
    errors.push("对象 Key 渲染结果不能包含 .. 路径段");
  }
  return errors;
}
function createDefaultProfileFromSettings(settings) {
  const defaultSettings = DEFAULT_SETTINGS;
  const scan = settings.scan || defaultSettings.scan;
  const filter = normalizeFilter(settings.filter || defaultSettings.filter);
  const targetMode = normalizeTargetMode(settings.cloud?.targetMode, defaultSettings.cloud.targetMode);
  const providerDirectories = normalizeScanConfig(
    {
      ...defaultSettings.scan,
      ...scan
    },
    targetMode
  ).providerDirectories;
  const providers = {
    aliyun: normalizeProfileProviderConfig({
      prefix: settings.oss?.prefix || "",
      pathMode: settings.oss?.pathMode,
      pathSegmentCount: settings.oss?.pathSegmentCount,
      objectKeyTemplate: DEFAULT_OBJECT_KEY_TEMPLATE
    }),
    tencent: normalizeProfileProviderConfig({
      prefix: settings.tencentS3?.prefix || "",
      pathMode: settings.tencentS3?.pathMode,
      pathSegmentCount: settings.tencentS3?.pathSegmentCount,
      objectKeyTemplate: DEFAULT_OBJECT_KEY_TEMPLATE
    })
  };
  const activeProviders = providersForMode(targetMode);
  return {
    id: DEFAULT_UPLOAD_PROFILE_ID,
    name: "默认归档",
    enabled: true,
    source: sourceFromProviderDirectories(providerDirectories),
    destinations: destinationsForProviders(activeProviders),
    pathMapping: pathMappingFromLegacyProviderConfig(providers[activeProviders[0]]),
    discovery: discoveryFromLegacyScan(scan.workDirNamePattern),
    completion: DEFAULT_COMPLETION_POLICY,
    cleanup: normalizeCleanupPolicy(settings.cleanup, DEFAULT_CLEANUP_POLICY),
    targetMode,
    filter,
    scan: {
      providerDirectories,
      workDirNamePattern: scan.workDirNamePattern || DEFAULT_WORK_DIR_NAME_PATTERN
    },
    providers,
    uploadPipeline: DEFAULT_PROFILE_UPLOAD_PIPELINE,
    extensions: buildDefaultExtensionsFromSettings(settings)
  };
}
function normalizeProfile(rawProfile, fallback) {
  const raw = isRecord$1(rawProfile) ? rawProfile : {};
  const rawScan = isRecord$1(raw.scan) ? raw.scan : {};
  const rawProviders = isRecord$1(raw.providers) ? raw.providers : {};
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : fallback.id;
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : fallback.name;
  const uploadPipeline = normalizeProfileUploadPipeline(
    raw.uploadPipeline,
    raw.plugins,
    fallback.uploadPipeline
  );
  const extensions = normalizeProfileExtensions(
    raw.extensions,
    raw.plugins,
    fallback.extensions
  );
  const targetMode = normalizeTargetMode(raw.targetMode, fallback.targetMode);
  const providerDirectories = normalizeProviderDirectories(
    isRecord$1(rawScan.providerDirectories) ? rawScan.providerDirectories : fallback.scan.providerDirectories
  );
  const scan = {
    providerDirectories,
    workDirNamePattern: typeof rawScan.workDirNamePattern === "string" && rawScan.workDirNamePattern.trim() ? rawScan.workDirNamePattern.trim() : fallback.scan.workDirNamePattern
  };
  const providers = {
    aliyun: normalizeProfileProviderConfig(
      isRecord$1(rawProviders.aliyun) ? rawProviders.aliyun : {},
      fallback.providers.aliyun
    ),
    tencent: normalizeProfileProviderConfig(
      isRecord$1(rawProviders.tencent) ? rawProviders.tencent : {},
      fallback.providers.tencent
    )
  };
  const source = normalizeUploadSourceConfig(
    raw.source,
    sourceFromProviderDirectories(providerDirectories, fallback.source)
  );
  const destinationFallback = destinationsForProviders(providersForMode(targetMode));
  const rawDestinationRefs = parseUploadDestinationRefs(raw.destinations);
  const destinations = rawDestinationRefs.length > 0 && !(targetMode !== fallback.targetMode && destinationsEqual(rawDestinationRefs, fallback.destinations)) ? rawDestinationRefs : destinationFallback;
  const activeProviders = providersForDestinations(destinations);
  const canonicalTargetMode = modeForProviders(
    activeProviders.length > 0 ? activeProviders : providersForMode(targetMode)
  );
  const legacyPathMapping = pathMappingFromLegacyProviderConfig(
    providers[providersForMode(canonicalTargetMode)[0]]
  );
  const rawPathMapping = pathMappingEquals(normalizePathMappingConfig(raw.pathMapping, fallback.pathMapping), fallback.pathMapping) && !pathMappingEquals(legacyPathMapping, fallback.pathMapping) ? void 0 : raw.pathMapping;
  const pathMapping = normalizePathMappingConfig(rawPathMapping, legacyPathMapping);
  const profile = {
    id,
    name,
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
    source,
    destinations,
    pathMapping,
    discovery: normalizeDiscoveryConfig$1(raw.discovery, discoveryFromLegacyScan(scan.workDirNamePattern)),
    completion: normalizeCompletionPolicy(raw.completion, fallback.completion),
    cleanup: normalizeCleanupPolicy(raw.cleanup, fallback.cleanup),
    cloudConnections: normalizeCloudConnections(raw.cloudConnections, fallback.cloudConnections),
    targetMode: canonicalTargetMode,
    filter: normalizeFilter(isRecord$1(raw.filter) ? raw.filter : fallback.filter),
    scan,
    providers,
    uploadPipeline,
    extensions
  };
  const converterEnabled = extensions.enabledIds.includes(EXTENSION_IDS.GENERIC_CONVERTER);
  const converterConfig = normalizeGenericConverterConfig(
    extensions.configs[EXTENSION_IDS.GENERIC_CONVERTER]
  );
  return converterEnabled ? applyGenericConverterScanHandoff(profile, converterConfig) : profile;
}
function normalizeProfileUploadPipeline(rawUploadPipeline, legacyPlugins, fallback = DEFAULT_PROFILE_UPLOAD_PIPELINE) {
  const raw = isRecord$1(rawUploadPipeline) ? rawUploadPipeline : {};
  const fallbackId = isBuiltinUploadPipelineId(fallback.id) ? fallback.id : DEFAULT_PROFILE_UPLOAD_PIPELINE.id;
  const rawId = typeof raw.id === "string" && isBuiltinUploadPipelineId(raw.id) ? raw.id : null;
  const hasLegacyPlugins = isRecord$1(legacyPlugins);
  const legacy = normalizeProfilePlugins(legacyPlugins);
  const legacyModule1Enabled = hasLegacyPlugins && legacy.enabledPluginIds.includes(
    PLUGIN_IDS.MODULE1_PREUPLOAD
  );
  const id = rawId || (legacyModule1Enabled ? UPLOAD_PIPELINE_IDS.SANY_MODULE1_UPLOAD : fallbackId);
  const fallbackConfig = isRecord$1(fallback.config) ? fallback.config : {};
  const rawConfig = isRecord$1(raw.config) ? raw.config : {};
  const legacyModule1Config = hasLegacyPlugins ? pluginConfigRecord(legacy.configs[PLUGIN_IDS.MODULE1_PREUPLOAD]) : {};
  return {
    id,
    config: {
      ...id === UPLOAD_PIPELINE_IDS.SANY_MODULE1_UPLOAD ? legacyModule1Config : {},
      ...fallbackConfig,
      ...rawConfig
    }
  };
}
function normalizeProfileExtensions(rawExtensions, legacyPlugins, fallback = DEFAULT_PROFILE_EXTENSIONS) {
  const raw = isRecord$1(rawExtensions) ? rawExtensions : {};
  const fallbackEnabled = Array.isArray(fallback.enabledIds) ? fallback.enabledIds : [];
  const rawEnabled = Array.isArray(raw.enabledIds) ? raw.enabledIds : null;
  const hasLegacyPlugins = isRecord$1(legacyPlugins);
  const legacy = normalizeProfilePlugins(legacyPlugins);
  const legacyEnabled = hasLegacyPlugins ? legacy.enabledPluginIds.filter(isBuiltinExtensionId) : [];
  const enabledIds = normalizeExtensionIdArray(rawEnabled || [
    ...fallbackEnabled,
    ...legacyEnabled
  ]);
  const fallbackConfigs = isRecord$1(fallback.configs) ? fallback.configs : DEFAULT_PROFILE_EXTENSIONS.configs;
  const rawConfigs = isRecord$1(raw.configs) ? raw.configs : {};
  return {
    enabledIds,
    configs: mergeExtensionConfigs(
      fallbackConfigs,
      hasLegacyPlugins ? legacy.configs : {},
      rawConfigs
    )
  };
}
function normalizeProfilePlugins(rawPlugins, fallback = DEFAULT_PROFILE_PLUGINS) {
  const raw = isRecord$1(rawPlugins) ? rawPlugins : {};
  const fallbackEnabled = Array.isArray(fallback.enabledPluginIds) ? fallback.enabledPluginIds : [];
  const rawEnabled = Array.isArray(raw.enabledPluginIds) ? raw.enabledPluginIds : fallbackEnabled;
  const enabledPluginIds = normalizePluginIdArray(rawEnabled);
  const fallbackOrder = Array.isArray(fallback.order) ? fallback.order : DEFAULT_PROFILE_PLUGINS.order;
  const rawOrder = Array.isArray(raw.order) ? raw.order : fallbackOrder;
  const order = normalizePluginIdArray([
    ...rawOrder,
    ...DEFAULT_PROFILE_PLUGINS.order,
    ...enabledPluginIds
  ]);
  const fallbackConfigs = isRecord$1(fallback.configs) ? fallback.configs : DEFAULT_PROFILE_PLUGINS.configs;
  const rawConfigs = isRecord$1(raw.configs) ? raw.configs : {};
  return {
    enabledPluginIds,
    order,
    configs: mergePluginConfigs(fallbackConfigs, rawConfigs)
  };
}
function buildDefaultExtensionsFromSettings(settings) {
  const extensions = cloneProfileExtensions(DEFAULT_PROFILE_EXTENSIONS);
  if (settings.webhook?.enabled) {
    extensions.enabledIds = normalizeExtensionIdArray([
      ...extensions.enabledIds,
      EXTENSION_IDS.WEBHOOK_NOTIFIER
    ]);
    extensions.configs[EXTENSION_IDS.WEBHOOK_NOTIFIER] = {
      ...pluginConfigRecord(extensions.configs[EXTENSION_IDS.WEBHOOK_NOTIFIER]),
      ...settings.webhook
    };
  }
  return extensions;
}
function cloneProfileExtensions(value) {
  return {
    enabledIds: [...value.enabledIds],
    configs: JSON.parse(JSON.stringify(value.configs))
  };
}
function normalizePluginIdArray(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value.map((item) => String(item).trim()).filter((item) => item && isBuiltinPluginId(item))
    )
  );
}
function normalizeExtensionIdArray(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value.map((item) => String(item).trim()).filter((item) => item && isBuiltinExtensionId(item))
    )
  );
}
function mergePluginConfigs(fallbackConfigs, rawConfigs) {
  const configs = JSON.parse(
    JSON.stringify(DEFAULT_PROFILE_PLUGINS.configs)
  );
  for (const id of DEFAULT_PROFILE_PLUGINS.order) {
    configs[id] = {
      ...pluginConfigRecord(configs[id]),
      ...pluginConfigRecord(fallbackConfigs[id]),
      ...pluginConfigRecord(rawConfigs[id])
    };
  }
  return configs;
}
function mergeExtensionConfigs(fallbackConfigs, legacyConfigs, rawConfigs) {
  const configs = JSON.parse(
    JSON.stringify(DEFAULT_PROFILE_EXTENSIONS.configs)
  );
  for (const id of Object.values(EXTENSION_IDS)) {
    configs[id] = {
      ...pluginConfigRecord(configs[id]),
      ...pluginConfigRecord(fallbackConfigs[id]),
      ...pluginConfigRecord(legacyConfigs[id]),
      ...pluginConfigRecord(rawConfigs[id])
    };
  }
  return configs;
}
function pluginConfigRecord(value) {
  return isRecord$1(value) ? value : {};
}
function normalizeProfileProviderConfig(rawConfig, fallback) {
  const raw = isRecord$1(rawConfig) ? rawConfig : {};
  const normalized = normalizeUploadPathConfig({
    pathMode: raw.pathMode ?? fallback?.pathMode,
    pathSegmentCount: raw.pathSegmentCount ?? fallback?.pathSegmentCount
  });
  return {
    prefix: typeof raw.prefix === "string" ? raw.prefix : fallback?.prefix || "",
    pathMode: normalized.pathMode,
    pathSegmentCount: normalized.pathSegmentCount ?? DEFAULT_UPLOAD_PATH_SEGMENT_COUNT,
    objectKeyTemplate: typeof raw.objectKeyTemplate === "string" ? raw.objectKeyTemplate : fallback?.objectKeyTemplate || DEFAULT_OBJECT_KEY_TEMPLATE
  };
}
function normalizeUploadSourceConfig(rawSource, fallback) {
  const raw = isRecord$1(rawSource) ? rawSource : {};
  const roots = normalizeSourceDirectories(
    Array.isArray(raw.roots) ? raw.roots.map((item) => String(item)) : typeof raw.root === "string" ? [raw.root] : fallback.roots
  );
  const sourceRoots = roots.length > 0 ? roots : normalizeSourceDirectories([fallback.root]);
  return {
    root: typeof raw.root === "string" && raw.root.trim() ? raw.root.trim() : sourceRoots[0] || fallback.root || "",
    roots: sourceRoots
  };
}
function sourceFromProviderDirectories(providerDirectories, fallback) {
  const roots = normalizeSourceDirectories([
    ...providerDirectories.aliyun,
    ...providerDirectories.tencent
  ]);
  const fallbackRoots = fallback?.roots?.length ? fallback.roots : fallback?.root ? [fallback.root] : [];
  const sourceRoots = roots.length > 0 ? roots : normalizeStringArray(fallbackRoots);
  return {
    root: sourceRoots[0] || "",
    roots: sourceRoots
  };
}
function parseUploadDestinationRefs(rawDestinations) {
  if (!Array.isArray(rawDestinations)) return [];
  return rawDestinations.map((item) => {
    if (!isRecord$1(item) || typeof item.connectionId !== "string") return null;
    const connectionId = item.connectionId.trim();
    if (!connectionId) return null;
    return {
      connectionId,
      required: typeof item.required === "boolean" ? item.required : true
    };
  }).filter((item) => Boolean(item));
}
function destinationsEqual(a, b) {
  if (a.length !== b.length) return false;
  return a.every(
    (destination, index) => destination.connectionId === b[index]?.connectionId && (destination.required ?? true) === (b[index]?.required ?? true)
  );
}
function normalizeCloudConnections(rawConnections, fallback) {
  if (!Array.isArray(rawConnections)) return fallback;
  const connections = rawConnections.map((item) => {
    if (!isRecord$1(item)) return null;
    if (typeof item.id !== "string" || !item.id.trim()) return null;
    if (typeof item.name !== "string" || !item.name.trim()) return null;
    if (item.type !== "aliyun-oss" && item.type !== "s3") return null;
    return {
      id: item.id.trim(),
      name: item.name.trim(),
      type: item.type,
      provider: item.provider === "aliyun" || item.provider === "tencent" ? item.provider : void 0,
      config: isRecord$1(item.config) ? item.config : {}
    };
  }).filter((item) => Boolean(item));
  return connections.length > 0 ? connections : fallback;
}
function normalizePathMappingConfig(rawMapping, fallback) {
  const raw = isRecord$1(rawMapping) ? rawMapping : {};
  const rawMode = typeof raw.mode === "string" ? raw.mode : fallback.mode;
  const mode = rawMode === "flatten" || rawMode === "template" || rawMode === "keep-relative" ? rawMode : fallback.mode;
  const template = typeof raw.template === "string" ? raw.template : fallback.template;
  return mode === "template" ? { mode, template: template || DEFAULT_OBJECT_KEY_TEMPLATE } : { mode };
}
function normalizeDiscoveryConfig$1(rawDiscovery, fallback) {
  const raw = isRecord$1(rawDiscovery) ? rawDiscovery : {};
  return {
    groupPattern: normalizeOptionalString$1(raw.groupPattern, fallback.groupPattern),
    taskPattern: normalizeOptionalString$1(raw.taskPattern, fallback.taskPattern),
    groupRegex: normalizeOptionalString$1(raw.groupRegex, fallback.groupRegex),
    taskRegex: normalizeOptionalString$1(raw.taskRegex, fallback.taskRegex),
    recursive: typeof raw.recursive === "boolean" ? raw.recursive : fallback.recursive ?? false
  };
}
function discoveryFromLegacyScan(workDirNamePattern) {
  const normalizedWorkDirPattern = workDirNamePattern?.trim();
  if (normalizedWorkDirPattern && normalizedWorkDirPattern !== DEFAULT_WORK_DIR_NAME_PATTERN) {
    return {
      groupPattern: "{date:yyyy-MM-dd}",
      taskRegex: normalizedWorkDirPattern,
      recursive: false
    };
  }
  return { ...DEFAULT_DISCOVERY_CONFIG };
}
function normalizeCompletionPolicy(rawCompletion, fallback) {
  const raw = isRecord$1(rawCompletion) ? rawCompletion : {};
  if (raw.mode === "manual") return { mode: "manual" };
  if (raw.mode === "none") return { mode: "none" };
  if (raw.mode === "rollover") return { mode: "rollover" };
  if (raw.mode === "marker-file") {
    return {
      mode: "marker-file",
      markerFile: typeof raw.markerFile === "string" && raw.markerFile.trim() ? raw.markerFile.trim() : "COMPLETE"
    };
  }
  if (raw.mode === "inactivity") {
    const idleMinutes = Number(raw.idleMinutes);
    return {
      mode: "inactivity",
      idleMinutes: Number.isFinite(idleMinutes) ? Math.max(0, Math.floor(idleMinutes)) : 60
    };
  }
  return fallback;
}
function normalizeCleanupPolicy(rawCleanup, fallback) {
  const raw = isRecord$1(rawCleanup) ? rawCleanup : {};
  const retentionDays = Number(raw.retentionDays);
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : fallback.enabled,
    retentionDays: Number.isFinite(retentionDays) ? Math.max(0, Math.floor(retentionDays)) : fallback.retentionDays,
    onlyAfterSealed: typeof raw.onlyAfterSealed === "boolean" ? raw.onlyAfterSealed : fallback.onlyAfterSealed
  };
}
function pathMappingFromLegacyProviderConfig(provider) {
  if (!provider) return { mode: "keep-relative" };
  if (provider.pathMode === "template") {
    return {
      mode: "template",
      template: provider.objectKeyTemplate || DEFAULT_OBJECT_KEY_TEMPLATE
    };
  }
  if (provider.pathMode === "target-root") return { mode: "keep-relative" };
  if (provider.pathMode === "date-workdir") {
    return {
      mode: "template",
      template: "{date}/{session}/{relativePath}"
    };
  }
  if (provider.pathMode === "keep-source") {
    return {
      mode: "template",
      template: "{sourceRelativePath}/{relativePath}"
    };
  }
  if (provider.pathMode === "last-segments") {
    const variable = `sourceLast${Math.max(1, Math.min(3, provider.pathSegmentCount || 1))}`;
    return {
      mode: "template",
      template: `{${variable}}/{relativePath}`
    };
  }
  return {
    mode: "keep-relative"
  };
}
function legacyUploadPathConfigForSnapshot(pathMapping, legacyProvider) {
  if (!pathMapping) return legacyProvider;
  if (pathMapping.mode === "keep-relative" && legacyProvider.pathMode !== "target-root") {
    return legacyProvider;
  }
  return pathMappingToLegacyProviderConfig(pathMapping);
}
function pathMappingToLegacyProviderConfig(pathMapping) {
  if (pathMapping.mode === "flatten") {
    return {
      pathMode: "template",
      pathSegmentCount: DEFAULT_UPLOAD_PATH_SEGMENT_COUNT,
      objectKeyTemplate: "{filename}"
    };
  }
  if (pathMapping.mode === "template") {
    return {
      pathMode: "template",
      pathSegmentCount: DEFAULT_UPLOAD_PATH_SEGMENT_COUNT,
      objectKeyTemplate: pathMapping.template || DEFAULT_OBJECT_KEY_TEMPLATE
    };
  }
  return {
    pathMode: "target-root",
    pathSegmentCount: DEFAULT_UPLOAD_PATH_SEGMENT_COUNT,
    objectKeyTemplate: DEFAULT_OBJECT_KEY_TEMPLATE
  };
}
function pathMappingEquals(a, b) {
  return a.mode === b.mode && (a.template || "") === (b.template || "");
}
function normalizeFilter(raw) {
  const defaultFilter = DEFAULT_SETTINGS.filter;
  return {
    whitelist: normalizeStringArray(raw.whitelist ?? defaultFilter.whitelist),
    blacklist: normalizeStringArray(raw.blacklist ?? defaultFilter.blacklist),
    regex: normalizeStringArray(raw.regex ?? defaultFilter.regex),
    suffixes: normalizeSuffixes$1(raw.suffixes ?? defaultFilter.suffixes)
  };
}
function normalizeStringArray(value) {
  return Array.isArray(value) ? Array.from(new Set(value.map((item) => String(item).trim()).filter(Boolean))) : [];
}
function normalizeSuffixes$1(value) {
  const suffixes = normalizeStringArray(value).map(
    (suffix) => suffix.startsWith(".") ? suffix.toLowerCase() : `.${suffix.toLowerCase()}`
  );
  return Array.from(new Set(suffixes));
}
function normalizeOptionalString$1(value, fallback) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return fallback;
}
function normalizeTargetMode(value, fallback) {
  return value === "aliyun" || value === "tencent" || value === "both" ? value : fallback;
}
function firstResolvedPath(providers, paths) {
  for (const provider of providers) {
    const value = paths[provider];
    if (value !== void 0) return value;
  }
  return "";
}
function parseDateParts(dateName) {
  const match = dateName.match(/^(\d{2}|\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return { yy: "", yyyy: "", MM: "", dd: "" };
  const yyyy = match[1].length === 2 ? `20${match[1]}` : match[1];
  return {
    yy: yyyy.slice(-2),
    yyyy,
    MM: match[2],
    dd: match[3]
  };
}
function parseTimeParts(workDirName) {
  const match = workDirName.match(/(\d{2})[-_:](\d{2})[-_:](\d{2})/);
  if (!match) return { HH: "", mm: "", ss: "" };
  return {
    HH: match[1],
    mm: match[2],
    ss: match[3]
  };
}
function normalizeObjectPath(path2) {
  return joinOssPath(path2);
}
function pathSegments(path2) {
  return path2.replace(/\\/g, "/").split("/").map((part) => part.trim()).filter((part) => part.length > 0 && part !== ".");
}
function segmentEquals(a, b) {
  if (a.endsWith(":") || b.endsWith(":")) return a.toLowerCase() === b.toLowerCase();
  return a === b;
}
function relativePathFromBase(sourcePath, basePath) {
  const source = pathSegments(sourcePath);
  const base = pathSegments(basePath);
  let index = 0;
  while (index < source.length && index < base.length && source[index].toLowerCase() === base[index].toLowerCase()) {
    index++;
  }
  if (index === base.length && index < source.length) {
    return source.slice(index).join("/");
  }
  return source.at(-1) || "";
}
function isPathUnderRoot(sourcePath, rootPath) {
  const source = pathSegments(sourcePath);
  const root = pathSegments(rootPath);
  if (root.length === 0 || source.length < root.length) return false;
  return root.every(
    (segment, index) => source[index] && segmentEquals(source[index], segment)
  );
}
function isAbsolutePath(path2) {
  return path2.startsWith("/") || path2.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(path2);
}
function isRecord$1(value) {
  return typeof value === "object" && value !== null;
}
const SAFE_STORAGE_PREFIX = "safe-storage:v1:";
class CredentialStore {
  encryptSecret(secret) {
    if (!secret || this.isEncryptedSecret(secret)) return secret;
    if (!electron.safeStorage?.isEncryptionAvailable?.()) return secret;
    return `${SAFE_STORAGE_PREFIX}${electron.safeStorage.encryptString(secret).toString("base64")}`;
  }
  decryptSecret(secret) {
    if (!this.isEncryptedSecret(secret)) return secret;
    if (!electron.safeStorage?.isEncryptionAvailable?.()) return secret;
    try {
      const payload = secret.slice(SAFE_STORAGE_PREFIX.length);
      return electron.safeStorage.decryptString(Buffer.from(payload, "base64"));
    } catch {
      return secret;
    }
  }
  encryptConfig(config) {
    if (typeof config.accessKeySecret !== "string") return config;
    return {
      ...config,
      accessKeySecret: this.encryptSecret(config.accessKeySecret)
    };
  }
  decryptConfig(config) {
    if (typeof config.accessKeySecret !== "string") return config;
    return {
      ...config,
      accessKeySecret: this.decryptSecret(config.accessKeySecret)
    };
  }
  isEncryptedSecret(secret) {
    return secret.startsWith(SAFE_STORAGE_PREFIX);
  }
}
let instance$m = null;
function getCredentialStore() {
  if (!instance$m) instance$m = new CredentialStore();
  return instance$m;
}
function normalizeSuffixes(suffixes) {
  const normalized = suffixes.map((suffix) => suffix.trim().toLowerCase()).filter(Boolean).map((suffix) => suffix.startsWith(".") ? suffix : `.${suffix}`);
  return Array.from(new Set(normalized));
}
class SettingsRepo {
  static valueCache = /* @__PURE__ */ new Map();
  static allCache = null;
  static dbIdentity = null;
  db() {
    const db2 = getDb();
    if (SettingsRepo.dbIdentity !== db2) {
      SettingsRepo.valueCache.clear();
      SettingsRepo.allCache = null;
      SettingsRepo.dbIdentity = db2;
    }
    return db2;
  }
  get(key) {
    const db2 = this.db();
    if (SettingsRepo.valueCache.has(key)) {
      return SettingsRepo.valueCache.get(key);
    }
    const row = db2.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    if (!row) {
      SettingsRepo.valueCache.set(key, null);
      return null;
    }
    const value = this.decodeValue(key, row.value);
    SettingsRepo.valueCache.set(key, value);
    return value;
  }
  decodeValue(key, value) {
    try {
      const parsed = JSON.parse(value);
      if (key === "filter" && typeof parsed === "object" && parsed !== null && "suffixes" in parsed && Array.isArray(parsed.suffixes)) {
        const filter = parsed;
        filter.suffixes = normalizeSuffixes(filter.suffixes);
      }
      if (key === "scan" && typeof parsed === "object" && parsed !== null && "directories" in parsed && Array.isArray(parsed.directories)) {
        const scan = parsed;
        scan.directories = normalizeScanDirectories(scan.directories);
        if ("providerDirectories" in scan && typeof scan.providerDirectories === "object" && scan.providerDirectories !== null) {
          scan.providerDirectories = normalizeProviderDirectories(
            scan.providerDirectories
          );
        }
      }
      if ((key === "oss" || key === "tencentS3") && typeof parsed === "object" && parsed !== null) {
        const normalized = normalizeUploadPathConfig(
          parsed
        );
        return getCredentialStore().decryptConfig(normalized);
      }
      return parsed;
    } catch {
      return value;
    }
  }
  set(key, value) {
    const db2 = this.db();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    let persistedValue = value;
    if (key === "filter" && typeof value === "object" && value !== null && "suffixes" in value && Array.isArray(value.suffixes)) {
      const filter = value;
      persistedValue = {
        ...filter,
        suffixes: normalizeSuffixes(filter.suffixes)
      };
    }
    if (key === "scan" && typeof value === "object" && value !== null && "directories" in value && Array.isArray(value.directories)) {
      const scan = value;
      const cloud = this.get("cloud");
      persistedValue = {
        ...scan,
        ...normalizeScanConfig(
          {
            ...DEFAULT_SETTINGS.scan,
            ...scan
          },
          cloud?.targetMode || DEFAULT_SETTINGS.cloud.targetMode
        )
      };
    }
    if ((key === "oss" || key === "tencentS3") && typeof value === "object" && value !== null) {
      const normalized = normalizeUploadPathConfig(
        value
      );
      persistedValue = getCredentialStore().encryptConfig(normalized);
    }
    const serialized = typeof persistedValue === "string" ? persistedValue : JSON.stringify(persistedValue);
    db2.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?"
    ).run(key, serialized, now, serialized, now);
    SettingsRepo.valueCache.delete(key);
    SettingsRepo.allCache = null;
  }
  getAll() {
    const db2 = this.db();
    if (SettingsRepo.allCache) return SettingsRepo.allCache;
    const settings = { ...DEFAULT_SETTINGS, profiles: [] };
    const settingsRecord = settings;
    const keys = [
      { section: "scan", key: "scan" },
      { section: "upload", key: "upload" },
      { section: "cloud", key: "cloud" },
      { section: "oss", key: "oss" },
      { section: "tencentS3", key: "tencentS3" },
      { section: "profiles", key: "profiles" },
      { section: "activeProfileId", key: "activeProfileId" },
      { section: "filter", key: "filter" },
      { section: "webhook", key: "webhook" },
      { section: "stability", key: "stability" },
      { section: "log", key: "log" },
      { section: "dataCollect", key: "dataCollect" },
      { section: "cleanup", key: "cleanup" }
    ];
    const rows = db2.prepare("SELECT key, value FROM settings").all();
    const stored = new Map(rows.map((row) => [row.key, row.value]));
    for (const { section, key } of keys) {
      const serialized = stored.get(key);
      const val = serialized === void 0 ? null : this.decodeValue(key, serialized);
      if (serialized !== void 0) {
        SettingsRepo.valueCache.set(key, val);
      }
      if (val !== null) {
        const defaultSection = settingsRecord[section];
        if (typeof defaultSection === "object" && defaultSection !== null && typeof val === "object" && val !== null && !Array.isArray(defaultSection) && !Array.isArray(val)) {
          settingsRecord[section] = {
            ...defaultSection,
            ...val
          };
        } else {
          settingsRecord[section] = val;
        }
      }
    }
    const hotkeySerialized = stored.get("hotkey");
    const hotkey = hotkeySerialized === void 0 ? null : this.decodeValue("hotkey", hotkeySerialized);
    if (hotkeySerialized !== void 0) {
      SettingsRepo.valueCache.set("hotkey", hotkey);
    }
    if (typeof hotkey === "string" && hotkey) settings.hotkey = hotkey;
    if (settings.filter && Array.isArray(settings.filter.suffixes)) {
      settings.filter.suffixes = normalizeSuffixes(settings.filter.suffixes);
    }
    settings.oss = normalizeUploadPathConfig(
      settings.oss
    );
    settings.tencentS3 = normalizeUploadPathConfig(
      settings.tencentS3
    );
    settings.scan = normalizeScanConfig(
      settings.scan,
      settings.cloud.targetMode
    );
    const normalizedProfiles = normalizeProfiles(settings);
    settings.profiles = normalizedProfiles.profiles;
    settings.activeProfileId = normalizedProfiles.activeProfileId;
    SettingsRepo.allCache = settings;
    return settings;
  }
  saveAll(partial) {
    const db2 = this.db();
    const transaction = db2.transaction(() => {
      for (const [key, value] of Object.entries(partial)) {
        if (value !== void 0) {
          this.set(key, value);
        }
      }
    });
    transaction();
  }
}
let instance$l = null;
function getSettingsRepo() {
  if (!instance$l) instance$l = new SettingsRepo();
  return instance$l;
}
function rowToHistory(row) {
  return {
    id: row.id,
    provider: row.provider,
    folderName: row.folder_name,
    fileCount: row.total_files,
    totalBytes: row.total_bytes,
    durationSeconds: row.duration_seconds,
    status: row.status,
    completedAt: row.completed_at
  };
}
class HistoryRepo {
  list(query) {
    const db2 = getDb();
    const { page, pageSize, status, provider } = query;
    const offset = (page - 1) * pageSize;
    let where = "WHERE td.status IN ('completed', 'failed') AND td.completed_at IS NOT NULL";
    const params = [];
    if (provider) {
      where += " AND td.provider = ?";
      params.push(provider);
    }
    if (status) {
      where += " AND td.status = ?";
      params.push(status);
    }
    const countRow = db2.prepare(
      `SELECT COUNT(*) as cnt
         FROM task_destinations td
         INNER JOIN tasks t ON t.id = td.task_id ${where}`
    ).get(...params);
    const total = countRow.cnt;
    const rows = db2.prepare(
      `SELECT t.id, td.provider, t.folder_name, td.total_files, td.total_bytes,
          td.status, td.completed_at,
          CAST((julianday(td.completed_at) - julianday(td.created_at)) * 86400 AS INTEGER)
            as duration_seconds
         FROM task_destinations td
         INNER JOIN tasks t ON t.id = td.task_id
         ${where}
         ORDER BY td.completed_at DESC LIMIT ? OFFSET ?`
    ).all(...params, pageSize, offset);
    return { items: rows.map(rowToHistory), total };
  }
  clear(before, provider) {
    const db2 = getDb();
    const transaction = db2.transaction(() => {
      if (provider) {
        const params = [provider];
        let beforeCondition = "";
        if (before) {
          beforeCondition = " AND completed_at < ?";
          params.push(before);
        }
        db2.prepare(
          `DELETE FROM task_destinations
           WHERE provider = ?
             AND status IN ('completed', 'failed')
             AND completed_at IS NOT NULL${beforeCondition}`
        ).run(...params);
        db2.prepare(
          `DELETE FROM tasks
           WHERE NOT EXISTS (
             SELECT 1 FROM task_destinations td WHERE td.task_id = tasks.id
           )`
        ).run();
      } else if (before) {
        db2.prepare("DELETE FROM tasks WHERE status IN ('completed', 'failed') AND completed_at < ?").run(before);
      } else {
        db2.prepare("DELETE FROM tasks WHERE status IN ('completed', 'failed')").run();
      }
    });
    transaction();
  }
  deleteById(id, provider) {
    const db2 = getDb();
    const transaction = db2.transaction(() => {
      if (provider) {
        db2.prepare(
          `DELETE FROM task_destinations
           WHERE task_id = ? AND provider = ? AND status IN ('completed', 'failed')`
        ).run(id, provider);
        db2.prepare(
          `DELETE FROM tasks
           WHERE id = ?
             AND NOT EXISTS (
               SELECT 1 FROM task_destinations td WHERE td.task_id = tasks.id
             )`
        ).run(id);
      } else {
        db2.prepare("DELETE FROM tasks WHERE id = ? AND status IN ('completed', 'failed')").run(id);
      }
    });
    transaction();
  }
}
let instance$k = null;
function getHistoryRepo() {
  if (!instance$k) instance$k = new HistoryRepo();
  return instance$k;
}
const TERMINAL_TASK_STATUSES = /* @__PURE__ */ new Set([
  "completed",
  "synced",
  "skipped"
]);
const PROBLEM_TASK_STATUSES = /* @__PURE__ */ new Set([
  "failed",
  "paused"
]);
const ALLOWED_UPLOAD_GROUP_TRANSITIONS = {
  open: ["open", "closing", "sealed", "error"],
  closing: ["closing", "sealed", "error", "open"],
  sealed: ["sealed", "cleanable", "error"],
  cleanable: ["cleanable", "cleaned", "sealed", "error"],
  cleaned: ["cleaned"],
  error: ["error", "open", "closing"]
};
function assertUploadGroupTransition(current, next) {
  if (!ALLOWED_UPLOAD_GROUP_TRANSITIONS[current]?.includes(next)) {
    throw new Error(`非法 UploadGroup 状态跳转: ${current} -> ${next}`);
  }
}
function deriveUploadGroupStatus(input) {
  if (input.currentStatus === "cleaned") return "cleaned";
  if (input.taskStatuses.some((status) => status && PROBLEM_TASK_STATUSES.has(status))) {
    return "error";
  }
  if (input.currentStatus === "sealed" || input.currentStatus === "cleanable") {
    return input.currentStatus;
  }
  const hasTasks = input.taskStatuses.length > 0;
  const allTerminal = hasTasks && input.taskStatuses.every((status) => status !== null && TERMINAL_TASK_STATUSES.has(status));
  if (input.completion.mode === "none") {
    return allTerminal ? "sealed" : "open";
  }
  if (input.completion.mode === "manual") {
    if (input.currentStatus === "closing" && allTerminal) return "sealed";
    return input.currentStatus === "error" ? "open" : input.currentStatus;
  }
  if (input.completion.mode === "marker-file") {
    if (input.currentStatus === "closing" && allTerminal) return "sealed";
    return input.currentStatus === "error" ? "open" : input.currentStatus;
  }
  if (input.completion.mode === "rollover") {
    if (input.hasNewerGroup || input.currentStatus === "closing") {
      return allTerminal ? "sealed" : "closing";
    }
    return input.currentStatus === "error" ? "open" : "open";
  }
  if (!allTerminal) return input.currentStatus === "closing" ? "closing" : "open";
  const lastActivityMs = input.lastActivityAt ? Date.parse(input.lastActivityAt) : Number.NaN;
  const idleMs = Math.max(0, input.completion.idleMinutes || 0) * 6e4;
  const nowMs = (input.now || /* @__PURE__ */ new Date()).getTime();
  if (Number.isFinite(lastActivityMs) && nowMs - lastActivityMs >= idleMs) {
    return "sealed";
  }
  return input.currentStatus === "closing" ? "closing" : "open";
}
function uploadGroupStatusToDayFolderStatus(status, taskStatuses) {
  if (status === "error") return "blocked";
  if (status === "sealed" || status === "cleanable" || status === "cleaned") {
    return taskStatuses.some((taskStatus) => taskStatus === "skipped") ? "completed_with_skips" : "completed";
  }
  if (taskStatuses.some(
    (taskStatus) => taskStatus === null || taskStatus === "pending" || taskStatus === "scanning" || taskStatus === "uploading" || taskStatus === "retrying"
  )) {
    return "processing";
  }
  return "collecting";
}
function mapLegacyDayFolderStatus(status) {
  if (status === "completed" || status === "completed_with_skips") return "sealed";
  if (status === "blocked") return "error";
  if (status === "processing") return "closing";
  return "open";
}
function normalizeFolderPath(p) {
  return path.normalize(p).replace(/[\\/]+$/, "");
}
function safeParseVariables(value, fallback = {}) {
  if (typeof value !== "string" || !value) return fallback;
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return fallback;
    return Object.fromEntries(
      Object.entries(parsed).map(([key, item]) => [key, String(item)])
    );
  } catch {
    return fallback;
  }
}
function safeParseProfile(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
function rowToRecord(row) {
  let childFolders = [];
  try {
    const parsed = JSON.parse(row.child_folders_json || "[]");
    if (Array.isArray(parsed)) {
      childFolders = parsed.filter((value) => typeof value === "string");
    }
  } catch {
    childFolders = [];
  }
  const variables = safeParseVariables(row.variables_json, {
    date: row.date_value || ""
  });
  const legacyStatus = row.status;
  const uploadGroupStatus = row.upload_group_status || mapLegacyDayFolderStatus(legacyStatus);
  return {
    id: row.id,
    folderPath: row.folder_path,
    folderName: row.folder_name,
    date: row.date_value,
    status: legacyStatus,
    profileId: row.profile_id || null,
    groupKey: row.group_key || row.date_value,
    variables,
    uploadGroupStatus,
    discoveredAt: row.discovered_at || row.created_at,
    sealedAt: row.sealed_at || null,
    cleanableAt: row.cleanable_at || null,
    cleanedAt: row.cleaned_at || null,
    totalChildren: row.total_children,
    completedChildren: row.completed_children,
    totalFiles: row.total_files,
    uploadedFiles: row.uploaded_files,
    totalBytes: row.total_bytes,
    uploadedBytes: row.uploaded_bytes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at || null,
    ignored: Boolean(row.ignored),
    childFolders
  };
}
class DayFolderRepo {
  ensure(folderPath, groupKey, variables = { date: groupKey }, profileId) {
    const existing = this.getRecordByPath(folderPath);
    if (existing) {
      this.updateGroupMetadata(existing.id, groupKey, variables, profileId ?? existing.profileId);
      return this.getById(existing.id) || existing;
    }
    const db2 = getDb();
    const id = uuid.v4();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const normalizedPath = normalizeFolderPath(folderPath);
    db2.prepare(
      `INSERT INTO day_folders (
        id, folder_path, folder_name, date_value, status, child_folders_json,
        created_at, updated_at, profile_id, group_key, variables_json,
        upload_group_status, discovered_at
      ) VALUES (?, ?, ?, ?, 'collecting', '[]', ?, ?, ?, ?, ?, 'open', ?)`
    ).run(
      id,
      normalizedPath,
      groupKey,
      groupKey,
      now,
      now,
      profileId || null,
      groupKey,
      JSON.stringify(variables),
      now
    );
    return this.getById(id);
  }
  getById(id) {
    const record = this.getRecordById(id);
    return record ? this.toSummary(record) : null;
  }
  getByPath(folderPath) {
    const record = this.getRecordByPath(folderPath);
    return record ? this.toSummary(record) : null;
  }
  list(query = {}) {
    const db2 = getDb();
    const conditions = [];
    const params = [];
    if (query.status) {
      conditions.push("status = ?");
      params.push(query.status);
    } else if (query.includeCompleted === false) {
      conditions.push("status NOT IN ('completed', 'completed_with_skips')");
    }
    if (query.provider) {
      conditions.push(
        `EXISTS (
          SELECT 1
          FROM tasks t
          INNER JOIN task_destinations td ON td.task_id = t.id
          WHERE t.day_folder_id = day_folders.id
            AND td.provider = ?
        )`
      );
      params.push(query.provider);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.max(1, Math.min(query.limit || 100, 1e3));
    const rows = db2.prepare(
      `SELECT * FROM day_folders ${where}
       ORDER BY date_value DESC, updated_at DESC LIMIT ?`
    ).all(...params, limit);
    return rows.map((row) => this.toSummary(rowToRecord(row)));
  }
  updateDiscovery(id, childFolders) {
    const db2 = getDb();
    const existing = this.getRecordById(id);
    const normalizedChildren = Array.from(
      /* @__PURE__ */ new Set([...existing?.childFolders || [], ...childFolders])
    ).sort();
    db2.prepare(
      `UPDATE day_folders
       SET child_folders_json = ?, total_children = ?, updated_at = ?
       WHERE id = ?`
    ).run(JSON.stringify(normalizedChildren), normalizedChildren.length, (/* @__PURE__ */ new Date()).toISOString(), id);
  }
  updateGroupMetadata(id, groupKey, variables, profileId) {
    getDb().prepare(
      `UPDATE day_folders
       SET group_key = ?, variables_json = ?, profile_id = COALESCE(?, profile_id),
           discovered_at = COALESCE(discovered_at, created_at),
           updated_at = ?
       WHERE id = ?`
    ).run(
      groupKey,
      JSON.stringify(variables),
      profileId || null,
      (/* @__PURE__ */ new Date()).toISOString(),
      id
    );
  }
  markClosing(id) {
    this.transitionStatus(id, "closing");
  }
  markCleanable(id) {
    this.transitionStatus(id, "cleanable");
  }
  markCleaned(id) {
    this.transitionStatus(id, "cleaned");
  }
  transitionStatus(id, nextStatus) {
    const current = this.getRecordById(id);
    if (!current) return;
    assertUploadGroupTransition(current.uploadGroupStatus, nextStatus);
    if (current.uploadGroupStatus === nextStatus) return;
    const now = (/* @__PURE__ */ new Date()).toISOString();
    getDb().prepare(
      `UPDATE day_folders
       SET upload_group_status = ?,
           sealed_at = CASE WHEN ? = 'sealed' THEN COALESCE(sealed_at, ?) ELSE sealed_at END,
           cleanable_at = CASE WHEN ? = 'cleanable' THEN COALESCE(cleanable_at, ?) ELSE cleanable_at END,
           cleaned_at = CASE WHEN ? = 'cleaned' THEN COALESCE(cleaned_at, ?) ELSE cleaned_at END,
           updated_at = ?
       WHERE id = ?`
    ).run(nextStatus, nextStatus, now, nextStatus, now, nextStatus, now, now, id);
  }
  recalculate(id, now = /* @__PURE__ */ new Date()) {
    const record = this.getRecordById(id);
    if (!record) return null;
    const tasks = getTaskRepo().listByDayFolder(id);
    const latestByPath = /* @__PURE__ */ new Map();
    for (const task of tasks) {
      const normalizedPath = normalizeFolderPath(task.folderPath);
      if (!latestByPath.has(normalizedPath)) {
        latestByPath.set(normalizedPath, task);
      }
    }
    const childTasks = record.childFolders.map(
      (folderName) => latestByPath.get(normalizeFolderPath(path.join(record.folderPath, folderName))) || (folderName === record.folderName ? latestByPath.get(normalizeFolderPath(record.folderPath)) : null) || null
    );
    const childStatuses = childTasks.map((task) => task?.status || null);
    const uploadGroupStatus = deriveUploadGroupStatus({
      currentStatus: record.uploadGroupStatus,
      completion: this.completionPolicyFor(record, childTasks),
      taskStatuses: childStatuses,
      lastActivityAt: this.latestActivityAt(record, childTasks),
      now
    });
    const status = record.ignored ? "completed_with_skips" : uploadGroupStatusToDayFolderStatus(uploadGroupStatus, childStatuses);
    const completedChildren = childTasks.filter(
      (task) => task?.status === "completed" || task?.status === "synced" || task?.status === "skipped"
    ).length;
    const totalFiles = childTasks.reduce((sum, task) => sum + (task?.totalFiles || 0), 0);
    const uploadedFiles = childTasks.reduce((sum, task) => sum + (task?.uploadedFiles || 0), 0);
    const totalBytes = childTasks.reduce((sum, task) => sum + (task?.totalBytes || 0), 0);
    const uploadedBytes = childTasks.reduce((sum, task) => sum + (task?.uploadedBytes || 0), 0);
    const updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    const completedAt = status === "completed" || status === "completed_with_skips" ? record.completedAt || updatedAt : null;
    const sealedAt = uploadGroupStatus === "sealed" || uploadGroupStatus === "cleanable" || uploadGroupStatus === "cleaned" ? record.sealedAt || completedAt || updatedAt : record.sealedAt;
    getDb().prepare(
      `UPDATE day_folders SET
        status = ?, completed_children = ?, total_files = ?, uploaded_files = ?,
        total_bytes = ?, uploaded_bytes = ?, upload_group_status = ?,
        updated_at = ?, completed_at = ?, sealed_at = ?
       WHERE id = ?`
    ).run(
      status,
      completedChildren,
      totalFiles,
      uploadedFiles,
      totalBytes,
      uploadedBytes,
      uploadGroupStatus,
      updatedAt,
      completedAt,
      sealedAt,
      id
    );
    return this.getById(id);
  }
  getChildTasks(id) {
    const record = this.getRecordById(id);
    if (!record) return [];
    const expectedPaths = new Set(
      record.childFolders.map((name) => normalizeFolderPath(path.join(record.folderPath, name)))
    );
    if (record.childFolders.includes(record.folderName)) {
      expectedPaths.add(normalizeFolderPath(record.folderPath));
    }
    const latestByPath = /* @__PURE__ */ new Map();
    for (const task of getTaskRepo().listByDayFolder(id)) {
      const path2 = normalizeFolderPath(task.folderPath);
      if (expectedPaths.has(path2) && !latestByPath.has(path2)) {
        latestByPath.set(path2, task);
      }
    }
    return record.childFolders.map((name) => latestByPath.get(normalizeFolderPath(path.join(record.folderPath, name)))).filter((task) => Boolean(task));
  }
  getCompletedForCleanup(retentionDays) {
    const cutoff = new Date(Date.now() - retentionDays * 864e5).toISOString();
    const rows = getDb().prepare(
      `SELECT * FROM day_folders
       WHERE upload_group_status IN ('sealed', 'cleanable')
         AND COALESCE(sealed_at, completed_at) IS NOT NULL
         AND COALESCE(sealed_at, completed_at) < ?
       ORDER BY COALESCE(sealed_at, completed_at) ASC`
    ).all(cutoff);
    return rows.map((row) => this.toSummary(rowToRecord(row)));
  }
  isSafeToClean(id) {
    const record = this.getRecordById(id);
    if (!record) return false;
    if (record.uploadGroupStatus !== "sealed" && record.uploadGroupStatus !== "cleanable") {
      return false;
    }
    const blockingTasks = getDb().prepare(
      `SELECT COUNT(*) AS count
       FROM tasks
       WHERE day_folder_id = ?
         AND status IN ('pending', 'scanning', 'uploading', 'retrying', 'failed', 'paused')`
    ).get(id);
    if ((blockingTasks.count || 0) > 0) return false;
    const incompleteDestinations = getDb().prepare(
      `SELECT COUNT(*) AS count
       FROM task_destinations
       WHERE task_id IN (SELECT id FROM tasks WHERE day_folder_id = ?)
         AND status NOT IN ('completed', 'synced', 'skipped')`
    ).get(id);
    if ((incompleteDestinations.count || 0) > 0) return false;
    const incompleteFiles = getDb().prepare(
      `SELECT COUNT(*) AS count
       FROM task_files
       WHERE task_id IN (SELECT id FROM tasks WHERE day_folder_id = ?)
         AND source_status = 'present'
         AND status NOT IN ('completed', 'skipped')`
    ).get(id);
    return (incompleteFiles.count || 0) === 0;
  }
  clearCompleted(before, provider) {
    const db2 = getDb();
    if (provider) {
      const transaction = db2.transaction(() => {
        const params = [provider];
        let beforeCondition = "";
        if (before) {
          beforeCondition = " AND df.completed_at < ?";
          params.push(before);
        }
        db2.prepare(
          `DELETE FROM task_destinations
           WHERE provider = ?
             AND task_id IN (
               SELECT t.id
               FROM tasks t
               INNER JOIN day_folders df ON df.id = t.day_folder_id
               WHERE df.status IN ('completed', 'completed_with_skips')
                 AND df.completed_at IS NOT NULL${beforeCondition}
             )`
        ).run(...params);
        db2.prepare(
          `DELETE FROM tasks
           WHERE day_folder_id IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM task_destinations td WHERE td.task_id = tasks.id
             )`
        ).run();
        db2.prepare(
          `DELETE FROM day_folders
           WHERE status IN ('completed', 'completed_with_skips')
             AND NOT EXISTS (
               SELECT 1
               FROM tasks t
               INNER JOIN task_destinations td ON td.task_id = t.id
               WHERE t.day_folder_id = day_folders.id
             )`
        ).run();
      });
      transaction();
      return;
    }
    if (before) {
      db2.prepare(
        "DELETE FROM day_folders WHERE status IN ('completed', 'completed_with_skips') AND completed_at < ?"
      ).run(before);
    } else {
      db2.prepare(
        "DELETE FROM day_folders WHERE status IN ('completed', 'completed_with_skips')"
      ).run();
    }
  }
  deleteCompleted(id, provider) {
    const db2 = getDb();
    if (provider) {
      const transaction = db2.transaction(() => {
        db2.prepare(
          `DELETE FROM task_destinations
           WHERE provider = ?
             AND task_id IN (SELECT id FROM tasks WHERE day_folder_id = ?)`
        ).run(provider, id);
        db2.prepare(
          `DELETE FROM tasks
           WHERE day_folder_id = ?
             AND NOT EXISTS (
               SELECT 1 FROM task_destinations td WHERE td.task_id = tasks.id
             )`
        ).run(id);
        db2.prepare(
          `DELETE FROM day_folders
           WHERE id = ?
             AND status IN ('completed', 'completed_with_skips')
             AND NOT EXISTS (
               SELECT 1
               FROM tasks t
               INNER JOIN task_destinations td ON td.task_id = t.id
               WHERE t.day_folder_id = day_folders.id
             )`
        ).run(id);
      });
      transaction();
      return;
    }
    db2.prepare(
      "DELETE FROM day_folders WHERE id = ? AND status IN ('completed', 'completed_with_skips')"
    ).run(id);
  }
  setIgnored(id, ignored) {
    getDb().prepare(
      `UPDATE day_folders
       SET ignored = ?, updated_at = ?
       WHERE id = ?`
    ).run(ignored ? 1 : 0, (/* @__PURE__ */ new Date()).toISOString(), id);
  }
  getRecordById(id) {
    const row = getDb().prepare("SELECT * FROM day_folders WHERE id = ?").get(id);
    return row ? rowToRecord(row) : null;
  }
  getRecordByPath(folderPath) {
    const normalizedPath = normalizeFolderPath(folderPath);
    const row = getDb().prepare("SELECT * FROM day_folders WHERE folder_path = ?").get(normalizedPath);
    return row ? rowToRecord(row) : null;
  }
  completionPolicyFor(record, childTasks) {
    const taskPolicy = childTasks.find((task) => task?.profileSnapshot?.completion)?.profileSnapshot?.completion;
    if (taskPolicy) return taskPolicy;
    if (record.profileId) {
      const row = getDb().prepare(
        `SELECT profile_snapshot_json
         FROM tasks
         WHERE day_folder_id = ? AND profile_snapshot_json IS NOT NULL
         ORDER BY created_at DESC
         LIMIT 1`
      ).get(record.id);
      const profile = row ? safeParseProfile(row.profile_snapshot_json) : null;
      if (profile?.completion) return profile.completion;
    }
    return DEFAULT_COMPLETION_POLICY;
  }
  latestActivityAt(record, childTasks) {
    return childTasks.reduce(
      (latest, task) => task && Date.parse(task.updatedAt) > Date.parse(latest) ? task.updatedAt : latest,
      record.updatedAt
    );
  }
  toSummary(record) {
    const { childFolders: _childFolders, ...summary } = record;
    return summary;
  }
}
let instance$j = null;
function getDayFolderRepo() {
  if (!instance$j) instance$j = new DayFolderRepo();
  return instance$j;
}
const MAX_ITEMS = 100;
class DataCollectService {
  cache = /* @__PURE__ */ new Map();
  getAll() {
    return Array.from(this.cache.values());
  }
  getByPath(folderPath) {
    return this.cache.get(folderPath) || null;
  }
  /**
   * 采集单个数据文件夹的元信息
   * 前提：文件夹中必须含有 welding_state/weld_signal.csv
   * @returns DataCollectInfo 或 null（不满足数采条件时）
   */
  collectDataInfo(folderPath) {
    const weldSignalPath = path.join(folderPath, "welding_state", "weld_signal.csv");
    if (!fs.existsSync(weldSignalPath)) {
      return null;
    }
    const folderName = path.basename(folderPath);
    const dateStr = parseDateFromPath(folderPath);
    const info = {
      folderPath,
      folderName,
      date: dateStr,
      sessionTime: folderName,
      weldSignal: {
        arcStartUs: null,
        arcEndUs: null,
        arcStartTime: null,
        arcEndTime: null,
        durationSeconds: null
      },
      cameras: [],
      robotState: {
        jointStateRows: 0,
        toolPoseRows: 0,
        hasCalibration: false
      },
      controlCmd: {
        speedRows: 0,
        freqRows: 0
      },
      pointCloudCount: 0,
      depthImageCount: 0,
      annotation: {
        hasXml: false,
        dataType: null,
        qualityType: null,
        specMin: null,
        specMax: null
      },
      totalFileCount: 0,
      totalSizeBytes: 0,
      collectedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    try {
      const { startTime, endTime } = readWeldSignal(weldSignalPath);
      info.weldSignal.arcStartUs = startTime;
      info.weldSignal.arcEndUs = endTime;
      info.weldSignal.arcStartTime = usToTimeStr(dateStr, startTime);
      info.weldSignal.arcEndTime = usToTimeStr(dateStr, endTime);
      if (startTime !== null && endTime !== null) {
        info.weldSignal.durationSeconds = Math.round((endTime - startTime) / 1e3) / 1e3;
      }
    } catch (err) {
      log.warn("读取焊接信号失败:", err);
    }
    try {
      const entries = fs.readdirSync(folderPath, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.startsWith("camera")).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const camPath = path.join(folderPath, entry.name);
        const { tsMin, tsMax, count } = getImageTimestampRange(camPath);
        info.cameras.push({
          name: entry.name,
          imageCount: count,
          tsMinUs: tsMin,
          tsMaxUs: tsMax,
          tsMinTime: usToTimeStr(dateStr, tsMin),
          tsMaxTime: usToTimeStr(dateStr, tsMax)
        });
      }
    } catch {
    }
    const jointCsv = path.join(folderPath, "robot_state", "joint_state.csv");
    if (fs.existsSync(jointCsv)) {
      info.robotState.jointStateRows = readCsvTimestamps(jointCsv).count;
    }
    const toolCsv = path.join(folderPath, "robot_state", "tool_pose.csv");
    if (fs.existsSync(toolCsv)) {
      info.robotState.toolPoseRows = readCsvTimestamps(toolCsv).count;
    }
    const calibCsv = path.join(folderPath, "robot_state", "calibration.csv");
    info.robotState.hasCalibration = fs.existsSync(calibCsv);
    const speedCsv = path.join(folderPath, "control_cmd", "control_speed.csv");
    if (fs.existsSync(speedCsv)) {
      info.controlCmd.speedRows = readCsvTimestamps(speedCsv).count;
    }
    const freqCsv = path.join(folderPath, "control_cmd", "control_freq.csv");
    if (fs.existsSync(freqCsv)) {
      info.controlCmd.freqRows = readCsvTimestamps(freqCsv).count;
    }
    const pcDir = path.join(folderPath, "scan_point_cloud");
    info.pointCloudCount = countFiles(pcDir, ".bin") + countFiles(pcDir, ".ply");
    const depthDir = path.join(folderPath, "camera_depth");
    info.depthImageCount = countFiles(depthDir, ".jpg") + countFiles(depthDir, ".ply");
    const xmlPath = path.join(folderPath, "annotation", "segment_timestamps.xml");
    if (fs.existsSync(xmlPath)) {
      info.annotation.hasXml = true;
      try {
        const xmlContent = fs.readFileSync(xmlPath, "utf-8");
        info.annotation.dataType = extractXmlTag(xmlContent, "data_type");
        info.annotation.qualityType = extractXmlTag(xmlContent, "quality_type");
        const specMin = extractXmlTag(xmlContent, "data_spec_min");
        const specMax = extractXmlTag(xmlContent, "data_spec_max");
        if (specMin !== null) info.annotation.specMin = parseInt(specMin);
        if (specMax !== null) info.annotation.specMax = parseInt(specMax);
      } catch {
      }
    }
    const { fileCount, totalSize } = walkDirStats(folderPath);
    info.totalFileCount = fileCount;
    info.totalSizeBytes = totalSize;
    this.cache.set(folderPath, info);
    if (this.cache.size > MAX_ITEMS) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
    log.info(`[数采模式] ${folderName}: 焊接${info.weldSignal.durationSeconds ?? "N/A"}s, ${info.cameras.length}相机, ${info.totalFileCount}文件`);
    return info;
  }
}
function parseDateFromPath(path2) {
  const pat = /(\d{4}-\d{2}-\d{2})/;
  const parts = path2.replace(/\\/g, "/").split("/").reverse();
  for (const part of parts) {
    const m = pat.exec(part);
    if (m) return m[1];
  }
  return null;
}
function usToTimeStr(dateStr, microseconds) {
  if (dateStr === null || microseconds === null) return null;
  try {
    const base = /* @__PURE__ */ new Date(dateStr + "T00:00:00");
    const ms = microseconds / 1e3;
    const ts = new Date(base.getTime() + ms);
    const pad = (n, d = 2) => String(n).padStart(d, "0");
    return `${ts.getFullYear()}-${pad(ts.getMonth() + 1)}-${pad(ts.getDate())} ${pad(ts.getHours())}:${pad(ts.getMinutes())}:${pad(ts.getSeconds())}.${pad(ts.getMilliseconds(), 3)}`;
  } catch {
    return String(microseconds);
  }
}
function readWeldSignal(filePath) {
  let startTime = null;
  let endTime = null;
  const content = fs.readFileSync(filePath, "utf-8");
  const pat = /^\s*(\d+)\s+[^:]*:\s*(true|false)\s*$/i;
  const tsPat = /(\d+)/;
  const boolPat = /(true|false)/i;
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let ts;
    let valTrue;
    const m = pat.exec(line);
    if (m) {
      ts = parseInt(m[1]);
      valTrue = m[2].toLowerCase() === "true";
    } else {
      const tsMatch = tsPat.exec(line);
      const boolMatch = boolPat.exec(line);
      if (!tsMatch || !boolMatch) continue;
      ts = parseInt(tsMatch[1]);
      valTrue = boolMatch[1].toLowerCase() === "true";
    }
    if (valTrue) {
      if (startTime === null) startTime = ts;
    } else {
      endTime = ts;
    }
  }
  return { startTime, endTime };
}
function extractXmlTag(xml, tagName) {
  const re = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const match = re.exec(xml);
  return match ? match[1].trim() : null;
}
function readCsvTimestamps(filePath) {
  let tsMin = null;
  let tsMax = null;
  let count = 0;
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      const parts = line.split(/[,\s]+/);
      if (!parts[0]) continue;
      const ts = parseInt(parts[0]);
      if (isNaN(ts)) continue;
      count++;
      if (tsMin === null || ts < tsMin) tsMin = ts;
      if (tsMax === null || ts > tsMax) tsMax = ts;
    }
  } catch {
  }
  return { tsMin, tsMax, count };
}
function countFiles(folderPath, ext) {
  if (!fs.existsSync(folderPath)) return 0;
  try {
    const entries = fs.readdirSync(folderPath);
    let count = 0;
    for (const entry of entries) {
      if (ext && !entry.toLowerCase().endsWith(ext)) continue;
      try {
        const stat = fs.statSync(path.join(folderPath, entry));
        if (stat.isFile()) count++;
      } catch {
      }
    }
    return count;
  } catch {
    return 0;
  }
}
function getImageTimestampRange(folderPath) {
  let tsMin = null;
  let tsMax = null;
  let count = 0;
  if (!fs.existsSync(folderPath)) return { tsMin, tsMax, count };
  try {
    const entries = fs.readdirSync(folderPath);
    for (const filename of entries) {
      if (!filename.toLowerCase().endsWith(".jpg")) continue;
      const nameNoExt = filename.slice(0, filename.lastIndexOf("."));
      const ts = parseInt(nameNoExt);
      if (isNaN(ts)) continue;
      count++;
      if (tsMin === null || ts < tsMin) tsMin = ts;
      if (tsMax === null || ts > tsMax) tsMax = ts;
    }
  } catch {
  }
  return { tsMin, tsMax, count };
}
function walkDirStats(dirPath) {
  let fileCount = 0;
  let totalSize = 0;
  function walk(dir) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile()) {
          fileCount++;
          try {
            totalSize += fs.statSync(fullPath).size;
          } catch {
          }
        }
      }
    } catch {
    }
  }
  walk(dirPath);
  return { fileCount, totalSize };
}
let instance$i = null;
function getDataCollectService() {
  if (!instance$i) instance$i = new DataCollectService();
  return instance$i;
}
function readTmpUpload(folderPath) {
  const filePath = path.join(folderPath, MARKER_FILES.TMP_UPLOAD);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}
function writeTmpUpload(folderPath, marker) {
  const filePath = path.join(folderPath, MARKER_FILES.TMP_UPLOAD);
  fs.writeFileSync(filePath, JSON.stringify(marker, null, 2), "utf-8");
}
function readProcessTask(folderPath) {
  const filePath = path.join(folderPath, MARKER_FILES.PROCESS_TASK);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}
function writeProcessTask(folderPath, marker) {
  const filePath = path.join(folderPath, MARKER_FILES.PROCESS_TASK);
  fs.writeFileSync(filePath, JSON.stringify(marker, null, 2), "utf-8");
}
function writeDayUpload(folderPath, marker) {
  const filePath = path.join(folderPath, MARKER_FILES.DAY_UPLOAD);
  fs.writeFileSync(filePath, JSON.stringify(marker, null, 2), "utf-8");
}
function removeDayUpload(folderPath) {
  const filePath = path.join(folderPath, MARKER_FILES.DAY_UPLOAD);
  if (fs.existsSync(filePath)) {
    fs.rmSync(filePath, { force: true });
  }
}
class DayFolderService {
  refresh(dayFolderId, discoveredChildren) {
    const repo = getDayFolderRepo();
    if (discoveredChildren) {
      repo.updateDiscovery(dayFolderId, discoveredChildren);
    }
    const summary = repo.recalculate(dayFolderId);
    if (!summary) return null;
    try {
      if ((summary.status === "completed" || summary.status === "completed_with_skips") && summary.completedAt) {
        const children = repo.getChildTasks(dayFolderId);
        const marker = {
          version: 1,
          dayFolderId: summary.id,
          date: summary.date,
          folderPath: summary.folderPath,
          status: summary.status,
          totalChildren: summary.totalChildren,
          totalFiles: summary.totalFiles,
          uploadedFiles: summary.uploadedFiles,
          totalBytes: summary.totalBytes,
          uploadedBytes: summary.uploadedBytes,
          children: children.map((task) => ({
            folderName: task.folderName,
            folderPath: task.folderPath,
            taskId: task.id,
            completedAt: task.completedAt,
            destinations: task.destinations.map((destination) => ({
              provider: destination.provider,
              status: destination.status,
              completedAt: destination.completedAt
            }))
          })),
          completedAt: summary.completedAt
        };
        writeDayUpload(summary.folderPath, marker);
      } else {
        removeDayUpload(summary.folderPath);
      }
    } catch (err) {
      log.error("更新 legacy 归档组标记失败:", summary.folderPath, err);
    }
    this.broadcast(summary);
    return summary;
  }
  refreshForTask(taskId) {
    const task = getTaskRepo().getById(taskId);
    if (!task?.dayFolderId) return null;
    return this.refresh(task.dayFolderId);
  }
  broadcast(summary) {
    for (const win of electron.BrowserWindow?.getAllWindows?.() ?? []) {
      win.webContents.send(IPC.DAY_FOLDER_EVENT, summary);
    }
  }
}
let instance$h = null;
function getDayFolderService() {
  if (!instance$h) instance$h = new DayFolderService();
  return instance$h;
}
function parseJsonRecord(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}
function rowToTaskPluginRun(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    pluginId: row.plugin_id,
    category: row.category,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at || null,
    errorMessage: row.error_message || null,
    summary: parseJsonRecord(row.summary_json),
    stagingPath: row.staging_path || null,
    artifacts: parseJsonRecord(row.artifacts_json)
  };
}
function stringifyRecord(value) {
  return value ? JSON.stringify(value) : null;
}
class PluginRunRepo {
  start(taskId, pluginId, category) {
    const id = uuid.v4();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    getDb().prepare(
      `INSERT INTO task_plugin_runs (
        id, task_id, plugin_id, category, status, started_at
      ) VALUES (?, ?, ?, ?, 'running', ?)`
    ).run(id, taskId, pluginId, category, now);
    return this.getById(id);
  }
  complete(id, input = {}) {
    getDb().prepare(
      `UPDATE task_plugin_runs
       SET status = ?, completed_at = ?, error_message = ?,
         summary_json = ?, staging_path = ?, artifacts_json = ?
       WHERE id = ?`
    ).run(
      input.status || "completed",
      (/* @__PURE__ */ new Date()).toISOString(),
      input.errorMessage || null,
      stringifyRecord(input.summary),
      input.stagingPath || null,
      stringifyRecord(input.artifacts),
      id
    );
  }
  fail(id, errorMessage) {
    this.complete(id, {
      status: "failed",
      errorMessage
    });
  }
  getById(id) {
    const row = getDb().prepare("SELECT * FROM task_plugin_runs WHERE id = ?").get(id);
    return row ? rowToTaskPluginRun(row) : null;
  }
  listByTask(taskId) {
    return getDb().prepare(
      `SELECT * FROM task_plugin_runs
           WHERE task_id = ?
           ORDER BY started_at DESC`
    ).all(taskId).map(rowToTaskPluginRun);
  }
  listRecent(limit = 50) {
    return getDb().prepare(
      `SELECT * FROM task_plugin_runs
           ORDER BY started_at DESC
           LIMIT ?`
    ).all(Math.max(1, limit)).map(rowToTaskPluginRun);
  }
  listStagingPathsForCompletedTasks(retentionDays) {
    const cutoff = new Date(Date.now() - retentionDays * 864e5).toISOString();
    return getDb().prepare(
      `SELECT DISTINCT tpr.task_id, tpr.staging_path
           FROM task_plugin_runs tpr
           INNER JOIN tasks t ON t.id = tpr.task_id
           WHERE tpr.staging_path IS NOT NULL
             AND t.status IN ('completed', 'synced')
             AND t.completed_at IS NOT NULL
             AND t.completed_at < ?`
    ).all(cutoff).map((row) => ({
      taskId: row.task_id,
      stagingPath: row.staging_path
    }));
  }
}
let instance$g = null;
function getPluginRunRepo() {
  if (!instance$g) instance$g = new PluginRunRepo();
  return instance$g;
}
const MARKER_FILE_NAMES = /* @__PURE__ */ new Set([
  "tmp_upload.json",
  "process_task.json",
  "day_upload.json"
]);
const ASYNC_STAT_BATCH_SIZE = 64;
const DEFAULT_SCAN_BATCH_SIZE = 1e3;
class FileFilterService {
  rules;
  whitelist = [];
  blacklist = [];
  regexExcludes = [];
  suffixes = /* @__PURE__ */ new Set();
  constructor(rules) {
    this.rules = rules;
    this.compileRules();
  }
  updateRules(rules) {
    this.rules = rules;
    this.compileRules();
  }
  /**
   * 判断单个文件是否应该被包含
   * @param relativePath 文件相对路径
   * @returns true = 包含, false = 排除
   */
  shouldInclude(relativePath) {
    const fileName = path.basename(relativePath);
    const ext = path.extname(relativePath).toLowerCase();
    if (this.whitelist.length > 0) {
      for (const matcher of this.whitelist) {
        if (this.matchPattern(fileName, relativePath, ext, matcher)) {
          return true;
        }
      }
    }
    if (this.blacklist.length > 0) {
      for (const matcher of this.blacklist) {
        if (this.matchPattern(fileName, relativePath, ext, matcher)) {
          return false;
        }
      }
    }
    if (this.regexExcludes.length > 0) {
      for (const re of this.regexExcludes) {
        if (re.test(relativePath) || re.test(fileName)) {
          return false;
        }
      }
    }
    if (this.suffixes.size > 0) {
      return this.suffixes.has(ext);
    }
    return true;
  }
  /**
   * 递归扫描文件夹，返回过滤后的文件列表
   */
  scanFolder(folderPath) {
    const results = [];
    this.walkDir(folderPath, folderPath, results);
    return results;
  }
  async scanFolderAsync(folderPath) {
    const results = [];
    for await (const batch of this.scanFolderBatches(folderPath)) {
      results.push(...batch);
    }
    return results;
  }
  async *scanFolderBatches(folderPath, batchSize = DEFAULT_SCAN_BATCH_SIZE) {
    const normalizedBatchSize = Math.max(1, Math.floor(batchSize || 1));
    const pendingStats = [];
    const batch = [];
    yield* this.walkDirAsync(
      folderPath,
      folderPath,
      pendingStats,
      batch,
      normalizedBatchSize
    );
    yield* this.flushPendingStats(pendingStats, batch, normalizedBatchSize);
    if (batch.length > 0) {
      yield batch.splice(0, batch.length);
    }
  }
  walkDir(basePath, currentPath, results) {
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".")) continue;
        this.walkDir(basePath, fullPath, results);
      } else if (entry.isFile()) {
        const relativePath = fullPath.slice(basePath.length + 1);
        if (MARKER_FILE_NAMES.has(entry.name)) continue;
        if (this.shouldInclude(relativePath)) {
          const stat2 = fs.statSync(fullPath);
          results.push({
            relativePath,
            absolutePath: fullPath,
            size: stat2.size,
            mtimeMs: stat2.mtimeMs
          });
        }
      }
    }
  }
  async *walkDirAsync(basePath, currentPath, pendingStats, batch, batchSize) {
    const entries = await promises.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".")) continue;
        yield* this.walkDirAsync(
          basePath,
          fullPath,
          pendingStats,
          batch,
          batchSize
        );
      } else if (entry.isFile()) {
        const relativePath = fullPath.slice(basePath.length + 1);
        if (MARKER_FILE_NAMES.has(entry.name)) continue;
        if (!this.shouldInclude(relativePath)) continue;
        pendingStats.push(this.statScannedFile(fullPath, relativePath));
        if (pendingStats.length >= ASYNC_STAT_BATCH_SIZE) {
          yield* this.flushPendingStats(pendingStats, batch, batchSize);
        }
      }
    }
  }
  async *flushPendingStats(pendingStats, batch, batchSize) {
    if (pendingStats.length === 0) return;
    const statBatch = pendingStats.splice(0, pendingStats.length);
    const files = await Promise.all(statBatch);
    for (const file of files) {
      if (!file) continue;
      batch.push(file);
      if (batch.length >= batchSize) {
        yield batch.splice(0, batch.length);
      }
    }
  }
  async statScannedFile(fullPath, relativePath) {
    try {
      const fileStat = await promises.stat(fullPath);
      return {
        relativePath,
        absolutePath: fullPath,
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs
      };
    } catch {
      return null;
    }
  }
  compileRules() {
    this.whitelist = this.rules.whitelist.map((pattern) => this.compilePattern(pattern)).filter((matcher) => Boolean(matcher));
    this.blacklist = this.rules.blacklist.map((pattern) => this.compilePattern(pattern)).filter((matcher) => Boolean(matcher));
    this.regexExcludes = [];
    for (const pattern of this.rules.regex) {
      try {
        this.regexExcludes.push(new RegExp(pattern));
      } catch {
      }
    }
    this.suffixes = new Set(
      this.rules.suffixes.map((suffix) => this.normalizeSuffix(suffix)).filter(Boolean)
    );
  }
  compilePattern(pattern) {
    if (!pattern) return null;
    if (pattern.includes("*")) {
      const regexStr = "^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$";
      try {
        return { wildcard: new RegExp(regexStr, "i") };
      } catch {
        return null;
      }
    }
    if (pattern.startsWith(".")) {
      return { suffix: this.normalizeSuffix(pattern) };
    }
    return { exactName: pattern };
  }
  matchPattern(fileName, relativePath, ext, matcher) {
    if (matcher.exactName && fileName === matcher.exactName) return true;
    if (matcher.suffix && ext === matcher.suffix) return true;
    if (matcher.wildcard) {
      return matcher.wildcard.test(fileName) || matcher.wildcard.test(relativePath);
    }
    return false;
  }
  normalizeSuffix(suffix) {
    const trimmed = suffix.trim().toLowerCase();
    if (!trimmed) return "";
    return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
  }
}
class CleanupService {
  timer = null;
  pendingRun = null;
  running = false;
  start() {
    if (this.timer) return;
    this.scheduleCleanup(5 * 60 * 1e3);
    this.timer = setInterval(() => void this.cleanup(), 36e5);
    log.info("自动清理服务已启动");
  }
  stop() {
    if (this.pendingRun) {
      clearTimeout(this.pendingRun);
      this.pendingRun = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    log.info("自动清理服务已停止");
  }
  scheduleCleanup(delayMs = 0) {
    if (this.pendingRun) {
      clearTimeout(this.pendingRun);
    }
    this.pendingRun = setTimeout(() => {
      this.pendingRun = null;
      void this.cleanup();
    }, Math.max(0, delayMs));
  }
  async cleanup() {
    if (this.running) return;
    this.running = true;
    try {
      const settings = getSettingsRepo();
      const config = settings.get("cleanup");
      if (!config?.enabled) return;
      const retentionDays = this.normalizeRetentionDays(config);
      const taskRepo = getTaskRepo();
      const dayFolderRepo = getDayFolderRepo();
      const pluginRunRepo = getPluginRunRepo();
      const tasks = taskRepo.getCompletedForCleanup(retentionDays);
      const dayFolders = dayFolderRepo.getCompletedForCleanup(retentionDays);
      const stagingPaths = pluginRunRepo.listStagingPathsForCompletedTasks(retentionDays);
      if (tasks.length === 0 && dayFolders.length === 0 && stagingPaths.length === 0) return;
      log.info(
        `自动清理: 发现 ${dayFolders.length} 个归档组、${tasks.length} 个独立任务和 ${stagingPaths.length} 个插件工作目录可清理 (保留天数: ${retentionDays})`
      );
      let cleaned = 0;
      for (const dayFolder of dayFolders) {
        try {
          if (!fs.existsSync(dayFolder.folderPath)) {
            continue;
          }
          await this.refreshGroupFiles(dayFolder.id);
          const latest = dayFolderRepo.recalculate(dayFolder.id);
          if (!latest) continue;
          if (config.onlyAfterSealed !== false && latest.uploadGroupStatus !== "sealed" && latest.uploadGroupStatus !== "cleanable") {
            continue;
          }
          if (!dayFolderRepo.isSafeToClean(latest.id)) {
            continue;
          }
          dayFolderRepo.markCleanable(latest.id);
          await promises.rm(dayFolder.folderPath, { recursive: true, force: true });
          dayFolderRepo.markCleaned(latest.id);
          cleaned++;
          log.info(
            `自动清理: 已删除归档组 ${dayFolder.folderPath} (归档组ID: ${dayFolder.id}, sealedAt: ${latest.sealedAt})`
          );
        } catch (err) {
          log.error(`自动清理归档组失败: ${dayFolder.folderPath}`, err);
        }
      }
      for (const task of tasks) {
        try {
          if (!fs.existsSync(task.folderPath)) {
            continue;
          }
          await this.refreshTaskFiles(task);
          const latest = taskRepo.getById(task.id);
          if (!latest || !this.isStandaloneTaskSafeToClean(latest)) {
            continue;
          }
          await promises.rm(task.folderPath, { recursive: true, force: true });
          cleaned++;
          log.info(`自动清理: 已删除 ${task.folderPath} (任务ID: ${task.id}, 完成于: ${task.completedAt})`);
        } catch (err) {
          log.error(`自动清理失败: ${task.folderPath}`, err);
        }
      }
      for (const item of stagingPaths) {
        try {
          if (!fs.existsSync(item.stagingPath)) continue;
          await promises.rm(item.stagingPath, { recursive: true, force: true });
          cleaned++;
          log.info(`自动清理: 已删除插件工作目录 ${item.stagingPath} (任务ID: ${item.taskId})`);
        } catch (err) {
          log.error(`自动清理插件工作目录失败: ${item.stagingPath}`, err);
        }
      }
      if (cleaned > 0) {
        log.info(`自动清理完成: 共删除 ${cleaned} 个文件夹`);
      }
    } catch (err) {
      log.error("自动清理服务异常:", err);
    } finally {
      this.running = false;
    }
  }
  normalizeRetentionDays(config) {
    if (!Number.isFinite(config.retentionDays)) {
      return 7;
    }
    return Math.max(0, Math.floor(config.retentionDays));
  }
  async refreshGroupFiles(dayFolderId) {
    const tasks = getDayFolderRepo().getChildTasks(dayFolderId);
    await Promise.all(tasks.map((task) => this.refreshTaskFiles(task)));
    getDayFolderService().refresh(dayFolderId);
  }
  async refreshTaskFiles(task) {
    if (!fs.existsSync(task.folderPath) || task.status === "skipped") return;
    const settings = getSettingsRepo().getAll();
    const requiredStableChecks = task.sourceType === "local" && task.dayFolderId ? Math.max(2, settings.stability.checkCount || 2) : 1;
    await getTaskRepo().reconcileFileBatches(
      task.id,
      new FileFilterService(
        task.profileSnapshot?.filter || settings.filter
      ).scanFolderBatches(task.folderPath),
      requiredStableChecks
    );
  }
  isStandaloneTaskSafeToClean(task) {
    if (task.status !== "completed") return false;
    if (task.destinations.length === 0) return false;
    if (task.destinations.some(
      (destination) => destination.status !== "completed" && destination.status !== "synced"
    )) {
      return false;
    }
    const summary = getTaskRepo().summarizeFiles(task.id);
    if (summary.failedFiles > 0) return false;
    const destinationRepo = getTaskDestinationRepo();
    for (const destination of task.destinations) {
      const destinationSummary = destinationRepo.summarizeFileTargets(
        task.id,
        destination.provider
      );
      if (destinationSummary.failed > 0 || destinationSummary.pending > 0) {
        return false;
      }
    }
    return summary.totalFiles === summary.completedFiles + summary.skippedFiles;
  }
}
let instance$f = null;
function getCleanupService() {
  if (!instance$f) instance$f = new CleanupService();
  return instance$f;
}
class TaskQueueService extends events.EventEmitter {
  runningTasks = /* @__PURE__ */ new Map();
  processTimer = null;
  initialProcessTimer = null;
  uploadGateOpen = false;
  priorityTaskIds = /* @__PURE__ */ new Set();
  priorityActive = false;
  priorityOverrideWindow = false;
  taskRunner = null;
  setTaskRunner(runner) {
    this.taskRunner = runner;
  }
  start() {
    if (this.processTimer) return;
    this.processTimer = setInterval(() => void this.processQueue(), 2e3);
    this.initialProcessTimer = setTimeout(() => {
      this.initialProcessTimer = null;
      void this.processQueue();
    }, 1500);
    log.info("任务队列已启动");
  }
  stop() {
    if (this.initialProcessTimer) {
      clearTimeout(this.initialProcessTimer);
      this.initialProcessTimer = null;
    }
    if (this.processTimer) {
      clearInterval(this.processTimer);
      this.processTimer = null;
    }
    log.info("任务队列已停止");
  }
  getStatus() {
    const uploadConfig = getSettingsRepo().get("upload");
    this.syncPriorityState(false);
    return {
      gateOpen: this.uploadGateOpen,
      priorityActive: this.priorityActive,
      priorityTaskIds: Array.from(this.priorityTaskIds),
      priorityRemaining: this.priorityTaskIds.size,
      runningTaskIds: Array.from(this.runningTasks.keys()),
      overrideWindow: this.priorityOverrideWindow,
      withinUploadWindow: this.isWithinUploadWindow(
        uploadConfig?.startAfterTime,
        uploadConfig?.endBeforeTime
      ),
      uploadWindow: {
        startAfterTime: uploadConfig?.startAfterTime ?? null,
        endBeforeTime: uploadConfig?.endBeforeTime ?? null
      }
    };
  }
  startUploading(input) {
    const taskRepo = getTaskRepo();
    const taskIds = this.resolveStartTaskIds(input);
    taskRepo.resumeManyForUpload(taskIds);
    this.uploadGateOpen = true;
    this.priorityTaskIds = new Set(taskIds);
    this.priorityActive = this.priorityTaskIds.size > 0;
    this.priorityOverrideWindow = Boolean(input.overrideWindow) && this.priorityActive;
    this.syncPriorityState(false);
    this.emitQueueStatus();
    void this.processQueue();
    log.info(
      `上传队列已放行，优先任务 ${this.priorityTaskIds.size} 个，overrideWindow=${this.priorityOverrideWindow}`
    );
    return this.getStatus();
  }
  stopUploading(input) {
    this.uploadGateOpen = false;
    this.priorityTaskIds.clear();
    this.priorityActive = false;
    this.priorityOverrideWindow = false;
    if (input.mode === "pause-running") {
      for (const taskId of Array.from(this.runningTasks.keys())) {
        this.pauseRunningTask(taskId);
      }
    }
    this.emitQueueStatus();
    log.info("上传队列已停止:", input.mode);
    return this.getStatus();
  }
  getRunningCount() {
    return this.runningTasks.size;
  }
  isTaskRunning(taskId) {
    return this.runningTasks.has(taskId);
  }
  cancelRunningTask(taskId) {
    const running = this.runningTasks.get(taskId);
    if (running) {
      running.cancel();
      this.runningTasks.delete(taskId);
      this.emitQueueStatus();
    }
  }
  async processQueue() {
    if (!this.taskRunner) return;
    if (!this.uploadGateOpen) return;
    this.syncPriorityState();
    const settings = getSettingsRepo();
    const uploadConfig = settings.get("upload");
    const withinUploadWindow = this.isWithinUploadWindow(
      uploadConfig?.startAfterTime,
      uploadConfig?.endBeforeTime
    );
    const canOverrideWindow = this.priorityActive && this.priorityOverrideWindow;
    if (!withinUploadWindow && !canOverrideWindow) return;
    const maxConcurrent = uploadConfig?.maxConcurrentTasks || 4;
    const taskRepo = getTaskRepo();
    const availableSlots = maxConcurrent - this.runningTasks.size;
    if (availableSlots <= 0) return;
    const pendingTasks = this.priorityActive ? taskRepo.listRunnable() : taskRepo.listRunnable(void 0, 1);
    const prioritizedTasks = this.priorityActive ? pendingTasks.filter((task) => this.priorityTaskIds.has(task.id)) : pendingTasks;
    const eligibleTasks = prioritizedTasks.filter(
      (task) => canOverrideWindow || this.isTaskEligibleForCurrentStartCycle(
        task,
        uploadConfig?.startAfterTime
      )
    );
    const toRun = eligibleTasks.slice(0, Math.min(availableSlots, 1));
    for (const task of toRun) {
      this.executeTask(task);
    }
  }
  async executeTask(task) {
    const taskRepo = getTaskRepo();
    const controller = new AbortController();
    this.runningTasks.set(task.id, { cancel: () => controller.abort() });
    try {
      taskRepo.updateStatus(task.id, "uploading");
      this.emitQueueStatus();
      this.emit("task:status-change", {
        taskId: task.id,
        oldStatus: task.status,
        newStatus: "uploading"
      });
      const finalStatus = await this.taskRunner(task, controller.signal);
      if (!controller.signal.aborted) {
        taskRepo.updateStatus(task.id, finalStatus);
        getDayFolderService().refreshForTask(task.id);
        if (finalStatus === "completed") {
          getCleanupService().scheduleCleanup();
        }
        this.emit("task:status-change", {
          taskId: task.id,
          oldStatus: "uploading",
          newStatus: finalStatus
        });
        log.info(`任务状态更新为 ${finalStatus}:`, task.folderPath);
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        const errMsg = err instanceof Error ? err.message : String(err);
        taskRepo.updateStatus(task.id, "failed", errMsg);
        getTaskDestinationRepo().updateIncompleteStatuses(
          task.id,
          "failed",
          errMsg
        );
        getDayFolderService().refreshForTask(task.id);
        this.emit("task:status-change", {
          taskId: task.id,
          oldStatus: "uploading",
          newStatus: "failed"
        });
        log.error("任务失败:", task.folderPath, errMsg);
      }
    } finally {
      this.runningTasks.delete(task.id);
      this.syncPriorityState();
      this.emitQueueStatus();
      void this.processQueue();
    }
  }
  resolveStartTaskIds(input) {
    const taskRepo = getTaskRepo();
    if (input.scope === "all-pending") {
      return taskRepo.listPendingUploadTaskIds();
    }
    const ids = /* @__PURE__ */ new Set();
    for (const taskId of input.taskIds || []) {
      if (taskId) ids.add(taskId);
    }
    const dayFolderTaskIds = taskRepo.listPendingUploadTaskIdsByDayFolderIds(
      input.dayFolderIds || []
    );
    for (const taskId of dayFolderTaskIds) ids.add(taskId);
    return Array.from(ids);
  }
  syncPriorityState(emit = true) {
    if (!this.priorityActive && this.priorityTaskIds.size === 0) return;
    let changed = false;
    for (const taskId of Array.from(this.priorityTaskIds)) {
      const task = getTaskRepo().getById(taskId);
      if (!task || this.isPriorityTerminalStatus(task.status)) {
        this.priorityTaskIds.delete(taskId);
        changed = true;
      }
    }
    if (this.priorityTaskIds.size === 0 && this.priorityActive) {
      this.priorityActive = false;
      this.priorityOverrideWindow = false;
      changed = true;
    }
    if (changed && emit) this.emitQueueStatus();
  }
  pauseRunningTask(taskId) {
    const running = this.runningTasks.get(taskId);
    if (!running) return;
    running.cancel();
    this.runningTasks.delete(taskId);
    getTaskRepo().updateStatus(taskId, "paused");
    getTaskDestinationRepo().updateIncompleteStatuses(taskId, "paused");
    getDayFolderService().refreshForTask(taskId);
    this.emit("task:status-change", {
      taskId,
      oldStatus: "uploading",
      newStatus: "paused"
    });
  }
  isPriorityTerminalStatus(status) {
    return status === "completed" || status === "synced" || status === "skipped" || status === "failed" || status === "paused";
  }
  emitQueueStatus() {
    this.emit("upload-queue:event", this.getStatus());
  }
  isWithinUploadWindow(startAfterTime, endBeforeTime) {
    const startMinutes = this.parseMinutes(startAfterTime);
    const endMinutes = this.parseMinutes(endBeforeTime);
    const now = /* @__PURE__ */ new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    if (startMinutes === null && endMinutes === null) return true;
    if (startMinutes !== null && endMinutes === null) {
      return currentMinutes >= startMinutes;
    }
    if (startMinutes === null && endMinutes !== null) {
      return currentMinutes <= endMinutes;
    }
    if (startMinutes === null || endMinutes === null) return true;
    if (startMinutes === endMinutes) return true;
    if (startMinutes < endMinutes) {
      return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
    }
    return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
  }
  parseMinutes(time) {
    if (!time || !time.trim()) return null;
    const match = time.match(/^(\d{1,2}):(\d{1,2})$/);
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return hour * 60 + minute;
  }
  isTaskEligibleForCurrentStartCycle(task, startAfterTime) {
    const startMinutes = this.parseMinutes(startAfterTime);
    if (startMinutes === null) return true;
    const cycleStart = this.getCurrentStartCycleStart(startMinutes, /* @__PURE__ */ new Date());
    const createdAtMs = new Date(task.createdAt).getTime();
    if (Number.isNaN(createdAtMs)) return true;
    return createdAtMs <= cycleStart.getTime();
  }
  getCurrentStartCycleStart(startMinutes, now) {
    const todayStart = new Date(now);
    todayStart.setHours(Math.floor(startMinutes / 60), startMinutes % 60, 0, 0);
    if (now.getTime() >= todayStart.getTime()) {
      return todayStart;
    }
    const previousStart = new Date(todayStart);
    previousStart.setDate(previousStart.getDate() - 1);
    return previousStart;
  }
}
let instance$e = null;
function getTaskQueueService() {
  if (!instance$e) instance$e = new TaskQueueService();
  return instance$e;
}
async function discoverUploadGroups(rootDir, config = {}) {
  const normalizedConfig = normalizeDiscoveryConfig(config);
  if (!hasGroupRule(normalizedConfig)) {
    return [
      {
        groupKey: path.basename(rootDir) || normalizeDiscoveryPath(rootDir),
        folderPath: rootDir,
        relativePath: "",
        variables: {},
        taskDirectories: await discoverTaskDirectories(rootDir, rootDir, {}, normalizedConfig)
      }
    ];
  }
  const groupDepth = normalizedConfig.recursive ? Number.POSITIVE_INFINITY : Math.max(1, discoveryPatternDepth(normalizedConfig.groupPattern));
  const candidates = await listDirectoryCandidates(rootDir, groupDepth);
  const groups = [];
  for (const candidate of candidates) {
    const match = matchDiscoveryRule(normalizedConfig, "group", candidate.relativePath);
    if (!match) continue;
    const variables = match.variables;
    groups.push({
      groupKey: candidate.relativePath || candidate.name,
      folderPath: candidate.absolutePath,
      relativePath: candidate.relativePath,
      variables,
      taskDirectories: await discoverTaskDirectories(
        rootDir,
        candidate.absolutePath,
        variables,
        normalizedConfig
      )
    });
  }
  return groups.sort((a, b) => a.groupKey.localeCompare(b.groupKey));
}
async function discoverTaskDirectories(rootDir, groupPath, groupVariables, config) {
  if (!hasTaskRule(config)) {
    return [
      {
        taskKey: normalizeDiscoveryPath(groupPath.slice(rootDir.length)) || path.basename(groupPath),
        folderName: path.basename(groupPath),
        folderPath: groupPath,
        relativePath: normalizeDiscoveryPath(groupPath.slice(rootDir.length)),
        variables: {},
        ignored: false
      }
    ];
  }
  const taskDepth = config.recursive ? Number.POSITIVE_INFINITY : Math.max(1, discoveryPatternDepth(config.taskPattern));
  const candidates = await listDirectoryCandidates(groupPath, taskDepth);
  const result = [];
  for (const candidate of candidates) {
    const match = matchDiscoveryRule(config, "task", candidate.relativePath);
    result.push({
      taskKey: candidate.relativePath || candidate.name,
      folderName: candidate.name,
      folderPath: candidate.absolutePath,
      relativePath: candidate.relativePath,
      variables: match ? { ...groupVariables, ...match.variables } : groupVariables,
      ignored: !match
    });
  }
  return result.sort((a, b) => a.taskKey.localeCompare(b.taskKey));
}
async function listDirectoryCandidates(rootDir, maxDepth) {
  const candidates = [];
  await visit(rootDir, "", 0, maxDepth, candidates);
  return candidates;
}
async function visit(rootDir, relativePath, depth, maxDepth, candidates) {
  if (depth >= maxDepth) return;
  let entries;
  try {
    entries = await promises.readdir(path.join(rootDir, relativePath), { withFileTypes: true });
  } catch (error) {
    const code = error.code;
    if (code === "ENOENT" || code === "ENOTDIR") return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const childRelativePath = normalizeDiscoveryPath(path.join(relativePath, entry.name));
    candidates.push({
      absolutePath: path.join(rootDir, childRelativePath),
      relativePath: childRelativePath,
      name: entry.name
    });
    await visit(rootDir, childRelativePath, depth + 1, maxDepth, candidates);
  }
}
function normalizeDiscoveryConfig(config) {
  return {
    groupPattern: normalizeOptionalString(config.groupPattern),
    taskPattern: normalizeOptionalString(config.taskPattern),
    groupRegex: normalizeOptionalString(config.groupRegex),
    taskRegex: normalizeOptionalString(config.taskRegex),
    recursive: config.recursive ?? false
  };
}
function hasGroupRule(config) {
  return Boolean(config.groupPattern || config.groupRegex);
}
function hasTaskRule(config) {
  return Boolean(config.taskPattern || config.taskRegex);
}
function normalizeOptionalString(value) {
  const trimmed = value?.trim();
  return trimmed || void 0;
}
const NON_WORK_DIR_REASON = "非任务目录";
const INITIAL_SCAN_DELAY_MS = 3e3;
const SCAN_BATCH_SIZE = 4;
const RECONCILE_BATCH_SIZE = 2;
class ScannerService {
  timer = null;
  stabilityTimer = null;
  running = false;
  lastScanAt = null;
  nextScanAt = null;
  pendingDirs = /* @__PURE__ */ new Map();
  lastScanResults = null;
  watcher = null;
  scanDebounceTimer = null;
  watcherErrorHandled = false;
  lastWatcherWarningAt = 0;
  scanInProgress = false;
  scanQueued = false;
  reconcileQueue = [];
  reconcileQueuedIds = /* @__PURE__ */ new Set();
  reconcileInProgress = false;
  stabilityCursor = 0;
  start() {
    if (this.running) return;
    this.running = true;
    const settings = getSettingsRepo();
    const allSettings = settings.getAll();
    const activeRoots = getActiveProfileScanRoots(allSettings.profiles);
    const directories = activeRoots.map((root) => root.directory);
    const intervalMs = (allSettings.scan.intervalSeconds || 30) * 1e3;
    this.startWatcher(directories);
    this.timer = setInterval(() => this.scheduleFullScan(), intervalMs);
    this.scheduleFullScan(INITIAL_SCAN_DELAY_MS);
    const stabilityConfig = settings.get("stability");
    const checkInterval = stabilityConfig?.checkIntervalMs || 5e3;
    this.stabilityTimer = setInterval(() => this.checkStability(), checkInterval);
    log.info("扫描器已启动, 间隔:", intervalMs / 1e3, "秒");
  }
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.stabilityTimer) {
      clearInterval(this.stabilityTimer);
      this.stabilityTimer = null;
    }
    if (this.watcher) {
      void this.watcher.close();
      this.watcher = null;
    }
    if (this.scanDebounceTimer) {
      clearTimeout(this.scanDebounceTimer);
      this.scanDebounceTimer = null;
    }
    this.scanQueued = false;
    this.reconcileQueue = [];
    this.reconcileQueuedIds.clear();
    this.running = false;
    this.nextScanAt = null;
    log.info("扫描器已停止");
    this.broadcastStatus();
  }
  isRunning() {
    return this.running;
  }
  getStatus() {
    const settings = getSettingsRepo();
    const allSettings = settings.getAll();
    const stabilityConfig = settings.get("stability");
    const requiredChecks = stabilityConfig?.checkCount || 3;
    const activeRoots = getActiveProfileScanRoots(allSettings.profiles);
    const watchedDirectoriesByProvider = getProfileWatchedDirectoriesByProvider(
      allSettings.profiles
    );
    const pendingStabilityChecks = [];
    for (const pending of this.pendingDirs.values()) {
      pendingStabilityChecks.push({
        path: pending.path,
        checks: pending.checks,
        requiredChecks,
        discoveredAt: pending.discoveredAt
      });
    }
    return {
      running: this.running,
      lastScanAt: this.lastScanAt,
      nextScanAt: this.nextScanAt,
      watchedDirectories: activeRoots.map((root) => root.directory),
      watchedDirectoriesByProvider,
      pendingStabilityChecks,
      lastScanResults: this.lastScanResults
    };
  }
  triggerScan() {
    this.scheduleFullScan(0);
  }
  async scan() {
    if (!this.running) return;
    if (this.scanInProgress) {
      this.scanQueued = true;
      return;
    }
    this.scanInProgress = true;
    const settings = getSettingsRepo();
    const allSettings = settings.getAll();
    const scanConfig = allSettings.scan;
    const activeRoots = getActiveProfileScanRoots(allSettings.profiles);
    const directories = activeRoots.map((root) => root.directory);
    const intervalMs = (scanConfig?.intervalSeconds || 30) * 1e3;
    const seenChildPaths = /* @__PURE__ */ new Set();
    let scannedDirs = 0;
    let newDirsFound = 0;
    let existingDirs = 0;
    let ignoredDirectories = 0;
    let skippedChildren = 0;
    try {
      for (const root of activeRoots) {
        if (!await this.pathExists(root.directory)) {
          log.warn("扫描根目录不存在:", root.directory);
          continue;
        }
        const profile = getProfileById(allSettings, root.profileId);
        const result = await this.scanRootDirectory(
          root,
          seenChildPaths,
          profile
        );
        scannedDirs += result.scanned;
        newDirsFound += result.newFound;
        existingDirs += result.existing;
        ignoredDirectories += result.ignored;
        skippedChildren += result.skipped;
        await this.yieldToEventLoop();
      }
      for (const pendingPath of this.pendingDirs.keys()) {
        if (!seenChildPaths.has(pendingPath)) {
          this.pendingDirs.delete(pendingPath);
        }
      }
      await this.reconcileDeletedTasks(seenChildPaths, directories);
      this.lastScanAt = (/* @__PURE__ */ new Date()).toISOString();
      this.nextScanAt = new Date(Date.now() + intervalMs).toISOString();
      this.lastScanResults = {
        scannedDirs,
        newDirsFound,
        existingDirs,
        ignoredDirectories,
        skippedChildren,
        timestamp: this.lastScanAt
      };
      this.broadcastStatus();
    } finally {
      this.scanInProgress = false;
      if (this.scanQueued && this.running) {
        this.scanQueued = false;
        this.scheduleFullScan(250);
      }
    }
  }
  async scanRootDirectory(root, seenChildPaths, profile = getProfileById(getSettingsRepo().getAll(), root.profileId)) {
    let scanned = 0;
    let newFound = 0;
    let existing = 0;
    let ignored = 0;
    let skipped = 0;
    try {
      const groups = await discoverUploadGroups(
        root.directory,
        profile.discovery
      );
      for (let index = 0; index < groups.length; index++) {
        const group = groups[index];
        const result = await this.scanUploadGroupDirectory(
          root.directory,
          group.folderPath,
          group.groupKey,
          group.variables,
          group.taskDirectories,
          seenChildPaths,
          root.providers,
          profile
        );
        scanned += result.scanned;
        newFound += result.newFound;
        existing += result.existing;
        ignored += result.ignored;
        skipped += result.skipped;
        const shouldCloseByRollover = profile.completion.mode === "rollover" && index < groups.length - 1;
        const shouldCloseByMarker = profile.completion.mode === "marker-file" && fs.existsSync(path.join(group.folderPath, profile.completion.markerFile));
        if (shouldCloseByRollover || shouldCloseByMarker) {
          const uploadGroup = getDayFolderRepo().getByPath(group.folderPath);
          if (uploadGroup?.uploadGroupStatus === "open") {
            getDayFolderRepo().markClosing(uploadGroup.id);
            getDayFolderService().refresh(uploadGroup.id);
          }
        }
        if ((index + 1) % SCAN_BATCH_SIZE === 0) {
          await this.yieldToEventLoop();
        }
      }
    } catch (err) {
      log.error("扫描数据根目录失败:", root.directory, err);
    }
    return { scanned, newFound, existing, ignored, skipped };
  }
  async scanUploadGroupDirectory(sourceRootDir, groupPath, groupKey, groupVariables, discoveredTasks, seenChildPaths, providers, profile) {
    const dayFolder = getDayFolderRepo().ensure(
      groupPath,
      groupKey,
      groupVariables,
      profile.id
    );
    const childNames = Array.from(
      new Set(discoveredTasks.map((task) => task.folderName))
    ).sort();
    let scanned = 0;
    let newFound = 0;
    let existing = 0;
    let ignored = 0;
    let skipped = 0;
    try {
      for (let index = 0; index < discoveredTasks.length; index++) {
        const discoveredTask = discoveredTasks[index];
        const childName = discoveredTask.folderName;
        const childPath = discoveredTask.folderPath;
        const variables = discoveredTask.ignored ? groupVariables : { ...groupVariables, ...discoveredTask.variables };
        const pathContext = {
          sourcePath: childPath,
          basePath: sourceRootDir,
          variables
        };
        const targetSnapshot = this.pendingTargetSnapshot(providers, pathContext, profile);
        const uploadRelativePath = targetSnapshot.uploadRelativePath;
        seenChildPaths.add(childPath);
        scanned++;
        const existingTask = getTaskRepo().getByFolderPath(childPath);
        if (existingTask) {
          this.attachTaskToDayFolder(existingTask, dayFolder.id);
          getTaskRepo().updateGroupVariables(existingTask.id, variables);
          this.pendingDirs.delete(childPath);
          if (dayFolder.ignored && existingTask.status !== "completed" && existingTask.status !== "synced") {
            getTaskRepo().skip(existingTask.id, "用户忽略整个归档组");
            this.broadcastTaskStatus(
              existingTask.id,
              existingTask.status,
              "skipped"
            );
          }
          existing++;
          continue;
        }
        if (discoveredTask.ignored) {
          const task = this.registerIgnoredDir(
            childPath,
            childName,
            dayFolder.id,
            uploadRelativePath,
            variables,
            providers,
            targetSnapshot
          );
          this.broadcastTaskStatus(task.id, task.status, "skipped");
          ignored++;
          skipped++;
          continue;
        }
        const processMarker = readProcessTask(childPath);
        if (processMarker?.status === "completed") {
          this.registerLegacyCompletedDir(
            childPath,
            childName,
            dayFolder.id,
            groupKey,
            variables,
            processMarker,
            readTmpUpload(childPath)
          );
          existing++;
          continue;
        }
        const tmpMarker = readTmpUpload(childPath);
        if (tmpMarker) {
          const markerUploadRelativePath = tmpMarker.metadata.uploadRelativePath ?? uploadRelativePath;
          const task = this.registerNewDir({
            path: childPath,
            dayFolderId: dayFolder.id,
            groupKey,
            variables,
            folderName: childName,
            uploadRelativePath: markerUploadRelativePath,
            checks: 0,
            discoveredAt: tmpMarker.createdAt || (/* @__PURE__ */ new Date()).toISOString(),
            lastSnapshot: /* @__PURE__ */ new Map(),
            uploadTargetMode: tmpMarker.metadata.uploadTargetMode,
            profileId: tmpMarker.metadata.profileId,
            profileName: tmpMarker.metadata.profileName,
            profileSnapshot: tmpMarker.metadata.profileSnapshot,
            destinationPrefixes: tmpMarker.metadata.destinationPrefixes,
            destinationUploadRelativePaths: tmpMarker.metadata.destinationUploadRelativePaths || this.legacyDestinationUploadRelativePaths(
              tmpMarker.metadata.uploadTargetMode,
              markerUploadRelativePath
            ),
            destinationPathModes: tmpMarker.metadata.destinationPathModes,
            destinationObjectKeyTemplates: tmpMarker.metadata.destinationObjectKeyTemplates
          });
          if (dayFolder.ignored) {
            getTaskRepo().skip(task.id, "用户忽略整个归档组");
            this.broadcastTaskStatus(task.id, task.status, "skipped");
          } else {
            this.queueReconcileTask(task);
          }
          existing++;
          continue;
        }
        if (!this.pendingDirs.has(childPath)) {
          log.info("发现新任务目录, 注册持续同步任务:", childPath);
          const pending = {
            path: childPath,
            dayFolderId: dayFolder.id,
            groupKey,
            variables,
            folderName: childName,
            uploadRelativePath,
            checks: 0,
            discoveredAt: (/* @__PURE__ */ new Date()).toISOString(),
            lastSnapshot: /* @__PURE__ */ new Map(),
            uploadTargetMode: targetSnapshot.mode,
            profileId: targetSnapshot.profileId,
            profileName: targetSnapshot.profileName,
            profileSnapshot: targetSnapshot.profileSnapshot,
            destinationPrefixes: targetSnapshot.prefixes,
            destinationUploadRelativePaths: targetSnapshot.uploadRelativePaths,
            destinationPathModes: targetSnapshot.pathModes,
            destinationObjectKeyTemplates: targetSnapshot.objectKeyTemplates
          };
          const task = this.registerNewDir(pending);
          if (dayFolder.ignored) {
            getTaskRepo().skip(task.id, "用户忽略整个归档组");
            this.broadcastTaskStatus(task.id, task.status, "skipped");
          } else {
            this.queueReconcileTask(task);
          }
          newFound++;
        }
        if ((index + 1) % SCAN_BATCH_SIZE === 0) {
          await this.yieldToEventLoop();
        }
      }
    } catch (err) {
      log.error("扫描归档组失败:", groupPath, err);
    }
    getDayFolderService().refresh(dayFolder.id, childNames);
    return { scanned, newFound, existing, ignored, skipped };
  }
  checkStability() {
    const taskIds = getTaskRepo().listContinuouslyMonitoredTaskIds();
    if (taskIds.length > 0) {
      const batchSize = Math.min(RECONCILE_BATCH_SIZE, taskIds.length);
      for (let i = 0; i < batchSize; i++) {
        const taskId = taskIds[(this.stabilityCursor + i) % taskIds.length];
        if (taskId) this.queueReconcileTask(taskId);
      }
      this.stabilityCursor = (this.stabilityCursor + batchSize) % taskIds.length;
    }
    this.broadcastStatus();
  }
  registerNewDir(pending) {
    const settings = getSettingsRepo().getAll();
    const snapshot = pending.uploadTargetMode && pending.destinationPrefixes ? {
      mode: pending.uploadTargetMode,
      prefixes: {
        aliyun: pending.destinationPrefixes.aliyun || "",
        tencent: pending.destinationPrefixes.tencent || ""
      },
      uploadRelativePaths: pending.destinationUploadRelativePaths || this.legacyDestinationUploadRelativePaths(
        pending.uploadTargetMode,
        pending.uploadRelativePath
      ),
      uploadRelativePath: pending.uploadRelativePath,
      profileId: pending.profileId,
      profileName: pending.profileName,
      profileSnapshot: pending.profileSnapshot,
      pathModes: pending.destinationPathModes,
      objectKeyTemplates: pending.destinationObjectKeyTemplates
    } : this.legacySnapshotForPendingDir(pending, settings);
    const marker = {
      version: 2,
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      folderPath: pending.path,
      metadata: {
        source: "local",
        dayFolderId: pending.dayFolderId,
        date: pending.variables.date,
        groupKey: pending.groupKey,
        groupVariables: pending.variables,
        uploadRelativePath: pending.uploadRelativePath,
        uploadTargetMode: snapshot.mode,
        profileId: snapshot.profileId,
        profileName: snapshot.profileName,
        profileSnapshot: snapshot.profileSnapshot,
        destinationPrefixes: snapshot.prefixes,
        destinationUploadRelativePaths: snapshot.uploadRelativePaths,
        destinationPathModes: snapshot.pathModes,
        destinationObjectKeyTemplates: snapshot.objectKeyTemplates
      }
    };
    writeTmpUpload(pending.path, marker);
    const task = this.ensureTaskRegistered(
      pending.path,
      pending.folderName,
      pending.dayFolderId,
      pending.uploadRelativePath,
      snapshot,
      pending.variables
    );
    log.info("任务目录已注册为上传任务:", pending.path);
    setTimeout(() => this.collectDataInfo(pending.path), 0);
    getDayFolderService().refresh(pending.dayFolderId);
    return task;
  }
  registerIgnoredDir(dirPath, folderName, dayFolderId, uploadRelativePath, variables, providers, targetSnapshot) {
    const task = this.ensureTaskRegistered(
      dirPath,
      folderName,
      dayFolderId,
      uploadRelativePath,
      targetSnapshot || (providers ? getUploadTargetSnapshot(getSettingsRepo().getAll()) : void 0),
      variables
    );
    if (task.status !== "skipped" || task.errorMessage !== NON_WORK_DIR_REASON) {
      getTaskRepo().skip(task.id, NON_WORK_DIR_REASON);
      log.info("已忽略非任务目录:", dirPath);
    }
    getDayFolderService().refresh(dayFolderId);
    return getTaskRepo().getById(task.id) || task;
  }
  startWatcher(directories) {
    if (this.watcher) void this.watcher.close();
    this.watcherErrorHandled = false;
    const existingDirectories = directories.filter(
      (directory) => fs.existsSync(directory)
    );
    if (existingDirectories.length === 0) return;
    this.watcher = chokidar.watch(existingDirectories, {
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: false,
      // 只监听 Source/Group/Task 附近的目录结构。
      // 文件变化由稳定性检查和 30 秒全量校准处理，避免大量小文件耗尽 inotify。
      depth: 4,
      ignored: (path2, stats) => {
        const normalized = path2.replace(/\\/g, "/");
        return stats?.isFile() === true || normalized.includes("/.git/") || normalized.endsWith("/tmp_upload.json") || normalized.endsWith("/process_task.json") || normalized.endsWith("/day_upload.json");
      }
    });
    this.watcher.on("addDir", () => this.scheduleFullScan()).on("unlinkDir", () => this.scheduleFullScan()).on("error", (error) => this.handleWatcherError(error));
  }
  scheduleFullScan(delayMs = 500) {
    if (this.scanDebounceTimer) clearTimeout(this.scanDebounceTimer);
    this.scanDebounceTimer = setTimeout(() => {
      this.scanDebounceTimer = null;
      void this.scan();
    }, delayMs);
  }
  handleWatcherError(error) {
    const message = error instanceof Error ? error.message : String(error);
    const isResourceLimit = message.includes("ENOSPC") || message.includes("EMFILE") || message.includes("file watchers");
    if (isResourceLimit && !this.watcherErrorHandled) {
      this.watcherErrorHandled = true;
      log.warn(
        "目录事件监控达到系统资源上限，已关闭事件监听并回退到周期扫描:",
        message
      );
      const watcher = this.watcher;
      this.watcher = null;
      if (watcher) void watcher.close();
      return;
    }
    const now = Date.now();
    if (now - this.lastWatcherWarningAt >= 6e4) {
      this.lastWatcherWarningAt = now;
      log.warn("目录事件监控异常，周期扫描仍会继续:", message);
    }
  }
  queueReconcileTask(task) {
    const taskId = typeof task === "string" ? task : task.id;
    if (!this.enqueueReconcileTaskId(taskId)) return;
    void this.processReconcileQueue();
  }
  queueReconcileTaskIds(taskIds) {
    let queued = false;
    for (const taskId of taskIds) {
      queued = this.enqueueReconcileTaskId(taskId) || queued;
    }
    if (queued) void this.processReconcileQueue();
  }
  enqueueReconcileTaskId(taskId) {
    if (this.reconcileQueuedIds.has(taskId)) return false;
    this.reconcileQueuedIds.add(taskId);
    this.reconcileQueue.push(taskId);
    return true;
  }
  async processReconcileQueue() {
    if (this.reconcileInProgress) return;
    this.reconcileInProgress = true;
    try {
      while (this.reconcileQueue.length > 0) {
        const taskId = this.reconcileQueue.shift();
        this.reconcileQueuedIds.delete(taskId);
        const task = getTaskRepo().getById(taskId);
        if (task) {
          await this.reconcileTask(task);
        }
        await this.yieldToEventLoop();
      }
    } finally {
      this.reconcileInProgress = false;
    }
  }
  async reconcileTask(task) {
    if (task.status === "skipped" || task.status === "paused" || task.status === "completed") {
      return;
    }
    if (!await this.pathExists(task.folderPath)) {
      if (task.status !== "synced") {
        getTaskQueueService().cancelRunningTask(task.id);
        getTaskRepo().skip(task.id, "源目录已删除");
        getDayFolderService().refreshForTask(task.id);
        this.broadcastTaskStatus(task.id, task.status, "skipped");
      }
      return;
    }
    try {
      const settings = getSettingsRepo().getAll();
      const fileFilter = new FileFilterService(
        task.profileSnapshot?.filter || settings.filter
      );
      const stableChecks = task.sourceType === "local" && task.dayFolderId ? Math.max(2, settings.stability.checkCount || 2) : 1;
      await getTaskRepo().reconcileFileBatches(
        task.id,
        fileFilter.scanFolderBatches(task.folderPath),
        stableChecks
      );
      const updated = getTaskRepo().getById(task.id);
      if (updated && updated.status !== task.status) {
        this.broadcastTaskStatus(task.id, task.status, updated.status);
      }
      getDayFolderService().refreshForTask(task.id);
    } catch (err) {
      if (!await this.pathExists(task.folderPath)) {
        getTaskQueueService().cancelRunningTask(task.id);
        getTaskRepo().skip(task.id, "源目录已删除");
        getDayFolderService().refreshForTask(task.id);
        this.broadcastTaskStatus(task.id, task.status, "skipped");
        return;
      }
      log.warn("持续同步校准失败:", task.folderPath, err);
    }
  }
  async reconcileDeletedTasks(seenChildPaths, watchedDirectories) {
    const normalizedRoots = watchedDirectories.map(
      (directory) => directory.replace(/[\\/]+$/, "")
    );
    const tasks = getTaskRepo().listMonitorableLocalUnfinishedTasks();
    for (let index = 0; index < tasks.length; index++) {
      const task = tasks[index];
      if (!normalizedRoots.some(
        (root) => task.folderPath === root || task.folderPath.startsWith(`${root}/`) || task.folderPath.startsWith(`${root}\\`)
      )) {
        continue;
      }
      if (seenChildPaths.has(task.folderPath) || await this.pathExists(task.folderPath)) continue;
      if (task.status === "completed" || task.status === "synced" || task.status === "skipped") {
        continue;
      }
      getTaskQueueService().cancelRunningTask(task.id);
      getTaskRepo().skip(task.id, "源目录已删除");
      getDayFolderService().refreshForTask(task.id);
      this.broadcastTaskStatus(task.id, task.status, "skipped");
      if ((index + 1) % SCAN_BATCH_SIZE === 0) {
        await this.yieldToEventLoop();
      }
    }
  }
  broadcastTaskStatus(taskId, oldStatus, newStatus) {
    for (const win of electron.BrowserWindow?.getAllWindows?.() ?? []) {
      win.webContents.send(IPC.TASK_STATUS_CHANGE, {
        taskId,
        oldStatus,
        newStatus
      });
    }
  }
  registerLegacyCompletedDir(dirPath, folderName, dayFolderId, groupKey, variables, processMarker, tmpMarker) {
    const legacyUploadRelativePath = folderName;
    const markerProviders = Object.keys(processMarker.destinations || {});
    const mode = processMarker.uploadTargetMode || (markerProviders.includes("tencent") && markerProviders.includes("aliyun") ? "both" : markerProviders.includes("tencent") ? "tencent" : "aliyun");
    const currentSettings = getSettingsRepo().getAll();
    const prefixes = {
      aliyun: tmpMarker?.metadata.destinationPrefixes?.aliyun || currentSettings.oss.prefix || "",
      tencent: tmpMarker?.metadata.destinationPrefixes?.tencent || currentSettings.tencentS3.prefix || ""
    };
    const uploadRelativePaths = tmpMarker?.metadata.destinationUploadRelativePaths || this.legacyDestinationUploadRelativePaths(mode, legacyUploadRelativePath);
    const task = this.ensureTaskRegistered(
      dirPath,
      folderName,
      dayFolderId,
      legacyUploadRelativePath,
      {
        mode,
        prefixes,
        uploadRelativePaths,
        uploadRelativePath: legacyUploadRelativePath
      },
      variables
    );
    const taskRepo = getTaskRepo();
    taskRepo.setTotals(task.id, processMarker.totalFiles, 0);
    taskRepo.updateProgress(task.id, processMarker.uploadedFiles, 0);
    taskRepo.updateStatus(task.id, "completed");
    for (const destination of getTaskDestinationRepo().listByTask(task.id)) {
      const marker = processMarker.destinations?.[destination.provider];
      getTaskDestinationRepo().setTotals(
        task.id,
        destination.provider,
        marker?.totalFiles ?? processMarker.totalFiles,
        0
      );
      getTaskDestinationRepo().updateProgress(
        task.id,
        destination.provider,
        marker?.uploadedFiles ?? processMarker.uploadedFiles,
        0
      );
      getTaskDestinationRepo().updateStatus(
        task.id,
        destination.provider,
        "completed"
      );
    }
    writeTmpUpload(dirPath, {
      version: 2,
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      folderPath: dirPath,
      metadata: {
        source: "local",
        dayFolderId,
        date: variables.date,
        groupKey,
        groupVariables: variables,
        uploadRelativePath: legacyUploadRelativePath,
        uploadTargetMode: mode,
        destinationPrefixes: prefixes,
        destinationUploadRelativePaths: uploadRelativePaths
      }
    });
    writeProcessTask(dirPath, {
      ...processMarker,
      taskId: task.id,
      status: "completed",
      lastUpdated: (/* @__PURE__ */ new Date()).toISOString()
    });
    getDayFolderService().refresh(dayFolderId);
    log.info("信任旧完成标记并登记任务目录:", dirPath);
  }
  ensureTaskRegistered(dirPath, folderName, dayFolderId, uploadRelativePath, targetSnapshot, groupVariables = {}) {
    const taskRepo = getTaskRepo();
    const existing = taskRepo.getByFolderPath(dirPath);
    if (existing) {
      this.attachTaskToDayFolder(existing, dayFolderId);
      return taskRepo.getById(existing.id);
    }
    const settings = getSettingsRepo().getAll();
    const snapshot = targetSnapshot || getUploadTargetSnapshot(settings);
    return taskRepo.create({
      folderPath: dirPath,
      folderName,
      ossPrefix: snapshot.prefixes.aliyun,
      uploadTargetMode: snapshot.mode,
      destinationPrefixes: snapshot.prefixes,
      destinationUploadRelativePaths: snapshot.uploadRelativePaths,
      destinationPathModes: snapshot.pathModes,
      destinationObjectKeyTemplates: snapshot.objectKeyTemplates,
      dayFolderId,
      uploadRelativePath,
      sourceType: "local",
      profileId: snapshot.profileId,
      profileName: snapshot.profileName,
      profileSnapshot: snapshot.profileSnapshot,
      groupVariables
    });
  }
  pendingTargetSnapshot(providers, context, profile) {
    const snapshot = resolveProfileUploadSnapshot(
      profile,
      context,
      providers
    );
    return {
      uploadTargetMode: snapshot.mode,
      destinationPrefixes: snapshot.prefixes,
      destinationUploadRelativePaths: snapshot.uploadRelativePaths,
      uploadRelativePath: snapshot.uploadRelativePath,
      mode: snapshot.mode,
      prefixes: snapshot.prefixes,
      uploadRelativePaths: snapshot.uploadRelativePaths,
      profileId: snapshot.profileId,
      profileName: snapshot.profileName,
      profileSnapshot: snapshot.profileSnapshot,
      pathModes: snapshot.pathModes,
      objectKeyTemplates: snapshot.objectKeyTemplates
    };
  }
  legacySnapshotForPendingDir(pending, settings) {
    const snapshot = getUploadTargetSnapshot(settings);
    return {
      ...snapshot,
      uploadRelativePath: pending.uploadRelativePath,
      uploadRelativePaths: this.legacyDestinationUploadRelativePaths(
        snapshot.mode,
        pending.uploadRelativePath
      )
    };
  }
  attachTaskToDayFolder(task, dayFolderId) {
    if (task.dayFolderId !== dayFolderId) {
      getTaskRepo().updateDayFolderId(task.id, dayFolderId);
    }
  }
  legacyDestinationUploadRelativePaths(mode, uploadRelativePath) {
    if (uploadRelativePath === void 0) return {};
    const paths = {};
    for (const provider of providersForMode(mode || "aliyun")) {
      paths[provider] = uploadRelativePath;
    }
    return paths;
  }
  collectDataInfo(dirPath) {
    const settings = getSettingsRepo();
    const dataCollectConfig = settings.get("dataCollect");
    if (!dataCollectConfig?.enabled) return;
    try {
      const info = getDataCollectService().collectDataInfo(dirPath);
      if (info) {
        for (const win of electron.BrowserWindow?.getAllWindows?.() ?? []) {
          win.webContents.send(IPC.DATA_COLLECT_RESULT, info);
        }
      }
    } catch (err) {
      log.warn("数采分析失败:", dirPath, err);
    }
  }
  broadcastStatus() {
    const status = this.getStatus();
    for (const win of electron.BrowserWindow?.getAllWindows?.() ?? []) {
      win.webContents.send(IPC.SCANNER_EVENT, status);
    }
  }
  async pathExists(path2) {
    try {
      await promises.access(path2);
      return true;
    } catch {
      return false;
    }
  }
  async yieldToEventLoop() {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
let instance$d = null;
function getScannerService() {
  if (!instance$d) instance$d = new ScannerService();
  return instance$d;
}
class OSSUploadService {
  client = null;
  config = null;
  multipartThreshold = 100 * 1024 * 1024;
  // 100MB
  minPartSize = 1024 * 1024;
  // 1MB
  maxMultipartParts = 1e4;
  configure(config, multipartThreshold) {
    this.config = config;
    if (multipartThreshold) this.multipartThreshold = multipartThreshold;
    this.client = null;
  }
  async getClient() {
    if (this.client) return this.client;
    if (!this.config) throw new Error("OSS 未配置");
    const OSS = (await import("ali-oss")).default;
    this.client = new OSS({
      region: this.config.region,
      accessKeyId: this.config.accessKeyId,
      accessKeySecret: this.config.accessKeySecret,
      bucket: this.config.bucket,
      endpoint: this.config.endpoint || void 0
    });
    return this.client;
  }
  /**
   * 创建任务级独立 OSS 客户端
   * 每个任务使用自己的客户端，cancel() 不会影响其他任务
   */
  async createTaskClient() {
    if (!this.config) throw new Error("OSS 未配置");
    const OSS = (await import("ali-oss")).default;
    return new OSS({
      region: this.config.region,
      accessKeyId: this.config.accessKeyId,
      accessKeySecret: this.config.accessKeySecret,
      bucket: this.config.bucket,
      endpoint: this.config.endpoint || void 0
    });
  }
  async createTaskUploader(config, multipartThreshold) {
    this.configure(config, multipartThreshold);
    const client = await this.createTaskClient();
    const threshold = multipartThreshold || this.multipartThreshold;
    return {
      provider: "aliyun",
      uploadFile: (filePath, objectKey, fileSize, onProgress, signal) => this.uploadFileWithClient(
        client,
        filePath,
        objectKey,
        fileSize,
        threshold,
        onProgress,
        signal
      ).then((key) => ({ objectKey: key })),
      uploadBuffer: async (buffer, objectKey, signal) => {
        if (signal?.aborted) throw new DOMException("Upload aborted", "AbortError");
        await client.put(objectKey, buffer);
        return objectKey;
      },
      abort: () => client.cancel(),
      dispose: () => {
      }
    };
  }
  /**
   * 上传单个文件到 OSS
   * @param filePath 本地文件绝对路径
   * @param ossKey OSS 对象 key
   * @param fileSize 文件大小
   * @param onProgress 进度回调 (0-1)
   * @param signal 取消信号
   * @param taskClient 任务级 OSS 客户端（可选，默认使用共享客户端）
   * @returns OSS key
   */
  async uploadFile(filePath, ossKey, fileSize, onProgress, signal, taskClient) {
    if (signal?.aborted) {
      throw new DOMException("Upload aborted", "AbortError");
    }
    const client = taskClient || await this.getClient();
    return this.uploadFileWithClient(
      client,
      filePath,
      ossKey,
      fileSize,
      this.multipartThreshold,
      onProgress,
      signal
    );
  }
  async uploadFileWithClient(client, filePath, ossKey, fileSize, multipartThreshold, onProgress, signal) {
    if (signal?.aborted) {
      throw new DOMException("Upload aborted", "AbortError");
    }
    if (fileSize > multipartThreshold) {
      try {
        const partSize = this.getPartSizeForMultipart(fileSize);
        await client.multipartUpload(ossKey, filePath, {
          partSize,
          progress: (percentage) => {
            onProgress?.(percentage);
          }
        });
      } catch (err) {
        if (signal?.aborted || err && typeof err === "object" && "name" in err && err.name === "cancel") {
          throw new DOMException("Upload aborted", "AbortError");
        }
        throw err;
      }
    } else {
      const stream = fs.createReadStream(filePath);
      const onAbort = () => {
        stream.destroy();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        await client.put(ossKey, stream);
        onProgress?.(1);
      } catch (err) {
        if (signal?.aborted) {
          throw new DOMException("Upload aborted", "AbortError");
        }
        throw err;
      } finally {
        signal?.removeEventListener("abort", onAbort);
        stream.destroy();
      }
    }
    return ossKey;
  }
  getPartSizeForMultipart(fileSize) {
    const minPartSizeByCount = Math.ceil(fileSize / (this.maxMultipartParts - 1));
    const partSize = Math.max(this.minPartSize, minPartSizeByCount);
    const step = 1024 * 1024;
    return Math.ceil(partSize / step) * step;
  }
  /**
   * 上传 Buffer 到 OSS（用于 SFTP 直传场景）
   */
  async uploadBuffer(buffer, ossKey) {
    const client = await this.getClient();
    await client.put(ossKey, buffer);
    return ossKey;
  }
  async testConnection(config) {
    const endpoint = config.endpoint.trim();
    const region = config.region.trim();
    const bucket = config.bucket.trim();
    const accessKeyId = config.accessKeyId.trim();
    const accessKeySecret = config.accessKeySecret.trim();
    if (!region) return { ok: false, error: "Region 不能为空" };
    if (!bucket) return { ok: false, error: "Bucket 不能为空" };
    if (!accessKeyId) return { ok: false, error: "AccessKey ID 不能为空" };
    if (!accessKeySecret) return { ok: false, error: "AccessKey Secret 不能为空" };
    try {
      const OSS = (await import("ali-oss")).default;
      const client = new OSS({
        region,
        accessKeyId,
        accessKeySecret,
        bucket,
        endpoint: endpoint || void 0,
        timeout: "10s",
        secure: true
      });
      const result = await client.list({ "max-keys": 1 });
      const statusCode = result?.res?.status;
      if (typeof statusCode === "number" && statusCode >= 200 && statusCode < 300) {
        return { ok: true };
      }
      return { ok: false, error: `桶连接校验失败，HTTP 状态码: ${statusCode ?? "unknown"}` };
    } catch (err) {
      const e = err;
      const parts = [
        e.code || e.name,
        typeof e.status === "number" ? `status=${e.status}` : void 0,
        e.message
      ].filter(Boolean);
      return { ok: false, error: parts.join(", ") || String(err) };
    }
  }
}
let instance$c = null;
function getOSSUploadService() {
  if (!instance$c) instance$c = new OSSUploadService();
  return instance$c;
}
class TencentS3UploadService {
  createTaskUploader(config, multipartThreshold = 100 * 1024 * 1024) {
    const client = this.createClient(config);
    const activeControllers = /* @__PURE__ */ new Set();
    const activeUploads = /* @__PURE__ */ new Set();
    let aborted = false;
    const createController = (signal) => {
      const controller = new AbortController();
      activeControllers.add(controller);
      if (aborted || signal?.aborted) controller.abort();
      signal?.addEventListener("abort", () => controller.abort(), { once: true });
      return controller;
    };
    return {
      provider: "tencent",
      uploadFile: async (filePath, objectKey, fileSize, onProgress, signal) => {
        const controller = createController(signal);
        let uploadId;
        try {
          if (fileSize > multipartThreshold) {
            const upload = new libStorage.Upload({
              client,
              params: {
                Bucket: config.bucket,
                Key: objectKey,
                Body: fs.createReadStream(filePath),
                ContentType: "application/octet-stream"
              },
              queueSize: 4,
              partSize: this.getPartSize(fileSize),
              leavePartsOnError: false,
              abortController: controller
            });
            activeUploads.add(upload);
            upload.on("httpUploadProgress", (progress) => {
              if (typeof progress.loaded === "number" && fileSize > 0) {
                onProgress?.(Math.min(1, progress.loaded / fileSize));
              }
            });
            try {
              await upload.done();
              uploadId = upload.uploadId;
            } finally {
              activeUploads.delete(upload);
            }
          } else {
            await client.send(
              new clientS3.PutObjectCommand({
                Bucket: config.bucket,
                Key: objectKey,
                Body: fs.createReadStream(filePath),
                ContentType: "application/octet-stream",
                ContentLength: fileSize
              }),
              { abortSignal: controller.signal }
            );
            onProgress?.(1);
          }
          return { objectKey, uploadId };
        } catch (err) {
          if (controller.signal.aborted) {
            throw new DOMException("Upload aborted", "AbortError");
          }
          throw err;
        } finally {
          activeControllers.delete(controller);
        }
      },
      uploadBuffer: async (buffer, objectKey, signal) => {
        const controller = createController(signal);
        try {
          await client.send(
            new clientS3.PutObjectCommand({
              Bucket: config.bucket,
              Key: objectKey,
              Body: buffer,
              ContentType: "application/octet-stream",
              ContentLength: buffer.length
            }),
            { abortSignal: controller.signal }
          );
          return objectKey;
        } catch (err) {
          if (controller.signal.aborted) {
            throw new DOMException("Upload aborted", "AbortError");
          }
          throw err;
        } finally {
          activeControllers.delete(controller);
        }
      },
      abort: () => {
        aborted = true;
        for (const controller of activeControllers) controller.abort();
        for (const upload of activeUploads) void upload.abort();
        client.destroy();
      },
      dispose: () => client.destroy()
    };
  }
  async testConnection(config) {
    const validationError = this.validateConfig(config);
    if (validationError) return { ok: false, error: validationError };
    const client = this.createClient(config, 1e4);
    try {
      await client.send(
        new clientS3.ListObjectsV2Command({
          Bucket: config.bucket,
          MaxKeys: 1
        })
      );
      return { ok: true };
    } catch (err) {
      return { ok: false, error: this.formatError(err) };
    } finally {
      client.destroy();
    }
  }
  validateConfig(config) {
    if (!config.endpoint.trim()) return "Endpoint 不能为空";
    if (!config.region.trim()) return "Region 不能为空";
    if (!config.bucket.trim()) return "Bucket 不能为空";
    if (!config.accessKeyId.trim()) return "AccessKey ID 不能为空";
    if (!config.accessKeySecret.trim()) return "AccessKey Secret 不能为空";
    return null;
  }
  createClient(config, requestTimeout = 3e5) {
    const requestHandler = new nodeHttpHandler.NodeHttpHandler({
      connectionTimeout: 3e4,
      requestTimeout,
      httpsAgent: new https.Agent({
        keepAlive: true,
        rejectUnauthorized: !config.allowInsecureTls
      })
    });
    return new clientS3.S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.accessKeySecret
      },
      requestHandler,
      maxAttempts: 1
    });
  }
  getPartSize(fileSize) {
    const minimum = 5 * 1024 * 1024;
    const byPartCount = Math.ceil(fileSize / 9999);
    const raw = Math.max(minimum, byPartCount);
    const step = 1024 * 1024;
    return Math.ceil(raw / step) * step;
  }
  formatError(err) {
    const error = err;
    return [
      error.Code || error.name,
      error.$metadata?.httpStatusCode ? `status=${error.$metadata.httpStatusCode}` : void 0,
      error.message
    ].filter(Boolean).join(", ") || String(err);
  }
}
let instance$b = null;
function getTencentS3UploadService() {
  if (!instance$b) instance$b = new TencentS3UploadService();
  return instance$b;
}
class CloudUploadService {
  async createTaskUploader(provider, settings, multipartThreshold) {
    if (provider === "aliyun") {
      return getOSSUploadService().createTaskUploader(settings.oss, multipartThreshold);
    }
    return getTencentS3UploadService().createTaskUploader(
      settings.tencentS3,
      multipartThreshold
    );
  }
  validateProvider(provider, settings) {
    if (provider === "aliyun") {
      if (!settings.oss.region.trim()) return "阿里云 Region 不能为空";
      if (!settings.oss.bucket.trim()) return "阿里云 Bucket 不能为空";
      if (!settings.oss.accessKeyId.trim()) return "阿里云 AccessKey ID 不能为空";
      if (!settings.oss.accessKeySecret.trim()) return "阿里云 AccessKey Secret 不能为空";
      return null;
    }
    const error = getTencentS3UploadService().validateConfig(settings.tencentS3);
    return error ? `腾讯云 ${error}` : null;
  }
}
let instance$a = null;
function getCloudUploadService() {
  if (!instance$a) instance$a = new CloudUploadService();
  return instance$a;
}
class SSHRsyncService {
  runningProcesses = /* @__PURE__ */ new Map();
  /**
   * 测试 SSH 连接
   */
  async testConnection(machine, password) {
    return new Promise((resolve) => {
      const client = new ssh2.Client();
      const timeout = setTimeout(() => {
        client.end();
        resolve({ ok: false, error: "连接超时 (10s)" });
      }, 1e4);
      client.on("ready", () => {
        clearTimeout(timeout);
        client.end();
        resolve({ ok: true });
      });
      client.on("error", (err) => {
        clearTimeout(timeout);
        resolve({ ok: false, error: err.message });
      });
      const connectOpts = {
        host: machine.host,
        port: machine.port,
        username: machine.username
      };
      if (machine.authType === "key" && machine.privateKeyPath) {
        try {
          connectOpts.privateKey = fs.readFileSync(machine.privateKeyPath);
        } catch (err) {
          resolve({ ok: false, error: `无法读取密钥文件: ${err}` });
          return;
        }
      } else if (password) {
        connectOpts.password = password;
      }
      client.connect(connectOpts);
    });
  }
  /**
   * 执行 rsync 拉取
   */
  async startRsync(machine, password, onProgress) {
    if (this.runningProcesses.has(machine.id)) {
      throw new Error("该机器已有传输进程在运行");
    }
    return new Promise((resolve, reject) => {
      const args = this.buildRsyncArgs(machine);
      const env = { ...process.env };
      let cmd;
      let cmdArgs;
      if (machine.authType === "password" && password) {
        cmd = "sshpass";
        cmdArgs = ["-p", password, "rsync", ...args];
      } else {
        cmd = "rsync";
        cmdArgs = args;
      }
      log.info(`rsync 启动: ${cmd} ${cmdArgs.join(" ")}`);
      const proc = child_process.spawn(cmd, cmdArgs, { env });
      this.runningProcesses.set(machine.id, proc);
      let stderr = "";
      proc.stdout?.on("data", (data) => {
        const line = data.toString();
        const progress = this.parseRsyncProgress(machine.id, line);
        if (progress && onProgress) {
          onProgress(progress);
        }
      });
      proc.stderr?.on("data", (data) => {
        stderr += data.toString();
      });
      proc.on("close", (code) => {
        this.runningProcesses.delete(machine.id);
        if (code === 0) {
          log.info(`rsync 完成: ${machine.name}`);
          resolve();
        } else {
          const err = `rsync 退出码 ${code}: ${stderr}`;
          log.error(err);
          reject(new Error(err));
        }
      });
      proc.on("error", (err) => {
        this.runningProcesses.delete(machine.id);
        reject(err);
      });
    });
  }
  /**
   * SFTP 流式直传到当前选择的云端（不落盘）
   */
  async sftpStreamToCloud(machine, password, settings, onProgress) {
    if (this.runningProcesses.has(machine.id)) {
      throw new Error("该机器已有传输进程在运行");
    }
    const profile = getProfileById(settings, machine.profileId);
    const providers = providersForProfile(profile);
    const uploaders = /* @__PURE__ */ new Map();
    try {
      for (const provider of providers) {
        const validationError = getCloudUploadService().validateProvider(provider, settings);
        if (validationError) throw new Error(validationError);
        uploaders.set(
          provider,
          await getCloudUploadService().createTaskUploader(
            provider,
            settings,
            settings.upload.multipartThreshold
          )
        );
      }
    } catch (err) {
      for (const uploader of uploaders.values()) uploader.dispose();
      throw err;
    }
    const client = new ssh2.Client();
    this.runningProcesses.set(machine.id, client);
    return new Promise((resolve, reject) => {
      const connectOpts = {
        host: machine.host,
        port: machine.port,
        username: machine.username
      };
      if (machine.authType === "key" && machine.privateKeyPath) {
        try {
          connectOpts.privateKey = fs.readFileSync(machine.privateKeyPath);
        } catch (err) {
          this.runningProcesses.delete(machine.id);
          reject(new Error(`无法读取密钥文件: ${err}`));
          return;
        }
      } else if (password) {
        connectOpts.password = password;
      }
      client.on("error", (err) => {
        this.runningProcesses.delete(machine.id);
        reject(err);
      });
      client.on("ready", () => {
        client.sftp(async (err, sftp) => {
          if (err) {
            client.end();
            this.runningProcesses.delete(machine.id);
            reject(err);
            return;
          }
          try {
            const result = await this.sftpUploadDir(
              sftp,
              machine,
              settings,
              uploaders,
              onProgress
            );
            client.end();
            this.runningProcesses.delete(machine.id);
            for (const uploader of uploaders.values()) uploader.dispose();
            resolve(result);
          } catch (uploadErr) {
            client.end();
            this.runningProcesses.delete(machine.id);
            for (const uploader of uploaders.values()) uploader.dispose();
            reject(uploadErr);
          }
        });
      });
      client.connect(connectOpts);
    });
  }
  async sftpUploadDir(sftp, machine, settings, uploaders, onProgress) {
    const files = await this.sftpListFiles(sftp, machine.remoteDir, machine.remoteDir);
    log.info(`SFTP 发现 ${files.length} 个文件`);
    const providers = Array.from(uploaders.keys());
    const snapshot = resolveProfileUploadSnapshot(
      getProfileById(settings, machine.profileId),
      { sourcePath: machine.remoteDir },
      providers
    );
    let uploadedCount = 0;
    const providerResults = /* @__PURE__ */ new Map();
    for (const provider of uploaders.keys()) {
      providerResults.set(provider, { provider, ok: true, keys: [] });
    }
    for (const remoteFile of files) {
      const relativePath = remoteFile.slice(machine.remoteDir.length).replace(/^\//, "");
      onProgress?.({
        machineId: machine.id,
        totalFiles: files.length,
        uploadedFiles: uploadedCount,
        currentFile: relativePath,
        speed: ""
      });
      await new Promise((res, rej) => {
        const readStream = sftp.createReadStream(remoteFile);
        const chunks = [];
        readStream.on("data", (chunk) => {
          chunks.push(chunk);
        });
        readStream.on("end", async () => {
          try {
            const buffer = Buffer.concat(chunks);
            const active = Array.from(uploaders.entries()).filter(([provider]) => {
              return providerResults.get(provider)?.ok;
            });
            await Promise.all(
              active.map(async ([provider, uploader]) => {
                const objectKey = renderObjectKey(
                  {
                    provider,
                    prefix: snapshot.prefixes[provider],
                    uploadRelativePath: snapshot.uploadRelativePaths[provider] ?? "",
                    pathMode: snapshot.pathModes[provider],
                    objectKeyTemplate: snapshot.objectKeyTemplates[provider] ?? null
                  },
                  {
                    sourcePath: machine.remoteDir,
                    folderName: path.posix.basename(machine.remoteDir),
                    relativePath,
                    profileId: snapshot.profileId,
                    profileName: snapshot.profileName
                  }
                );
                try {
                  await uploader.uploadBuffer(buffer, objectKey);
                  providerResults.get(provider)?.keys?.push(objectKey);
                } catch (err) {
                  providerResults.set(provider, {
                    provider,
                    ok: false,
                    error: err instanceof Error ? err.message : String(err)
                  });
                }
              })
            );
            if (Array.from(providerResults.values()).every((result) => result.ok)) {
              uploadedCount++;
            }
            res();
          } catch (e) {
            rej(e);
          }
        });
        readStream.on("error", rej);
      });
    }
    onProgress?.({
      machineId: machine.id,
      totalFiles: files.length,
      uploadedFiles: uploadedCount,
      currentFile: "",
      speed: ""
    });
    log.info(`SFTP 直传完成: ${uploadedCount}/${files.length} 个文件`);
    const results = Array.from(providerResults.values());
    return {
      ok: results.every((result) => result.ok),
      results
    };
  }
  sftpListFiles(sftp, basePath, currentPath) {
    return new Promise((resolve, reject) => {
      sftp.readdir(currentPath, async (err, list) => {
        if (err) {
          reject(err);
          return;
        }
        const files = [];
        for (const item of list) {
          if (item.filename.startsWith(".")) continue;
          const fullPath = path.posix.join(currentPath, item.filename);
          if (item.attrs.isDirectory()) {
            const subFiles = await this.sftpListFiles(sftp, basePath, fullPath);
            files.push(...subFiles);
          } else if (item.attrs.isFile()) {
            files.push(fullPath);
          }
        }
        resolve(files);
      });
    });
  }
  stopRsync(machineId) {
    const running = this.runningProcesses.get(machineId);
    if (running) {
      if (running instanceof ssh2.Client) {
        running.end();
      } else {
        running.kill("SIGTERM");
      }
      this.runningProcesses.delete(machineId);
      log.info("传输已停止:", machineId);
    }
  }
  buildRsyncArgs(machine) {
    const args = [
      "-avz",
      "--partial",
      "--progress",
      `--bwlimit=${machine.bwLimit}`
    ];
    const sshCmd = machine.authType === "key" && machine.privateKeyPath ? `ssh -i ${machine.privateKeyPath} -p ${machine.port} -o StrictHostKeyChecking=no` : `ssh -p ${machine.port} -o StrictHostKeyChecking=no`;
    const remoteRsync = `nice -n ${machine.cpuNice} ionice -c 3 rsync`;
    args.push(`--rsync-path=${remoteRsync}`);
    args.push("-e", sshCmd);
    const remotePath = machine.remoteDir.endsWith("/") ? machine.remoteDir : machine.remoteDir + "/";
    const source = `${machine.username}@${machine.host}:${remotePath}`;
    const dest = machine.localDir.endsWith("/") ? machine.localDir : machine.localDir + "/";
    args.push(source, dest);
    return args;
  }
  parseRsyncProgress(machineId, line) {
    const match = line.match(/(\d+)%\s+([\d.]+\w+\/s)/);
    if (match) {
      return {
        machineId,
        percent: parseInt(match[1]),
        speed: match[2],
        file: line.trim().split("\n")[0] || ""
      };
    }
    return null;
  }
}
let instance$9 = null;
function getSSHRsyncService() {
  if (!instance$9) instance$9 = new SSHRsyncService();
  return instance$9;
}
const IMAGE_EXTENSIONS = /* @__PURE__ */ new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".tiff", ".tif"]);
const DEFAULT_MAX_KEYS = 200;
const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
function normalizePrefix(prefix) {
  const normalized = prefix.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized) return "";
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}
function itemNameFromPath(pathValue) {
  const trimmed = pathValue.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}
function isImageByName(name) {
  return IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase());
}
function headerValue(headers, name) {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}
function asBuffer(content) {
  if (Buffer.isBuffer(content)) return content;
  if (content instanceof Uint8Array) return Buffer.from(content);
  if (typeof content === "string") return Buffer.from(content);
  throw new Error("图片数据格式不受支持");
}
function mapOSSObject(raw) {
  const key = String(raw.name || "");
  const size = Number(raw.size || 0);
  const lastModifiedRaw = raw.lastModified ? String(raw.lastModified) : "";
  const lastModified = lastModifiedRaw || (/* @__PURE__ */ new Date(0)).toISOString();
  return {
    key,
    name: itemNameFromPath(key),
    size: Number.isFinite(size) ? size : 0,
    lastModified,
    contentType: raw.type ? String(raw.type) : void 0,
    isImage: isImageByName(key)
  };
}
class OSSBrowserService {
  client = null;
  configKey = null;
  async getClientAndBasePrefix() {
    const settings = getSettingsRepo().getAll();
    const profile = settings.profiles.find((item) => item.id === settings.activeProfileId) || settings.profiles[0];
    const extensions = normalizeProfileExtensions(profile.extensions, profile.plugins);
    if (!extensions.enabledIds.includes(EXTENSION_IDS.OSS_BROWSER)) {
      throw new Error("当前 Profile 未启用 OSS 浏览器插件");
    }
    if (!providersForProfile(profile).includes("aliyun")) {
      throw new Error("OSS 浏览器插件第一版仅支持包含阿里云目标的 Profile");
    }
    const config = {
      ...settings.oss,
      ...profile.providers.aliyun,
      accessKeyId: settings.oss.accessKeyId,
      accessKeySecret: settings.oss.accessKeySecret,
      endpoint: settings.oss.endpoint,
      bucket: settings.oss.bucket,
      region: settings.oss.region
    };
    if (!config.region || !config.bucket || !config.accessKeyId || !config.accessKeySecret) {
      throw new Error("阿里云 OSS 配置不完整，请先到设置页完成配置");
    }
    const newConfigKey = this.getConfigKey(config);
    if (!this.client || this.configKey !== newConfigKey) {
      const OSS = (await import("ali-oss")).default;
      this.client = new OSS({
        region: config.region,
        accessKeyId: config.accessKeyId,
        accessKeySecret: config.accessKeySecret,
        bucket: config.bucket,
        endpoint: config.endpoint || void 0
      });
      this.configKey = newConfigKey;
    }
    return {
      client: this.client,
      basePrefix: normalizePrefix(config.prefix || "")
    };
  }
  getConfigKey(config) {
    return [config.endpoint, config.region, config.bucket, config.accessKeyId, config.accessKeySecret].join("|");
  }
  async list(prefix, continuationToken, maxKeys = DEFAULT_MAX_KEYS) {
    const { client, basePrefix } = await this.getClientAndBasePrefix();
    const effectivePrefix = prefix ? normalizePrefix(prefix) : basePrefix;
    const options = {
      prefix: effectivePrefix,
      delimiter: "/",
      "max-keys": Math.min(Math.max(20, maxKeys), 1e3)
    };
    if (continuationToken) {
      options["continuation-token"] = continuationToken;
    }
    const result = await client.listV2(options);
    return {
      effectivePrefix,
      prefixes: (result.prefixes || []).map((p) => ({
        prefix: p,
        name: itemNameFromPath(p)
      })),
      objects: (result.objects || []).map(mapOSSObject).filter((item) => item.key && item.key !== effectivePrefix),
      nextContinuationToken: result.nextContinuationToken,
      isTruncated: Boolean(result.isTruncated)
    };
  }
  async head(key) {
    const { client } = await this.getClientAndBasePrefix();
    const result = await client.head(key);
    const headers = result.res.headers;
    const size = Number(headerValue(headers, "content-length") || 0);
    const lastModified = headerValue(headers, "last-modified");
    const contentType = headerValue(headers, "content-type");
    return {
      key,
      size: Number.isFinite(size) ? size : 0,
      lastModified: lastModified ? new Date(lastModified).toISOString() : (/* @__PURE__ */ new Date(0)).toISOString(),
      contentType,
      etag: headerValue(headers, "etag")
    };
  }
  async getImagePreview(key, maxBytes = DEFAULT_MAX_IMAGE_BYTES) {
    const { client } = await this.getClientAndBasePrefix();
    const meta = await this.head(key);
    if (meta.size > maxBytes) {
      throw new Error(`图片过大，超过预览限制（${Math.round(maxBytes / 1024 / 1024)}MB）`);
    }
    const response = await client.get(key);
    const buffer = asBuffer(response.content);
    const contentType = meta.contentType || "image/jpeg";
    return {
      dataUrl: `data:${contentType};base64,${buffer.toString("base64")}`,
      contentType,
      size: buffer.length
    };
  }
}
let instance$8 = null;
function getOSSBrowserService() {
  if (!instance$8) {
    instance$8 = new OSSBrowserService();
  }
  return instance$8;
}
class WebhookService {
  async notify(config, payload) {
    if (!config.enabled || !config.url) return;
    const maxRetries = 3;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(config.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...config.headers
          },
          body: JSON.stringify(payload)
        });
        if (response.ok) {
          log.info(`Webhook 通知成功: ${config.url}`);
          return;
        }
        log.warn(`Webhook 响应异常: ${response.status} ${response.statusText}`);
      } catch (err) {
        log.warn(`Webhook 请求失败 (尝试 ${attempt + 1}/${maxRetries + 1}):`, err);
      }
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1e3;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    log.error(`Webhook 通知最终失败: ${config.url}`);
  }
}
let instance$7 = null;
function getWebhookService() {
  if (!instance$7) instance$7 = new WebhookService();
  return instance$7;
}
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function normalizedTaskExtensions(task) {
  return normalizeProfileExtensions(
    task.profileSnapshot?.extensions,
    task.profileSnapshot?.plugins
  );
}
function configForExtension(extensions, extensionId) {
  return extensions.configs[extensionId];
}
function webhookConfigFromExtension(rawConfig) {
  if (!isRecord(rawConfig)) return null;
  return {
    enabled: rawConfig.enabled === true,
    url: typeof rawConfig.url === "string" ? rawConfig.url : "",
    headers: isRecord(rawConfig.headers) ? Object.fromEntries(
      Object.entries(rawConfig.headers).map(([key, value]) => [key, String(value)])
    ) : {}
  };
}
function summarizeExtensionConfig(extension, rawConfig) {
  if (extension.id === EXTENSION_IDS.WEBHOOK_NOTIFIER) {
    const config = webhookConfigFromExtension(rawConfig);
    return config?.enabled && config.url ? `已配置 ${config.url}` : "未配置";
  }
  if (extension.id === EXTENSION_IDS.OSS_BROWSER) {
    return "使用当前 Profile 的阿里云 OSS 配置";
  }
  if (extension.id === EXTENSION_IDS.GENERIC_CONVERTER) {
    const config = normalizeGenericConverterConfig(rawConfig);
    if (!config.enabled) return "未启用";
    const dataRoot = config.dataRoot || "-";
    const outputRoot = config.outputRoot || "-";
    return `输入=${dataRoot}; 输出=${outputRoot}`;
  }
  return "";
}
function summarizePipelineConfig(pipelineId, rawConfig) {
  if (pipelineId === UPLOAD_PIPELINE_IDS.SANY_MODULE1_UPLOAD) {
    const stationPrefix = isRecord(rawConfig) && typeof rawConfig.stationPrefix === "string" ? rawConfig.stationPrefix : "station2";
    return `stationPrefix=${stationPrefix}`;
  }
  return "使用原始源目录和 Profile 路径规则";
}
class ExtensionRuntimeService {
  listManifests() {
    return BUILTIN_EXTENSIONS;
  }
  listCapabilities() {
    return {
      uploadPipelines: BUILTIN_UPLOAD_PIPELINES,
      extensions: BUILTIN_EXTENSIONS
    };
  }
  notifyTaskEvent(task, event) {
    const settings = getSettingsRepo();
    const extensions = normalizedTaskExtensions(task);
    const webhookExtensionEnabled = extensions.enabledIds.includes(
      EXTENSION_IDS.WEBHOOK_NOTIFIER
    );
    const extensionConfig = webhookConfigFromExtension(
      configForExtension(extensions, EXTENSION_IDS.WEBHOOK_NOTIFIER)
    );
    const legacyConfig = settings.get("webhook");
    const config = webhookExtensionEnabled ? extensionConfig : legacyConfig;
    if (!config?.enabled || !config.url) return;
    const run = getPluginRunRepo().start(task.id, EXTENSION_IDS.WEBHOOK_NOTIFIER, "notification");
    const createdAt = new Date(task.createdAt).getTime();
    const durationSeconds = Number.isFinite(createdAt) ? Math.max(0, Math.round((Date.now() - createdAt) / 1e3)) : 0;
    void getWebhookService().notify(config, {
      event,
      taskId: task.id,
      folderName: task.folderName,
      fileCount: task.totalFiles,
      totalBytes: task.totalBytes,
      durationSeconds,
      status: event === "task_completed" ? "completed" : "failed",
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    }).then(() => {
      getPluginRunRepo().complete(run.id, {
        summary: {
          event,
          url: config.url
        }
      });
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      getPluginRunRepo().fail(run.id, message);
      log.warn("Webhook 扩展通知失败:", message);
    });
  }
  getProjectCapabilityStatus(profileId) {
    const settings = getSettingsRepo().getAll();
    const profile = settings.profiles.find((item) => item.id === profileId) || settings.profiles.find((item) => item.id === settings.activeProfileId) || settings.profiles[0];
    const pipeline = normalizeProfileUploadPipeline(
      profile.uploadPipeline,
      profile.plugins
    );
    const extensions = normalizeProfileExtensions(
      profile.extensions,
      profile.plugins
    );
    const enabled = new Set(extensions.enabledIds);
    const recentRuns = getPluginRunRepo().listRecent(100);
    const pipelineManifest = BUILTIN_UPLOAD_PIPELINES.find((item) => item.id === pipeline.id) || BUILTIN_UPLOAD_PIPELINES[0];
    return {
      profileId: profile.id,
      profileName: profile.name,
      uploadPipeline: {
        manifest: pipelineManifest,
        configSummary: summarizePipelineConfig(pipeline.id, pipeline.config),
        lastRun: this.findLastRun(recentRuns, pipeline.id)
      },
      extensions: BUILTIN_EXTENSIONS.map((manifest) => ({
        manifest,
        enabled: enabled.has(manifest.id),
        configSummary: summarizeExtensionConfig(manifest, extensions.configs[manifest.id]),
        lastRun: this.findLastRun(recentRuns, manifest.id)
      }))
    };
  }
  getProfileStatus(profileId) {
    const status = this.getProjectCapabilityStatus(profileId);
    return {
      profileId: status.profileId,
      profileName: status.profileName,
      plugins: status.extensions
    };
  }
  listTaskRuns(taskId) {
    return getPluginRunRepo().listByTask(taskId);
  }
  findLastRun(runs, pluginId) {
    return runs.find((run) => run.pluginId === pluginId) || null;
  }
}
let instance$6 = null;
function getExtensionRuntimeService() {
  if (!instance$6) instance$6 = new ExtensionRuntimeService();
  return instance$6;
}
const MAX_LOG_LINES = 80;
function configSignature(config) {
  return JSON.stringify(config);
}
function createRuntime(profileId, profileName, signature) {
  return {
    profileId,
    profileName,
    signature,
    child: null,
    pid: null,
    startedAt: null,
    stoppedAt: null,
    exitCode: null,
    lastError: null,
    recentLogs: [],
    stopping: false
  };
}
class GenericConverterService extends events.EventEmitter {
  runtimes = /* @__PURE__ */ new Map();
  syncWithSettings() {
    const targets = this.listTargets();
    const targetIds = new Set(targets.map((target) => target.profile.id));
    for (const profileId of Array.from(this.runtimes.keys())) {
      if (!targetIds.has(profileId)) {
        this.stopProfile(profileId);
        this.runtimes.delete(profileId);
      }
    }
    for (const target of targets) {
      const signature = configSignature(target.config);
      const runtime = this.ensureRuntime(target.profile, signature);
      const previousSignature = runtime.signature;
      runtime.profileName = target.profile.name;
      if (!target.enabled || !target.configured) {
        runtime.signature = signature;
        this.stopProfile(target.profile.id);
        continue;
      }
      if (runtime.child && previousSignature === signature) continue;
      if (runtime.child && previousSignature !== signature) {
        this.stopProfile(target.profile.id);
      }
      runtime.signature = signature;
      this.startTarget(target, false);
    }
    return this.emitStatus();
  }
  getStatus() {
    const targets = this.listTargets();
    const profiles = targets.map((target) => this.statusForTarget(target));
    return { profiles };
  }
  startProfile(profileId) {
    const target = this.findTarget(profileId);
    if (!target) throw new Error("Profile 不存在");
    if (!target.extensionEnabled || !target.config.enabled) {
      throw new Error("通用转换工具未启用");
    }
    if (!target.configured) {
      throw new Error("通用转换工具配置不完整");
    }
    this.startTarget(target, false);
    return this.emitStatus();
  }
  stopProfile(profileId) {
    const runtime = this.runtimes.get(profileId);
    if (!runtime?.child) return this.emitStatus();
    runtime.stopping = true;
    this.appendLog(runtime, "[app] stopping converter monitor");
    this.terminateChild(runtime.child);
    runtime.child = null;
    runtime.pid = null;
    runtime.stoppedAt = (/* @__PURE__ */ new Date()).toISOString();
    return this.emitStatus();
  }
  scanNow(profileId) {
    const target = this.findTarget(profileId);
    if (!target) throw new Error("Profile 不存在");
    if (!target.extensionEnabled || !target.config.enabled) {
      throw new Error("通用转换工具未启用");
    }
    if (!target.configured) {
      throw new Error("通用转换工具配置不完整");
    }
    const runtime = this.ensureRuntime(target.profile, configSignature(target.config));
    if (runtime.child) {
      this.appendLog(runtime, "[app] monitor is already running; skip parallel scan-now");
      return this.emitStatus();
    }
    this.startTarget(target, true);
    return this.emitStatus();
  }
  stopAll() {
    for (const profileId of Array.from(this.runtimes.keys())) {
      this.stopProfile(profileId);
    }
  }
  listTargets() {
    const settings = getSettingsRepo().getAll();
    return settings.profiles.map((profile) => {
      const extensions = profile.extensions;
      const extensionEnabled = Boolean(
        extensions?.enabledIds?.includes(EXTENSION_IDS.GENERIC_CONVERTER)
      );
      const config = genericConverterConfigFromExtensions(extensions);
      const enabled = profile.enabled && extensionEnabled && config.enabled;
      const configured = Boolean(
        config.monitorScriptPath && config.dataRoot && config.outputRoot
      );
      return {
        profile,
        config,
        extensionEnabled,
        enabled,
        configured
      };
    });
  }
  findTarget(profileId) {
    return this.listTargets().find((target) => target.profile.id === profileId) || null;
  }
  ensureRuntime(profile, signature) {
    const existing = this.runtimes.get(profile.id);
    if (existing) return existing;
    const runtime = createRuntime(profile.id, profile.name, signature);
    this.runtimes.set(profile.id, runtime);
    return runtime;
  }
  startTarget(target, once) {
    const runtime = this.ensureRuntime(
      target.profile,
      configSignature(target.config)
    );
    if (runtime.child) return;
    const command = this.buildCommand(target.config, once);
    runtime.startedAt = (/* @__PURE__ */ new Date()).toISOString();
    runtime.stoppedAt = null;
    runtime.exitCode = null;
    runtime.lastError = null;
    runtime.stopping = false;
    this.appendLog(runtime, `[app] starting ${command.command} ${command.args.join(" ")}`);
    const child = child_process.spawn(command.command, command.args, {
      cwd: path.dirname(target.config.monitorScriptPath),
      env: command.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
    runtime.child = child;
    runtime.pid = child.pid ?? null;
    child.stdout.on("data", (chunk) => {
      if (runtime.child !== child) return;
      this.appendLog(runtime, String(chunk));
      if (String(chunk).includes("[monitor] converted")) {
        getScannerService().triggerScan();
      }
      this.emitStatus();
    });
    child.stderr.on("data", (chunk) => {
      if (runtime.child !== child) return;
      this.appendLog(runtime, String(chunk));
      this.emitStatus();
    });
    child.on("error", (error) => {
      if (runtime.child !== child) return;
      runtime.lastError = error.message;
      this.appendLog(runtime, `[error] ${error.message}`);
      log.error("通用转换工具启动失败:", error);
      this.emitStatus();
    });
    child.on("exit", (code, signal) => {
      if (runtime.child !== child) return;
      runtime.child = null;
      runtime.pid = null;
      runtime.exitCode = code;
      runtime.stoppedAt = (/* @__PURE__ */ new Date()).toISOString();
      if (!runtime.stopping && code !== 0) {
        runtime.lastError = signal ? `进程被信号 ${signal} 结束` : `进程退出码 ${code}`;
      }
      this.appendLog(runtime, `[app] exited code=${code ?? "-"} signal=${signal ?? "-"}`);
      this.emitStatus();
    });
  }
  buildCommand(rawConfig, once) {
    const config = normalizeGenericConverterConfig(rawConfig);
    const args = [
      config.monitorScriptPath,
      "--data-root",
      config.dataRoot,
      "--output-root",
      config.outputRoot,
      "--device-code",
      config.deviceCode,
      "--stable-seconds",
      String(config.stableSeconds),
      "--poll-interval",
      String(config.pollIntervalSeconds)
    ];
    if (config.retryFailed) args.push("--retry-failed");
    if (once) args.push("--once");
    args.push(...config.extraArgs.map((arg) => this.expandTemplate(arg, config)));
    const env = {
      ...process.env,
      ...config.env,
      GENERIC_CONVERTER_SCRIPT_PATH: config.converterScriptPath,
      GENERIC_CONVERTER_OUTPUT_DIRECTORY_TEMPLATE: config.outputDirectoryTemplate,
      GENERIC_CONVERTER_OUTPUT_BATCH_NAME_TEMPLATE: config.outputBatchNameTemplate,
      GENERIC_CONVERTER_OUTPUT_FILE_NAME_TEMPLATE: config.outputFileNameTemplate,
      GENERIC_CONVERTER_OUTPUT_BATCH_NAME_PATTERN: config.outputBatchNamePattern
    };
    if (config.converterScriptPath) {
      env.COVER_MCAP_CONVERTER_SCRIPT = config.converterScriptPath;
    }
    return {
      command: config.pythonPath || "python3",
      args,
      env
    };
  }
  expandTemplate(arg, config) {
    return arg.replace(/\{dataRoot\}/g, config.dataRoot).replace(/\{outputRoot\}/g, config.outputRoot).replace(/\{deviceCode\}/g, config.deviceCode).replace(/\{stableSeconds\}/g, String(config.stableSeconds)).replace(/\{pollIntervalSeconds\}/g, String(config.pollIntervalSeconds)).replace(/\{monitorScriptPath\}/g, config.monitorScriptPath).replace(/\{converterScriptPath\}/g, config.converterScriptPath).replace(/\{outputDirectoryTemplate\}/g, config.outputDirectoryTemplate).replace(/\{outputBatchNameTemplate\}/g, config.outputBatchNameTemplate).replace(/\{outputFileNameTemplate\}/g, config.outputFileNameTemplate).replace(/\{outputBatchNamePattern\}/g, config.outputBatchNamePattern);
  }
  statusForTarget(target) {
    const runtime = this.runtimes.get(target.profile.id);
    const child = runtime?.child || null;
    const state = !target.extensionEnabled || !target.config.enabled ? "disabled" : child ? "running" : runtime?.lastError ? "failed" : "stopped";
    return {
      profileId: target.profile.id,
      profileName: target.profile.name,
      enabled: target.enabled,
      configured: target.configured,
      running: Boolean(child),
      pid: runtime?.pid || null,
      startedAt: runtime?.startedAt || null,
      stoppedAt: runtime?.stoppedAt || null,
      exitCode: runtime?.exitCode ?? null,
      lastError: runtime?.lastError || null,
      dataRoot: target.config.dataRoot,
      outputRoot: target.config.outputRoot,
      monitorScriptPath: target.config.monitorScriptPath,
      recentLogs: runtime?.recentLogs || [],
      state
    };
  }
  appendLog(runtime, text) {
    const lines = text.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
    runtime.recentLogs.push(...lines);
    if (runtime.recentLogs.length > MAX_LOG_LINES) {
      runtime.recentLogs.splice(0, runtime.recentLogs.length - MAX_LOG_LINES);
    }
  }
  terminateChild(child) {
    try {
      if (process.platform !== "win32" && child.pid) {
        process.kill(-child.pid, "SIGTERM");
      } else {
        child.kill("SIGTERM");
      }
    } catch {
      child.kill("SIGTERM");
    }
  }
  emitStatus() {
    const status = this.getStatus();
    this.emit("generic-converter:event", status);
    this.emit("status", status);
    return status;
  }
}
let instance$5 = null;
function getGenericConverterService() {
  if (!instance$5) instance$5 = new GenericConverterService();
  return instance$5;
}
function shouldRestartScannerAfterSettingsSave(data) {
  return data.scan !== void 0 || data.stability !== void 0 || data.profiles !== void 0 || data.activeProfileId !== void 0;
}
function rowToSSHMachine(row) {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    username: row.username,
    authType: row.auth_type,
    privateKeyPath: row.private_key_path || null,
    remoteDir: row.remote_dir,
    localDir: row.local_dir,
    bwLimit: row.bw_limit,
    cpuNice: row.cpu_nice,
    transferMode: row.transfer_mode || "rsync",
    profileId: row.profile_id || null,
    enabled: Boolean(row.enabled),
    lastSyncAt: row.last_sync_at || null,
    createdAt: row.created_at
  };
}
function registerAllIpc() {
  function broadcastStatusChange(taskId, newStatus) {
    for (const win of electron.BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.TASK_STATUS_CHANGE, { taskId, newStatus });
    }
  }
  electron.ipcMain.handle(IPC.TASK_LIST, (_event, args) => {
    return getTaskRepo().listByQuery(args);
  });
  electron.ipcMain.handle(IPC.TASK_GET, (_event, args) => {
    return getTaskRepo().getById(args.taskId);
  });
  electron.ipcMain.handle(IPC.TASK_DETAIL, (_event, args) => {
    const task = getTaskRepo().getById(args.taskId);
    if (!task) throw new Error("任务不存在");
    return {
      task,
      files: getTaskRepo().listFileDetails(args.taskId)
    };
  });
  electron.ipcMain.handle(IPC.TASK_ADD_FOLDER, (_event, args) => {
    const taskRepo = getTaskRepo();
    const settingsRepo = getSettingsRepo();
    const settings = settingsRepo.getAll();
    const profile = getProfileById(settings, args.profileId);
    const variables = extractProfilePathVariables(
      profile,
      args.folderPath,
      path.dirname(args.folderPath)
    );
    const snapshot = resolveProfileUploadSnapshot(profile, {
      sourcePath: args.folderPath,
      variables
    });
    const folderName = path.basename(args.folderPath);
    const task = taskRepo.create({
      folderPath: args.folderPath,
      folderName,
      ossPrefix: snapshot.prefixes.aliyun,
      uploadTargetMode: snapshot.mode,
      destinationPrefixes: snapshot.prefixes,
      destinationUploadRelativePaths: snapshot.uploadRelativePaths,
      destinationPathModes: snapshot.pathModes,
      destinationObjectKeyTemplates: snapshot.objectKeyTemplates,
      uploadRelativePath: snapshot.uploadRelativePath,
      sourceType: "manual",
      profileId: snapshot.profileId,
      profileName: snapshot.profileName,
      profileSnapshot: snapshot.profileSnapshot,
      groupVariables: variables
    });
    getScannerService().queueReconcileTask(task);
    return getTaskRepo().getById(task.id);
  });
  electron.ipcMain.handle(IPC.TASK_PAUSE, (_event, args) => {
    getTaskQueueService().cancelRunningTask(args.taskId);
    getTaskRepo().updateStatus(args.taskId, "paused");
    getTaskDestinationRepo().updateIncompleteStatuses(args.taskId, "paused");
    getDayFolderService().refreshForTask(args.taskId);
    broadcastStatusChange(args.taskId, "paused");
  });
  electron.ipcMain.handle(IPC.TASK_RESUME, (_event, args) => {
    getTaskRepo().retry(args.taskId);
    getDayFolderService().refreshForTask(args.taskId);
    broadcastStatusChange(args.taskId, "pending");
  });
  electron.ipcMain.handle(IPC.TASK_CANCEL, (_event, args) => {
    getTaskQueueService().cancelRunningTask(args.taskId);
    getTaskRepo().skip(args.taskId, "用户跳过");
    getDayFolderService().refreshForTask(args.taskId);
    broadcastStatusChange(args.taskId, "skipped");
  });
  electron.ipcMain.handle(IPC.TASK_SKIP, (_event, args) => {
    getTaskQueueService().cancelRunningTask(args.taskId);
    getTaskRepo().skip(args.taskId, "用户跳过");
    getDayFolderService().refreshForTask(args.taskId);
    broadcastStatusChange(args.taskId, "skipped");
  });
  electron.ipcMain.handle(IPC.TASK_RESTORE, (_event, args) => {
    const task = getTaskRepo().getById(args.taskId);
    if (!task) throw new Error("任务不存在");
    if (!fs.existsSync(task.folderPath)) throw new Error("源目录不存在，无法恢复");
    getTaskRepo().restore(args.taskId);
    const restored = getTaskRepo().getById(args.taskId);
    if (restored) getScannerService().queueReconcileTask(restored);
    getDayFolderService().refreshForTask(args.taskId);
    broadcastStatusChange(args.taskId, "scanning");
  });
  electron.ipcMain.handle(IPC.TASK_RETRY, (_event, args) => {
    getTaskRepo().retry(args.taskId, args.provider);
    getDayFolderService().refreshForTask(args.taskId);
    broadcastStatusChange(args.taskId, "pending");
  });
  electron.ipcMain.handle(IPC.UPLOAD_QUEUE_STATUS, () => {
    return getTaskQueueService().getStatus();
  });
  electron.ipcMain.handle(IPC.UPLOAD_QUEUE_START, (_event, args) => {
    return getTaskQueueService().startUploading(args);
  });
  electron.ipcMain.handle(IPC.UPLOAD_QUEUE_STOP, (_event, args) => {
    return getTaskQueueService().stopUploading(args);
  });
  electron.ipcMain.handle(IPC.SCANNER_STATUS, () => {
    return getScannerService().getStatus();
  });
  electron.ipcMain.handle(IPC.SCANNER_TRIGGER, () => {
    getScannerService().triggerScan();
  });
  electron.ipcMain.handle(IPC.SCANNER_START, () => {
    getScannerService().start();
  });
  electron.ipcMain.handle(IPC.SCANNER_STOP, () => {
    getScannerService().stop();
  });
  electron.ipcMain.handle(IPC.DAY_FOLDER_LIST, (_event, query) => {
    return getDayFolderRepo().list(query);
  });
  electron.ipcMain.handle(IPC.DAY_FOLDER_DELETE, (_event, args) => {
    getDayFolderRepo().deleteCompleted(args.id, args.provider);
  });
  electron.ipcMain.handle(IPC.DAY_FOLDER_IGNORE, (_event, args) => {
    const repo = getDayFolderRepo();
    repo.setIgnored(args.id, true);
    for (const task of repo.getChildTasks(args.id)) {
      if (task.status === "completed" || task.status === "synced") continue;
      getTaskQueueService().cancelRunningTask(task.id);
      getTaskRepo().skip(task.id, "用户忽略整个日期");
      broadcastStatusChange(task.id, "skipped");
    }
    return getDayFolderService().refresh(args.id);
  });
  electron.ipcMain.handle(IPC.DAY_FOLDER_RESTORE, (_event, args) => {
    const repo = getDayFolderRepo();
    repo.setIgnored(args.id, false);
    for (const task of repo.getChildTasks(args.id)) {
      if (task.status !== "skipped" || !fs.existsSync(task.folderPath)) continue;
      getTaskRepo().restore(task.id);
      const restored = getTaskRepo().getById(task.id);
      if (restored) getScannerService().queueReconcileTask(restored);
      broadcastStatusChange(task.id, "scanning");
    }
    return getDayFolderService().refresh(args.id);
  });
  electron.ipcMain.handle(IPC.SETTINGS_GET_ALL, () => {
    return getSettingsRepo().getAll();
  });
  electron.ipcMain.handle(IPC.SETTINGS_SAVE, (_event, data) => {
    getSettingsRepo().saveAll(data);
    if (data.cleanup !== void 0) {
      getCleanupService().scheduleCleanup();
    }
    if (shouldRestartScannerAfterSettingsSave(data)) {
      getScannerService().stop();
      getScannerService().start();
    }
    getGenericConverterService().syncWithSettings();
    return { ok: true };
  });
  electron.ipcMain.handle(IPC.SETTINGS_TEST_OSS, async (_event, config) => {
    return getOSSUploadService().testConnection(config);
  });
  electron.ipcMain.handle(
    IPC.SETTINGS_TEST_TENCENT_S3,
    async (_event, config) => {
      return getTencentS3UploadService().testConnection(config);
    }
  );
  electron.ipcMain.handle(
    IPC.UPLOAD_PATH_PREVIEW,
    (_event, args) => {
      const settings = getSettingsRepo().getAll();
      const profile = getProfileById(settings, args.profileId);
      const folderName = path.basename(args.sourcePath);
      const variables = extractProfilePathVariables(
        profile,
        args.sourcePath,
        path.dirname(args.sourcePath)
      );
      const context = {
        sourcePath: args.sourcePath,
        basePath: path.dirname(args.sourcePath),
        variables
      };
      const requestedProviders = args.provider ? [args.provider] : void 0;
      const snapshot = resolveProfileUploadSnapshot(
        profile,
        context,
        requestedProviders
      );
      const sampleFiles = (args.sampleFiles?.length ? args.sampleFiles : ["camera/0001.jpg", "data/sample.csv"]).slice(0, 20);
      return {
        profileId: profile.id,
        profileName: profile.name,
        sourcePath: args.sourcePath,
        providers: Object.keys(snapshot.pathModes || {}).map((providerKey) => {
          const provider = providerKey;
          const pathMode = snapshot.pathModes?.[provider] || "target-root";
          const objectKeyTemplate = snapshot.objectKeyTemplates?.[provider] ?? null;
          const errors = objectKeyTemplate ? [...validateObjectKeyTemplate(objectKeyTemplate)] : [];
          const keys = [];
          for (const relativePath of sampleFiles) {
            try {
              const key = renderObjectKey(
                {
                  provider,
                  prefix: snapshot.prefixes[provider],
                  uploadRelativePath: snapshot.uploadRelativePaths[provider] ?? "",
                  pathMode,
                  objectKeyTemplate
                },
                {
                  ...context,
                  profileId: profile.id,
                  profileName: profile.name,
                  folderName,
                  relativePath
                }
              );
              const valueErrors = validateObjectKeyValue(key);
              if (valueErrors.length > 0) errors.push(...valueErrors);
              keys.push(key);
            } catch (error) {
              errors.push(error instanceof Error ? error.message : String(error));
            }
          }
          const duplicateKeys = keys.filter(
            (key, index) => keys.indexOf(key) !== index
          );
          const warnings = duplicateKeys.length > 0 ? [`存在重复对象 Key: ${Array.from(new Set(duplicateKeys)).join(", ")}`] : [];
          return {
            provider,
            prefix: snapshot.prefixes[provider],
            uploadRelativePath: snapshot.uploadRelativePaths[provider] ?? "",
            pathMode,
            objectKeyTemplate,
            variables: buildObjectKeyVariables(provider, {
              ...context,
              profileId: profile.id,
              profileName: profile.name,
              folderName,
              relativePath: sampleFiles[0] || ""
            }),
            keys,
            errors: Array.from(new Set(errors)),
            warnings
          };
        })
      };
    }
  );
  electron.ipcMain.handle(IPC.CAPABILITY_LIST, () => {
    return getExtensionRuntimeService().listCapabilities();
  });
  electron.ipcMain.handle(IPC.CAPABILITY_PROFILE_STATUS, (_event, args) => {
    return getExtensionRuntimeService().getProjectCapabilityStatus(args?.profileId);
  });
  electron.ipcMain.handle(IPC.CAPABILITY_TASK_RUNS, (_event, args) => {
    return getExtensionRuntimeService().listTaskRuns(args.taskId);
  });
  electron.ipcMain.handle(IPC.PLUGIN_LIST, () => {
    return getExtensionRuntimeService().listManifests();
  });
  electron.ipcMain.handle(IPC.PLUGIN_PROFILE_STATUS, (_event, args) => {
    return getExtensionRuntimeService().getProfileStatus(args?.profileId);
  });
  electron.ipcMain.handle(IPC.PLUGIN_TASK_RUNS, (_event, args) => {
    return getExtensionRuntimeService().listTaskRuns(args.taskId);
  });
  electron.ipcMain.handle(IPC.OSS_BROWSER_LIST, async (_event, args) => {
    return getOSSBrowserService().list(args?.prefix, args?.continuationToken, args?.maxKeys);
  });
  electron.ipcMain.handle(IPC.OSS_BROWSER_HEAD, async (_event, args) => {
    return getOSSBrowserService().head(args.key);
  });
  electron.ipcMain.handle(IPC.OSS_BROWSER_GET_IMAGE, async (_event, args) => {
    return getOSSBrowserService().getImagePreview(args.key, args.maxBytes);
  });
  electron.ipcMain.handle(IPC.OSS_BROWSER_OPEN_PREVIEW_WINDOW, (_event, args) => {
    createOSSPreviewWindow(args.key);
  });
  electron.ipcMain.handle(IPC.GENERIC_CONVERTER_STATUS, () => {
    return getGenericConverterService().getStatus();
  });
  electron.ipcMain.handle(IPC.GENERIC_CONVERTER_START, async (_event, args) => {
    return getGenericConverterService().startProfile(args.profileId);
  });
  electron.ipcMain.handle(IPC.GENERIC_CONVERTER_STOP, (_event, args) => {
    return getGenericConverterService().stopProfile(args.profileId);
  });
  electron.ipcMain.handle(IPC.GENERIC_CONVERTER_SCAN_NOW, async (_event, args) => {
    return getGenericConverterService().scanNow(args.profileId);
  });
  electron.ipcMain.handle(IPC.SSH_LIST_MACHINES, () => {
    const db2 = getDb();
    const rows = db2.prepare("SELECT * FROM ssh_machines ORDER BY created_at DESC").all();
    return rows.map(rowToSSHMachine);
  });
  electron.ipcMain.handle(IPC.SSH_ADD_MACHINE, (_event, input) => {
    const db2 = getDb();
    const id = uuid.v4();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const profileId = input.profileId || getSettingsRepo().getAll().activeProfileId;
    db2.prepare(
      `INSERT INTO ssh_machines (id, name, host, port, username, auth_type, private_key_path, encrypted_password, remote_dir, local_dir, bw_limit, cpu_nice, transfer_mode, profile_id, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, input.name, input.host, input.port, input.username, input.authType, input.privateKeyPath || null, input.password || null, input.remoteDir, input.localDir, input.bwLimit, input.cpuNice, input.transferMode || "rsync", profileId, input.enabled ? 1 : 0, now);
    const row = db2.prepare("SELECT * FROM ssh_machines WHERE id = ?").get(id);
    return rowToSSHMachine(row);
  });
  electron.ipcMain.handle(IPC.SSH_UPDATE_MACHINE, (_event, machine) => {
    const db2 = getDb();
    db2.prepare(
      `UPDATE ssh_machines SET name=?, host=?, port=?, username=?, auth_type=?, private_key_path=?, remote_dir=?, local_dir=?, bw_limit=?, cpu_nice=?, transfer_mode=?, profile_id=?, enabled=? WHERE id=?`
    ).run(machine.name, machine.host, machine.port, machine.username, machine.authType, machine.privateKeyPath, machine.remoteDir, machine.localDir, machine.bwLimit, machine.cpuNice, machine.transferMode || "rsync", machine.profileId || null, machine.enabled ? 1 : 0, machine.id);
  });
  electron.ipcMain.handle(IPC.SSH_DELETE_MACHINE, (_event, args) => {
    const db2 = getDb();
    db2.prepare("DELETE FROM ssh_machines WHERE id = ?").run(args.id);
  });
  electron.ipcMain.handle(IPC.SSH_TEST_CONNECTION, async (_event, args) => {
    const db2 = getDb();
    const row = db2.prepare("SELECT * FROM ssh_machines WHERE id = ?").get(args.id);
    if (!row) return { ok: false, error: "机器不存在" };
    const machine = rowToSSHMachine(row);
    const password = row.encrypted_password || void 0;
    return getSSHRsyncService().testConnection(machine, password);
  });
  electron.ipcMain.handle(IPC.RSYNC_START, async (_event, args) => {
    const db2 = getDb();
    const row = db2.prepare("SELECT * FROM ssh_machines WHERE id = ?").get(args.machineId);
    if (!row) throw new Error("机器不存在");
    const machine = rowToSSHMachine(row);
    const password = row.encrypted_password || void 0;
    try {
      await getSSHRsyncService().startRsync(machine, password, (progress) => {
        for (const win of electron.BrowserWindow.getAllWindows()) {
          win.webContents.send(IPC.RSYNC_PROGRESS, progress);
        }
      });
      db2.prepare("UPDATE ssh_machines SET last_sync_at = ? WHERE id = ?").run((/* @__PURE__ */ new Date()).toISOString(), args.machineId);
      const taskRepo = getTaskRepo();
      const settingsRepo = getSettingsRepo();
      const settings = settingsRepo.getAll();
      const profile = getProfileById(settings, machine.profileId);
      const localDir = path.normalize(machine.localDir).replace(/[\\/]+$/, "");
      const variables = extractProfilePathVariables(
        profile,
        machine.remoteDir,
        path.dirname(machine.remoteDir)
      );
      const snapshot = resolveProfileUploadSnapshot(profile, {
        sourcePath: machine.remoteDir,
        fallbackDirectoryPath: localDir,
        variables
      });
      const existing = taskRepo.getByFolderPath(localDir);
      let markerMode = snapshot.mode;
      let markerPrefixes = snapshot.prefixes;
      let markerUploadRelativePath = snapshot.uploadRelativePath;
      let markerUploadRelativePaths = snapshot.uploadRelativePaths;
      let markerPathModes = snapshot.pathModes;
      let markerObjectKeyTemplates = snapshot.objectKeyTemplates;
      let markerProfileId = snapshot.profileId;
      let markerProfileName = snapshot.profileName;
      let markerProfileSnapshot = snapshot.profileSnapshot;
      if (!existing || existing.status === "completed" || existing.status === "failed") {
        const task = taskRepo.create({
          folderPath: localDir,
          folderName: path.basename(localDir),
          ossPrefix: snapshot.prefixes.aliyun,
          uploadTargetMode: snapshot.mode,
          destinationPrefixes: snapshot.prefixes,
          destinationUploadRelativePaths: snapshot.uploadRelativePaths,
          destinationPathModes: snapshot.pathModes,
          destinationObjectKeyTemplates: snapshot.objectKeyTemplates,
          uploadRelativePath: snapshot.uploadRelativePath,
          sourceType: "rsync",
          sourceMachineId: machine.id,
          profileId: snapshot.profileId,
          profileName: snapshot.profileName,
          profileSnapshot: snapshot.profileSnapshot,
          groupVariables: variables
        });
        getScannerService().queueReconcileTask(task);
        log.info("rsync 完成, 自动创建上传任务:", localDir);
      } else {
        const current = taskRepo.getById(existing.id) || existing;
        markerMode = current.uploadTargetMode;
        markerPrefixes = {
          aliyun: current.destinations.find((item) => item.provider === "aliyun")?.prefix || "",
          tencent: current.destinations.find((item) => item.provider === "tencent")?.prefix || ""
        };
        markerUploadRelativePaths = Object.fromEntries(
          current.destinations.map((destination) => [
            destination.provider,
            destination.uploadRelativePath
          ])
        );
        markerPathModes = Object.fromEntries(
          current.destinations.map((destination) => [
            destination.provider,
            destination.pathMode
          ])
        );
        markerObjectKeyTemplates = Object.fromEntries(
          current.destinations.map((destination) => [
            destination.provider,
            destination.objectKeyTemplate
          ])
        );
        markerUploadRelativePath = current.uploadRelativePath;
        markerProfileId = current.profileId || void 0;
        markerProfileName = current.profileName || void 0;
        markerProfileSnapshot = current.profileSnapshot || void 0;
      }
      writeTmpUpload(localDir, {
        version: 2,
        createdAt: (/* @__PURE__ */ new Date()).toISOString(),
        folderPath: localDir,
        metadata: {
          source: "rsync",
          machineId: machine.id,
          uploadRelativePath: markerUploadRelativePath,
          uploadTargetMode: markerMode,
          profileId: markerProfileId,
          profileName: markerProfileName,
          profileSnapshot: markerProfileSnapshot,
          groupVariables: variables,
          destinationPrefixes: markerPrefixes,
          destinationUploadRelativePaths: markerUploadRelativePaths,
          destinationPathModes: markerPathModes,
          destinationObjectKeyTemplates: markerObjectKeyTemplates
        }
      });
    } catch (err) {
      log.error("rsync 失败:", err);
      throw err;
    }
  });
  electron.ipcMain.handle(IPC.RSYNC_STOP, (_event, args) => {
    getSSHRsyncService().stopRsync(args.machineId);
  });
  electron.ipcMain.handle(IPC.HISTORY_LIST, (_event, query) => {
    return getHistoryRepo().list(query);
  });
  electron.ipcMain.handle(IPC.HISTORY_CLEAR, (_event, args) => {
    getHistoryRepo().clear(args?.before, args?.provider);
    getDayFolderRepo().clearCompleted(args?.before, args?.provider);
  });
  electron.ipcMain.handle(IPC.HISTORY_DELETE, (_event, args) => {
    getHistoryRepo().deleteById(args.id, args.provider);
  });
  electron.ipcMain.handle(IPC.DIALOG_SELECT_FOLDER, async () => {
    const win = getMainWindow();
    if (!win) return null;
    const result = await electron.dialog.showOpenDialog(win, {
      properties: ["openDirectory"]
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });
  electron.ipcMain.handle(IPC.DIALOG_SELECT_DIRECTORY, async () => {
    const win = getMainWindow();
    if (!win) return null;
    const result = await electron.dialog.showOpenDialog(win, {
      properties: ["openDirectory"]
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });
  electron.ipcMain.handle(IPC.SFTP_START, async (_event, args) => {
    const db2 = getDb();
    const row = db2.prepare("SELECT * FROM ssh_machines WHERE id = ?").get(args.machineId);
    if (!row) throw new Error("机器不存在");
    const machine = rowToSSHMachine(row);
    const password = row.encrypted_password || void 0;
    const settings = getSettingsRepo().getAll();
    try {
      const result = await getSSHRsyncService().sftpStreamToCloud(
        machine,
        password,
        settings,
        (progress) => {
          for (const win of electron.BrowserWindow.getAllWindows()) {
            win.webContents.send(IPC.SFTP_PROGRESS, progress);
          }
        }
      );
      db2.prepare("UPDATE ssh_machines SET last_sync_at = ? WHERE id = ?").run((/* @__PURE__ */ new Date()).toISOString(), args.machineId);
      return result;
    } catch (err) {
      log.error("SFTP 直传失败:", err);
      throw err;
    }
  });
  electron.ipcMain.handle(IPC.SFTP_STOP, (_event, args) => {
    getSSHRsyncService().stopRsync(args.machineId);
  });
  electron.ipcMain.handle(IPC.DATA_COLLECT_LIST, () => {
    return getDataCollectService().getAll();
  });
  electron.ipcMain.handle(IPC.DATA_COLLECT_RUN, (_event, args) => {
    const result = getDataCollectService().collectDataInfo(args.folderPath);
    if (result) {
      for (const win of electron.BrowserWindow.getAllWindows()) {
        win.webContents.send(IPC.DATA_COLLECT_RESULT, result);
      }
    }
    return result;
  });
  electron.ipcMain.handle(IPC.DISK_USAGE, async () => {
    const settingsRepo = getSettingsRepo();
    const scanConfig = settingsRepo.getAll().scan;
    const db2 = getDb();
    const paths = /* @__PURE__ */ new Set();
    if (scanConfig?.directories) {
      for (const d of scanConfig.directories) paths.add(path.normalize(d).replace(/[\\/]+$/, ""));
    }
    const sshRows = db2.prepare("SELECT local_dir FROM ssh_machines WHERE enabled = 1").all();
    for (const r of sshRows) {
      paths.add(path.normalize(r.local_dir).replace(/[\\/]+$/, ""));
    }
    const results = [];
    for (const p of paths) {
      try {
        if (!fs.existsSync(p)) continue;
        const stats = await promises.statfs(p);
        const totalBytes = stats.bsize * stats.blocks;
        const freeBytes = stats.bsize * stats.bavail;
        const usedBytes = totalBytes - freeBytes;
        const usagePercent = totalBytes > 0 ? Math.round(usedBytes / totalBytes * 100) : 0;
        results.push({ path: p, totalBytes, freeBytes, usedBytes, usagePercent });
      } catch (err) {
        log.warn("获取磁盘用量失败:", p, err);
      }
    }
    return results;
  });
}
function normalizePath(p) {
  return p.replace(/\\/g, "/");
}
async function walkFiles(dirPath) {
  const entries = await promises.readdir(dirPath, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const abs = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      result.push(...await walkFiles(abs));
      continue;
    }
    if (!entry.isFile()) continue;
    const fileStat = await promises.stat(abs);
    result.push({
      filePath: abs,
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs
    });
  }
  return result;
}
class Module1ManifestService {
  async build(rootPath, infos, stationPrefix = "station2") {
    const manifest = [];
    for (const info of infos) {
      const files = await walkFiles(info.fullPath);
      for (const file of files) {
        const relInFolder = normalizePath(path.relative(info.fullPath, file.filePath));
        const localRelativePath = normalizePath(path.relative(rootPath, file.filePath));
        const ossKey = normalizePath(
          [stationPrefix, info.type1, info.type2, info.date, info.folderName, relInFolder].filter(Boolean).join("/")
        ).replace(/\/+/g, "/");
        manifest.push({
          localRelativePath,
          ossKey,
          fileSize: file.size,
          mtimeMs: file.mtimeMs
        });
      }
    }
    return manifest;
  }
}
let instance$4 = null;
function getModule1ManifestService() {
  if (!instance$4) instance$4 = new Module1ManifestService();
  return instance$4;
}
const MANIFEST_FILE = ".module1-manifest.json";
function formatDate(d) {
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${day}`;
}
async function getFileDate(filePath) {
  try {
    const fileStat = await promises.stat(filePath);
    return formatDate(fileStat.mtime);
  } catch {
    return null;
  }
}
function extractTagValues(xml, tagName) {
  const re = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "gi");
  const values = [];
  let match;
  while ((match = re.exec(xml)) !== null) {
    values.push(String(match[1]).trim());
  }
  return values;
}
function normalizeStationPrefix(value) {
  if (typeof value !== "string") return "station2";
  const normalized = value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").trim();
  return normalized || "station2";
}
function getPluginWorkspaceRoot() {
  const electronApp2 = electron.app;
  return electronApp2?.getPath?.("userData") || path.join(os.tmpdir(), "ts-upload-plugin-workspaces");
}
class Module1PreUploadService {
  async run(task, rawConfig) {
    if (!fs.existsSync(task.folderPath)) {
      throw new Error("源目录不存在，无法执行 Module1 上传前处理");
    }
    const config = typeof rawConfig === "object" && rawConfig !== null ? rawConfig : {};
    const stationPrefix = normalizeStationPrefix(config.stationPrefix);
    const stagingRootPath = path.join(
      getPluginWorkspaceRoot(),
      "plugin-workspaces",
      task.id,
      "module1"
    );
    await promises.rm(stagingRootPath, { recursive: true, force: true });
    await promises.mkdir(stagingRootPath, { recursive: true });
    await promises.cp(task.folderPath, stagingRootPath, {
      recursive: true,
      force: true,
      errorOnExist: false
    });
    await this.processDataFolders(stagingRootPath);
    const fileInfos = await this.splitType(stagingRootPath);
    const manifest = await getModule1ManifestService().build(
      stagingRootPath,
      fileInfos,
      stationPrefix
    );
    if (manifest.length === 0) {
      throw new Error("Module1 筛选结果为空：未找到包含 annotation/segment_timestamps.xml 的有效数据目录");
    }
    const payload = {
      version: 1,
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      sourceRootPath: task.folderPath,
      stagingRootPath,
      manifest
    };
    await promises.writeFile(
      path.join(stagingRootPath, MANIFEST_FILE),
      JSON.stringify(payload, null, 2),
      "utf-8"
    );
    const totalBytes = manifest.reduce((sum, item) => sum + item.fileSize, 0);
    return {
      pipelineId: UPLOAD_PIPELINE_IDS.SANY_MODULE1_UPLOAD,
      uploadRootPath: stagingRootPath,
      requiredStableChecks: 1,
      files: manifest.map((item) => ({
        relativePath: item.localRelativePath,
        fileSize: item.fileSize,
        mtimeMs: item.mtimeMs,
        plannedObjectKey: item.ossKey
      })),
      summary: {
        sourceRootPath: task.folderPath,
        stagingRootPath,
        files: manifest.length,
        totalBytes,
        stationPrefix
      },
      artifacts: {
        manifestPath: path.join(stagingRootPath, MANIFEST_FILE)
      }
    };
  }
  async processDataFolders(rootPath) {
    const entries = await promises.readdir(rootPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const folderPath = path.join(rootPath, entry.name);
      const weldSignalPath = path.join(folderPath, "welding_state", "weld_signal.csv");
      if (!fs.existsSync(weldSignalPath)) continue;
      const { startTime, endTime } = await this.readWeldSignal(weldSignalPath);
      if (startTime === null || endTime === null) continue;
      const startRange = startTime - 5e6;
      const endRange = endTime + 5e6;
      const subNames = await promises.readdir(folderPath);
      for (const subName of subNames) {
        if (!subName.includes("camera_0")) continue;
        const cameraPath = path.join(folderPath, subName);
        if (!fs.existsSync(cameraPath)) continue;
        await this.cleanImages(cameraPath, startRange, endRange);
      }
    }
  }
  async readWeldSignal(filePath) {
    let startTime = null;
    let endTime = null;
    const strictPattern = /^\s*(\d+)\s+[^:]*:\s*(true|false)\s*$/i;
    try {
      const text = await promises.readFile(filePath, "utf-8");
      const lines = text.split(/\r?\n/);
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        let ts = null;
        let isTrue = null;
        const strict = strictPattern.exec(line);
        if (strict) {
          ts = Number(strict[1]);
          isTrue = strict[2].toLowerCase() === "true";
        } else {
          const tsMatch = line.match(/(\d+)/);
          const boolMatch = line.match(/(true|false)/i);
          if (!tsMatch || !boolMatch) continue;
          ts = Number(tsMatch[1]);
          isTrue = boolMatch[1].toLowerCase() === "true";
        }
        if (!Number.isFinite(ts) || isTrue === null) continue;
        if (isTrue && startTime === null) startTime = ts;
        if (!isTrue) endTime = ts;
      }
    } catch {
      return { startTime: null, endTime: null };
    }
    return { startTime, endTime };
  }
  async cleanImages(folderPath, startRange, endRange) {
    let deletedCount = 0;
    const filenames = await promises.readdir(folderPath);
    for (const filename of filenames) {
      if (!filename.toLowerCase().endsWith(".jpg")) continue;
      const abs = path.join(folderPath, filename);
      try {
        const stem = filename.slice(0, -4);
        const ts = Number(stem);
        if (!Number.isFinite(ts)) {
          log.warn(`文件名 ${filename} 不包含有效时间戳，已跳过`);
          continue;
        }
        if (ts >= startRange && ts <= endRange) continue;
        await promises.rm(abs, { force: true });
        deletedCount++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`删除文件 ${filename} 时出错: ${msg}`);
      }
    }
    log.info(`Module1 staging 在 ${path.basename(folderPath)} 中删除了 ${deletedCount} 个文件`);
  }
  async splitType(rootPath) {
    const originalDirs = (await promises.readdir(rootPath, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    await this.createProjectStructure(rootPath);
    const infos = [];
    for (const dirName of originalDirs) {
      const fullPath = path.join(rootPath, dirName);
      const xmlPath = path.join(fullPath, "annotation", "segment_timestamps.xml");
      if (!fs.existsSync(xmlPath)) continue;
      let type1 = "unknown";
      let type2 = "";
      let failed = false;
      let specMin = 0;
      let specMax = 0;
      let dataType = "";
      let qualityType = "";
      try {
        const xml = await promises.readFile(xmlPath, "utf-8");
        const minValues = extractTagValues(xml, "data_spec_min");
        const maxValues = extractTagValues(xml, "data_spec_max");
        const dataTypeValues = extractTagValues(xml, "data_type");
        const qualityValues = extractTagValues(xml, "quality_type");
        if (minValues.length !== 1 || maxValues.length !== 1 || dataTypeValues.length !== 1 || qualityValues.length !== 1) {
          failed = true;
        } else {
          specMin = Number(minValues[0]);
          specMax = Number(maxValues[0]);
          dataType = dataTypeValues[0];
          qualityType = qualityValues[0];
          if (!Number.isFinite(specMin) || !Number.isFinite(specMax)) failed = true;
        }
      } catch {
        failed = true;
      }
      if (!failed) {
        if (qualityType === "bad") type1 = "RL";
        else if (dataType.includes("teleop")) type1 = "teleop";
        else type1 = "vla";
        type2 = specMin === specMax ? `${specMin}mm` : `${specMin}-${specMax}mm`;
      }
      const stateTypePath = path.join(fullPath, "state_type");
      const date = await getFileDate(stateTypePath);
      infos.push({
        fullPath,
        folderName: path.basename(fullPath),
        type1,
        type2,
        date
      });
    }
    log.info("Module1 split 完成, fileInfo 数量:", infos.length);
    return infos;
  }
  async createProjectStructure(rootPath) {
    const structure = {
      vla: ["1mm", "1-2mm", "2mm", "3mm"],
      teleop: ["1mm", "1-2mm", "2mm", "3mm"],
      RL: ["1mm", "1-2mm", "2mm", "3mm"],
      unknown: []
    };
    for (const [top, subs] of Object.entries(structure)) {
      const topDir = path.join(rootPath, top);
      await promises.mkdir(topDir, { recursive: true });
      for (const sub of subs) {
        await promises.mkdir(path.join(topDir, sub), { recursive: true });
      }
    }
  }
}
let instance$3 = null;
function getModule1PreUploadService() {
  if (!instance$3) instance$3 = new Module1PreUploadService();
  return instance$3;
}
class UploadPipelineRuntimeService {
  listManifests() {
    return BUILTIN_UPLOAD_PIPELINES;
  }
  async prepareUploadPlan(task, sourceStableChecks) {
    const pipeline = normalizeProfileUploadPipeline(
      task.profileSnapshot?.uploadPipeline,
      task.profileSnapshot?.plugins
    );
    const run = getPluginRunRepo().start(task.id, pipeline.id, "pipeline");
    try {
      const result = pipeline.id === UPLOAD_PIPELINE_IDS.SANY_MODULE1_UPLOAD ? await getModule1PreUploadService().run(task, pipeline.config) : await this.prepareStandardUploadPlan(task, sourceStableChecks);
      getPluginRunRepo().complete(run.id, {
        summary: result.summary || null,
        stagingPath: result.pipelineId === UPLOAD_PIPELINE_IDS.SANY_MODULE1_UPLOAD ? result.uploadRootPath : null,
        artifacts: result.artifacts || null
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      getPluginRunRepo().fail(run.id, message);
      throw error;
    }
  }
  async prepareStandardUploadPlan(task, requiredStableChecks) {
    const settings = getSettingsRepo().getAll();
    const files = await new FileFilterService(
      task.profileSnapshot?.filter || settings.filter
    ).scanFolderAsync(task.folderPath);
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    return {
      pipelineId: UPLOAD_PIPELINE_IDS.STANDARD_UPLOAD,
      uploadRootPath: task.folderPath,
      requiredStableChecks,
      files: files.map((file) => ({
        relativePath: file.relativePath,
        fileSize: file.size,
        mtimeMs: file.mtimeMs
      })),
      summary: {
        files: files.length,
        totalBytes
      }
    };
  }
}
let instance$2 = null;
function getUploadPipelineRuntimeService() {
  if (!instance$2) instance$2 = new UploadPipelineRuntimeService();
  return instance$2;
}
class SpeedCalculator {
  samples = [];
  windowMs;
  constructor(windowMs = 5e3) {
    this.windowMs = windowMs;
  }
  addSample(totalBytes) {
    const now = Date.now();
    this.samples.push({ time: now, bytes: totalBytes });
    const cutoff = now - this.windowMs;
    this.samples = this.samples.filter((s) => s.time >= cutoff);
  }
  getSpeed() {
    if (this.samples.length < 2) return 0;
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const recent = this.samples.filter((s) => s.time >= cutoff);
    if (recent.length < 2) return 0;
    const first = recent[0];
    const last = recent[recent.length - 1];
    const timeDiff = (last.time - first.time) / 1e3;
    if (timeDiff <= 0) return 0;
    return Math.max(0, (last.bytes - first.bytes) / timeDiff);
  }
  reset() {
    this.samples = [];
  }
}
class UploadSemaphore {
  constructor(max) {
    this.max = max;
    this.max = this.normalizeMax(max);
  }
  current = 0;
  waiting = [];
  setMax(max) {
    this.max = this.normalizeMax(max);
    for (const entry of this.waiting) {
      entry.weight = Math.min(entry.weight, this.max);
    }
    this.drain();
  }
  getMax() {
    return this.max;
  }
  getCurrent() {
    return this.current;
  }
  async acquire(signal, weight = 1) {
    if (signal?.aborted) {
      throw new DOMException("Semaphore acquire aborted", "AbortError");
    }
    const effectiveWeight = this.normalizeAcquireWeight(weight);
    if (this.waiting.length === 0 && this.current + effectiveWeight <= this.max) {
      this.current += effectiveWeight;
      return;
    }
    return new Promise((resolve, reject) => {
      const id = Symbol();
      const entry = {
        resolve: () => {
          this.current += entry.weight;
          cleanup();
          resolve();
        },
        id,
        weight: effectiveWeight
      };
      const onAbort = () => {
        const idx = this.waiting.findIndex((w) => w.id === id);
        if (idx !== -1) this.waiting.splice(idx, 1);
        cleanup();
        reject(new DOMException("Semaphore acquire aborted", "AbortError"));
      };
      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(entry);
      this.drain();
    });
  }
  release(weight = 1) {
    this.current = Math.max(0, this.current - this.normalizeReleaseWeight(weight));
    this.drain();
  }
  drain() {
    while (this.waiting.length > 0) {
      const next = this.waiting[0];
      next.weight = Math.min(next.weight, this.max);
      if (this.current + next.weight > this.max) return;
      this.waiting.shift();
      next.resolve();
    }
  }
  normalizeMax(max) {
    return Math.max(1, Math.floor(max || 1));
  }
  normalizeAcquireWeight(weight) {
    return Math.max(1, Math.min(this.normalizeReleaseWeight(weight), this.max));
  }
  normalizeReleaseWeight(weight) {
    return Math.max(1, Math.floor(weight || 1));
  }
}
let instance$1 = null;
function getUploadSemaphore(max) {
  if (!instance$1) {
    instance$1 = new UploadSemaphore(max ?? 12);
  } else if (max !== void 0) {
    instance$1.setMax(max);
  }
  return instance$1;
}
const RETRY_DELAYS_MS = [1e3, 2e3, 5e3, 15e3, 3e4];
const MARKER_WRITE_INTERVAL_MS = 5e3;
const PROGRESS_PERSIST_INTERVAL_MS = 1e3;
class TaskRunnerService {
  async run(task, signal) {
    const taskRepo = getTaskRepo();
    const destinationRepo = getTaskDestinationRepo();
    const settings = getSettingsRepo().getAll();
    const stableChecks = task.sourceType === "local" && task.dayFolderId ? Math.max(2, settings.stability.checkCount || 2) : 1;
    if (!fs.existsSync(task.folderPath)) {
      destinationRepo.updateIncompleteStatuses(
        task.id,
        "skipped",
        "源目录已删除"
      );
      return "skipped";
    }
    const uploadPlan = await getUploadPipelineRuntimeService().prepareUploadPlan(
      task,
      stableChecks
    );
    const uploadRootPath = uploadPlan.uploadRootPath;
    if (!fs.existsSync(uploadRootPath)) {
      throw new Error("上传工作目录不存在");
    }
    const requiredStableChecks = uploadPlan.requiredStableChecks;
    await this.reconcileBeforeUpload(
      task,
      requiredStableChecks,
      uploadPlan
    );
    const destinations = destinationRepo.listByTask(task.id);
    if (destinations.length === 0) {
      throw new Error("任务没有配置任何上传目标");
    }
    const destinationByProvider = new Map(
      destinations.map((destination) => [destination.provider, destination])
    );
    const objectKeyBaseContext = this.buildObjectKeyBaseContext(task);
    const jobs = destinationRepo.listReadyFileTargets(
      task.id,
      requiredStableChecks
    );
    if (jobs.length === 0) {
      taskRepo.recalculateProgress(task.id);
      return this.updateDestinationFinalStates(task);
    }
    this.assertNoDuplicateObjectKeys(
      destinationByProvider,
      jobs,
      objectKeyBaseContext
    );
    const jobProviders = new Set(jobs.map((job) => job.provider));
    for (const destination of destinations) {
      if (!jobProviders.has(destination.provider)) continue;
      const error = getCloudUploadService().validateProvider(
        destination.provider,
        settings
      );
      if (error) throw new Error(error);
    }
    const initialLogicalSummary = taskRepo.summarizeFiles(task.id);
    const logicalProgress = {
      completedThisRun: /* @__PURE__ */ new Set(),
      uploadedFiles: initialLogicalSummary.completedFiles,
      uploadedBytes: initialLogicalSummary.completedBytes,
      lastPersistAt: 0
    };
    const providers = Array.from(jobProviders);
    const runtimes = /* @__PURE__ */ new Map();
    try {
      for (const provider of providers) {
        const destination = destinationByProvider.get(provider);
        if (!destination) continue;
        const uploader = await getCloudUploadService().createTaskUploader(
          provider,
          settings,
          settings.upload.multipartThreshold
        );
        const providerSummary = destinationRepo.summarizeFileTargets(
          task.id,
          provider
        );
        runtimes.set(provider, {
          uploader,
          speed: new SpeedCalculator(),
          uploadedFiles: providerSummary.uploaded,
          uploadedBytes: providerSummary.uploadedBytes,
          totalFiles: providerSummary.total,
          totalBytes: providerSummary.totalBytes,
          queuedFiles: providerSummary.pending,
          failedFiles: providerSummary.failed,
          skippedFiles: providerSummary.skipped,
          activeUploads: /* @__PURE__ */ new Map(),
          activeBytes: 0,
          transferredBytes: 0,
          lastBroadcastAt: 0,
          lastProgressPersistAt: 0
        });
        destinationRepo.updateStatus(task.id, provider, "uploading");
        this.broadcastDestinationStatus(task.id, provider, "uploading");
      }
    } catch (error) {
      for (const runtime of runtimes.values()) runtime.uploader.dispose();
      throw error;
    }
    const abortUploaders = () => {
      for (const runtime of runtimes.values()) runtime.uploader.abort();
    };
    signal?.addEventListener("abort", abortUploaders, { once: true });
    const markerDestinations = destinations.map(
      (destination) => jobProviders.has(destination.provider) ? { ...destination, status: "uploading" } : destination
    );
    const marker = this.createCompactMarker(
      { ...task, status: "uploading" },
      markerDestinations
    );
    this.writeMarker(task.folderPath, marker);
    const markerTimer = setInterval(() => {
      const currentTask2 = taskRepo.getById(task.id);
      if (!currentTask2) return;
      this.writeMarker(
        task.folderPath,
        this.createCompactMarker(currentTask2, currentTask2.destinations)
      );
    }, MARKER_WRITE_INTERVAL_MS);
    const maxConcurrentUploads = settings.upload.maxConcurrentUploads || DEFAULT_SETTINGS.upload.maxConcurrentUploads;
    const multipartThreshold = settings.upload.multipartThreshold || DEFAULT_SETTINGS.upload.multipartThreshold;
    const semaphore = getUploadSemaphore(maxConcurrentUploads);
    let nextIndex = 0;
    const workerCount = Math.max(
      1,
      Math.min(settings.upload.maxFilesPerTask || 12, jobs.length)
    );
    const runNext = async () => {
      while (nextIndex < jobs.length && !signal?.aborted) {
        const target = jobs[nextIndex++];
        await this.uploadTarget(
          task,
          target,
          runtimes,
          semaphore,
          logicalProgress,
          destinationByProvider,
          objectKeyBaseContext,
          uploadRootPath,
          multipartThreshold,
          signal
        );
      }
    };
    try {
      await Promise.all(
        Array.from({ length: workerCount }, () => runNext())
      );
    } finally {
      clearInterval(markerTimer);
      signal?.removeEventListener("abort", abortUploaders);
      this.persistLogicalProgress(task.id, logicalProgress, true);
      for (const [provider, runtime] of runtimes) {
        this.persistProviderProgress(task.id, provider, runtime, true);
      }
      for (const runtime of runtimes.values()) runtime.uploader.dispose();
    }
    if (signal?.aborted) {
      return getTaskRepo().getById(task.id)?.status || "paused";
    }
    taskRepo.recalculateProgress(task.id);
    const finalStatus = this.updateDestinationFinalStates(task);
    const currentTask = taskRepo.getById(task.id) || task;
    const finalTask = { ...currentTask, status: finalStatus };
    this.writeMarker(
      task.folderPath,
      this.createCompactMarker(finalTask, finalTask.destinations)
    );
    return finalStatus;
  }
  async reconcileBeforeUpload(task, stableChecks, uploadPlan) {
    const files = uploadPlan.files.map((file) => ({
      relativePath: file.relativePath,
      size: file.fileSize,
      mtimeMs: file.mtimeMs,
      plannedObjectKey: file.plannedObjectKey
    }));
    getTaskRepo().reconcileFiles(
      task.id,
      files,
      stableChecks,
      { replacePlannedObjectKeys: true }
    );
  }
  assertNoDuplicateObjectKeys(destinationByProvider, jobs, objectKeyBaseContext) {
    const keysByProvider = /* @__PURE__ */ new Map();
    for (const target of jobs) {
      const destination = destinationByProvider.get(target.provider);
      if (!destination) continue;
      const objectKey = this.renderTaskObjectKey(
        destination,
        target.relativePath,
        target.plannedObjectKey,
        objectKeyBaseContext
      );
      const providerKeys = keysByProvider.get(target.provider) || /* @__PURE__ */ new Map();
      const existing = providerKeys.get(objectKey);
      if (existing && existing !== target.relativePath) {
        throw new Error(
          `${target.provider} 对象 Key 重复: ${objectKey} (${existing}, ${target.relativePath})`
        );
      }
      providerKeys.set(objectKey, target.relativePath);
      keysByProvider.set(target.provider, providerKeys);
    }
  }
  renderTaskObjectKey(destination, relativePath, plannedObjectKey, objectKeyBaseContext) {
    if (plannedObjectKey) return plannedObjectKey;
    return renderObjectKey(
      {
        provider: destination.provider,
        prefix: destination.prefix,
        uploadRelativePath: destination.uploadRelativePath,
        pathMode: destination.pathMode,
        objectKeyTemplate: destination.objectKeyTemplate
      },
      this.buildObjectKeyContext(objectKeyBaseContext, relativePath)
    );
  }
  buildObjectKeyBaseContext(task) {
    const groupVariables = task.groupVariables || {};
    const variables = Object.keys(groupVariables).length > 0 ? groupVariables : this.deriveLegacyVariables(task.folderPath);
    return {
      sourcePath: task.folderPath,
      basePath: this.findProfileBasePath(task),
      dateName: variables.date,
      workDirName: variables.workDir || variables.session || task.folderName,
      variables,
      folderName: task.folderName,
      profileId: task.profileId,
      profileName: task.profileName,
      createdAt: task.createdAt
    };
  }
  buildObjectKeyContext(baseContext, relativePath) {
    return {
      ...baseContext,
      relativePath
    };
  }
  deriveLegacyVariables(folderPath) {
    const workDirName = path.basename(folderPath);
    const dateName = path.basename(path.dirname(folderPath));
    return isDateFolderName(dateName) ? { date: dateName, session: workDirName, workDir: workDirName } : { session: workDirName, workDir: workDirName };
  }
  findProfileBasePath(task) {
    const profile = task.profileSnapshot;
    if (!profile) return void 0;
    for (const directory of getProfileSourceDirectories(profile)) {
      if (task.folderPath === directory || task.folderPath.startsWith(`${directory}/`) || task.folderPath.startsWith(`${directory}\\`)) {
        return directory;
      }
    }
    return void 0;
  }
  async uploadTarget(task, target, runtimes, semaphore, logicalProgress, destinationByProvider, objectKeyBaseContext, uploadRootPath, multipartThreshold, signal) {
    const taskRepo = getTaskRepo();
    const destinationRepo = getTaskDestinationRepo();
    const runtime = runtimes.get(target.provider);
    const destination = destinationByProvider.get(target.provider);
    if (!runtime || !destination) return;
    const localPath = path.join(uploadRootPath, target.relativePath);
    if (!fs.existsSync(localPath)) {
      destinationRepo.updateFileStatus(
        target.id,
        "skipped",
        void 0,
        void 0,
        "源文件已删除"
      );
      destinationRepo.recalculateLogicalFile(target.taskFileId);
      runtime.skippedFiles++;
      runtime.queuedFiles = Math.max(0, runtime.queuedFiles - 1);
      this.persistProviderProgress(task.id, target.provider, runtime);
      this.broadcastProgress(task.id, target.provider, runtime, null, true);
      return;
    }
    let acquired = false;
    const uploadWeight = this.getUploadSlotWeight(
      target.fileSize,
      multipartThreshold,
      semaphore.getMax()
    );
    try {
      await semaphore.acquire(signal, uploadWeight);
      acquired = true;
      if (signal?.aborted) throw new DOMException("Upload aborted", "AbortError");
      const before = fs.statSync(localPath);
      if (before.size !== target.fileSize || before.mtimeMs !== target.mtimeMs) {
        taskRepo.markFileChanged(
          target.taskFileId,
          before.size,
          before.mtimeMs
        );
        log.info("文件在进入上传前发生变化，等待重新稳定:", localPath);
        return;
      }
      destinationRepo.updateFileStatus(target.id, "uploading");
      runtime.activeUploads.set(target.id, 0);
      runtime.queuedFiles = Math.max(0, runtime.queuedFiles - 1);
      this.broadcastProgress(
        task.id,
        target.provider,
        runtime,
        target.relativePath,
        true
      );
      const objectKey = this.renderTaskObjectKey(
        destination,
        target.relativePath,
        target.plannedObjectKey,
        objectKeyBaseContext
      );
      let previousLoaded = 0;
      const result = await runtime.uploader.uploadFile(
        localPath,
        objectKey,
        target.fileSize,
        (fraction) => {
          const loaded = Math.min(
            target.fileSize,
            Math.max(0, Math.round(target.fileSize * fraction))
          );
          const delta = Math.max(0, loaded - previousLoaded);
          previousLoaded = loaded;
          runtime.transferredBytes += delta;
          runtime.activeBytes += loaded - (runtime.activeUploads.get(target.id) || 0);
          runtime.activeUploads.set(target.id, loaded);
          runtime.speed.addSample(runtime.transferredBytes);
          this.broadcastProgress(
            task.id,
            target.provider,
            runtime,
            target.relativePath
          );
        },
        signal
      );
      if (fs.existsSync(localPath)) {
        const after = fs.statSync(localPath);
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
          taskRepo.markFileChanged(target.taskFileId, after.size, after.mtimeMs);
          log.info("文件上传期间发生变化，重新排队:", localPath);
          return;
        }
      }
      destinationRepo.updateFileStatus(
        target.id,
        "completed",
        result.objectKey,
        result.uploadId
      );
      const logicalStatus = destinationRepo.recalculateLogicalFile(
        target.taskFileId
      );
      if (logicalStatus === "completed") {
        taskRepo.clearRetry(target.taskFileId);
        if (!logicalProgress.completedThisRun.has(target.taskFileId)) {
          logicalProgress.completedThisRun.add(target.taskFileId);
          logicalProgress.uploadedFiles++;
          logicalProgress.uploadedBytes += target.fileSize;
          this.persistLogicalProgress(task.id, logicalProgress);
        }
      }
      runtime.uploadedFiles++;
      runtime.uploadedBytes += target.fileSize;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        if (taskRepo.getById(task.id)?.status !== "skipped") {
          destinationRepo.updateFileStatus(target.id, "pending");
        }
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (this.isRetriableUploadError(error) && target.retryCount < RETRY_DELAYS_MS.length) {
        const delay = this.retryDelay(target.retryCount);
        const nextRetryAt = new Date(Date.now() + delay).toISOString();
        const retryCount = taskRepo.scheduleRetry(
          target.taskFileId,
          message,
          nextRetryAt
        );
        destinationRepo.updateFileStatus(
          target.id,
          "pending",
          void 0,
          void 0,
          `第 ${retryCount} 次重试等待中: ${message}`
        );
        log.warn(
          `任务 ${task.id} [${target.provider}] 将在 ${delay}ms 后重试: ${target.relativePath}`
        );
      } else {
        destinationRepo.updateFileStatus(
          target.id,
          "failed",
          void 0,
          void 0,
          message
        );
        destinationRepo.recalculateLogicalFile(target.taskFileId);
        runtime.failedFiles++;
        log.error(
          `上传失败 [${target.provider}] ${target.relativePath}:`,
          message
        );
      }
    } finally {
      runtime.activeBytes = Math.max(
        0,
        runtime.activeBytes - (runtime.activeUploads.get(target.id) || 0)
      );
      runtime.activeUploads.delete(target.id);
      if (acquired) semaphore.release(uploadWeight);
      this.persistProviderProgress(task.id, target.provider, runtime);
      this.broadcastProgress(task.id, target.provider, runtime, null, true);
    }
  }
  getUploadSlotWeight(fileSize, multipartThreshold, maxConcurrentUploads) {
    if (fileSize <= multipartThreshold) return 1;
    return Math.max(1, Math.min(4, Math.floor(maxConcurrentUploads || 1)));
  }
  persistProviderProgress(taskId, provider, runtime, force = false) {
    const now = Date.now();
    if (!force && now - runtime.lastProgressPersistAt < PROGRESS_PERSIST_INTERVAL_MS) {
      return;
    }
    getTaskDestinationRepo().updateProgress(
      taskId,
      provider,
      runtime.uploadedFiles,
      runtime.uploadedBytes
    );
    runtime.lastProgressPersistAt = now;
  }
  persistLogicalProgress(taskId, logicalProgress, force = false) {
    const now = Date.now();
    if (!force && now - logicalProgress.lastPersistAt < PROGRESS_PERSIST_INTERVAL_MS) {
      return;
    }
    getTaskRepo().updateProgress(
      taskId,
      logicalProgress.uploadedFiles,
      logicalProgress.uploadedBytes
    );
    logicalProgress.lastPersistAt = now;
  }
  updateDestinationFinalStates(task) {
    const repo = getTaskDestinationRepo();
    let taskStatus = task.sourceType === "local" && task.dayFolderId ? "synced" : "completed";
    for (const destination of repo.listByTask(task.id)) {
      const summary = repo.summarizeFileTargets(task.id, destination.provider);
      if (summary.failed > 0) {
        const examples = repo.listFailedFileTargetExamples(
          task.id,
          destination.provider
        );
        const message = `${summary.failed} 个文件上传失败，例如 ${examples.map(
          (example) => `${example.relativePath}: ${example.errorMessage || "unknown error"}`
        ).join(" | ")}`;
        repo.updateStatus(task.id, destination.provider, "failed", message);
        this.broadcastDestinationStatus(
          task.id,
          destination.provider,
          "failed",
          message
        );
        taskStatus = "failed";
      } else if (summary.pending > 0) {
        repo.updateStatus(
          task.id,
          destination.provider,
          "retrying",
          `${summary.pending} 个文件等待自动重试或稳定`
        );
        this.broadcastDestinationStatus(
          task.id,
          destination.provider,
          "retrying",
          `${summary.pending} 个文件等待自动重试或稳定`
        );
        if (taskStatus !== "failed") taskStatus = "retrying";
      } else {
        const status = task.sourceType === "local" && task.dayFolderId ? "synced" : "completed";
        repo.updateStatus(
          task.id,
          destination.provider,
          status,
          summary.skipped > 0 ? `${summary.skipped} 个源文件已跳过` : void 0
        );
        this.broadcastDestinationStatus(
          task.id,
          destination.provider,
          status,
          summary.skipped > 0 ? `${summary.skipped} 个源文件已跳过` : void 0
        );
      }
      repo.setTotals(
        task.id,
        destination.provider,
        summary.total,
        summary.totalBytes
      );
      repo.updateProgress(
        task.id,
        destination.provider,
        summary.uploaded,
        summary.uploadedBytes
      );
    }
    return taskStatus;
  }
  createCompactMarker(task, destinations) {
    const destinationRepo = getTaskDestinationRepo();
    const taskSummary = getTaskRepo().summarizeFiles(task.id);
    return {
      version: 3,
      taskId: task.id,
      status: task.status,
      totalFiles: taskSummary.totalFiles,
      uploadedFiles: taskSummary.completedFiles,
      failedFiles: taskSummary.failedFiles,
      skippedFiles: taskSummary.skippedFiles,
      lastUpdated: (/* @__PURE__ */ new Date()).toISOString(),
      error: task.errorMessage || destinations.map((destination) => destination.errorMessage).filter(Boolean).join(" || ") || null,
      uploadTargetMode: task.uploadTargetMode,
      destinations: Object.fromEntries(
        destinations.map((destination) => {
          const summary = destinationRepo.summarizeFileTargets(
            task.id,
            destination.provider
          );
          return [
            destination.provider,
            {
              status: destination.status,
              uploadRelativePath: destination.uploadRelativePath,
              pathMode: destination.pathMode,
              objectKeyTemplate: destination.objectKeyTemplate,
              totalFiles: summary.total,
              uploadedFiles: summary.uploaded,
              failedFiles: summary.failed,
              skippedFiles: summary.skipped,
              error: destination.errorMessage
            }
          ];
        })
      )
    };
  }
  broadcastProgress(taskId, provider, runtime, currentFile, force = false) {
    const now = Date.now();
    if (!force && now - runtime.lastBroadcastAt < 250) return;
    runtime.lastBroadcastAt = now;
    const progress = {
      taskId,
      provider,
      uploadedFiles: runtime.uploadedFiles,
      totalFiles: runtime.totalFiles,
      uploadedBytes: Math.min(
        runtime.totalBytes,
        runtime.uploadedBytes + runtime.activeBytes
      ),
      totalBytes: runtime.totalBytes,
      speed: runtime.speed.getSpeed(),
      currentFile,
      queuedFiles: runtime.queuedFiles,
      activeUploads: runtime.activeUploads.size,
      failedFiles: runtime.failedFiles,
      skippedFiles: runtime.skippedFiles,
      transferredBytes: runtime.transferredBytes
    };
    for (const win of electron.BrowserWindow?.getAllWindows?.() ?? []) {
      win.webContents.send(IPC.TASK_PROGRESS, progress);
    }
  }
  writeMarker(folderPath, marker) {
    if (!fs.existsSync(folderPath)) return;
    try {
      writeProcessTask(folderPath, marker);
    } catch (error) {
      log.warn("写入任务汇总标记失败:", folderPath, error);
    }
  }
  broadcastDestinationStatus(taskId, provider, status, errorMessage) {
    for (const win of electron.BrowserWindow?.getAllWindows?.() ?? []) {
      win.webContents.send(IPC.TASK_DESTINATION_CHANGE, {
        taskId,
        provider,
        status,
        errorMessage
      });
    }
  }
  retryDelay(retryCount) {
    const base = RETRY_DELAYS_MS[Math.min(retryCount, RETRY_DELAYS_MS.length - 1)];
    const jitter = 0.8 + Math.random() * 0.4;
    return Math.round(base * jitter);
  }
  isRetriableUploadError(errorValue) {
    const error = errorValue;
    const status = error.status || error.$metadata?.httpStatusCode;
    if (typeof status === "number" && (status === 429 || status >= 500)) {
      return true;
    }
    const transientCodes = /* @__PURE__ */ new Set([
      "ECONNRESET",
      "ETIMEDOUT",
      "ESOCKETTIMEDOUT",
      "EAI_AGAIN",
      "ENOTFOUND",
      "EPIPE",
      "ECONNREFUSED"
    ]);
    if (error.code && transientCodes.has(error.code)) return true;
    const text = `${error.name || ""} ${error.message || ""}`.toLowerCase();
    return text.includes("timeout") || text.includes("temporarily unavailable") || text.includes("socket hang up");
  }
}
let instance = null;
function getTaskRunnerService() {
  if (!instance) instance = new TaskRunnerService();
  return instance;
}
let logDir = "";
let levelFileHookInstalled = false;
const LEVEL_LOG_MAX_SIZE = 10 * 1024 * 1024;
const LEVEL_LOG_DISCARD_SIZE = 50 * 1024 * 1024;
function initLogger(config) {
  logDir = config?.directory || path.join(electron.app.getPath("userData"), "logs");
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  log.transports.file.resolvePathFn = () => {
    const date = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
    const dir = path.join(logDir, date);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return path.join(dir, "info.log");
  };
  log.transports.file.level = "info";
  log.transports.file.format = "[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}";
  log.transports.file.maxSize = 10 * 1024 * 1024;
  prepareCurrentLevelLogs();
  if (!levelFileHookInstalled) {
    log.hooks.push((message) => {
      if (!logDir) return message;
      const level = message.level;
      if (level === "error" || level === "warn") {
        try {
          const date = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
          const dir = path.join(logDir, date);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
          const fileName = level === "error" ? "error.log" : "warn.log";
          const text = message.data?.map((d) => String(d)).join(" ") || "";
          const ts = (/* @__PURE__ */ new Date()).toISOString().replace("T", " ").slice(0, 23);
          const line = `[${ts}] [${level}] ${text}
`;
          const filePath = path.join(dir, fileName);
          rotateLevelLog(filePath);
          fs.appendFileSync(filePath, line);
        } catch {
        }
      }
      return message;
    });
    levelFileHookInstalled = true;
  }
  const maxDays = config?.maxDays || 30;
  cleanOldLogs(logDir, maxDays);
  log.info("日志系统初始化完成, 目录:", logDir);
}
function prepareCurrentLevelLogs() {
  const date = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  const dir = path.join(logDir, date);
  if (!fs.existsSync(dir)) return;
  rotateLevelLog(path.join(dir, "warn.log"));
  rotateLevelLog(path.join(dir, "error.log"));
}
function rotateLevelLog(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }
  const size = fs.statSync(filePath).size;
  if (size < LEVEL_LOG_MAX_SIZE) return;
  if (size >= LEVEL_LOG_DISCARD_SIZE) {
    fs.rmSync(filePath, { force: true });
    return;
  }
  const oldPath = filePath.replace(/\.log$/, ".old.log");
  fs.rmSync(oldPath, { force: true });
  fs.renameSync(filePath, oldPath);
}
function cleanOldLogs(dir, maxDays) {
  try {
    const cutoff = Date.now() - maxDays * 24 * 60 * 60 * 1e3;
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      const entryPath = path.join(dir, entry);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(entry)) continue;
      try {
        const stat = fs.statSync(entryPath);
        if (stat.isDirectory() && stat.mtimeMs < cutoff) {
          fs.rmSync(entryPath, { recursive: true, force: true });
          log.info("已清理过期日志目录:", entry);
        }
      } catch {
      }
    }
  } catch {
  }
}
let mainWindow = null;
let startupWindow = null;
let ossPreviewWindow = null;
let tray = null;
let servicesStarted = false;
const hasSingleInstanceLock = electron.app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  electron.app.quit();
}
electron.app.on("second-instance", () => {
  const window = mainWindow || startupWindow;
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
});
async function createStartupWindow() {
  startupWindow = new electron.BrowserWindow({
    width: 460,
    height: 220,
    resizable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    title: "云桥上传器正在启动",
    backgroundColor: "#f8fafc",
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  startupWindow.once("ready-to-show", () => startupWindow?.show());
  const html = `<!doctype html>
    <html lang="zh-CN">
      <head><meta charset="utf-8"><title>正在启动</title></head>
      <body style="margin:0;font-family:sans-serif;background:#f8fafc;color:#0f172a">
        <main style="height:220px;display:flex;flex-direction:column;align-items:center;justify-content:center">
          <div style="font-size:18px;font-weight:600">云桥上传器正在启动</div>
          <div style="margin-top:14px;font-size:14px;color:#475569">正在检查和升级本地数据库，请勿重复启动或强制关机。</div>
          <div style="margin-top:8px;font-size:12px;color:#64748b">历史文件较多时首次升级可能需要几分钟。</div>
        </main>
      </body>
    </html>`;
  await startupWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}
function createWindow() {
  mainWindow = new electron.BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: "云桥上传器",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.on("ready-to-show", () => {
    startupWindow?.destroy();
    startupWindow = null;
    mainWindow?.show();
    if (!servicesStarted) {
      servicesStarted = true;
      setTimeout(() => {
        try {
          startServices();
        } catch (error) {
          log.error("后台服务启动失败:", error);
        }
      }, 500);
    }
  });
  mainWindow.on("close", (e) => {
    if (!electron.app.isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.webContents.setWindowOpenHandler((details) => {
    electron.shell.openExternal(details.url);
    return { action: "deny" };
  });
  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}
function createTray() {
  const icon = electron.nativeImage.createEmpty();
  tray = new electron.Tray(icon.isEmpty() ? electron.nativeImage.createFromBuffer(Buffer.alloc(0)) : icon);
  const contextMenu = electron.Menu.buildFromTemplate([
    {
      label: "显示主窗口",
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      }
    },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        electron.app.isQuitting = true;
        electron.app.quit();
      }
    }
  ]);
  tray.setToolTip("云桥上传器");
  tray.setContextMenu(contextMenu);
  tray.on("click", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}
function registerHotkey() {
  try {
    const settingsRepo = getSettingsRepo();
    const hotkey = settingsRepo.get("hotkey") || "CommandOrControl+Shift+U";
    electron.globalShortcut.register(hotkey, () => {
      if (mainWindow) {
        if (mainWindow.isVisible()) {
          mainWindow.hide();
        } else {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    });
  } catch (err) {
    log.error("注册快捷键失败:", err);
  }
}
function startServices() {
  const taskQueue = getTaskQueueService();
  const taskRunner = getTaskRunnerService();
  const extensionRuntime = getExtensionRuntimeService();
  const genericConverter = getGenericConverterService();
  const taskRepo = getTaskRepo();
  const scanner = getScannerService();
  taskQueue.setTaskRunner(async (task, signal) => {
    const finalStatus = await taskRunner.run(task, signal);
    if (signal.aborted) return finalStatus;
    if (finalStatus === "completed") {
      const updatedTask = taskRepo.getById(task.id);
      if (updatedTask) extensionRuntime.notifyTaskEvent(updatedTask, "task_completed");
    }
    return finalStatus;
  });
  taskQueue.on("task:status-change", (event) => {
    if (event.newStatus === "failed") {
      const task = taskRepo.getById(event.taskId);
      if (task) extensionRuntime.notifyTaskEvent(task, "task_failed");
    }
    for (const win of electron.BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.TASK_STATUS_CHANGE, event);
    }
  });
  taskQueue.on("upload-queue:event", (status) => {
    for (const win of electron.BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.UPLOAD_QUEUE_EVENT, status);
    }
  });
  genericConverter.on("status", (status) => {
    for (const win of electron.BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.GENERIC_CONVERTER_EVENT, status);
    }
  });
  const unfinishedTaskIds = taskRepo.listUnfinishedTaskIds();
  if (unfinishedTaskIds.length > 0) {
    log.info(`发现 ${unfinishedTaskIds.length} 个未完成任务，等待后台队列分批恢复`);
  }
  taskQueue.start();
  scanner.start();
  scanner.queueReconcileTaskIds(unfinishedTaskIds);
  getCleanupService().start();
  genericConverter.syncWithSettings();
  log.info("所有服务已启动");
}
electron.app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  electronApp.setAppUserModelId("com.uploader.app");
  electron.app.on("browser-window-created", (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });
  initLogger();
  process.on("uncaughtException", (error) => {
    log.error("主进程未捕获异常:", error);
  });
  process.on("unhandledRejection", (reason) => {
    log.error("主进程未处理 Promise 异常:", reason);
  });
  electron.app.on("render-process-gone", (_event, webContents, details) => {
    log.error("渲染进程异常退出:", {
      reason: details.reason,
      exitCode: details.exitCode,
      url: webContents.getURL()
    });
  });
  electron.app.on("child-process-gone", (_event, details) => {
    log.error("Electron 子进程异常退出:", details);
  });
  await createStartupWindow();
  initDatabase();
  const logConfig = getSettingsRepo().get("log");
  if (logConfig?.directory) {
    initLogger(logConfig);
  }
  registerAllIpc();
  createWindow();
  createTray();
  registerHotkey();
  log.info("应用界面初始化完成，后台服务将在窗口显示后启动");
  electron.app.on("activate", () => {
    if (electron.BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  log.error("应用启动失败:", error);
  startupWindow?.destroy();
  startupWindow = null;
  electron.dialog.showErrorBox(
    "云桥上传器启动失败",
    message.includes("database is locked") ? "数据库正在被另一个程序进程使用。请结束旧的云桥上传器进程后重试。" : `${message}

请查看 ~/.config/electron-uploader/logs 下的日志。`
  );
  electron.app.quit();
});
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    electron.app.quit();
  }
});
electron.app.on("will-quit", () => {
  electron.globalShortcut.unregisterAll();
  getScannerService().stop();
  getTaskQueueService().stop();
  getCleanupService().stop();
  getGenericConverterService().stopAll();
});
electron.app.isQuitting = false;
electron.app.on("before-quit", () => {
  electron.app.isQuitting = true;
});
function getMainWindow() {
  return mainWindow;
}
function createOSSPreviewWindow(key) {
  const encodedKey = encodeURIComponent(key);
  const hash = `oss-preview?key=${encodedKey}`;
  if (ossPreviewWindow && !ossPreviewWindow.isDestroyed()) {
    if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
      ossPreviewWindow.loadURL(`${process.env["ELECTRON_RENDERER_URL"]}#/${hash}`);
    } else {
      ossPreviewWindow.loadFile(path.join(__dirname, "../renderer/index.html"), { hash });
    }
    ossPreviewWindow.show();
    ossPreviewWindow.focus();
    return;
  }
  ossPreviewWindow = new electron.BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 760,
    minHeight: 520,
    title: "OSS 预览",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  ossPreviewWindow.on("closed", () => {
    ossPreviewWindow = null;
  });
  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    ossPreviewWindow.loadURL(`${process.env["ELECTRON_RENDERER_URL"]}#/${hash}`);
  } else {
    ossPreviewWindow.loadFile(path.join(__dirname, "../renderer/index.html"), { hash });
  }
}
exports.createOSSPreviewWindow = createOSSPreviewWindow;
exports.getMainWindow = getMainWindow;
