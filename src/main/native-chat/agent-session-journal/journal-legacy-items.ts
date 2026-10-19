import type { AgentType } from '../../../shared/agent-status-types'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import type { NativeChatBlock, NativeChatMessage } from '../../../shared/native-chat-types'
import { boundSubagentEntryId } from '../subagent-entry-id-bounds'
import type { JournalReplacementItem } from './journal-epoch-replacement'
import {
  boundInlineText,
  boundToolInput,
  type JournalPayloadLimits
} from './journal-payload-bounds'

// Bridge-era transcript messages as journal replacement items, bounded the way
// live events are. Split from journal-legacy-import.ts for its line budget.

const MAX_LEGACY_IMPORT_SUBAGENTS = 64

/** Messages whose provider ids are stable, so the ids are the import identities. */
export function importedMessages(
  input: { agent: AgentType; sessionId: string },
  messages: readonly NativeChatMessage[],
  limits: JournalPayloadLimits,
  sourceEmpty: boolean
): { ok: true; items: JournalReplacementItem[]; sourceEmpty: boolean } {
  const identities = messages.map((message): AgentJournalItemIdentity => ({
    provider: 'legacy',
    agent: input.agent,
    sessionId: input.sessionId,
    recordId: message.id
  }))
  return { ok: true, items: replacementItems(messages, identities, limits), sourceEmpty }
}

export function replacementItems(
  messages: readonly NativeChatMessage[],
  identities: readonly AgentJournalItemIdentity[],
  limits: JournalPayloadLimits
): JournalReplacementItem[] {
  const replacement: JournalReplacementItem[] = []
  for (const [index, message] of messages.entries()) {
    const identity = identities[index]
    if (identity) {
      replacement.push(replacementItem(message, identity, limits))
    }
  }
  return replacement
}

export function replacementItem(
  message: NativeChatMessage,
  identity: AgentJournalItemIdentity,
  limits: JournalPayloadLimits
): JournalReplacementItem {
  return {
    identity,
    body: legacyItemBody(message, limits),
    observedAt: message.timestamp ?? undefined,
    // Imported history is no generation's work: never current, whatever it says still runs.
    ownerFence: 0
  }
}

/**
 * A message whose only content is a tool invocation becomes a tool-call item so
 * the reducer renders it as one. Everything else stays a message item with its
 * blocks bounded in place.
 */
function legacyItemBody(
  message: NativeChatMessage,
  limits: JournalPayloadLimits
): AgentJournalItemBody {
  const only = message.blocks.length === 1 ? message.blocks[0] : undefined
  if (only?.type === 'tool-call') {
    // Legacy transcripts are untrusted and can contain arbitrarily large tool
    // arguments. Keep them on the same bounded path as live events before the
    // replacement epoch is published.
    return {
      kind: 'tool-call',
      name: only.name,
      input: boundToolInput(only.input, limits),
      ...(only.callId !== undefined ? { callId: only.callId } : {}),
      state: 'completed'
    }
  }
  return {
    kind: 'message',
    role: message.role,
    blocks: message.blocks.map((block) => boundBlock(block, limits))
  }
}

/** Every block that can carry untrusted bulk is bounded here, tool calls
 *  included: a provider decoder is free to put one alongside narration, and the
 *  sole-block path above never sees those. The remainder is discarded rather
 *  than stored elsewhere — the marker keeps its digest and byte length, and the
 *  source transcript remains the full copy. */
function boundBlock(block: NativeChatBlock, limits: JournalPayloadLimits): NativeChatBlock {
  if (block.type === 'text') {
    return { ...block, text: boundInlineText(block.text, limits).text }
  }
  if (block.type === 'tool-result') {
    return { ...block, output: boundInlineText(block.output, limits).text }
  }
  if (block.type === 'tool-call') {
    return { ...block, input: boundToolInput(block.input, limits) }
  }
  if (block.type === 'subagent-group') {
    return {
      ...block,
      agents: block.agents.slice(0, MAX_LEGACY_IMPORT_SUBAGENTS).map((agent) => ({
        ...agent,
        // The id is the roster key, so it is bounded with a digest rather than
        // clipped to a prefix that two distinct children could share.
        id: boundSubagentEntryId(agent.id),
        label: boundInlineText(agent.label, limits).text
      }))
    }
  }
  return block
}
