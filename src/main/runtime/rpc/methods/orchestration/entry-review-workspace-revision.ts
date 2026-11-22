import { createHash } from 'node:crypto'
import type { OrcaRuntimeService } from '../../../orca-runtime'

const MAX_ENTRIES = 1_000
const MAX_BYTES = 32 * 1024 * 1024
const CHUNK_BYTES = 128 * 1024

/** A review covers the Git tip, staged and working changes, or the contents of a folder workspace. */
export async function readEntryReviewWorkspaceRevision(
  runtime: OrcaRuntimeService,
  worktreeId: string
): Promise<string> {
  const selector = `id:${worktreeId}`
  const worktree = await runtime.showTerminalWorkspaceLaunchScope(selector)
  const digest = createHash('sha256')
  let entries = 0
  let bytes = 0
  const add = (value: unknown): void => {
    const encoded = JSON.stringify(value)
    bytes += Buffer.byteLength(encoded)
    if (bytes > MAX_BYTES || entries > MAX_ENTRIES) {
      throw new Error('The workspace exceeds the review verification limit.')
    }
    digest.update(`${encoded}\n`)
  }

  if (worktree.folderWorkspace) {
    const directories = ['']
    for (const directory of directories) {
      const children = await runtime.readFileExplorerDir(selector, directory, {
        followSymlinks: false
      })
      for (const child of children) {
        entries++
        const relativePath = directory ? `${directory}/${child.name}` : child.name
        add([relativePath, child.isDirectory])
        if (child.isSymlink) {
          throw new Error('The review cannot verify symbolic links in this folder workspace.')
        }
        if (child.isDirectory) {
          directories.push(relativePath)
          continue
        }
        for (let offset = 0; ;) {
          const chunk = await runtime.readFileExplorerChunk(
            selector,
            relativePath,
            offset,
            CHUNK_BYTES
          )
          add(chunk.contentBase64)
          if (chunk.eof) {
            break
          }
          if (chunk.bytesRead === 0) {
            throw new Error('The review could not read the full workspace file.')
          }
          offset += chunk.bytesRead
        }
      }
    }
  } else {
    const status = await runtime.getRuntimeGitStatus(selector, {
      includeLineStats: false,
      includeIgnored: false
    })
    if (!status.head || status.readError || status.didHitLimit) {
      throw new Error('The review could not read the current Git worktree.')
    }
    add([status.head, status.branch, status.conflictOperation])
    const changes = status.entries.toSorted((a, b) =>
      JSON.stringify([a.path, a.area]).localeCompare(JSON.stringify([b.path, b.area]))
    )
    for (const change of changes) {
      entries++
      add([change.path, change.area, change.status, change.oldPath, change.conflictKind])
      if (change.submodule || change.submoduleRoot || change.conflictKind) {
        throw new Error('The review cannot verify a changed submodule or unresolved conflict.')
      }
      const diff = await runtime.getRuntimeGitDiff(
        selector,
        change.path,
        change.area === 'staged',
        false,
        undefined,
        change.oldPath
      )
      if (
        (diff.kind === 'binary' && (diff.tooLarge || !diff.isImage)) ||
        (diff.kind === 'text' && diff.largeDiffRenderLimit)
      ) {
        throw new Error('The review could not verify the whole changed file.')
      }
      add([diff.originalContent, diff.modifiedContent])
    }
  }
  return digest.digest('hex')
}
