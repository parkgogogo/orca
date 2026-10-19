import type { AgentSessionContinuationRequest } from '@/lib/agent-session-continuation'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'

export function canContinueAiVaultSessionInNewSession(
  session: AiVaultSession,
  targetWorktreeId: string | null | undefined
): boolean {
  return Boolean(
    targetWorktreeId &&
    (vaultTranscriptPath(session) || session.previewMessages.some((message) => message.text.trim()))
  )
}

export function prepareAiVaultSessionContinuation(args: {
  session: AiVaultSession
  targetWorktreeId: string
  targetWorkspacePath: string
  /** A readable transcript prepared for the next agent, in place of the session's own file. */
  transcriptPath?: string | null
}): AgentSessionContinuationRequest {
  const { session, targetWorktreeId, targetWorkspacePath } = args
  return {
    source: {
      capturedText: previewTranscript(session),
      sourceAgent: session.agent,
      sourceTitle: session.title,
      sourceWorkingDirectory: session.cwd,
      transcriptPath:
        args.transcriptPath !== undefined ? args.transcriptPath : vaultTranscriptPath(session),
      // Why: preview user entries can be tool results or injected skill text; only provider-authenticated prompts are safe hints.
      lastPrompt: session.lastUserPrompt ?? null,
      lastAssistantMessage: latestAssistantPreview(session)
    },
    worktreeId: targetWorktreeId,
    workspacePath: targetWorkspacePath,
    // Why: sessions can outlive their worktree selection, but continuation should preserve their recorded cwd.
    initialCwd: session.cwd || targetWorkspacePath,
    launchSource: 'sidebar'
  }
}

function latestAssistantPreview(session: AiVaultSession): string | null {
  return session.previewMessages.findLast((message) => message.role === 'assistant')?.text ?? null
}

function previewTranscript(session: AiVaultSession): string {
  return session.previewMessages
    .filter((message) => message.text.trim())
    .map((message) => `${message.role}: ${message.text.trim()}`)
    .join('\n\n')
}

function vaultTranscriptPath(session: AiVaultSession): string | null {
  // OpenCode vault paths identify its database or storage metadata, not a full transcript.
  // A DSH log is zstd frames another agent cannot read; see exportAiVaultDshTranscript.
  if (session.agent === 'opencode' || session.agent === 'opencode2' || session.agent === 'dsh') {
    return null
  }
  return session.filePath.trim() || null
}

/**
 * A Markdown copy of a local DSH session for the next agent to read, or null
 * (remote row, older host, unreadable log) to fall back to the preview text.
 */
export async function exportAiVaultDshTranscript(session: AiVaultSession): Promise<string | null> {
  const exportTranscript = window.api.aiVault.exportDshTranscript
  if (
    session.agent !== 'dsh' ||
    session.executionHostId !== LOCAL_EXECUTION_HOST_ID ||
    typeof exportTranscript !== 'function'
  ) {
    return null
  }
  try {
    return (await exportTranscript({ filePath: session.filePath, title: session.title })).path
  } catch {
    return null
  }
}
