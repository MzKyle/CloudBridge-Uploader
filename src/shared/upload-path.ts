export function joinOssPath(...parts: Array<string | null | undefined>): string {
  return parts
    .flatMap((part) => (part || '').replace(/\\/g, '/').split('/'))
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part !== '.')
    .join('/')
}

export function buildUploadRelativePath(groupPath: string, taskPath: string): string {
  return joinOssPath(groupPath, taskPath)
}

export function buildOssKey(
  prefix: string,
  uploadRelativePath: string,
  fileRelativePath: string
): string {
  return joinOssPath(prefix, uploadRelativePath, fileRelativePath)
}
