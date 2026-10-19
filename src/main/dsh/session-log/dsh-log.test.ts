import { readFile } from 'node:fs/promises'
import { zstdCompressSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { readDshLog } from './dsh-log'
import { decodeDshLogChunk } from './dsh-log-lines'
import type { DshEntry } from './dsh-log-types'

const ZSTD_PATH = '/h/.dsh/sessions/--p--/s/session.v4.jsonl.zstd'

function header(version: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'session',
    version,
    id: 's',
    createdAt: 1,
    cwd: '/p',
    delegationDepth: 0,
    ...(version >= 2 ? { isSeeded: false } : {}),
    ...extra
  }
}

function user(seq: number, text: string, kind = 'user'): Record<string, unknown> {
  return {
    type: 'user/message',
    seq,
    time: 1000 + seq,
    data: { id: `u${seq}`, role: 'user', source: { kind }, content: [{ type: 'text', text }] }
  }
}

function endSeed(seq: number, inherited: boolean): Record<string, unknown> {
  return {
    type: 'session/end-seed',
    seq,
    time: 1000 + seq,
    data: inherited ? { inherited: true } : {}
  }
}

const lines = (rows: Record<string, unknown>[]): string[] => rows.map((row) => JSON.stringify(row))
const frames = (rows: Record<string, unknown>[]): Buffer =>
  Buffer.concat(rows.map((row) => zstdCompressSync(Buffer.from(`${JSON.stringify(row)}\n`))))
const ownTexts = (rows: Record<string, unknown>[]): string[] => {
  const log = readDshLog(lines(rows))!
  return log.entries
    .slice(log.ownStart)
    .flatMap((entry) =>
      entry.kind === 'user' && entry.blocks[0]?.type === 'text' ? [entry.blocks[0].text] : []
    )
}

describe('decodeDshLogChunk', () => {
  it('decodes every frame and reports the bytes the complete ones cover', () => {
    const bytes = frames([header(4), user(0, 'one'), user(1, 'two')])
    const chunk = decodeDshLogChunk(ZSTD_PATH, bytes)
    expect(chunk.lines).toHaveLength(3)
    expect(chunk.consumedBytes).toBe(bytes.length)
  })

  it('leaves a frame still being written for the next read', () => {
    const complete = frames([header(4), user(0, 'one')])
    const torn = zstdCompressSync(Buffer.from(`${JSON.stringify(user(1, 'two'))}\n`)).subarray(0, 9)
    const chunk = decodeDshLogChunk(ZSTD_PATH, Buffer.concat([complete, torn]))
    expect(chunk.lines).toHaveLength(2)
    expect(chunk.consumedBytes).toBe(complete.length)
  })

  it('resumes from a consumed offset with only the appended frames', () => {
    const first = frames([header(4)])
    const bytes = Buffer.concat([first, frames([user(0, 'appended')])])
    const chunk = decodeDshLogChunk(ZSTD_PATH, bytes.subarray(first.length))
    expect(chunk.lines.map((line) => JSON.parse(line).type)).toEqual(['user/message'])
  })

  it('withholds a plain record whose newline has not landed', () => {
    const text = `${JSON.stringify(header(4))}\n{"type":"user/mess`
    const chunk = decodeDshLogChunk('/h/session.v4.jsonl', Buffer.from(text))
    expect(chunk.lines).toHaveLength(1)
    expect(chunk.consumedBytes).toBe(text.indexOf('\n') + 1)
  })
})

