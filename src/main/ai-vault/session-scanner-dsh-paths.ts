import type { Dirent } from 'node:fs'
import { basename, dirname, join } from 'node:path'

export { resolveDshSessionsDir } from '../../shared/dsh-session-paths'

// `session.jsonl` (generation 0) or `session.v<N>.jsonl`, zstd-compressed by
// default (`.jsonl.zstd`). DSH's own scanner rejects leading zeros, and a dir
// holding only `session.lock` is a session that never wrote a header.
const DSH_SESSION_FILE_NAME = /^session(?:\.v([1-9]\d*))?\.jsonl(\.zstd)?$/

export const DSH_ZSTD_SESSION_FILE_SUFFIX = '.zstd'

export function isDshSessionFilePath(filePath: string): boolean {
  return DSH_SESSION_FILE_NAME.test(basename(filePath))
}

/** The file format generation N from `session[.v<N>]...`; -1 when the name does not match. */
export function dshSessionFileGeneration(filePath: string): number {
  const match = DSH_SESSION_FILE_NAME.exec(basename(filePath))
  if (!match) {
    return -1
  }
  const generation = Number(match[1] ?? 0)
  return Number.isSafeInteger(generation) ? generation : -1
}

/** The session id is the directory holding the generation file. */
export function dshSessionIdFromFilePath(filePath: string): string {
  return basename(dirname(filePath))
}

/** `<home>/sessions/<encoded-cwd>/<session-id>/<generation file>` → `<home>`. */
export function dshHomeFromSessionFilePath(filePath: string): string {
  return dirname(dirname(dirname(dirname(filePath))))
}

/**
 * Only the newest generation of one session dir is the session: DSH migrates by
 * writing a successor file and leaves the older ones behind. A dir holding the
 * same generation both compressed and plain is ambiguous to DSH itself, so
 * neither copy is offered. Directories pass through untouched.
 */
export function selectDshGenerationEntries(entries: Dirent[]): Dirent[] {
  let newest: Dirent | null = null
  let newestGeneration = -1
  let ambiguous = false
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue
    }
    const generation = dshSessionFileGeneration(entry.name)
    if (generation < 0 || generation < newestGeneration) {
      continue
    }
    ambiguous = generation === newestGeneration
    newest = entry
    newestGeneration = generation
  }
  return entries.filter(
    (entry) =>
      !entry.isFile() || (entry === newest && !ambiguous) || !isDshSessionFilePath(entry.name)
  )
}

/** The newest generation file name among `names`, or null (none, or ambiguous). */
export function newestDshGenerationName(names: readonly string[]): string | null {
  let newest: string | null = null
  let newestGeneration = -1
  let ambiguous = false
  for (const name of names) {
    const generation = dshSessionFileGeneration(name)
    if (generation < 0 || generation < newestGeneration) {
      continue
    }
    ambiguous = generation === newestGeneration
    newest = name
    newestGeneration = generation
  }
  return ambiguous ? null : newest
}

// Content-addressed: `sha256:<hex>` lives at `attachments/v1/objects/<hex[0:2]>/<hex>`.
const DSH_ATTACHMENT_ID = /^sha256:([0-9a-f]{64})$/

/** Where DSH keeps an attachment's bytes, or null for an id this layout does not name. */
export function dshAttachmentObjectPath(dshHome: string, attachmentId: string): string | null {
  const hex = DSH_ATTACHMENT_ID.exec(attachmentId)?.[1]
  return hex ? join(dshHome, 'attachments', 'v1', 'objects', hex.slice(0, 2), hex) : null
}
