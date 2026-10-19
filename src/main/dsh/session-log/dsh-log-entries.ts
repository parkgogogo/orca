import { asRecord, extractString } from '../../ai-vault/session-scanner-values'
import type { DshBlock, DshEntry, DshEntryBody, DshTodo, DshUsage } from './dsh-log-types'

// Message positions per format generation (official session-format codecs):
//  - v4 tool results are first-class `role: 'tool'` messages carrying `toolCallId`;
//  - v0–v3 wrapped them in a `role: 'user'` message holding one `tool-result` block;
//  - released v0 also wrote flat payloads with no `message` envelope.

/** One log record as an entry, or null for bookkeeping that says nothing about the conversation. */
export function dshEntryFromRecord(
  record: Record<string, unknown>,
  version: number
): DshEntry | null {
  // Old packed stream deltas span several sequence slots and are never settled messages.
  if (typeof record.seq0 === 'number') {
    return null
  }
  const seq = typeof record.seq === 'number' ? record.seq : -1
  const time = typeof record.time === 'number' && record.time > 0 ? record.time : null
  const data = asRecord(record.data) ?? {}
  const body = entryBody(record.type, data, version)
  return body ? { ...body, seq, time } : null
}

type EntryBody = DshEntryBody

function entryBody(
  type: unknown,
  data: Record<string, unknown>,
  version: number
): EntryBody | null {
  switch (type) {
    case 'user/message':
      return userBody(data)
    case 'assistant/message':
      return assistantBody(data, version)
    case 'tool/result':
      return toolResultBody(data, version)
    case 'command/run':
      return asRecord(data.source)?.kind === 'user' && extractString(data.name)
        ? {
            kind: 'command',
            commandId: extractString(data.commandId),
            name: extractString(data.name) ?? '',
            args: typeof data.args === 'string' ? data.args : ''
          }
        : null
    case 'command/done':
      return {
        kind: 'command-done',
        commandId: extractString(data.commandId),
        outcome: extractString(data.kind),
        text: typeof data.text === 'string' ? data.text : null
      }
    case 'approval/asked':
      return {
        kind: 'approval-asked',
        id: extractString(data.id),
        toolName: extractString(data.toolName),
        reason: typeof data.reason === 'string' ? data.reason : null
      }
    case 'approval/decided':
      return {
        kind: 'approval-decided',
        id: extractString(data.id),
        outcome: extractString(data.outcome)
      }
    case 'todo/write':
      return { kind: 'todo', todos: todos(data.todos) }
    case 'turn/start':
      return { kind: 'turn-start', turn: integer(data.turn) }
    case 'turn/end':
      return {
        kind: 'turn-end',
        turn: integer(data.turn),
        reason: extractString(asRecord(data.reason)?.kind)
      }
    case 'session/title': {
      const title = extractString(data.title)
      return title
        ? { kind: 'title', title, fallback: asRecord(data.source)?.kind === 'fallback' }
        : null
    }
    case 'request/context': {
      const model = extractString(data.model)
      return model ? { kind: 'model', model, provider: extractString(data.provider) } : null
    }
    case 'request/header': {
      const config = asRecord(asRecord(data.header)?.config)
      const model = extractString(config?.model)
      return model ? { kind: 'model', model, provider: extractString(config?.provider) } : null
    }
    case 'compaction/summary':
      return { kind: 'compaction', summary: typeof data.summary === 'string' ? data.summary : null }
    case 'session/end-seed':
      return data.inherited === true ? { kind: 'inherited-boundary' } : null
    default:
      return null
  }
}

function userBody(data: Record<string, unknown>): EntryBody | null {
  // v0 flat user payloads omit the role; any other role is not a user turn.
  if (data.role !== undefined && data.role !== 'user') {
    return null
  }
  return {
    kind: 'user',
    id: extractString(data.id),
    sourceKind: extractString(asRecord(data.source)?.kind),
    blocks: dshBlocks(data.content)
  }
}

