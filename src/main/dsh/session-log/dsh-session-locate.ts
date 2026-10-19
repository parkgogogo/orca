import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { newestDshGenerationName } from '../../ai-vault/session-scanner-dsh-paths'

/**
 * The live log of DSH session `sessionId` under `sessionsDir`
 * (`<sessionsDir>/<encoded-cwd>/<session-id>/session[.vN].jsonl[.zstd]`), or null.
 * The id is DSH's own (the hook bridge reports it as `session_id`), so the
 * encoded cwd directory is the only unknown.
 */
export async function resolveDshSessionFileById(
  sessionsDir: string,
  sessionId: string
): Promise<string | null> {
  const id = sessionId.trim()
  if (!id || id === '.' || id === '..' || /[\\/]/.test(id)) {
    return null
  }
  const projects = await readdir(sessionsDir, { withFileTypes: true }).catch(() => [])
  for (const project of projects) {
    if (!project.isDirectory()) {
      continue
    }
    const sessionDir = join(sessionsDir, project.name, id)
    const names = await readdir(sessionDir).catch(() => null)
    const newest = names ? newestDshGenerationName(names) : null
    if (newest) {
      return join(sessionDir, newest)
    }
  }
  return null
}
