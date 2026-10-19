import { copyFile, link, lstat, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { dshAttachmentObjectPath } from '../ai-vault/session-scanner-dsh-paths'
import type { DshEntry } from '../dsh/session-log/dsh-log-types'
import type { DshImageLocator } from './transcript-dsh-messages'

// DSH stores attachments content-addressed and extensionless, while the chat
// image loader serves a local file only by an image extension (so a renamed
// non-image is never shown). Each attachment the Chat view needs gets a
// `<hash>/<name>.<ext>` hard link here — no copy, and DSH's own store is never written.
// A temp folder is fine: links are recreated on the next read if it is cleaned.

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp'
}

const HASH_OF_ID = /^sha256:([0-9a-f]{64})$/

export function dshAttachmentLinkDir(): string {
  return join(tmpdir(), 'orca-dsh-attachments')
}

/** `<hash>/<original name>`: the hash keeps links unique, the name is what the chat shows. */
function linkPath(
  attachmentId: string,
  mediaType: string | null,
  name: string | null
): string | null {
  const hash = HASH_OF_ID.exec(attachmentId)?.[1]
  const extension = mediaType ? IMAGE_EXTENSIONS[mediaType.toLowerCase()] : undefined
  if (!hash || !extension) {
    return null
  }
  const stem = (name ?? 'image')
    .replace(/\.[^.]*$/, '')
    .replace(/[^\w.-]+/g, '_')
    .slice(0, 80)
  return join(dshAttachmentLinkDir(), hash, `${stem || 'image'}.${extension}`)
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false
  )
}

/**
 * Make every image in `entries` loadable and return a locator for them. An image
 * whose bytes DSH no longer has (or whose type is not an image) is left out, and
 * the Chat view shows its name instead.
 */
export async function prepareDshImages(
  dshHome: string,
  entries: readonly DshEntry[]
): Promise<DshImageLocator> {
  const ready = new Map<string, string>()
  for (const entry of entries) {
    if (entry.kind !== 'user' && entry.kind !== 'tool-result') {
      continue
    }
    for (const block of entry.blocks) {
      if (block.type !== 'image' || !block.attachmentId || ready.has(block.attachmentId)) {
        continue
      }
      const target = linkPath(block.attachmentId, block.mediaType, block.name)
      const source = dshAttachmentObjectPath(dshHome, block.attachmentId)
      if (!target || !source) {
        continue
      }
      if (!(await exists(target))) {
        if (!(await exists(source))) {
          continue
        }
        await mkdir(dirname(target), { recursive: true })
        // Another reader may have linked it first; a cross-volume temp dir needs a copy.
        const linked = await link(source, target).then(
          () => true,
          (error: NodeJS.ErrnoException) =>
            error.code === 'EEXIST' ||
            copyFile(source, target).then(
              () => true,
              () => false
            )
        )
        if (!linked) {
          continue
        }
      }
      ready.set(block.attachmentId, target)
    }
  }
  return (attachmentId) => ready.get(attachmentId) ?? null
}
