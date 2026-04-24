/**
 * File message handling for Claude SDK.
 * Downloads server-uploaded files to local filesystem and replaces
 * [File: server-uploads/...] references with local paths so Claude can read them directly.
 */

import { dirname, join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { logger } from '@/lib'
import { configuration } from '@/configuration'

const FILE_PATTERN = /\[File:\s*(server-uploads\/[^\]]+)\]/g

/**
 * Resolve [File: server-uploads/...] references by downloading files to local disk.
 * Returns the message text with references replaced by local file paths.
 */
export async function resolveFileReferences(text: string, workingDirectory: string): Promise<string> {
    const regex = new RegExp(FILE_PATTERN.source, 'g')
    const matches: { full: string; serverPath: string }[] = []
    let match: RegExpExecArray | null

    while ((match = regex.exec(text)) !== null) {
        matches.push({ full: match[0], serverPath: match[1].trim() })
    }

    if (matches.length === 0) return text

    let result = text
    for (const { full, serverPath } of matches) {
        try {
            const url = `${configuration.serverUrl}/cli/${serverPath}`
            const response = await fetch(url, {
                headers: {
                    'Authorization': `Bearer ${configuration.cliApiToken}`,
                    'x-org-id': configuration.orgId,
                },
            })
            if (!response.ok) {
                logger.debug(`[fileMessage] Failed to fetch ${serverPath}: ${response.status}`)
                result = result.replace(full, `[文件下载失败: ${serverPath}]`)
                continue
            }

            const buffer = Buffer.from(await response.arrayBuffer())
            const downloadDir = join(workingDirectory, '.feishu-files')
            const relativePath = serverPath.startsWith('server-uploads/')
                ? serverPath.slice('server-uploads/'.length)
                : (serverPath.split('/').pop() || 'unknown-file')
            const localPath = join(downloadDir, relativePath)
            mkdirSync(dirname(localPath), { recursive: true })
            writeFileSync(localPath, buffer)

            logger.debug(`[fileMessage] Downloaded ${serverPath} → ${localPath} (${buffer.length} bytes)`)
            result = result.replace(full, `[文件: ${localPath}]`)
        } catch (err) {
            logger.debug(`[fileMessage] Failed to download ${serverPath}:`, err)
        }
    }

    return result
}