function assistantBody(data: Record<string, unknown>, version: number): EntryBody | null {
  const message = asRecord(data.message)
  const flat = version === 0 && !message
  const source = flat ? asRecord(data.provenance) : asRecord(message?.source)
  if (!flat && (!message || (message.role !== undefined && message.role !== 'assistant'))) {
    return null
  }
  return {
    kind: 'assistant',
    id: extractString(flat ? data.id : message?.id),
    turn: integer(data.turn),
    blocks: dshBlocks(flat ? data.content : message?.content),
    usage: usage(data.usage),
    model: extractString(source?.model),
    provider: extractString(source?.provider),
    interrupted: data.interrupted === true
  }
}

function toolResultBody(data: Record<string, unknown>, version: number): EntryBody | null {
  const message = asRecord(data.message)
  if (version === 0 && !message) {
    return {
      kind: 'tool-result',
      id: extractString(data.id),
      callId: extractString(data.callId),
      blocks: dshBlocks(data.content),
      isError: data.isError === true
    }
  }
  if (!message) {
    return null
  }
  const callId =
    extractString(message.toolCallId) ?? extractString(asRecord(message.source)?.callId)
  if (message.role === 'tool') {
    return {
      kind: 'tool-result',
      id: extractString(message.id),
      callId,
      blocks: dshBlocks(message.content),
      isError: message.isError === true
    }
  }
  const wrapper = Array.isArray(message.content) ? asRecord(message.content[0]) : null
  if (message.role !== 'user' || wrapper?.type !== 'tool-result') {
    return null
  }
  return {
    kind: 'tool-result',
    id: extractString(message.id),
    callId: extractString(wrapper.toolCallId) ?? callId,
    blocks: dshBlocks(wrapper.content),
    isError: wrapper.isError === true
  }
}

/** A content value as blocks; unknown block types are dropped, never guessed at. */
export function dshBlocks(content: unknown): DshBlock[] {
  if (typeof content === 'string') {
    return content.length > 0 ? [{ type: 'text', text: content }] : []
  }
  if (!Array.isArray(content)) {
    return []
  }
  const blocks: DshBlock[] = []
  for (const item of content) {
    const block = dshBlock(item)
    if (block) {
      blocks.push(block)
    }
  }
  return blocks
}

function dshBlock(item: unknown): DshBlock | null {
  if (typeof item === 'string') {
    return item.length > 0 ? { type: 'text', text: item } : null
  }
  const record = asRecord(item)
  const text = typeof record?.text === 'string' && record.text.length > 0 ? record.text : null
  switch (record?.type) {
    case 'text':
      return text ? { type: 'text', text } : null
    case 'reasoning':
    case 'thinking':
      return text ? { type: 'reasoning', text } : null
    case 'tool-call':
      return {
        type: 'tool-call',
        callId: extractString(record.id) ?? extractString(record.toolCallId),
        name: extractString(record.name) ?? 'tool',
        input: toolInput(record.arguments ?? record.input)
      }
    case 'image': {
      const attachment = asRecord(record.attachment)
      return {
        type: 'image',
        attachmentId: extractString(attachment?.attachmentId),
        mediaType: extractString(attachment?.mediaType),
        name: extractString(attachment?.name)
      }
    }
    default:
      return null
  }
}

/** DSH records tool arguments as the model's JSON text; an object reads better when it parses. */
function toolInput(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value ?? {}
  }
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function usage(value: unknown): DshUsage | null {
  const record = asRecord(value)
  if (!record) {
    return null
  }
  const count = (key: string): number => {
    const n = record[key]
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0
  }
  const parts = {
    inputTokens: count('inputTokens'),
    outputTokens: count('outputTokens'),
    cacheReadTokens: count('cacheReadTokens'),
    cacheWriteTokens: count('cacheWriteTokens')
  }
  const sum =
    parts.inputTokens + parts.outputTokens + parts.cacheReadTokens + parts.cacheWriteTokens
  return { ...parts, totalTokens: count('totalTokens') || sum }
}

function todos(value: unknown): DshTodo[] {
  if (!Array.isArray(value)) {
    return []
  }
  const items: DshTodo[] = []
  for (const item of value) {
    const record = asRecord(item)
    const content = extractString(record?.content)
    if (content) {
      items.push({ content, status: extractString(record?.status) ?? 'pending' })
    }
  }
  return items
}

function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null
}
