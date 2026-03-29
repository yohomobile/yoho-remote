import React from 'react'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { ImageViewer, parseAttachmentsFromText, hasAttachmentReferences } from '@/components/ImageViewer'
import { FileIcon } from '@/components/FileIcon'
import { useYohoRemoteChatContextSafe } from '@/components/AssistantChat/context'

// Build image URL from relative path
function buildImageUrl(path: string, sessionId: string): string {
    // server-uploads 路径直接使用服务器端存储
    if (path.startsWith('server-uploads/')) {
        return `/api/${path}`
    }
    // Handle absolute paths containing server-uploads/ (e.g. from feishu-file tags)
    const suIdx = path.indexOf('server-uploads/')
    if (suIdx >= 0) {
        return `/api/${path.slice(suIdx)}`
    }
    // The image is stored in .yoho-remote/uploads/ directory on the CLI side
    // We need to fetch it through the session file read API
    const encodedPath = encodeURIComponent(path)
    return `/api/sessions/${encodeURIComponent(sessionId)}/file?path=${encodedPath}&raw=true`
}

function buildFileUrl(path: string, sessionId: string): string {
    // Handle server-uploads paths
    if (path.startsWith('server-uploads/')) {
        return `/api/${path}?download=true`
    }
    const suIdx = path.indexOf('server-uploads/')
    if (suIdx >= 0) {
        return `/api/${path.slice(suIdx)}?download=true`
    }
    const encodedPath = encodeURIComponent(path)
    return `/api/sessions/${encodeURIComponent(sessionId)}/file?path=${encodedPath}&raw=true&download=true`
}

function getDisplayNameFromPath(path: string): string {
    const name = path.split('/').pop() ?? path
    return name
        .replace(/-\d{13}(?=\.[^./]+$)/, '')
        .replace(/-\d{13}$/, '')
}

// Component to render images from message
function MessageImages({ images, sessionId }: { images: string[]; sessionId: string }) {
    if (images.length === 0) return null

    return (
        <div className="flex flex-wrap gap-2 mt-2">
            {images.map((imagePath, index) => (
                <ImageViewer
                    key={`${imagePath}-${index}`}
                    src={buildImageUrl(imagePath, sessionId)}
                    alt={`Uploaded image ${index + 1}`}
                />
            ))}
        </div>
    )
}

function MessageFiles({ files, sessionId }: { files: string[]; sessionId: string }) {
    if (files.length === 0) return null

    return (
        <div className="flex flex-col gap-2 mt-2">
            {files.map((filePath, index) => {
                const displayName = getDisplayNameFromPath(filePath)
                return (
                    <a
                        key={`${filePath}-${index}`}
                        href={buildFileUrl(filePath, sessionId)}
                        download
                        className="inline-flex items-center gap-2 rounded-lg border border-[var(--app-divider)] bg-[var(--app-secondary-bg)] px-2 py-1 text-xs text-[var(--app-fg)] hover:border-[var(--app-link)]"
                        title={filePath}
                    >
                        <FileIcon fileName={displayName} size={16} />
                        <span className="truncate">{displayName}</span>
                        <span className="ml-auto text-[10px] text-[var(--app-hint)]">下载</span>
                    </a>
                )
            })}
        </div>
    )
}

export function LazyRainbowText(props: { text: string }) {
    const text = props.text

    // Get context for building image URLs (safe version that won't throw)
    const context = useYohoRemoteChatContextSafe()
    const sessionId = context?.sessionId ?? ''

    // Check for attachment references
    const containsAttachments = hasAttachmentReferences(text)

    // If text contains attachments, parse and render them separately
    if (containsAttachments && sessionId) {
        const { textParts, images, files } = parseAttachmentsFromText(text)
        const textContent = textParts.join('\n\n')

        return (
            <div>
                {textContent && (
                    <MarkdownRenderer content={textContent} />
                )}
                <MessageImages images={images} sessionId={sessionId} />
                <MessageFiles files={files} sessionId={sessionId} />
            </div>
        )
    }

    return (
        <div>
            <MarkdownRenderer content={text} />
        </div>
    )
}
