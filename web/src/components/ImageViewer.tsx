import { useState, useCallback, useEffect, useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useYohoRemoteChatContextSafe } from '@/components/AssistantChat/context'

interface ImageViewerProps {
    src: string
    alt?: string
    className?: string
}

export function ImageViewer({ src, alt = 'Image', className = '' }: ImageViewerProps) {
    const [isOpen, setIsOpen] = useState(false)
    const [isLoading, setIsLoading] = useState(true)
    const [hasError, setHasError] = useState(false)
    const context = useYohoRemoteChatContextSafe()
    const modalRef = useRef<HTMLDivElement | null>(null)
    const closeButtonRef = useRef<HTMLButtonElement | null>(null)
    const previousActiveElementRef = useRef<HTMLElement | null>(null)
    const previousOverflowRef = useRef<string>('')

    const handleOpen = useCallback(() => {
        previousActiveElementRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
        previousOverflowRef.current = document.body.style.overflow
        setIsOpen(true)
    }, [])

    const handleClose = useCallback(() => {
        setIsOpen(false)
    }, [])

    const handleKeyDown = useCallback((e: KeyboardEvent) => {
        if (e.key === 'Escape') {
            handleClose()
        }
    }, [handleClose])

    // 复现：打开大图后按 Tab / Shift+Tab，焦点不应离开弹层；Esc 关闭后焦点要回到触发按钮。
    const handleModalKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            handleClose()
            return
        }

        if (event.key !== 'Tab') {
            return
        }

        const root = modalRef.current
        if (!root) {
            return
        }

        const focusable = Array.from(root.querySelectorAll<HTMLElement>(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        )).filter((element) => element.tabIndex >= 0 && !element.hasAttribute('disabled'))

        if (focusable.length === 0) {
            event.preventDefault()
            root.focus()
            return
        }

        const active = document.activeElement
        const currentIndex = focusable.findIndex((element) => element === active)

        if (event.shiftKey) {
            if (currentIndex <= 0) {
                event.preventDefault()
                focusable[focusable.length - 1]?.focus()
            }
            return
        }

        if (currentIndex === -1 || currentIndex === focusable.length - 1) {
            event.preventDefault()
            focusable[0]?.focus()
        }
    }, [handleClose])

    const api = context?.api ?? null

    // 构建带 token 的图片 URL
    const imageUrl = useMemo(() => {
        if (!src || !api) return null
        const token = api.getCurrentToken()
        if (!token) return null

        // server-uploads 路径直接作为 API 路径使用
        let fullPath = src
        if (src.startsWith('server-uploads/')) {
            fullPath = `/api/${src}`
        }

        // 添加 token 到 URL query 参数
        const separator = fullPath.includes('?') ? '&' : '?'
        return `${fullPath}${separator}token=${encodeURIComponent(token)}`
    }, [src, api])

    // 当 src 变化时重置状态
    useEffect(() => {
        setIsLoading(true)
        setHasError(false)
    }, [src])

    useEffect(() => {
        if (!isOpen) return

        document.addEventListener('keydown', handleKeyDown)
        document.body.style.overflow = 'hidden'
        closeButtonRef.current?.focus()
        return () => {
            document.removeEventListener('keydown', handleKeyDown)
            document.body.style.overflow = previousOverflowRef.current
            if (previousActiveElementRef.current?.isConnected) {
                previousActiveElementRef.current.focus({ preventScroll: true })
            }
        }
    }, [isOpen, handleKeyDown])

    const handleImageLoad = useCallback(() => {
        setIsLoading(false)
        setHasError(false)
    }, [])

    const handleImageError = useCallback(() => {
        setIsLoading(false)
        setHasError(true)
    }, [])

    if (!imageUrl) {
        return (
            <div className={`inline-flex items-center gap-1 px-2 py-1 rounded bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 text-xs ${className}`}>
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <polyline points="21 15 16 10 5 21" />
                </svg>
                <span>Loading...</span>
            </div>
        )
    }

    if (hasError) {
        return (
            <div className={`inline-flex items-center gap-1 px-2 py-1 rounded bg-red-100 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-xs ${className}`}>
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <polyline points="21 15 16 10 5 21" />
                </svg>
                <span>Failed to load image</span>
            </div>
        )
    }

    return (
        <>
            <button
                type="button"
                onClick={handleOpen}
                className={`group relative inline-block cursor-pointer rounded-lg overflow-hidden border border-[var(--app-divider)] hover:border-[var(--app-link)] transition-colors ${className}`}
            >
                {isLoading && (
                    <div className="absolute inset-0 flex items-center justify-center bg-[var(--app-secondary-bg)] min-w-16 min-h-16">
                        <svg className="animate-spin" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none">
                            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeOpacity="0.25" />
                            <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                        </svg>
                    </div>
                )}
                <img
                    src={imageUrl}
                    alt={alt}
                    className="max-h-48 max-w-full object-contain"
                    onLoad={handleImageLoad}
                    onError={handleImageError}
                />
                <div className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/20 transition-colors">
                    <div className="opacity-0 group-hover:opacity-100 transition-opacity">
                        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="drop-shadow-lg">
                            <circle cx="11" cy="11" r="8" />
                            <line x1="21" y1="21" x2="16.65" y2="16.65" />
                            <line x1="11" y1="8" x2="11" y2="14" />
                            <line x1="8" y1="11" x2="14" y2="11" />
                        </svg>
                    </div>
                </div>
            </button>

            {isOpen && createPortal(
                <div
                    ref={modalRef}
                    role="dialog"
                    aria-modal="true"
                    aria-label={alt}
                    tabIndex={-1}
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
                    onClick={(event) => {
                        if (event.target === event.currentTarget) {
                            handleClose()
                        }
                    }}
                    onKeyDown={handleModalKeyDown}
                >
                    <button
                        ref={closeButtonRef}
                        type="button"
                        onClick={handleClose}
                        className="absolute top-4 right-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors"
                        aria-label="Close"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                    </button>
                    <img
                        src={imageUrl}
                        alt={alt}
                        onClick={(e) => e.stopPropagation()}
                        className="max-h-[90vh] max-w-[90vw] object-contain rounded-lg shadow-2xl"
                    />
                </div>,
                document.body
            )}
        </>
    )
}

