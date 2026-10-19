import { isDshTypedPrompt } from './dsh-log'
import type { DshBlock, DshEntry, DshLog } from './dsh-log-types'

// A readable rendering of a DSH log for another agent to read as context: the
// raw log is zstd frames of event JSON, which an agent cannot open, and which
// would bury the conversation in bookkeeping if it could.

const MAX_TOOL_INPUT_CHARS = 4_000
const MAX_TOOL_OUTPUT_CHARS = 8_000

function fence(text: string, language = ''): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
  const marks = '`'.repeat(Math.max(3, longest + 1))
  return `${marks}${language}\n${text}\n${marks}`
}

function clip(text: string, limit: number): string {
  return text.length > limit
    ? `${text.slice(0, limit)}\n… (${text.length - limit} more characters)`
    : text
}

function texts(blocks: readonly DshBlock[], type: 'text' | 'reasoning'): string {
  return blocks
    .flatMap((block) => (block.type === type ? [block.text] : []))
    .join('\n\n')
    .trim()
}

function images(blocks: readonly DshBlock[]): string[] {
  return blocks.flatMap((block) =>
    block.type === 'image' ? [`[image${block.name ? `: ${block.name}` : ''}]`] : []
  )
}

function entrySection(entry: DshEntry): string | null {
  switch (entry.kind) {
    case 'user': {
      if (!isDshTypedPrompt(entry)) {
        return null
      }
      const body = [texts(entry.blocks, 'text'), ...images(entry.blocks)].filter(Boolean).join('\n')
      return body ? `## User\n\n${body}` : null
    }
    case 'assistant': {
      const parts: string[] = []
      const reasoning = texts(entry.blocks, 'reasoning')
      if (reasoning) {
        parts.push(`*Reasoning:*\n\n${reasoning.replace(/^/gm, '> ')}`)
      }
      const reply = texts(entry.blocks, 'text')
      if (reply) {
        parts.push(reply)
      }
      for (const block of entry.blocks) {
        if (block.type === 'tool-call') {
          const input =
            typeof block.input === 'string' ? block.input : JSON.stringify(block.input, null, 2)
          parts.push(
            `**Tool call \`${block.name}\`**\n\n${fence(clip(input ?? '', MAX_TOOL_INPUT_CHARS), 'json')}`
          )
        }
      }
      return parts.length > 0 ? `## Assistant\n\n${parts.join('\n\n')}` : null
    }
    case 'tool-result': {
      const output = [texts(entry.blocks, 'text'), ...images(entry.blocks)]
        .filter(Boolean)
        .join('\n')
      return `### Tool result${entry.isError ? ' (error)' : ''}\n\n${fence(clip(output, MAX_TOOL_OUTPUT_CHARS))}`
    }
    case 'command':
      return `*Command:* \`/${entry.name}${entry.args ? ` ${entry.args}` : ''}\``
    case 'approval-asked':
      return `*Approval requested${entry.toolName ? ` for ${entry.toolName}` : ''}:* ${entry.reason ?? ''}`.trim()
    case 'approval-decided':
      return `*Approval ${entry.outcome ?? 'decided'}*`
    case 'todo':
      return entry.todos.length > 0
        ? `*Todo list:*\n\n${entry.todos.map((todo) => `- [${todo.status === 'completed' ? 'x' : ' '}] ${todo.content}${todo.status === 'in_progress' ? ' (in progress)' : ''}`).join('\n')}`
        : null
    case 'compaction':
      return '*Context compacted here.*'
    case 'turn-end':
      return entry.reason === 'aborted' ? '*Turn interrupted by the user.*' : null
    case 'command-done':
    case 'inherited-boundary':
    case 'model':
    case 'title':
    case 'turn-start':
      return null
  }
}

export function dshLogMarkdown(log: DshLog, title: string | null): string {
  const lines = [
    `# ${title ?? 'DeepSeek Harness session'}`,
    '',
    `- Session id: ${log.header.id}`,
    ...(log.header.cwd ? [`- Working directory: ${log.header.cwd}`] : []),
    ...(log.header.createdAt ? [`- Started: ${new Date(log.header.createdAt).toISOString()}`] : [])
  ]
  log.entries.forEach((entry, index) => {
    if (index === log.ownStart && index > 0) {
      lines.push(
        '',
        '---',
        '',
        '*Everything above was inherited from the parent session this one was forked from.*'
      )
    }
    const section = entrySection(entry)
    if (section) {
      lines.push('', section)
    }
  })
  return `${lines.join('\n')}\n`
}
