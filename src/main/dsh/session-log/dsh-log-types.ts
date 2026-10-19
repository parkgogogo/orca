// The DSH session log as Orca reads it: one typed entry per settled event that
// says something about the conversation. Event shapes follow the official
// harness (`@deepseek-ai/dsh` 0.2.0-rc.2: dsh-session, session-format v0→v4).

export type DshHeader = {
  id: string
  cwd: string | null
  createdAt: number | null
  /** Physical format generation, 0–4. */
  version: number
  /** v2+: fork history exists; its cut is the final inherited `session/end-seed`. */
  isSeeded: boolean
  /** v0/v1: the count of leading events inherited from a fork parent. */
  seedLength: number
  /** Delegated children resume only through their parent. */
  isSubagent: boolean
  parentSession: string | null
}

export type DshBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; callId: string | null; name: string; input: unknown }
  | { type: 'image'; attachmentId: string | null; mediaType: string | null; name: string | null }

export type DshUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
}

export type DshTodo = { content: string; status: string }

export type DshEntryBody =
  /** Every user-role message; `sourceKind` tells a typed prompt from injected context. */
  | { kind: 'user'; id: string | null; sourceKind: string | null; blocks: DshBlock[] }
  /** A slash command run by the user or the TUI on the user's behalf. */
  | { kind: 'command'; commandId: string | null; name: string; args: string }
  | { kind: 'command-done'; commandId: string | null; outcome: string | null; text: string | null }
  | {
      kind: 'assistant'
      id: string | null
      turn: number | null
      blocks: DshBlock[]
      usage: DshUsage | null
      model: string | null
      provider: string | null
      interrupted: boolean
    }
  | {
      kind: 'tool-result'
      id: string | null
      callId: string | null
      blocks: DshBlock[]
      isError: boolean
    }
  | { kind: 'approval-asked'; id: string | null; toolName: string | null; reason: string | null }
  | { kind: 'approval-decided'; id: string | null; outcome: string | null }
  | { kind: 'todo'; todos: DshTodo[] }
  | { kind: 'turn-start'; turn: number | null }
  | { kind: 'turn-end'; turn: number | null; reason: string | null }
  | { kind: 'title'; title: string; fallback: boolean }
  | { kind: 'model'; model: string; provider: string | null }
  | { kind: 'compaction'; summary: string | null }
  /** Marks where a fork's inherited prefix ends. */
  | { kind: 'inherited-boundary' }

export type DshEntry = DshEntryBody & {
  /** The event's position in the log; stable across appends. */
  seq: number
  /** Epoch ms, or null when the event carried none. */
  time: number | null
}

export type DshLog = {
  header: DshHeader
  entries: DshEntry[]
  /** Index of the first entry this session owns; earlier entries came from a fork parent. */
  ownStart: number
}
