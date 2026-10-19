import { asRecord, extractString, parseJsonObject } from '../../ai-vault/session-scanner-values'
import { dshEntryFromRecord } from './dsh-log-entries'
import type { DshEntry, DshHeader, DshLog } from './dsh-log-types'

const NEWEST_DSH_FORMAT = 4

/** The `type: 'session'` header line, or null when the line is not one Orca can read. */
export function parseDshHeader(line: string): DshHeader | null {
  const record = parseJsonObject(line)
  const id = extractString(record?.id)
  if (!record || record.type !== 'session' || !id) {
    return null
  }
  const version = record.version
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    return null
  }
  if (version > NEWEST_DSH_FORMAT) {
    throw new Error(`DSH session format v${version} is newer than this Orca can read`)
  }
  const depth = record.delegationDepth
  return {
    id,
    cwd: extractString(record.cwd),
    createdAt: typeof record.createdAt === 'number' ? record.createdAt : null,
    version,
    isSeeded: version >= 2 && record.isSeeded === true,
    seedLength:
      version < 2 && typeof record.seedLength === 'number' && record.seedLength > 0
        ? record.seedLength
        : 0,
    isSubagent:
      record.origin === 'subagent' ||
      (typeof depth === 'number' && Number.isFinite(depth) && depth > 0),
    parentSession: extractString(record.parentSession) ?? extractString(asRecord(record.parent)?.id)
  }
}

/**
 * Read a whole log from its decoded lines. The first line must be the header; a
 * log without one (a session that never wrote it) reads as null. Malformed lines
 * are skipped like any other agent's transcript: one bad record must not hide
 * the conversation.
 */
export function readDshLog(lines: readonly string[]): DshLog | null {
  const header = lines.length > 0 ? parseDshHeader(lines[0]) : null
  if (!header) {
    return null
  }
  const log: DshLog = { header, entries: [], ownStart: 0 }
  appendDshLogLines(log, lines.slice(1))
  log.ownStart = dshOwnStart(header, log.entries)
  return log
}

/** Add appended lines to a log read earlier. A fork's inherited prefix is written
 *  when the session is created, so appends never move the inherited cut. */
export function appendDshLogLines(log: DshLog, lines: readonly string[]): DshEntry[] {
  const added: DshEntry[] = []
  for (const line of lines) {
    const record = parseJsonObject(line)
    const entry = record ? dshEntryFromRecord(record, log.header.version) : null
    if (entry) {
      log.entries.push(entry)
      added.push(entry)
    }
  }
  return added
}

/**
 * Where the session's own history starts. v2+ (dsh-session `Session` constructor):
 * only a seeded header has an inherited prefix, ending at the LAST
 * `session/end-seed` marked `inherited` — a fork of a fork keeps its parent's
 * marker too. Unmarked end-seed events close constructor setup and cut nothing.
 * v0/v1 recorded the inherited event count as `seedLength`.
 */
export function dshOwnStart(header: DshHeader, entries: readonly DshEntry[]): number {
  if (header.version >= 2) {
    if (!header.isSeeded) {
      return 0
    }
    for (let index = entries.length - 1; index >= 0; index--) {
      if (entries[index].kind === 'inherited-boundary') {
        return index + 1
      }
    }
    return 0
  }
  if (header.seedLength === 0) {
    return 0
  }
  const index = entries.findIndex((entry) => entry.seq >= header.seedLength)
  return index === -1 ? entries.length : index
}

/** Typed prompts only: DSH injects runtime context, skill catalogs and approval
 *  notices as user-role messages with another source kind. */
export function isDshTypedPrompt(entry: DshEntry): boolean {
  return entry.kind === 'user' && entry.sourceKind === 'user'
}
