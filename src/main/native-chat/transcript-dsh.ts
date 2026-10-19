import type {
  AgentType,
  NativeChatMessage,
  NativeChatTurnLifecycle
} from '../../shared/native-chat-types'
import { dshHomeFromSessionFilePath } from '../ai-vault/session-scanner-dsh-paths'
import { errorMessage } from '../ai-vault/session-scanner-values'
import { readDshLogFile } from '../dsh/session-log/dsh-log-file'
import type { DshLog } from '../dsh/session-log/dsh-log-types'
import { isENOENT } from '../ipc/filesystem-path-containment'
import { resolveSessionFilePath, type ResolveSessionFileOptions } from './session-file-resolver'
import { prepareDshImages } from './transcript-dsh-attachments'
import { dshLogMessages, dshTurnLifecycle } from './transcript-dsh-messages'

// A DSH log is zstd frames, not text lines, so the line-decoder readers cannot
// page it by byte offset. These readers decode the whole log (a few MB at most
// in practice) and page by message index instead; `beforeOffset` is that index.

export type DshTranscript = {
  log: DshLog | null
  messages: NativeChatMessage[]
  lifecycle: NativeChatTurnLifecycle | null
  /** File bytes the decoded log covers; live follow resumes from here. */
  consumedBytes: number
}

export async function readDshTranscriptFile(
  path: string,
  signal?: AbortSignal
): Promise<DshTranscript> {
  const read = await readDshLogFile(path, 'exact', signal)
  if (!read.log) {
    return { log: null, messages: [], lifecycle: null, consumedBytes: 0 }
  }
  const locateImage = await prepareDshImages(dshHomeFromSessionFilePath(path), read.log.entries)
  return {
    log: read.log,
    messages: dshLogMessages(read.log, locateImage),
    lifecycle: dshTurnLifecycle(read.log.entries),
    consumedBytes: read.consumedBytes
  }
}

type DshReadArgs = ResolveSessionFileOptions & { filePath?: string }

async function resolveDshPath(
  agent: AgentType,
  sessionId: string,
  options: DshReadArgs,
  signal?: AbortSignal
): Promise<string | null> {
  return options.filePath ?? (await resolveSessionFilePath(agent, sessionId, options, signal))
}

function failure(error: unknown): { error: string; notFound?: true } {
  return isENOENT(error)
    ? { error: errorMessage(error), notFound: true }
    : { error: errorMessage(error) }
}

export async function readDshNativeChatTranscriptFull(
  agent: AgentType,
  sessionId: string,
  options: DshReadArgs = {}
): Promise<
  | { messages: NativeChatMessage[]; lifecycle?: NativeChatTurnLifecycle; sourceEmpty?: boolean }
  | { error: string; notFound?: true }
> {
  try {
    const path = await resolveDshPath(agent, sessionId, options)
    if (!path) {
      return { error: `No transcript found for ${agent} session ${sessionId}`, notFound: true }
    }
    const transcript = await readDshTranscriptFile(path)
    return {
      messages: transcript.messages,
      ...(transcript.lifecycle ? { lifecycle: transcript.lifecycle } : {}),
      ...(transcript.log ? {} : { sourceEmpty: true })
    }
  } catch (error) {
    return failure(error)
  }
}

/** The page of `messages` ending before index `before` (the newest page when omitted). */
export function dshTranscriptPage(
  messages: readonly NativeChatMessage[],
  limit: number,
  before?: number
): { messages: NativeChatMessage[]; hasMore: boolean; beforeOffset: number } {
  const end = Math.min(before ?? messages.length, messages.length)
  const start = Math.max(0, end - Math.max(1, limit))
  return { messages: messages.slice(start, end), hasMore: start > 0, beforeOffset: start }
}

export async function readDshNativeChatTranscriptTail(
  args: DshReadArgs & {
    agent: AgentType
    sessionId: string
    limit: number
    beforeOffset?: number
  },
  signal?: AbortSignal
): Promise<
  | {
      messages: NativeChatMessage[]
      lifecycle?: NativeChatTurnLifecycle
      hasMore: boolean
      beforeOffset: number
    }
  | { error: string; notFound?: true }
> {
  try {
    const path = await resolveDshPath(args.agent, args.sessionId, args, signal)
    signal?.throwIfAborted()
    // A new session can report its id before DSH writes the log's first frame.
    if (!path) {
      return { error: 'Transcript unavailable', notFound: true }
    }
    const transcript = await readDshTranscriptFile(path, signal)
    signal?.throwIfAborted()
    const page = dshTranscriptPage(transcript.messages, args.limit, args.beforeOffset)
    // An older page must not rewind the live lifecycle; only the newest page describes turn state.
    return args.beforeOffset === undefined && transcript.lifecycle
      ? { ...page, lifecycle: transcript.lifecycle }
      : page
  } catch (error) {
    signal?.throwIfAborted()
    return failure(error)
  }
}
