import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useQuery } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'
import { useKeycloakAuth } from '@/hooks/useKeycloakAuth'
import { useConfig } from '@/hooks/useConfig'
import type { SessionDownloadFile } from '@/types/api'

function DownloadIcon({ size = 16 }: { size?: number }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
    )
}

function FileIcon({ mimeType }: { mimeType: string }) {
    const isImage = mimeType.startsWith('image/')
    const isText = mimeType.startsWith('text/') || mimeType === 'application/json'
    const isPdf = mimeType === 'application/pdf'

    if (isImage) {
        return (
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <polyline points="21 15 16 10 5 21" />
            </svg>
        )
    }
    if (isPdf) {
        return (
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
            </svg>
        )
    }
    if (isText) {
        return (
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
                <polyline points="10 9 9 9 8 9" />
            </svg>
        )
    }
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
            <polyline points="13 2 13 9 20 9" />
        </svg>
    )
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function DownloadButton({ sessionId }: { sessionId: string }) {
    const { baseUrl } = useConfig()
    const { api: apiClient } = useKeycloakAuth(baseUrl)
    const [open, setOpen] = useState(false)
    const [downloading, setDownloading] = useState<string | null>(null)
    const popoverRef = useRef<HTMLDivElement>(null)
    const buttonRef = useRef<HTMLButtonElement>(null)
    const [popoverPos, setPopoverPos] = useState<{ bottom: number; left: number } | null>(null)

    const { data } = useQuery({
        queryKey: queryKeys.sessionDownloads(sessionId),
        queryFn: async () => {
            if (!apiClient) return { files: [] as SessionDownloadFile[] }
            const res = await apiClient.getSessionDownloads(sessionId)
            return res
        },
        enabled: !!apiClient,
        staleTime: 30_000,
    })

    const files = data?.files ?? []

    const updatePosition = useCallback(() => {
        if (!buttonRef.current) return
        const rect = buttonRef.current.getBoundingClientRect()
        setPopoverPos({
            bottom: window.innerHeight - rect.top + 6,
            left: rect.left,
        })
    }, [])

    // Close on outside click
    useEffect(() => {
        if (!open) return
        const handler = (e: MouseEvent) => {
            if (
                popoverRef.current && !popoverRef.current.contains(e.target as Node) &&
                buttonRef.current && !buttonRef.current.contains(e.target as Node)
            ) {
                setOpen(false)
            }
        }
        document.addEventListener('mousedown', handler)
        return () => document.removeEventListener('mousedown', handler)
    }, [open])

    // Close on Escape
    useEffect(() => {
        if (!open) return
        const handler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setOpen(false)
        }
        document.addEventListener('keydown', handler)
        return () => document.removeEventListener('keydown', handler)
    }, [open])

    // Reposition on scroll/resize
    useEffect(() => {
        if (!open) return
        window.addEventListener('resize', updatePosition)
        window.addEventListener('scroll', updatePosition, true)
        return () => {
            window.removeEventListener('resize', updatePosition)
            window.removeEventListener('scroll', updatePosition, true)
        }
    }, [open, updatePosition])

    if (files.length === 0) return null

    const handleToggle = () => {
        if (!open) updatePosition()
        setOpen(v => !v)
    }

    const handleDownload = async (file: SessionDownloadFile) => {
        if (!apiClient || downloading) return
        setDownloading(file.id)
        try {
            await apiClient.downloadFile(file.id, file.filename)
        } finally {
            setDownloading(null)
        }
    }

    return (
        <div className="relative">
            <button
                ref={buttonRef}
                type="button"
                aria-label={`Downloads (${files.length})`}
                title={`Downloads (${files.length})`}
                className="relative flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-fg)]/60 transition-colors hover:bg-[var(--app-bg)] hover:text-emerald-500"
                onClick={handleToggle}
            >
                <DownloadIcon size={18} />
                <span className="absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 text-[10px] font-bold text-white">
                    {files.length}
                </span>
            </button>

            {open && popoverPos && createPortal(
                <div
                    ref={popoverRef}
                    style={{
                        position: 'fixed',
                        bottom: popoverPos.bottom,
                        left: popoverPos.left,
                        zIndex: 9999,
                    }}
                    className="min-w-[280px] max-w-[360px] rounded-2xl border border-[var(--app-border)] bg-[var(--app-secondary-bg)] shadow-2xl"
                >
                    <div className="flex items-center gap-2 px-4 pt-3 pb-2">
                        <DownloadIcon size={14} />
                        <span className="text-xs font-semibold text-[var(--app-hint)] uppercase tracking-wide">
                            Downloads
                        </span>
                        <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-emerald-500/15 px-1.5 text-[10px] font-bold text-emerald-500">
                            {files.length}
                        </span>
                    </div>
                    <div className="px-2 pb-2">
                        <div className="flex flex-col gap-0.5">
                            {files.map(file => (
                                <button
                                    key={file.id}
                                    type="button"
                                    disabled={downloading === file.id}
                                    className="group flex items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-all hover:bg-[var(--app-bg)] disabled:opacity-50"
                                    onClick={() => handleDownload(file)}
                                >
                                    <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-500 transition-colors group-hover:bg-emerald-500/20">
                                        <FileIcon mimeType={file.mimeType} />
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <p className="truncate text-sm font-medium text-[var(--app-fg)]">{file.filename}</p>
                                        <p className="text-[11px] text-[var(--app-hint)]">{formatBytes(file.size)}</p>
                                    </div>
                                    {downloading === file.id ? (
                                        <div className="h-4 w-4 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
                                    ) : (
                                        <div className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--app-hint)] opacity-0 transition-opacity group-hover:opacity-100">
                                            <DownloadIcon size={14} />
                                        </div>
                                    )}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>,
                document.body,
            )}
        </div>
    )
}
