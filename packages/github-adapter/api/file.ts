import get from 'lodash.get'

import {
  GitFileMode,
  GitItemType,
  AdapterError,
  Tree,
  CreateSingleTreeItemArgs,
  UnifiedClients,
  FileApiInterface,
  ContentInfo,
  CreateFileContentArgs,
  InputFile,
  CreateBlobInfoArgs,
  BlobInfo,
  GraphQLContentEntry, GetFolderContentArgs, GetFileContentArgs, DeleteFileContentArgs,
} from '../types'

const TYPENAME_BLOB = 'Blob' // used to compare against GraphQL api responses

class FileApi implements FileApiInterface {
  protected clients: UnifiedClients

  constructor(unifiedClients: UnifiedClients) {
    this.clients = unifiedClients
  }

  createSingleTreeItem = ({ path, blob: { sha } }: CreateSingleTreeItemArgs): Tree => ({
    mode: GitFileMode.BLOB,
    type: GitItemType.BLOB,
    path,
    sha,
  }) as Tree & { sha: string | null}

  createTreeItems = (
    blobInfo: CreateSingleTreeItemArgs[] | CreateSingleTreeItemArgs,
    multi?: boolean,
  ): Tree[] => {
    if (!multi) return [this.createSingleTreeItem(blobInfo as CreateSingleTreeItemArgs)]

    return (blobInfo as CreateSingleTreeItemArgs[]).map(this.createSingleTreeItem)
  }

  createBlobInfo = async (args: CreateBlobInfoArgs): Promise<BlobInfo | BlobInfo[]> => {
    const {
      repo,
      owner,
      files,
      multi,
    } = args

    if (!multi) {
      const { path, content } = files as InputFile
      const blob = await this.clients.rest.createBlob({
        repo,
        owner,
        content,
      })

      return { path, blob } as BlobInfo
    }

    const blobPromises = (files as InputFile[]).map(async ({ path, content }) => {
      const blob = await this.clients.rest.createBlob({
        repo,
        owner,
        content,
      })

      return { path, blob } as BlobInfo
    })

    return Promise.all(blobPromises)
  }

  createFileContent = async (args: CreateFileContentArgs): Promise<ContentInfo | ContentInfo[]> => {
    const {
      repo,
      owner,
      branch,
      files,
      commitMessage,
    } = args
    const parentCommitInfo = await this.clients.graphql.getBaseCommitInfo({
      owner,
      repo,
      branch,
    })

    const parentCommit = get(parentCommitInfo, 'repository.ref.target.commitSha')
    const baseTree = get(parentCommitInfo, 'repository.ref.target.tree.sha')
    const multi = Array.isArray(files)

    const blobInfo = await this.createBlobInfo({
      repo,
      owner,
      files,
      multi,
    })

    const treeItems = await this.createTreeItems(blobInfo, multi)

    const { sha: treeSha } = await this.clients.rest.createTree({
      repo,
      owner,
      baseTree,
      treeItems,
    })

    const { sha: commitSha } = await this.clients.rest.createCommit({
      owner,
      repo,
      message: commitMessage,
      tree: treeSha,
      parents: parentCommit ? [parentCommit] : [],
    })

    await this.clients.rest.updateRef({
      owner,
      repo,
      ref: `heads/${branch}`,
      sha: commitSha,
    })

    return multi
      ? (blobInfo as BlobInfo[]).map(({ path, blob: { sha } }) => ({ path, sha })) as ContentInfo[]
      : ({ path: (blobInfo as BlobInfo).path, sha: (blobInfo as BlobInfo).blob.sha }) as ContentInfo
  }

  deleteFileContent = async (args: DeleteFileContentArgs): Promise<boolean> => {
    const {
      repo,
      owner,
      branch,
      path,
      commitMessage,
    } = args
    const parentCommitInfo = await this.clients.graphql.getBaseCommitInfo({ owner, repo, branch })

    const parentCommit = get(parentCommitInfo, 'repository.ref.target.commitSha')
    const baseTree = get(parentCommitInfo, 'repository.ref.target.tree.sha')

    const treeItems = await this.createTreeItems({
      path,
      blob: { sha: null }, // sha=null will be delete the file
    })

    const { sha: treeSha } = await this.clients.rest.createTree({
      repo,
      owner,
      baseTree,
      treeItems,
    })

    const { sha: commitSha } = await this.clients.rest.createCommit({
      owner,
      repo,
      message: commitMessage,
      tree: treeSha,
      parents: parentCommit ? [parentCommit] : [],
    })

    await this.clients.rest.updateRef({
      owner,
      repo,
      ref: `heads/${branch}`,
      sha: commitSha,
    })

    return true
  }

  getFileContent = async (args: GetFileContentArgs): Promise<string> => {
    const {
      owner,
      repo,
      branch,
      path,
    } = args
    const response = await this.clients.graphql.getFileContent({
      owner,
      repo,
      branch,
      path,
    }).catch((errorResponse: any[]) => {
      if (get(errorResponse, 'errors[0].type') === AdapterError.NOT_FOUND) return null

      throw errorResponse
    })

    return get(response, 'repository.ref.target.file.object.text', null)
  }

  getFolderContent = async (args: GetFolderContentArgs): Promise<GraphQLContentEntry[]> => {
    const {
      owner,
      repo,
      branch,
      path,
    } = args

    const response = await this.clients.graphql.getFolderContent({
      owner,
      repo,
      branch,
      path,
    }).catch((errorResponse: any[]) => {
      if (get(errorResponse, 'errors[0].type') === AdapterError.NOT_FOUND) return null

      throw errorResponse
    })

    if (!response) return []

    const entries: GraphQLContentEntry[] = get(response, 'repository.ref.target.files.object.entries') || []
    const filesContent = entries
      .filter((entry: GraphQLContentEntry) => get(entry, 'object.__typename') === TYPENAME_BLOB)

    return filesContent
  }
}

export { FileApi }
