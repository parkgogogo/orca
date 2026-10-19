// DSH session-log entries → NativeChatMessage, for the Chat view of a DSH session.
//
// Unlike the line decoders this works on parsed entries: a compressed DSH log
// has no per-line byte cursor, and a fork's inherited prefix is only known once
// the whole head is read. Ids are DSH's own message ids, so re-reads and live
// appends key the same rows.

import type { AgentSessionTokenUsage } from '../../shared/agent-session-context-usage'
import {
  NATIVE_CHAT_INTERRUPTED_STATUS_TEXT,
  type NativeChatBlock,
  type NativeChatMessage,
  type NativeChatTurnLifecycle
} from '../../shared/native-chat-types'
import { isDshTypedPrompt } from '../dsh/session-log/dsh-log'
import type { DshBlock, DshEntry, DshLog, DshUsage } from '../dsh/session-log/dsh-log-types'

/** Where an attachment can be shown from, or null when it cannot be. */
export type DshImageLocator = (attachmentId: string, mediaType: string | null) => string | null

export const DSH_INHERITED_HISTORY_TEXT = 'Earlier messages were inherited from the parent session'

const TODO_MARKS: Record<string, string> = { completed: '[x]', in_progress: '[~]' }

/** Every message of a whole log, with a divider where a fork's own history begins. */
export function dshLogMessages(log: DshLog, locateImage: DshImageLocator): NativeChatMessage[] {
  const messages: NativeChatMessage[] = []
  log.entries.forEach((entry, index) => {
    if (index === log.ownStart && index > 0) {
      messages.push(
        systemMessage(`dsh:${log.header.id}:inherited`, DSH_INHERITED_HISTORY_TEXT, entry.time)
      )
    }
    messages.push(...dshEntryMessages(entry, locateImage))
  })
  return messages
}

export function dshEntryMessages(
  entry: DshEntry,
  locateImage: DshImageLocator
): NativeChatMessage[] {
  const id = (own: string | null): string => own ?? `dsh-seq:${entry.seq}`
  switch (entry.kind) {
    case 'user': {
      if (!isDshTypedPrompt(entry)) {
        // Runtime context, skill catalogs, approval notices: DSH injects them; nobody typed them.
        return []
      }
      const blocks = contentBlocks(entry.blocks, locateImage)
      return blocks.length > 0 ? [message(id(entry.id), 'user', blocks, entry.time)] : []
    }
    case 'assistant':
      return assistantMessages(id(entry.id), entry, locateImage)
    case 'tool-result':
      return [toolResultMessage(id(entry.id), entry, locateImage)]
    case 'command':
      return [
        systemMessage(id(null), `/${entry.name}${entry.args ? ` ${entry.args}` : ''}`, entry.time)
      ]
    case 'approval-asked':
      return [
        systemMessage(
          id(null),
          `Approval requested${entry.toolName ? ` for ${entry.toolName}` : ''}${entry.reason ? `: ${entry.reason}` : ''}`,
          entry.time
        )
      ]
    case 'approval-decided':
      return [systemMessage(id(null), `Approval ${entry.outcome ?? 'decided'}`, entry.time)]
    case 'todo':
      return entry.todos.length > 0
        ? [
            systemMessage(
              id(null),
              entry.todos
                .map((todo) => `${TODO_MARKS[todo.status] ?? '[ ]'} ${todo.content}`)
                .join('\n'),
              entry.time
            )
          ]
        : []
    case 'compaction':
      return [
        message(
          id(null),
          'system',
          [{ type: 'text', text: 'Context compacted', presentation: 'compaction' }],
          entry.time
        )
      ]
    case 'turn-end':
      return entry.reason === 'aborted'
        ? [systemMessage(id(null), NATIVE_CHAT_INTERRUPTED_STATUS_TEXT, entry.time)]
        : []
    case 'command-done':
    case 'inherited-boundary':
    case 'model':
    case 'title':
    case 'turn-start':
      return []
  }
}

