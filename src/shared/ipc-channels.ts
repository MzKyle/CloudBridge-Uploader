// ============================================
// IPC 通道常量 — 主进程 & 渲染进程共享
// ============================================

export const IPC = {
  // 任务管理
  TASK_LIST: 'task:list',
  TASK_GET: 'task:get',
  TASK_ADD_FOLDER: 'task:add-folder',
  TASK_PAUSE: 'task:pause',
  TASK_RESUME: 'task:resume',
  TASK_CANCEL: 'task:cancel',
  TASK_RETRY: 'task:retry',
  TASK_SKIP: 'task:skip',
  TASK_RESTORE: 'task:restore',
  TASK_DETAIL: 'task:detail',
  TASK_PROGRESS: 'task:progress',         // push from main
  TASK_STATUS_CHANGE: 'task:status-change', // push from main
  TASK_DESTINATION_CHANGE: 'task:destination-change',

  // 上传队列
  UPLOAD_QUEUE_STATUS: 'upload-queue:status',
  UPLOAD_QUEUE_START: 'upload-queue:start',
  UPLOAD_QUEUE_STOP: 'upload-queue:stop',
  UPLOAD_QUEUE_EVENT: 'upload-queue:event',

  // 日期目录汇总
  DAY_FOLDER_LIST: 'day-folder:list',
  DAY_FOLDER_DELETE: 'day-folder:delete',
  DAY_FOLDER_IGNORE: 'day-folder:ignore',
  DAY_FOLDER_RESTORE: 'day-folder:restore',
  UPLOAD_GROUP_CLOSE: 'upload-group:close',
  DAY_FOLDER_EVENT: 'day-folder:event',

  // 扫描器
  SCANNER_STATUS: 'scanner:status',
  SCANNER_TRIGGER: 'scanner:trigger',
  SCANNER_START: 'scanner:start',
  SCANNER_STOP: 'scanner:stop',
  SCANNER_EVENT: 'scanner:event',         // push from main

  // 数采模式
  DATA_COLLECT_LIST: 'data-collect:list',
  DATA_COLLECT_RUN: 'data-collect:run',
  DATA_COLLECT_RESULT: 'data-collect:result', // push from main

  // 设置
  SETTINGS_GET_ALL: 'settings:get-all',
  SETTINGS_SAVE: 'settings:save',
  SETTINGS_TEST_OSS: 'settings:test-oss',
  SETTINGS_TEST_TENCENT_S3: 'settings:test-tencent-s3',
  UPLOAD_PATH_PREVIEW: 'upload:path-preview',

  // 项目插件
  CAPABILITY_LIST: 'capability:list',
  CAPABILITY_PROFILE_STATUS: 'capability:profile-status',
  CAPABILITY_TASK_RUNS: 'capability:task-runs',
  PLUGIN_LIST: 'plugin:list',
  PLUGIN_PROFILE_STATUS: 'plugin:profile-status',
  PLUGIN_TASK_RUNS: 'plugin:task-runs',

  // OSS 浏览器工具插件
  OSS_BROWSER_LIST: 'oss-browser:list',
  OSS_BROWSER_HEAD: 'oss-browser:head',
  OSS_BROWSER_GET_IMAGE: 'oss-browser:get-image',
  OSS_BROWSER_OPEN_PREVIEW_WINDOW: 'oss-browser:open-preview-window',

  // 通用转换工具
  GENERIC_CONVERTER_STATUS: 'generic-converter:status',
  GENERIC_CONVERTER_START: 'generic-converter:start',
  GENERIC_CONVERTER_STOP: 'generic-converter:stop',
  GENERIC_CONVERTER_SCAN_NOW: 'generic-converter:scan-now',
  GENERIC_CONVERTER_EVENT: 'generic-converter:event',

  // SSH / rsync
  SSH_LIST_MACHINES: 'ssh:list-machines',
  SSH_ADD_MACHINE: 'ssh:add-machine',
  SSH_UPDATE_MACHINE: 'ssh:update-machine',
  SSH_DELETE_MACHINE: 'ssh:delete-machine',
  SSH_TEST_CONNECTION: 'ssh:test-connection',
  RSYNC_START: 'rsync:start',
  RSYNC_STOP: 'rsync:stop',
  RSYNC_PROGRESS: 'rsync:progress',       // push from main
  SFTP_START: 'sftp:start',
  SFTP_STOP: 'sftp:stop',
  SFTP_PROGRESS: 'sftp:progress',         // push from main

  // 历史
  HISTORY_LIST: 'history:list',
  HISTORY_CLEAR: 'history:clear',
  HISTORY_DELETE: 'history:delete',

  // 磁盘用量
  DISK_USAGE: 'disk:usage',

  // 窗口
  WINDOW_TOGGLE: 'window:toggle',
  WINDOW_MINI_MONITOR: 'window:mini-monitor',

  // 对话框
  DIALOG_SELECT_FOLDER: 'dialog:select-folder',
  DIALOG_SELECT_DIRECTORY: 'dialog:select-directory'
} as const
