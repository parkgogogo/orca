import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './helpers/terminal'
import {
  enableNativeChatSetting,
  toggleTerminalTabToChatView
} from './helpers/native-chat-transcript-fixture'

// DSH sessions in Session History and the Chat view, from a disposable DSH home.
// Set ORCA_E2E_DSH_HOME_SOURCE to a real DSH home to run the same flow against a
// copy of its sessions (with ORCA_E2E_DSH_SESSION_ID naming one of them); the
// source is only read.

const SYNTHETIC_ID = '7d3c1e52-4b0a-4e8f-9a61-2f5b8c0d9e14'
const HASH = 'ab'.repeat(32)
// A 1×1 PNG, so the Chat view has a real image to load.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

const source = process.env.ORCA_E2E_DSH_HOME_SOURCE?.trim()
// Playwright also imports this spec in its runner process; only a test worker gets a home.
const inWorker = process.env.TEST_WORKER_INDEX !== undefined
const dshHome = inWorker
  ? mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-dsh-home-'))
  : path.join(os.tmpdir(), 'orca-e2e-dsh-home-unused')
const sessionId = source ? (process.env.ORCA_E2E_DSH_SESSION_ID?.trim() ?? '') : SYNTHETIC_ID
const frame = (row: Record<string, unknown>): Buffer =>
  zstdCompressSync(Buffer.from(`${JSON.stringify(row)}\n`))
const event = (seq: number, type: string, data: Record<string, unknown>) => ({
  type,
  seq,
  time: Date.UTC(2026, 9, 18, 9, 0, seq),
  data
})

function seedSyntheticHome(): string {
  const dir = path.join(dshHome, 'sessions', '--tmp-dsh-e2e--', SYNTHETIC_ID)
  mkdirSync(dir, { recursive: true })
  const objects = path.join(dshHome, 'attachments', 'v1', 'objects', HASH.slice(0, 2))
  mkdirSync(objects, { recursive: true })
  writeFileSync(path.join(objects, HASH), PNG)
  const rows = [
    {
      type: 'session',
      version: 4,
      id: SYNTHETIC_ID,
      createdAt: Date.UTC(2026, 9, 18, 9),
      cwd: '/tmp/dsh-e2e',
      isSeeded: false,
      delegationDepth: 0
    },
    event(0, 'request/context', { provider: 'deepseek-official', model: 'deepseek-flash' }),
    event(1, 'user/message', {
      id: 'u1',
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'Capture the login screen' }]
    }),
    event(2, 'session/title', { title: 'Login screen capture', source: { kind: 'provider' } }),
    event(3, 'assistant/message', {
      message: {
        id: 'a1',
        role: 'assistant',
        source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
        content: [
          { type: 'reasoning', text: 'A screenshot answers this directly.' },
          { type: 'tool-call', id: 'call-1', name: 'screenshot', arguments: '{"display":1}' }
        ]
      },
      usage: { inputTokens: 900, outputTokens: 40, totalTokens: 940 }
    }),
    event(4, 'tool/result', {
      message: {
        id: 't1',
        role: 'tool',
        toolCallId: 'call-1',
        content: [
          { type: 'text', text: 'zebra-window-7 captured' },
          {
            type: 'image',
            attachment: {
              attachmentId: `sha256:${HASH}`,
              mediaType: 'image/png',
              name: 'login.png'
            }
          }
        ]
      }
    }),
    event(5, 'assistant/message', {
      message: {
        id: 'a2',
        role: 'assistant',
        content: [{ type: 'text', text: 'The login screen is captured.' }]
      }
    })
  ]
  const file = path.join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(file, Buffer.concat(rows.map(frame)))
  return file
}

/** The copied session's log path is looked up through Session History once the app runs. */
function copyRealHome(from: string): string {
  // The source is only read; every write in this spec lands in the copy.
  cpSync(path.join(from, 'sessions'), path.join(dshHome, 'sessions'), { recursive: true })
  cpSync(path.join(from, 'attachments'), path.join(dshHome, 'attachments'), { recursive: true })
  return ''
}

const sessionFile = !inWorker ? '' : source ? copyRealHome(source) : seedSyntheticHome()

