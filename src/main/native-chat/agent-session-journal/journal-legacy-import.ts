// Hydrating a journal from a bridge-era transcript.
//
// Ordinary messages reuse the existing per-agent transcript decoders; Pi also
// projects its saved branch and summaries. The decoders return a render model
// with no identity, so the import wraps them: the wrapper
// reads an identity anchor off the SAME raw line, then delegates the content.
//
// Import always opens a fresh epoch. The imported timeline is a best-effort
// reconstruction with import-scoped identities for most providers, so it must
// never be spliced into a sequence space that a structured session is also
// writing; a later structured resume rolls the epoch again and rebuilds.

import {
  adoptedTranscriptSourceObserver,
  validateAdoptedOpenCodeSource,
  type AdoptedTranscriptSource
} from './adopted-transcript-source'
import { createReadStream } from 'node:fs'
import type { AgentType } from '../../../shared/agent-status-types'
import type {
  AgentJournalCursor,
  AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import type { NativeChatMessage } from '../../../shared/native-chat-types'
import { resolveNativeChatTranscriptAgent } from '../../../shared/native-chat-agent-support'
import { resolveSessionFilePath, type ResolveSessionFileOptions } from '../session-file-resolver'
import {
  decodeClaudeTranscriptLine,
  decodeCodexTranscriptLine,
  decodeGrokTranscriptLine,
  decodeOmpTranscriptLine
} from '../transcript-line-decoders'
import { decodeTranscriptStream } from '../transcript-stream-lines'
import { readOpenCodeNativeChatTranscriptFull } from '../transcript-opencode'
import { readDshNativeChatTranscriptFull } from '../transcript-dsh'
import { createLegacyIdentityTracker } from './journal-legacy-identity'
import { importedMessages, replacementItem } from './journal-legacy-items'
import { createPiTranscriptCollector } from './journal-pi-active-branch'
import { createNewestItemWindow } from './journal-newest-item-window'
import type { JournalReplacementItem } from './journal-epoch-replacement'
import { DEFAULT_JOURNAL_PAYLOAD_LIMITS, type JournalPayloadLimits } from './journal-payload-bounds'
import type { AgentSessionJournal } from './journal-store'

export type LegacyImportOptions = ResolveSessionFileOptions & {
  /** Resolve directly to this file, skipping path discovery. */
  filePath?: string
  source?: AdoptedTranscriptSource
  limits?: JournalPayloadLimits
  decodedMessageIdentities?: true
}

/** One transcript line; the resume reconciler reads the same file under the same bound. */
const MAX_LEGACY_IMPORT_RECORD_BYTES = 16 * 1024 * 1024
/** Bounded history kept from a source of any size. The agent resumes the whole conversation
 *  itself, so only the chat's earliest messages fall outside this. */
const MAX_LEGACY_IMPORT_RETAINED_BYTES = 16 * 1024 * 1024
/** A roster is a status list; an imported one is as untrusted as any other block. */

export type LegacyImportResult =
  | {
      ok: true
      epoch: string
      cursor: AgentJournalCursor
      imported: number
      /** False when the transcript held no messages and the epoch was left as it stood. */
      replaced: boolean
    }
  | { ok: false; error: string }

type PreparedLegacyImport =
  | { ok: true; items: JournalReplacementItem[]; sourceEmpty: boolean }
  | { ok: false; error: string }

export async function importLegacyTranscriptIntoJournal(input: {
  journal: AgentSessionJournal
  agent: AgentType
  sessionId: string
  fence: number
  options?: LegacyImportOptions
}): Promise<LegacyImportResult> {
  const prepared = await prepareLegacyTranscriptImport(input)
  if (!prepared.ok) {
    return prepared
  }
  // An empty import leaves the epoch as it stands.
  if (prepared.items.length === 0) {
    const current = input.journal.cursor()
    return { ok: true, epoch: current.epoch, cursor: current, imported: 0, replaced: false }
  }
  const cursor = await input.journal.replaceEpochItems('legacy_import', input.fence, prepared.items)
  return { ok: true, epoch: cursor.epoch, cursor, imported: prepared.items.length, replaced: true }
}

export async function prepareLegacyTranscriptImport(input: {
  agent: AgentType
  sessionId: string
  options?: LegacyImportOptions
}): Promise<PreparedLegacyImport> {
  const options = input.options ?? {}
  const limits = options.limits ?? DEFAULT_JOURNAL_PAYLOAD_LIMITS
  // OMP is a Pi fork that kept Pi's session format, so OMP's decoder reads Pi's sessions too.
  const transcriptAgent =
    input.agent === 'pi' ? 'omp' : resolveNativeChatTranscriptAgent(input.agent)
  if (!transcriptAgent) {
    return { ok: false, error: `Unsupported agent for journal import: ${input.agent}` }
  }
  if (transcriptAgent === 'opencode') {
    return prepareOpenCodeImport({ ...input, limits })
  }
  // A DSH log is zstd frames, read by the Chat view's own reader; DSH message ids are stable.
  if (transcriptAgent === 'dsh') {
    const read = await readDshNativeChatTranscriptFull(input.agent, input.sessionId, options)
    return 'error' in read
      ? { ok: false, error: read.error }
      : importedMessages(input, read.messages, limits, read.sourceEmpty === true)
  }
  const filePath =
    options.filePath ?? (await resolveSessionFilePath(input.agent, input.sessionId, options))
  if (!filePath) {
    return { ok: false, error: `No transcript found for ${input.agent} session ${input.sessionId}` }
  }

  try {
    const { items, consumedBytes } = await decodeReplacementItems({
      filePath,
      transcriptAgent,
      agent: input.agent,
      sessionId: input.sessionId,
      source: options.source,
      decodedMessageIdentities: options.decodedMessageIdentities,
      limits
    })
    return { ok: true, items, sourceEmpty: consumedBytes === 0 }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** OpenCode keeps conversations in a database (`filePath` names it), read by the reader its
 *  transcript view uses; its message ids are stable, so they are the identities. */
async function prepareOpenCodeImport(input: {
  agent: AgentType
  sessionId: string
  options?: LegacyImportOptions
  limits: JournalPayloadLimits
}): Promise<PreparedLegacyImport> {
  const dbPath = input.options?.filePath
  if (input.options?.source) {
    if (!dbPath) {
      return { ok: false, error: 'The conversation database is unavailable.' }
    }
    try {
      await validateAdoptedOpenCodeSource(dbPath, input.options.source)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  const read = await readOpenCodeNativeChatTranscriptFull(
    input.sessionId,
    dbPath ? { resolveDbPath: async () => dbPath } : {}
  )
  if ('error' in read) {
    return { ok: false, error: read.error }
  }
  return importedMessages(input, read.messages, input.limits, read.sourceEmpty === true)
}

const TRANSCRIPT_DECODERS = {
  claude: decodeClaudeTranscriptLine,
  codex: decodeCodexTranscriptLine,
  grok: decodeGrokTranscriptLine,
  omp: decodeOmpTranscriptLine
} as const

/** Run the real decoder while recording an identity anchor per emitted message. Each message is
 *  bounded as it is read and only the newest fit the retained budget, so memory tracks what is
 *  kept, never the source's size. */
async function decodeReplacementItems(input: {
  filePath: string
  transcriptAgent: keyof typeof TRANSCRIPT_DECODERS
  agent: AgentType
  sessionId: string
  decodedMessageIdentities?: true
  source?: AdoptedTranscriptSource
  limits: JournalPayloadLimits
}): Promise<{ items: JournalReplacementItem[]; consumedBytes: number }> {
  const source = input.source
    ? adoptedTranscriptSourceObserver({
        agent: input.agent,
        filePath: input.filePath,
        source: input.source,
        maxSourceBytes: MAX_LEGACY_IMPORT_RECORD_BYTES
      })
    : null
  const tracker = createLegacyIdentityTracker({
    transcriptAgent: input.transcriptAgent,
    agent: input.agent,
    sessionId: input.sessionId
  })
  const decode = TRANSCRIPT_DECODERS[input.transcriptAgent]
  const toItem = (message: NativeChatMessage, identity: AgentJournalItemIdentity) =>
    replacementItem(message, identity, input.limits)
  const retained = createNewestItemWindow(MAX_LEGACY_IMPORT_RETAINED_BYTES)
  const pi =
    input.agent === 'pi'
      ? createPiTranscriptCollector(toItem, (line, lineIndex) => tracker.identify(line, lineIndex))
      : null
  let lineIndex = 0
  try {
    const { consumedBytes } = await decodeTranscriptStream(
      createReadStream(input.filePath),
      input.filePath,
      0,
      (line, fallbackId) => {
        source?.observe(line)
        const currentLineIndex = lineIndex
        lineIndex += 1
        if (pi) {
          pi.record(line, fallbackId, currentLineIndex)
          return null
        }
        const message = decode(line, fallbackId)
        if (message) {
          retained.push(
            toItem(
              message,
              input.decodedMessageIdentities
                ? {
                    provider: 'legacy',
                    agent: input.agent,
                    sessionId: input.sessionId,
                    recordId: message.id
                  }
                : tracker.identify(line, currentLineIndex)
            )
          )
        }
        return null
      },
      true,
      MAX_LEGACY_IMPORT_RECORD_BYTES
    )
    if (consumedBytes > 0) {
      await source?.validate()
    }
    if (pi) {
      await pi.project(retained.push)
    }
    return { items: retained.items(), consumedBytes }
  } finally {
    pi?.close()
  }
}