/** Reasoning is its own row (sharing the reply's identity), as the other providers' readers do. */
function assistantMessages(
  id: string,
  entry: Extract<DshEntry, { kind: 'assistant' }>,
  locateImage: DshImageLocator
): NativeChatMessage[] {
  const reasoning: NativeChatBlock[] = entry.blocks.flatMap((block) =>
    block.type === 'reasoning' ? [{ type: 'text' as const, text: block.text }] : []
  )
  const blocks = contentBlocks(entry.blocks, locateImage)
  const messages: NativeChatMessage[] = []
  if (reasoning.length > 0) {
    messages.push(
      message(blocks.length > 0 ? `${id}:reasoning` : id, 'reasoning', reasoning, entry.time)
    )
  }
  if (blocks.length > 0) {
    const usage = tokenUsage(entry.usage)
    messages.push({
      ...message(id, 'assistant', blocks, entry.time),
      ...(entry.model ? { model: entry.model } : {}),
      ...(entry.provider ? { provider: entry.provider } : {}),
      ...(usage && !entry.interrupted ? { usage } : {})
    })
  }
  return messages
}

function toolResultMessage(
  id: string,
  entry: Extract<DshEntry, { kind: 'tool-result' }>,
  locateImage: DshImageLocator
): NativeChatMessage {
  const output = entry.blocks
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
  const images = contentBlocks(
    entry.blocks.filter((block) => block.type === 'image'),
    locateImage
  )
  return message(
    id,
    'tool',
    [
      {
        type: 'tool-result',
        output,
        ...(entry.isError ? { isError: true } : {}),
        ...(entry.callId ? { callId: entry.callId } : {})
      },
      ...images
    ],
    entry.time
  )
}

/** Text, tool calls and images; reasoning is left to its own row. */
function contentBlocks(
  blocks: readonly DshBlock[],
  locateImage: DshImageLocator
): NativeChatBlock[] {
  const result: NativeChatBlock[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      result.push({ type: 'text', text: block.text })
    } else if (block.type === 'tool-call') {
      result.push({
        type: 'tool-call',
        name: block.name,
        input: block.input,
        ...(block.callId ? { callId: block.callId } : {})
      })
    } else if (block.type === 'image') {
      const path = block.attachmentId ? locateImage(block.attachmentId, block.mediaType) : null
      result.push(
        path
          ? { type: 'image-ref', path, ...(block.name ? { alt: block.name } : {}) }
          : { type: 'text', text: `[image${block.name ? `: ${block.name}` : ''}]` }
      )
    }
  }
  return result
}

function tokenUsage(usage: DshUsage | null): AgentSessionTokenUsage | null {
  return usage
    ? {
        inputTokens: usage.inputTokens,
        cacheCreationInputTokens: usage.cacheWriteTokens,
        cacheReadInputTokens: usage.cacheReadTokens,
        outputTokens: usage.outputTokens
      }
    : null
}

function message(
  id: string,
  role: NativeChatMessage['role'],
  blocks: NativeChatBlock[],
  time: number | null
): NativeChatMessage {
  return { id, role, blocks, timestamp: time, source: 'transcript' }
}

function systemMessage(id: string, text: string, time: number | null): NativeChatMessage {
  return message(id, 'system', [{ type: 'text', text }], time)
}

/** The latest turn boundary in `entries`, for the Chat view's working/done state. */
export function dshTurnLifecycle(entries: readonly DshEntry[]): NativeChatTurnLifecycle | null {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    if (entry.kind === 'turn-start') {
      return {
        state: 'working',
        turnId: `dsh-turn:${entry.turn ?? entry.seq}`,
        timestamp: entry.time
      }
    }
    if (entry.kind === 'turn-end') {
      return {
        state: entry.reason === 'aborted' ? 'interrupted' : 'completed',
        turnId: `dsh-turn:${entry.turn ?? entry.seq}`,
        timestamp: entry.time
      }
    }
  }
  return null
}
