import { watch, type FSWatcher } from 'node:fs'
import { dirname } from 'node:path'
import { dshHomeFromSessionFilePath } from '../ai-vault/session-scanner-dsh-paths'
import { errorMessage } from '../ai-vault/session-scanner-values'
import { readDshLogAppend } from '../dsh/session-log/dsh-log-file'
import { resolveSessionFilePath } from './session-file-resolver'
import { readDshTranscriptFile, dshTranscriptPage, type DshTranscript } from './transcript-dsh'
import { prepareDshImages } from './transcript-dsh-attachments'
import { dshEntryMessages, dshTurnLifecycle } from './transcript-dsh-messages'
import {
  DESKTOP_READ_WINDOW,
  UNFLUSHED_SETTLE_MS,
  type NativeChatTranscriptSubscription,
  type SubscribeNativeChatTranscriptArgs
} from './transcript-watch-contract'

// The watcher wakes a read as soon as DSH appends; the poll is the backstop for
// filesystems whose events are unreliable, and the occasional re-resolve notices
// DSH moving the session to a newer format generation.
const DSH_POLL_MS = 1_000
const DSH_WATCH_DEBOUNCE_MS = 100
const DSH_RERESOLVE_EVERY_TICKS = 10

export function subscribeDshNativeChatTranscript(
  args: SubscribeNativeChatTranscriptArgs,
  setupSignal?: AbortSignal
): NativeChatTranscriptSubscription {
  setupSignal?.throwIfAborted()
  const initialLimit =
    args.initialLimit && args.initialLimit > 0 ? args.initialLimit : DESKTOP_READ_WINDOW
  const pollMs = args.resolvePollIntervalMs ?? DSH_POLL_MS
  let closed = false
  let running = false
  let rerun = false
  let ticks = 0
  let path: string | null = null
  let state: DshTranscript | null = null
  let snapshotSent = false
  let watcher: FSWatcher | null = null
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let wakeTimer: ReturnType<typeof setTimeout> | null = null
  const settleTimer = args.onTranscriptPending
    ? setTimeout(() => {
        if (!closed && !snapshotSent) {
          safely(() => args.onTranscriptPending?.())
        }
      }, UNFLUSHED_SETTLE_MS)
    : null
  settleTimer?.unref?.()

  function safely(run: () => void): void {
    try {
      run()
    } catch (error) {
      console.warn(`DSH native-chat subscriber threw; following continues. ${errorMessage(error)}`)
    }
  }

  function schedule(): void {
    if (!closed) {
      pollTimer = setTimeout(() => void tick(), pollMs)
      pollTimer.unref?.()
    }
  }

  function wake(): void {
    if (closed || wakeTimer) {
      return
    }
    wakeTimer = setTimeout(() => {
      wakeTimer = null
      void tick()
    }, DSH_WATCH_DEBOUNCE_MS)
    wakeTimer.unref?.()
  }

  function watchDirectory(file: string): void {
    watcher?.close()
    try {
      watcher = watch(dirname(file), { persistent: false }, wake)
      watcher.on('error', () => undefined)
    } catch {
      watcher = null // polling alone still follows the log
    }
  }

  async function readWhole(file: string, replace: boolean): Promise<void> {
    state = await readDshTranscriptFile(file)
    if (!state.log) {
      state = null // header not written yet
      return
    }
    const page = dshTranscriptPage(state.messages, initialLimit)
    const lifecycle = state.lifecycle ?? undefined
    if (replace) {
      safely(() => args.onReplace?.(page.messages, page.hasMore, page.beforeOffset, lifecycle))
    } else {
      snapshotSent = true
      safely(() =>
        args.onInitialSnapshot?.(
          page.messages,
          page.hasMore,
          page.beforeOffset,
          undefined,
          lifecycle
        )
      )
    }
  }

  async function step(): Promise<void> {
    const resolved =
      args.filePath ??
      (path && ticks % DSH_RERESOLVE_EVERY_TICKS !== 0
        ? path
        : await resolveSessionFilePath(args.agent, args.sessionId, args))
    if (!resolved || closed) {
      return
    }
    if (resolved !== path) {
      const moved = path !== null
      path = resolved
      watchDirectory(resolved)
      await readWhole(resolved, moved && snapshotSent)
      return
    }
    if (!state?.log) {
      await readWhole(resolved, false)
      return
    }
    const append = await readDshLogAppend(resolved, state.log, state.consumedBytes)
    if (append.kind === 'rewritten') {
      await readWhole(resolved, true)
    } else if (append.kind === 'appended') {
      state.consumedBytes = append.consumedBytes
      const locateImage = await prepareDshImages(
        dshHomeFromSessionFilePath(resolved),
        append.entries
      )
      const messages = append.entries.flatMap((entry) => dshEntryMessages(entry, locateImage))
      state.messages.push(...messages)
      const lifecycle = dshTurnLifecycle(append.entries)
      if (messages.length > 0 || lifecycle) {
        safely(() => args.onAppend(messages, lifecycle ?? undefined))
      }
    }
  }

  async function tick(): Promise<void> {
    if (closed) {
      return
    }
    if (running) {
      rerun = true
      return
    }
    running = true
    if (pollTimer) {
      clearTimeout(pollTimer)
      pollTimer = null
    }
    try {
      await step()
      ticks++
    } catch (error) {
      if (!snapshotSent && !closed) {
        snapshotSent = true
        safely(() => args.onInitialSnapshot?.([], false, 0, errorMessage(error)))
      }
    } finally {
      running = false
    }
    if (rerun) {
      rerun = false
      void tick()
    } else {
      schedule()
    }
  }

  function unsubscribe(): void {
    closed = true
    for (const timer of [pollTimer, wakeTimer, settleTimer]) {
      if (timer) {
        clearTimeout(timer)
      }
    }
    watcher?.close()
    watcher = null
    setupSignal?.removeEventListener('abort', unsubscribe)
  }

  setupSignal?.addEventListener('abort', unsubscribe, { once: true })
  void tick()
  return { unsubscribe, watching: true }
}
