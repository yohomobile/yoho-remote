/**
 * Image message parsing and handling for Claude SDK
 * Parses [Image: path] references in messages and converts them to base64 image content
 */

import { readFile } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { logger } from '@/lib'
import { configuration } from '@/configuration'

const IMAGE_PATTERN = /\[Image:\s*([^\]]+)\]/g

export interface ImageContentBlock {
    type: 'image'
    source: {
        type: 'base64'
        media_type: string
        data: string
    }
    [key: string]: unknown
}

export interface TextContentBlock {
    type: 'text'
    text: string
    [key: string]: unknown
}

export type ContentBlock = ImageContentBlock | TextContentBlock

/**
 * Check if a message contains image references
 */
export function hasImageReferences(text: string): boolean {
    return IMAGE_PATTERN.test(text)
}

/**
 * Get MIME type from file extension
 */
function getMimeType(path: string): string {
    const ext = path.toLowerCase().split('.').pop() || ''
    const mimeTypes: Record<string, string> = {
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'png': 'image/png',
        'gif': 'image/gif',
        'webp': 'image/webp',
        'svg': 'image/svg+xml',
        'bmp': 'image/bmp',
        'tiff': 'image/tiff',
        'heic': 'image/heic',
        'heif': 'image/heif'
    }
    return mimeTypes[ext] || 'image/png'
}

/**
 * Fetch image from server-uploads path
 * server-uploads/{sessionId}/{filename} -> fetch from server CLI API
 */
async function fetchServerUploadImage(imagePath: string): Promise<Buffer> {
    // imagePath format: server-uploads/{sessionId}/{filename}
    // Use /cli/ endpoint which accepts CLI_API_TOKEN
    const url = `${configuration.serverUrl}/cli/${imagePath}`

    const response = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${configuration.cliApiToken}`
        }
    })

    if (!response.ok) {
        throw new Error(`Failed to fetch server image: ${response.status} ${response.statusText}`)
    }

    const arrayBuffer = await response.arrayBuffer()
    return Buffer.from(arrayBuffer)
}

/**
 * Parse message text and extract image paths
 */
export function parseImagePaths(text: string): string[] {
    const paths: string[] = []
    const regex = new RegExp(IMAGE_PATTERN.source, 'g')
    let match: RegExpExecArray | null

    while ((match = regex.exec(text)) !== null) {
        paths.push(match[1].trim())
    }

    return paths
}

/**
 * Remove image references from text, returning clean text
 */
export function removeImageReferences(text: string): string {
    return text.replace(IMAGE_PATTERN, '').trim()
}

/**
 * Parse message and build content blocks with images
 * Returns an array of content blocks (text and images) for Claude API
 */
export async function buildMessageContent(
    message: string,
    workingDirectory: string
): Promise<string | ContentBlock[]> {
    // Reset regex state
    const regex = new RegExp(IMAGE_PATTERN.source, 'g')

    // Check if message contains image references
    if (!regex.test(message)) {
        return message
    }

    // Reset regex for actual parsing
    regex.lastIndex = 0

    const contentBlocks: ContentBlock[] = []
    let lastIndex = 0
    let match: RegExpExecArray | null

    while ((match = regex.exec(message)) !== null) {
        // Add text before this image reference
        if (match.index > lastIndex) {
            const textContent = message.slice(lastIndex, match.index).trim()
            if (textContent) {
                contentBlocks.push({
                    type: 'text',
                    text: textContent
                })
            }
        }

        // Process image
        const imagePath = match[1].trim()

        try {
            let imageData: Buffer

            // Check if this is a server-uploads path
            if (imagePath.startsWith('server-uploads/')) {
                // Fetch from server API
                imageData = await fetchServerUploadImage(imagePath)
                logger.debug(`[imageMessage] Fetched server image: ${imagePath}`)
            } else {
                // Local file path
                const fullPath = isAbsolute(imagePath)
                    ? imagePath
                    : join(workingDirectory, imagePath)
                imageData = await readFile(fullPath)
            }

            const base64Data = imageData.toString('base64')
            const mimeType = getMimeType(imagePath)

            // Claude API limit: base64 must be under ~5MB
            const MAX_BASE64_SIZE = 4.5 * 1024 * 1024
            if (base64Data.length > MAX_BASE64_SIZE) {
                logger.debug(`[imageMessage] Image too large for API: ${imagePath} (${(base64Data.length / 1024 / 1024).toFixed(1)}MB base64, limit ${(MAX_BASE64_SIZE / 1024 / 1024).toFixed(1)}MB). Replacing with text description.`)
                contentBlocks.push({
                    type: 'text',
                    text: `[Image too large to display: ${imagePath} (${(imageData.length / 1024 / 1024).toFixed(1)}MB). Please ask the user to send a smaller image.]`
                })
            } else {
                contentBlocks.push({
                    type: 'image',
                    source: {
                        type: 'base64',
                        media_type: mimeType,
                        data: base64Data
                    }
                })
            }

            logger.debug(`[imageMessage] Loaded image: ${imagePath} (${mimeType}, ${base64Data.length} bytes)`)
        } catch (error) {
            logger.debug(`[imageMessage] Failed to load image: ${imagePath}`, error)
            // Add error message as text
            contentBlocks.push({
                type: 'text',
                text: `[Failed to load image: ${imagePath}]`
            })
        }

        lastIndex = match.index + match[0].length
    }

    // Add remaining text after last image reference
    if (lastIndex < message.length) {
        const textContent = message.slice(lastIndex).trim()
        if (textContent) {
            contentBlocks.push({
                type: 'text',
                text: textContent
            })
        }
    }

    // If no content blocks were created, return original message
    if (contentBlocks.length === 0) {
        return message
    }

    return contentBlocks
}
