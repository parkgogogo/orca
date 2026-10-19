import { existsSync } from 'node:fs'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import { prepareLegacyTranscriptImport } from './agent-session-journal/journal-legacy-import'
import { resolveSessionFilePath } from './session-file-resolver'
import {
  dshTranscriptPage,
  readDshNativeChatTranscriptFull,
  readDshNativeChatTranscriptTail
} from './transcript-dsh'
import { DSH_INHERITED_HISTORY_TEXT } from './transcript-dsh-messages'
import { subscribeDshNativeChatTranscript } from './transcript-dsh-subscribe'

const SESSION_ID = '0b5c2f6e-9d1a-4c33-8f0e-1d2a3b4c5d6e'
const HASH = 'cd'.repeat(32)
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const frame = (row: Record<string, unknown>): Buffer =>
  zstdCompressSync(Buffer.from(`${JSON.stringify(row)}\n`))

function event(seq: number, type: string, data: Record<string, unknown>): Record<string, unknown> {
  return { type, seq, time: 1780000000000 + seq, data }
}

const prompt = (seq: number, text: string) =>
  event(seq, 'user/message', {
    id: `u${seq}`,
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }]
  })

function conversation(seeded = false): Record<string, unknown>[] {
  return [
    {
      type: 'session',
      version: 4,
      id: SESSION_ID,
      createdAt: 1780000000000,
      cwd: '/p',
      isSeeded: seeded,
      delegationDepth: 0
    },
    prompt(0, 'Take a screenshot'),
    event(1, 'user/message', {
      role: 'user',
      source: { kind: 'runtime-context' },
      content: [{ type: 'text', text: 'injected' }]
    }),
    event(2, 'turn/start', { turn: 1 }),
    event(3, 'assistant/message', {
      turn: 1,
      message: {
        id: 'a1',
        role: 'assistant',
        source: { kind: 'model', provider: 'deepseek', model: 'deepseek-flash' },
        content: [
          { type: 'reasoning', text: 'Call the tool.' },
          { type: 'tool-call', id: 'c1', name: 'screenshot', arguments: '{"display":1}' }
        ]
      },
      usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 5, totalTokens: 17 }
    }),
    event(4, 'tool/result', {
      message: {
        id: 't1',
        role: 'tool',
        toolCallId: 'c1',
        content: [
          { type: 'text', text: 'Captured.' },
          {
            type: 'image',
            attachment: { attachmentId: `sha256:${HASH}`, mediaType: 'image/png', name: 'shot.png' }
          }
        ]
      }
    }),
    event(5, 'todo/write', { todos: [{ content: 'Check it', status: 'completed' }] }),
    ...(seeded ? [event(6, 'session/end-seed', { inherited: true })] : []),
    event(7, 'assistant/message', {
      message: { id: 'a2', role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }
    }),
    event(8, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  ]
}

async function writeSession(rows: Record<string, unknown>[]) {
  const home = await mkdtemp(join(tmpdir(), 'orca-dsh-chat-'))
  roots.push(home)
  const sessionsDir = join(home, 'sessions')
  const dir = join(sessionsDir, '--p--', SESSION_ID)
  await mkdir(dir, { recursive: true })
  await mkdir(join(home, 'attachments', 'v1', 'objects', HASH.slice(0, 2)), { recursive: true })
  await writeFile(join(home, 'attachments', 'v1', 'objects', HASH.slice(0, 2), HASH), PNG)
  const filePath = join(dir, 'session.v4.jsonl.zstd')
  await writeFile(filePath, Buffer.concat(rows.map(frame)))
  return { sessionsDir, filePath }
}

function chatRows(messages: NativeChatMessage[]): unknown[] {
  return messages.map((message) => [
    message.id,
    message.role,
    message.blocks.map((block) => (block.type === 'text' ? block.text : block.type))
  ])
}

