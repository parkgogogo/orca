import type { AiVaultSession } from '../../shared/ai-vault-types'
import { readDshLog, isDshTypedPrompt } from '../dsh/session-log/dsh-log'
import { readDshLogFile } from '../dsh/session-log/dsh-log-file'
import type { DshBlock, DshEntry, DshLog } from '../dsh/session-log/dsh-log-types'
import {
  addPreviewContent,
  addPreviewMessage,
  createAccumulator,
  finalizeSession,
  timestampIso,
  updateTimeline
} from './session-scanner-accumulator'
import type { FileWithMtime, SessionAccumulator } from './session-scanner-types'
import { transcriptMessagesFromContent } from './session-transcript-message-content'
import type { TranscriptMessageSink } from './session-transcript-consumers'
import { normalizeTitleText } from './session-scanner-values'

type DshTitleState = { title: string | null; isFallback: boolean }

/** Fold one DSH session's decoded JSONL; null for subagent sessions and headerless files. */
export function parseDshSessionLines(
  file: FileWithMtime,
  lines: Iterable<string>,
  platform: NodeJS.Platform = process.platform,
  messages?: TranscriptMessageSink
): AiVaultSession | null {
  const log = readDshLog([...lines])
  return log ? foldDshSession(file, log, platform, messages) : null
}

/**
 * A session row from a read log. Only the session's own history counts: a fork's
 * inherited prefix is its parent's conversation, so it feeds neither the title,
 * the first prompt, the counts nor search. The model is the exception — a fork
 * keeps talking to its parent's model until it sends a request of its own.
 */
export function foldDshSession(
  file: FileWithMtime,
  log: DshLog,
  platform: NodeJS.Platform = process.platform,
  messages?: TranscriptMessageSink
): AiVaultSession | null {
  // Subagent sessions resume only through their parent, so they stay out of the list.
  if (log.header.isSubagent) {
    return null
  }
  const accumulator = createAccumulator({
    agent: 'dsh',
    file,
    sessionId: log.header.id,
    messages
  })
  accumulator.cwd = log.header.cwd
  updateTimeline(accumulator, log.header.createdAt)
  const titles: DshTitleState = { title: null, isFallback: false }
  log.entries.forEach((entry, index) => {
    if (entry.kind === 'model') {
      accumulator.model = entry.model
    } else if (index >= log.ownStart) {
      foldOwnEntry(accumulator, titles, entry)
    }
  })
  // DSH's fallback title is a truncated stub of the first prompt; the normalized prompt reads better.
  if (titles.title && !titles.isFallback) {
    accumulator.title = titles.title
  } else {
    accumulator.fallbackTitle ??= titles.title
  }
  return finalizeSession(accumulator, platform)
}

function foldOwnEntry(
  accumulator: SessionAccumulator,
  titles: DshTitleState,
  entry: DshEntry
): void {
  updateTimeline(accumulator, entry.time)
  switch (entry.kind) {
    case 'user':
      if (isDshTypedPrompt(entry)) {
        accumulator.messageCount++
        const firstText = entry.blocks.find((block) => block.type === 'text')
        if (firstText?.type === 'text') {
          accumulator.fallbackTitle ??= normalizeTitleText(firstText.text)
        }
        addPreviewContent(accumulator, 'user', searchContent(entry.blocks), entry.time)
      }
      break
    case 'assistant':
      foldAssistant(accumulator, entry)
      break
    case 'tool-result':
      publish(accumulator, 'tool', searchContent(entry.blocks), entry.time)
      break
    case 'command':
      publish(
        accumulator,
        'user',
        `/${entry.name}${entry.args ? ` ${entry.args}` : ''}`,
        entry.time
      )
      break
    case 'title':
      // Latest wins, except that a later fallback never replaces a chosen title.
      if (!(entry.fallback && titles.title && !titles.isFallback)) {
        titles.title = entry.title
        titles.isFallback = entry.fallback
      }
      break
    case 'approval-asked':
    case 'approval-decided':
    case 'command-done':
    case 'compaction':
    case 'inherited-boundary':
    case 'model':
    case 'todo':
    case 'turn-end':
    case 'turn-start':
      break
  }
}

function foldAssistant(
  accumulator: SessionAccumulator,
  entry: Extract<DshEntry, { kind: 'assistant' }>
): void {
  accumulator.totalTokens += entry.usage?.totalTokens ?? 0
  if (entry.model) {
    accumulator.model = entry.model
  }
  // Search sees the whole step: reasoning, the reply and the tools it called.
  publish(accumulator, 'assistant', searchContent(entry.blocks), entry.time)
  // The short preview shows replies only; reasoning leads every step and would fill it.
  const reply = entry.blocks
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
  // Tool-call-only steps are not turns a reader recognizes as replies.
  if (!reply.trim()) {
    return
  }
  accumulator.messageCount++
  addPreviewMessage(accumulator, {
    role: 'assistant',
    text: reply,
    timestamp: entry.time,
    publishMessage: false
  })
}

/** Blocks in the shared consumer shape: text-like blocks, then tool calls as `tool_use`. */
function searchContent(blocks: readonly DshBlock[]): unknown[] {
  return blocks.flatMap((block): Record<string, unknown>[] => {
    switch (block.type) {
      case 'text':
      case 'reasoning':
        return [{ type: block.type, text: block.text }]
      case 'tool-call':
        return [{ type: 'tool_use', name: block.name, input: block.input }]
      case 'image':
        return block.name ? [{ type: 'text', text: `[image: ${block.name}]` }] : []
    }
  })
}

function publish(
  accumulator: SessionAccumulator,
  role: 'user' | 'assistant' | 'tool',
  content: unknown,
  time: number | null
): void {
  if (!accumulator.messages.active) {
    return
  }
  for (const message of transcriptMessagesFromContent(role, content, timestampIso(time))) {
    accumulator.messages.push(message)
  }
}

export async function parseDshSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform,
  messages?: TranscriptMessageSink
): Promise<AiVaultSession | null> {
  const { log } = await readDshLogFile(file.path, 'scan')
  return log ? foldDshSession(file, log, platform, messages) : null
}
