import type { Dirent } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  dshAttachmentObjectPath,
  dshSessionFileGeneration,
  newestDshGenerationName,
  selectDshGenerationEntries
} from './session-scanner-dsh-paths'
import { parseDshSessionLines } from './session-scanner-dsh-parser'
import type { TranscriptMessage } from './session-transcript-consumers'

function entry(name: string, file = true): Dirent {
  return { name, isFile: () => file, isDirectory: () => !file } as Dirent
}

const FILE = { path: '/h/.dsh/sessions/--p--/s/session.v4.jsonl', mtimeMs: 1, modifiedAt: '' }

function parse(rows: Record<string, unknown>[]) {
  const messages: TranscriptMessage[] = []
  const session = parseDshSessionLines(
    FILE,
    rows.map((row) => JSON.stringify(row)),
    'darwin',
    { active: true, push: (message) => messages.push(message) }
  )
  return { session, messages: messages.map(({ role, text }) => [role, text]) }
}

const header = (extra: Record<string, unknown> = {}) => ({
  type: 'session',
  version: 4,
  id: 's',
  createdAt: 1780000000000,
  cwd: '/p',
  isSeeded: false,
  delegationDepth: 0,
  ...extra
})
const prompt = (seq: number, text: string) => ({
  type: 'user/message',
  seq,
  time: 1780000000000 + seq,
  data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }
})

describe('DSH session files', () => {
  it('reads generation 0 and rejects leading zeros', () => {
    expect(dshSessionFileGeneration('/x/session.jsonl.zstd')).toBe(0)
    expect(dshSessionFileGeneration('/x/session.v12.jsonl')).toBe(12)
    expect(dshSessionFileGeneration('/x/session.v04.jsonl')).toBe(-1)
    expect(dshSessionFileGeneration('/x/session.lock')).toBe(-1)
  })

  it('keeps only the newest generation of a session dir', () => {
    const selected = selectDshGenerationEntries([
      entry('session.v3.jsonl.zstd'),
      entry('session.lock'),
      entry('session.v4.jsonl.zstd'),
      entry('child', false)
    ])
    expect(selected.map(({ name }) => name)).toEqual([
      'session.lock',
      'session.v4.jsonl.zstd',
      'child'
    ])
  })

  it('offers neither copy when one generation exists compressed and plain', () => {
    const names = ['session.v4.jsonl', 'session.v4.jsonl.zstd', 'session.v3.jsonl']
    expect(selectDshGenerationEntries(names.map((name) => entry(name)))).toEqual([])
    expect(newestDshGenerationName(names)).toBeNull()
    expect(newestDshGenerationName(['session.v3.jsonl', 'session.v4.jsonl.zstd'])).toBe(
      'session.v4.jsonl.zstd'
    )
  })

  it('locates content-addressed attachments', () => {
    const hex = 'ab'.repeat(32)
    expect(dshAttachmentObjectPath('/h/.dsh', `sha256:${hex}`)).toBe(
      `/h/.dsh/attachments/v1/objects/ab/${hex}`
    )
    expect(dshAttachmentObjectPath('/h/.dsh', 'sha256:../../etc')).toBeNull()
  })
})

describe('DSH session rows', () => {
  it('counts, titles and indexes only what a fork wrote itself', () => {
    const { session, messages } = parse([
      header({ isSeeded: true }),
      prompt(0, 'Parent prompt'),
      {
        type: 'session/title',
        seq: 1,
        data: { title: 'Parent title', source: { kind: 'provider' } }
      },
      { type: 'session/end-seed', seq: 2, data: { inherited: true } },
      prompt(3, 'Fork prompt')
    ])
    expect(session?.title).toBe('Fork prompt')
    expect(session?.messageCount).toBe(1)
    expect(messages).toEqual([['user', 'Fork prompt']])
  })

  it('indexes reasoning, tool calls and tool output for search, but previews replies only', () => {
    const { session, messages } = parse([
      header(),
      prompt(0, 'List files'),
      {
        type: 'assistant/message',
        seq: 1,
        data: {
          message: {
            role: 'assistant',
            content: [
              { type: 'reasoning', text: 'Use ls.' },
              { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"ls -la"}' }
            ]
          }
        }
      },
      {
        type: 'tool/result',
        seq: 2,
        data: {
          message: {
            role: 'tool',
            toolCallId: 'c1',
            content: [{ type: 'text', text: 'README.md' }]
          }
        }
      },
      {
        type: 'assistant/message',
        seq: 3,
        data: { message: { role: 'assistant', content: [{ type: 'text', text: 'One file.' }] } }
      }
    ])
    expect(messages).toEqual([
      ['user', 'List files'],
      ['assistant', 'Use ls.'],
      ['tool', 'bash: ls -la'],
      ['tool', 'README.md'],
      ['assistant', 'One file.']
    ])
    expect(session?.messageCount).toBe(2)
    expect(session?.previewMessages.map(({ role, text }) => [role, text])).toEqual([
      ['user', 'List files'],
      ['assistant', 'One file.']
    ])
  })

  it('takes the model from request context and keeps the latest', () => {
    const { session } = parse([
      header(),
      { type: 'request/context', seq: 0, data: { provider: 'p', model: 'first' } },
      prompt(1, 'Hi'),
      { type: 'request/context', seq: 2, data: { provider: 'p', model: 'second' } }
    ])
    expect(session?.model).toBe('second')
  })
})