describe('DSH Chat transcript', () => {
  it('renders prompts, reasoning, tool calls, results with images, todos and skips injected context', async () => {
    const { filePath } = await writeSession(conversation())
    const read = await readDshNativeChatTranscriptFull('dsh', SESSION_ID, { filePath })
    if ('error' in read) {
      throw new Error(read.error)
    }
    expect(chatRows(read.messages)).toEqual([
      ['u0', 'user', ['Take a screenshot']],
      ['a1:reasoning', 'reasoning', ['Call the tool.']],
      ['a1', 'assistant', ['tool-call']],
      ['t1', 'tool', ['tool-result', 'image-ref']],
      ['dsh-seq:5', 'system', ['[x] Check it']],
      ['a2', 'assistant', ['Done.']]
    ])
    const [call] = read.messages[2].blocks
    expect(call).toMatchObject({ type: 'tool-call', callId: 'c1', input: { display: 1 } })
    expect(read.messages[2]).toMatchObject({
      model: 'deepseek-flash',
      usage: { cacheReadInputTokens: 5 }
    })
    const [result, image] = read.messages[3].blocks
    expect(result).toMatchObject({ type: 'tool-result', callId: 'c1', output: 'Captured.' })
    const imagePath = image.type === 'image-ref' ? image.path : undefined
    expect(imagePath && extname(imagePath)).toBe('.png')
    expect(imagePath && existsSync(imagePath)).toBe(true)
    expect(read.lifecycle).toMatchObject({ state: 'completed', turnId: 'dsh-turn:1' })
  })

  it('marks where a fork stops showing its parent history', async () => {
    const { filePath } = await writeSession(conversation(true))
    const read = await readDshNativeChatTranscriptFull('dsh', SESSION_ID, { filePath })
    if ('error' in read) {
      throw new Error(read.error)
    }
    const divider = read.messages.findIndex((message) =>
      message.blocks.some(
        (block) => block.type === 'text' && block.text === DSH_INHERITED_HISTORY_TEXT
      )
    )
    expect(read.messages[divider + 1]?.id).toBe('a2')
  })

  it('finds the log by the session id the hook reports, and pages by message index', async () => {
    const { sessionsDir, filePath } = await writeSession(conversation())
    expect(await resolveSessionFilePath('dsh', SESSION_ID, { dshSessionsDir: sessionsDir })).toBe(
      filePath
    )
    const newest = await readDshNativeChatTranscriptTail({
      agent: 'dsh',
      sessionId: SESSION_ID,
      dshSessionsDir: sessionsDir,
      limit: 2
    })
    if ('error' in newest) {
      throw new Error(newest.error)
    }
    expect(newest.messages.map(({ id }) => id)).toEqual(['dsh-seq:5', 'a2'])
    expect(newest).toMatchObject({
      hasMore: true,
      beforeOffset: 4,
      lifecycle: { state: 'completed' }
    })
    expect(
      dshTranscriptPage(
        ['a', 'b', 'c'].map((id) => ({ id }) as NativeChatMessage),
        2,
        1
      )
    ).toEqual({
      messages: [{ id: 'a' }],
      hasMore: false,
      beforeOffset: 0
    })
  })

  it('follows appended frames live', async () => {
    const { filePath } = await writeSession(conversation())
    const appended: NativeChatMessage[] = []
    const snapshot = Promise.withResolvers<NativeChatMessage[]>()
    const subscription = subscribeDshNativeChatTranscript({
      agent: 'dsh',
      sessionId: SESSION_ID,
      filePath,
      resolvePollIntervalMs: 20,
      onInitialSnapshot: (messages) => snapshot.resolve(messages),
      onAppend: (messages) => appended.push(...messages)
    })
    try {
      expect(await snapshot.promise).toHaveLength(6)
      await appendFile(filePath, frame(prompt(9, 'One more')))
      await expect.poll(() => appended.map(({ id }) => id), { timeout: 2000 }).toEqual(['u9'])
    } finally {
      subscription.unsubscribe()
    }
  })

  it('imports into the journal through the same reader', async () => {
    const { filePath } = await writeSession(conversation())
    const prepared = await prepareLegacyTranscriptImport({
      agent: 'dsh',
      sessionId: SESSION_ID,
      options: { filePath }
    })
    expect(prepared.ok && prepared.items.length).toBe(6)
  })
})