// Parse text for [Image: path], [File: path], [feishu-file: path] patterns and return structured content
const ATTACHMENT_PATTERN = /\[(Image|File|feishu-file):\s*([^\]]+)\]/g

export function parseImagesFromText(text: string): Array<{ type: 'text' | 'image'; content: string }> {
    const imagePattern = /\[Image:\s*([^\]]+)\]/g
    const parts: Array<{ type: 'text' | 'image'; content: string }> = []
    let lastIndex = 0
    let match: RegExpExecArray | null

    while ((match = imagePattern.exec(text)) !== null) {
        // Add text before the image
        if (match.index > lastIndex) {
            const textContent = text.slice(lastIndex, match.index).trim()
            if (textContent) {
                parts.push({ type: 'text', content: textContent })
            }
        }
        // Add the image
        parts.push({ type: 'image', content: match[1].trim() })
        lastIndex = match.index + match[0].length
    }

    // Add remaining text
    if (lastIndex < text.length) {
        const textContent = text.slice(lastIndex).trim()
        if (textContent) {
            parts.push({ type: 'text', content: textContent })
        }
    }

    // If no images found, return the original text
    if (parts.length === 0 && text.trim()) {
        parts.push({ type: 'text', content: text })
    }

    return parts
}

// Check if text contains any image references
export function hasImageReferences(text: string): boolean {
    return /\[Image:\s*[^\]]+\]/.test(text)
}

export function parseAttachmentsFromText(text: string): { textParts: string[]; images: string[]; files: string[] } {
    const regex = new RegExp(ATTACHMENT_PATTERN.source, 'g')
    const textParts: string[] = []
    const images: string[] = []
    const files: string[] = []
    let lastIndex = 0
    let match: RegExpExecArray | null

    while ((match = regex.exec(text)) !== null) {
        if (match.index > lastIndex) {
            const textContent = text.slice(lastIndex, match.index).trim()
            if (textContent) {
                textParts.push(textContent)
            }
        }
        const refType = match[1]?.toLowerCase()
        const refValue = match[2]?.trim()
        if (refType === 'image' && refValue) {
            images.push(refValue)
        } else if (refType === 'feishu-file' && refValue) {
            // Classify by extension
            const ext = refValue.split('.').pop()?.toLowerCase() ?? ''
            if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'heic', 'heif'].includes(ext)) {
                images.push(refValue)
            } else {
                files.push(refValue)
            }
        } else if (refType === 'file' && refValue) {
            files.push(refValue)
        }
        lastIndex = match.index + match[0].length
    }

    if (lastIndex < text.length) {
        const textContent = text.slice(lastIndex).trim()
        if (textContent) {
            textParts.push(textContent)
        }
    }

    if (textParts.length === 0 && images.length === 0 && files.length === 0 && text.trim()) {
        textParts.push(text)
    }

    return { textParts, images, files }
}

export function hasAttachmentReferences(text: string): boolean {
    return new RegExp(ATTACHMENT_PATTERN.source).test(text)
}