describe('inherited fork history', () => {
  it('cuts a seeded v2+ session at its LAST inherited marker', () => {
    const rows = [
      header(4, { isSeeded: true }),
      user(0, 'grandparent'),
      endSeed(1, true),
      user(2, 'parent'),
      endSeed(3, true),
      user(4, 'mine')
    ]
    expect(ownTexts(rows)).toEqual(['mine'])
  })

  it('keeps everything when an end-seed only closes constructor setup', () => {
    expect(ownTexts([header(4), user(0, 'first'), endSeed(1, false), user(2, 'second')])).toEqual([
      'first',
      'second'
    ])
  })

  it('never cuts an unseeded header, whatever markers it holds', () => {
    expect(ownTexts([header(3), user(0, 'first'), endSeed(1, true), user(2, 'second')])).toEqual([
      'first',
      'second'
    ])
  })

  it('uses seedLength for v0/v1 forks', () => {
    expect(
      ownTexts([header(1, { seedLength: 2 }), user(0, 'a'), user(1, 'b'), user(2, 'c')])
    ).toEqual(['c'])
  })
})

describe('entries across format generations', () => {
  // Rows from #24681, validated there by the published @deepseek-ai/dsh-session-format-v0-to-v1
  // through v3-to-v4 codecs at 0.2.0-rc.2; human and tool text are synthetic.
  it.each([0, 1, 2, 3, 4])('reads the v%s user prompt and tool result', async (version) => {
    const text = await readFile(
      new URL(`./__fixtures__/dsh-codec-v${version}.jsonl`, import.meta.url),
      'utf8'
    )
    const log = readDshLog(text.trim().split('\n'))!
    expect(log.header.version).toBe(version)
    expect(log.entries.map(({ kind }) => kind)).toEqual(['user', 'tool-result'])
    const result = log.entries[1] as Extract<DshEntry, { kind: 'tool-result' }>
    expect(result.callId).toBe('call-1')
    expect(result.blocks).toEqual([{ type: 'text', text: 'Synthetic official-codec tool output' }])
  })

  it('reads v0 flat assistant and tool payloads', () => {
    const log = readDshLog(
      lines([
        header(0),
        {
          type: 'assistant/message',
          seq: 0,
          data: { content: [{ type: 'text', text: 'hi' }], provenance: { model: 'm' } }
        },
        { type: 'tool/result', seq: 1, data: { callId: 'c', isError: true, content: 'boom' } }
      ])
    )!
    expect(log.entries).toMatchObject([
      { kind: 'assistant', model: 'm', blocks: [{ type: 'text', text: 'hi' }] },
      { kind: 'tool-result', callId: 'c', isError: true, blocks: [{ type: 'text', text: 'boom' }] }
    ])
  })

  it('maps reasoning, parsed tool arguments and image attachments', () => {
    const log = readDshLog(
      lines([
        header(4),
        {
          type: 'assistant/message',
          seq: 0,
          data: {
            message: {
              role: 'assistant',
              source: { kind: 'model', provider: 'p', model: 'm' },
              content: [
                { type: 'reasoning', text: 'think' },
                { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"ls"}' }
              ]
            },
            usage: { inputTokens: 2, outputTokens: 3 }
          }
        },
        {
          type: 'tool/result',
          seq: 1,
          data: {
            message: {
              role: 'tool',
              toolCallId: 'c1',
              content: [
                {
                  type: 'image',
                  attachment: {
                    attachmentId: 'sha256:ab',
                    mediaType: 'image/png',
                    name: 'shot.png'
                  }
                }
              ]
            }
          }
        }
      ])
    )!
    expect(log.entries).toMatchObject([
      {
        kind: 'assistant',
        provider: 'p',
        usage: { totalTokens: 5 },
        blocks: [
          { type: 'reasoning', text: 'think' },
          { type: 'tool-call', callId: 'c1', name: 'bash', input: { command: 'ls' } }
        ]
      },
      {
        kind: 'tool-result',
        callId: 'c1',
        blocks: [{ type: 'image', attachmentId: 'sha256:ab', mediaType: 'image/png' }]
      }
    ])
  })

  it('skips packed stream deltas and refuses a format newer than v4', () => {
    const log = readDshLog(
      lines([header(1), { type: 'assistant/chunk', seq0: 0, data: { texts: ['a'] } }])
    )!
    expect(log.entries).toEqual([])
    expect(() => readDshLog(lines([header(5)]))).toThrow(/newer/)
  })
})
