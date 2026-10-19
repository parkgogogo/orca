import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { exportDshTranscript } from './dsh-transcript-export'

const rows = [
  {
    type: 'session',
    version: 4,
    id: 'sess-1',
    createdAt: 1780000000000,
    cwd: '/work',
    isSeeded: false,
    delegationDepth: 0
  },
  {
    type: 'user/message',
    seq: 0,
    data: {
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'Fix the build' }]
    }
  },
  {
    type: 'user/message',
    seq: 1,
    data: {
      role: 'user',
      source: { kind: 'skill-catalog' },
      content: [{ type: 'text', text: 'SKILL LIST' }]
    }
  },
  {
    type: 'assistant/message',
    seq: 2,
    data: {
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'Run the tests first.' },
          { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"pnpm test"}' }
        ]
      }
    }
  },
  {
    type: 'tool/result',
    seq: 3,
    data: {
      message: {
        role: 'tool',
        toolCallId: 'c1',
        isError: true,
        content: [{ type: 'text', text: '1 failed' }]
      }
    }
  },
  {
    type: 'assistant/message',
    seq: 4,
    data: { message: { role: 'assistant', content: [{ type: 'text', text: 'One test fails.' }] } }
  }
]

let home: string
let previousHome: string | undefined

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'orca-dsh-export-'))
  previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
})

afterEach(async () => {
  if (previousHome === undefined) {
    delete process.env.DSH_HOME
  } else {
    process.env.DSH_HOME = previousHome
  }
  await rm(home, { recursive: true, force: true })
})

async function writeLog(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'session.v4.jsonl.zstd')
  await writeFile(
    path,
    Buffer.concat(rows.map((row) => zstdCompressSync(`${JSON.stringify(row)}\n`)))
  )
  return path
}

describe('exportDshTranscript', () => {
  it('writes the conversation as Markdown, without injected context', async () => {
    const filePath = await writeLog(join(home, 'sessions', '--work--', 'sess-1'))
    const { path } = await exportDshTranscript({ filePath, title: 'Build fix' })
    const markdown = await readFile(path!, 'utf8')
    expect(markdown).toContain('# Build fix')
    expect(markdown).toContain('- Working directory: /work')
    expect(markdown).toContain('## User\n\nFix the build')
    expect(markdown).toContain('> Run the tests first.')
    expect(markdown).toContain('**Tool call `bash`**')
    expect(markdown).toContain('### Tool result (error)')
    expect(markdown).toContain('One test fails.')
    expect(markdown).not.toContain('SKILL LIST')
  })

  it('reads only session logs inside the DSH sessions root', async () => {
    const outside = await writeLog(join(home, 'elsewhere', 'sess-1'))
    expect(await exportDshTranscript({ filePath: outside })).toEqual({ path: null })
    expect(await exportDshTranscript({ filePath: join(home, 'sessions', 'notes.txt') })).toEqual({
      path: null
    })
    expect(await exportDshTranscript(undefined)).toEqual({ path: null })
  })
})
