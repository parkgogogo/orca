import { readTranscriptSlice, transcriptFileStat } from '../../native-chat/wsl-transcript-fs-access'
import type { WslTranscriptFsTaskPriority } from '../../native-chat/wsl-transcript-fs-gate'
import { appendDshLogLines, readDshLog } from './dsh-log'
import { decodeDshLogChunk, MAX_DSH_LOG_FILE_BYTES } from './dsh-log-lines'
import type { DshEntry, DshLog } from './dsh-log-types'

export type DshLogRead = {
  log: DshLog | null
  /** File bytes the log accounts for; an incremental read resumes here. */
  consumedBytes: number
  /** File size at the read, so a caller can tell a rewrite (shrink) from an append. */
  size: number
}

/** Read and decode a whole session log. Goes through the transcript fs gate so
 *  WSL guest paths read the same way native ones do. */
export async function readDshLogFile(
  path: string,
  priority: WslTranscriptFsTaskPriority = 'exact',
  signal?: AbortSignal
): Promise<DshLogRead> {
  const { size } = await transcriptFileStat(path, priority, signal)
  if (size > MAX_DSH_LOG_FILE_BYTES) {
    throw new Error('DSH session log is too large to read')
  }
  const bytes =
    size === 0 ? Buffer.alloc(0) : await readTranscriptSlice(path, 0, size, priority, signal)
  const chunk = decodeDshLogChunk(path, bytes)
  return { log: readDshLog(chunk.lines), consumedBytes: chunk.consumedBytes, size }
}

export type DshLogAppend =
  | { kind: 'unchanged' }
  /** The file shrank or its head changed: the caller rereads it whole. */
  | { kind: 'rewritten' }
  | { kind: 'appended'; entries: DshEntry[]; consumedBytes: number; size: number }

/**
 * Decode only what was appended after `consumedBytes`. DSH appends whole frames
 * and never rewrites a written one, so a log read once can be followed by
 * decoding new frames only.
 */
export async function readDshLogAppend(
  path: string,
  log: DshLog,
  consumedBytes: number,
  signal?: AbortSignal
): Promise<DshLogAppend> {
  const { size } = await transcriptFileStat(path, 'exact', signal)
  if (size < consumedBytes) {
    return { kind: 'rewritten' }
  }
  if (size === consumedBytes) {
    return { kind: 'unchanged' }
  }
  if (size - consumedBytes > MAX_DSH_LOG_FILE_BYTES) {
    throw new Error('DSH session log is too large to read')
  }
  const bytes = await readTranscriptSlice(
    path,
    consumedBytes,
    size - consumedBytes,
    'exact',
    signal
  )
  let chunk
  try {
    chunk = decodeDshLogChunk(path, bytes)
  } catch {
    // Not a frame boundary any more: the file was replaced under the same name.
    return { kind: 'rewritten' }
  }
  if (chunk.consumedBytes === 0) {
    return { kind: 'unchanged' }
  }
  return {
    kind: 'appended',
    entries: appendDshLogLines(log, chunk.lines),
    consumedBytes: consumedBytes + chunk.consumedBytes,
    size
  }
}
