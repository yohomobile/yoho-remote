import { useState, useRef, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'
import { useKeycloakAuth } from '@/hooks/useKeycloakAuth'
import { useConfig } from '@/hooks/useConfig'
import type { SessionDownloadFile } from '@/types/api'

function DownloadIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
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

    if (files.length === 0) return null

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
                onClick={() => setOpen(v => !v)}
            >
                <DownloadIcon />
                <span className="absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 text-[10px] font-bold text-white">
                    {files.length}
                </span>
            </button>

            {open && (
                <div
                    ref={popoverRef}
                    className="absolute bottom-10 left-0 z-50 min-w-[240px] max-w-[320px] rounded-xl border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-2 shadow-xl"
                >
                    <p className="mb-1.5 px-2 text-xs font-semibold text-[var(--app-hint)]">可下载文件</p>
                    <div className="flex flex-col gap-1">
                        {files.map(file => (
                            <button
                                key={file.id}
                                type="button"
                                disabled={downloading === file.id}
                                className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-[var(--app-bg)] disabled:opacity-50"
                                onClick={() => handleDownload(file)}
                            >
                                <DownloadIcon />
                                <div className="min-w-0 flex-1">
                                    <p className="truncate text-sm font-medium text-[var(--app-fg)]">{file.filename}</p>
                                    <p className="text-xs text-[var(--app-hint)]">{formatBytes(file.size)}</p>
                                </div>
                                {downloading === file.id && (
                                    <span className="text-xs text-[var(--app-hint)]">...</span>
                                )}
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </div>
    )
}
