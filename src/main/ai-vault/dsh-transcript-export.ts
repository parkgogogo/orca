import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, isAbsolute } from 'node:path'
import type {
  AiVaultExportDshTranscriptArgs,
  AiVaultExportDshTranscriptResult
} from '../../shared/ai-vault-types'
import { readDshLogFile } from '../dsh/session-log/dsh-log-file'
import { dshLogMarkdown } from '../dsh/session-log/dsh-log-markdown'
import { isDshSessionFilePath, resolveDshSessionsDir } from './session-scanner-dsh-paths'

export function dshTranscriptExportDir(): string {
  return join(tmpdir(), 'orca-dsh-transcripts')
}

/** Whether `filePath` is a session log inside this host's DSH sessions root, links resolved. */
async function isLocalDshSessionLog(filePath: string): Promise<boolean> {
  if (!isAbsolute(filePath) || !isDshSessionFilePath(filePath)) {
    return false
  }
  try {
    const [root, target] = await Promise.all([
      realpath(resolveDshSessionsDir()),
      realpath(filePath)
    ])
    const inside = relative(root, target)
    return inside.length > 0 && !inside.startsWith('..') && !isAbsolute(inside)
  } catch {
    return false
  }
}

/**
 * Write a DSH session as Markdown another agent can read, and return its path.
 * Continuing a DSH session in another agent hands that agent a transcript path;
 * the raw log is zstd frames of event JSON, so it gets this rendering instead.
 * Only logs under the local DSH sessions root are read; anything else is null.
 */
export async function exportDshTranscript(
  args: AiVaultExportDshTranscriptArgs | undefined
): Promise<AiVaultExportDshTranscriptResult> {
  const filePath = typeof args?.filePath === 'string' ? args.filePath.trim() : ''
  if (!filePath || !(await isLocalDshSessionLog(filePath))) {
    return { path: null }
  }
  try {
    const { log } = await readDshLogFile(filePath, 'exact')
    if (!log) {
      return { path: null }
    }
    const title = typeof args?.title === 'string' && args.title.trim() ? args.title.trim() : null
    const dir = dshTranscriptExportDir()
    await mkdir(dir, { recursive: true })
    const path = join(dir, `${log.header.id.replace(/[^\w.-]/g, '_')}.md`)
    await writeFile(path, dshLogMarkdown(log, title), 'utf8')
    return { path }
  } catch {
    return { path: null }
  }
}