test.use({ orcaAppExtraEnv: { DSH_HOME: dshHome } })
test.afterAll(() => rmSync(dshHome, { recursive: true, force: true }))
test.skip(Boolean(source) && !sessionId, 'ORCA_E2E_DSH_SESSION_ID names the copied session to open')

test('DSH sessions list, open in the Chat view with tools and images, and follow appends', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const shots = testInfo.outputPath('screenshots')
  mkdirSync(shots, { recursive: true })

  const listed = await orcaPage.evaluate(() =>
    window.api.aiVault.listSessions({ executionHostScope: 'local', limit: 500 })
  )
  const dshRows = listed.sessions.filter((row) => row.agent === 'dsh')
  writeFileSync(
    testInfo.outputPath('dsh-rows.json'),
    JSON.stringify(
      dshRows.map(({ sessionId: id, messageCount, model }) => ({ id, messageCount, model })),
      null,
      2
    )
  )
  const row = dshRows.find((value) => value.sessionId === sessionId)
  expect(row, 'the DSH session is listed').toBeTruthy()
  if (!source) {
    expect(row).toMatchObject({
      title: 'Login screen capture',
      messageCount: 2,
      model: 'deepseek-flash',
      cwd: '/tmp/dsh-e2e'
    })
  }

  // What DSH's hook bridge reports for a running pane: its session id, no transcript path.
  const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
  const [tabId] = descriptor.paneKey.split(':')
  await enableNativeChatSetting(orcaPage)
  await orcaPage.evaluate(
    ({ paneKey, worktreeId, id }) => {
      window.__store
        ?.getState()
        .setAgentStatus(
          paneKey,
          { state: 'done', prompt: '', agentType: 'dsh' },
          'DeepSeek Harness',
          undefined,
          { worktreeId },
          { providerSession: { key: 'session_id', id } }
        )
    },
    { paneKey: descriptor.paneKey, worktreeId: descriptor.worktreeId, id: sessionId }
  )
  await toggleTerminalTabToChatView(orcaPage, { tabId, worktreeId: descriptor.worktreeId })
  const chat = orcaPage.locator('[data-native-chat-root="true"]')
  await expect(chat).toBeVisible({ timeout: 15_000 })
  await expect(orcaPage.getByText('Could not load conversation')).toHaveCount(0)
  if (!source) {
    await expect(chat.getByText('Capture the login screen')).toBeVisible({ timeout: 15_000 })
    await expect(chat.getByText('The login screen is captured.')).toBeVisible()
    await expect(chat.getByText('Used 1 tool')).toBeVisible()
    await expect(chat.getByText('login.png')).toBeVisible({ timeout: 10_000 })
  } else {
    // A real session shows its turns: reasoning rows, tool groups and replies.
    await expect(chat.getByText(/^Reasoning$|^Worked for/).first()).toBeVisible({ timeout: 20_000 })
  }
  await orcaPage.screenshot({ path: path.join(shots, '01-dsh-chat.png') })

  // Live follow: DSH appends a frame per write batch.
  const file =
    sessionFile ||
    (await orcaPage.evaluate(
      (id) =>
        window.api.aiVault
          .listSessions({ executionHostScope: 'local', limit: 500 })
          .then(
            (r) => r.sessions.find((s) => s.agent === 'dsh' && s.sessionId === id)?.filePath ?? ''
          ),
      sessionId
    ))
  appendFileSync(
    file,
    frame(
      event(9001, 'user/message', {
        id: 'u-live',
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Live follow probe quokka' }]
      })
    )
  )
  await expect(chat.getByText('Live follow probe quokka')).toBeVisible({ timeout: 10_000 })
  await orcaPage.screenshot({ path: path.join(shots, '02-dsh-chat-live.png') })

  // Continuing in another agent gets a readable Markdown copy, not the zstd log.
  const exported = await orcaPage.evaluate(
    (filePath) => window.api.aiVault.exportDshTranscript?.({ filePath, title: null }),
    file
  )
  expect(exported?.path).toBeTruthy()
  expect(readFileSync(exported!.path!, 'utf8')).toContain('Live follow probe quokka')
})
