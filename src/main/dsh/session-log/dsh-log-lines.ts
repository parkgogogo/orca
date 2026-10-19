import * as zlib from 'node:zlib'
import { DSH_ZSTD_SESSION_FILE_SUFFIX } from '../../ai-vault/session-scanner-dsh-paths'
import { zstdFrames } from '../../ai-vault/session-scanner-dsh-zstd-frames'

// Why caps: one frame is one write batch (a few KB in practice); anything near
// these is not a session log, and a decoder window that large is refused.
const MAX_FRAME_DECODED_BYTES = 64 * 1024 * 1024
export const MAX_DSH_LOG_FILE_BYTES = 256 * 1024 * 1024

export type DshLogChunk = {
  /** Complete JSONL records, without their newlines. */
  lines: string[]
  /** Input bytes those records fully account for; the rest is a write still in flight. */
  consumedBytes: number
}

const NEWLINE = 0x0a

/**
 * Decode the complete records in `bytes`, which must start on a record boundary:
 * the start of the file, or a `consumedBytes` an earlier call returned. DSH
 * appends one independent zstd frame per write batch, so a compressed log is
 * decoded frame by frame (a single zstd call stops after the first frame).
 */
export function decodeDshLogChunk(filePath: string, bytes: Buffer): DshLogChunk {
  if (!filePath.endsWith(DSH_ZSTD_SESSION_FILE_SUFFIX)) {
    const end = bytes.lastIndexOf(NEWLINE) + 1
    return { lines: splitRecords(bytes.subarray(0, end)), consumedBytes: end }
  }
  // Why: zstd landed in Node 22.15; an older runtime reports an error instead of crashing.
  if (typeof zlib.zstdDecompressSync !== 'function') {
    throw new Error('This runtime cannot decompress zstd session files')
  }
  const decoded: Buffer[] = []
  let decodedBytes = 0
  // Only a frame whose text ends a record moves the boundary; a batch that ends
  // mid-record (never seen from DSH, which writes whole lines) waits for the next.
  let settledFrames = 0
  let consumedBytes = 0
  for (const frame of zstdFrames(bytes)) {
    const text = zlib.zstdDecompressSync(frame, { maxOutputLength: MAX_FRAME_DECODED_BYTES })
    decoded.push(text)
    decodedBytes += text.length
    if (text.at(-1) === NEWLINE) {
      settledFrames = decoded.length
      consumedBytes = frame.byteOffset - bytes.byteOffset + frame.length
    }
  }
  if (decodedBytes > MAX_DSH_LOG_FILE_BYTES) {
    throw new Error('DSH session log is too large to read')
  }
  return {
    lines: splitRecords(Buffer.concat(decoded.slice(0, settledFrames))),
    consumedBytes
  }
}

function splitRecords(bytes: Buffer): string[] {
  if (bytes.length === 0) {
    return []
  }
  // Decoded once at a record boundary, so no multibyte character is split.
  const lines = bytes.toString('utf8').split('\n')
  lines.pop()
  return lines.filter((line) => line.trim().length > 0)
}
