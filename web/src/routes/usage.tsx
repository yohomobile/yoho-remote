import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAppContext } from '@/lib/app-context'
import { useAppGoBack } from '@/hooks/useAppGoBack'

function BackIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <polyline points="15 18 9 12 15 6" />
        </svg>
    )
}

function RefreshIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
        </svg>
    )
}

function formatTokens(tokens: number): string {
    if (tokens >= 1_000_000) {
        return `${(tokens / 1_000_000).toFixed(2)}M`
    }
    if (tokens >= 1_000) {
        return `${(tokens / 1_000).toFixed(1)}K`
    }
    return tokens.toLocaleString()
}

export default function UsagePage() {
    const { api } = useAppContext()
    const goBack = useAppGoBack()

    const { data: hourlyData, refetch, isFetching } = useQuery({
        queryKey: ['usage-hourly'],
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return await api.getHourlyUsage()
        },
        enabled: Boolean(api),
        refetchInterval: 5 * 60_000
    })

    return (
        <div className="flex h-full flex-col">
            <div className="bg-[var(--app-bg)] border-b border-[var(--app-divider)] pt-[env(safe-area-inset-top)]">
                <div className="mx-auto w-full max-w-content flex items-center gap-2 px-3 py-1.5">
                    <button
                        type="button"
                        onClick={goBack}
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                    >
                        <BackIcon />
                    </button>
                    <div className="flex-1 font-medium text-sm">Token Usage</div>
                    <button
                        type="button"
                        onClick={() => refetch()}
                        disabled={isFetching}
                        className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)] disabled:opacity-50"
                        title="Refresh"
                    >
                        <RefreshIcon className={isFetching ? 'animate-spin' : ''} />
                    </button>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
                <div className="mx-auto w-full max-w-content p-3 space-y-4">
                    {hourlyData && !hourlyData.error && hourlyData.hourly.length > 0 && (
                        <HourlyAnalysisPanel data={hourlyData} />
                    )}
                </div>
            </div>
        </div>
    )
}

// --- 24h Analysis Components ---

function shortenProject(name: string): string {
    return name
        .replace(/^-home-[^-]+-/, '')
        .replace(/^softwares-/, '')
        .replace(/^yoho-remote-/, '')
}

interface HourlyData {
    hourly: Array<{
        hour: string
        cacheRead: number
        cacheCreate: number
        input: number
        output: number
        messages: number
    }>
    projects: Array<{
        project: string
        cacheRead: number
        cacheCreate: number
        input: number
        output: number
        messages: number
        sessions: number
    }>
    sessions: Array<{
        sessionId: string
        project: string
        model: string
        firstSeen: string
        lastSeen: string
        cacheRead: number
        cacheCreate: number
        messages: number
        toolCalls: number
    }>
    timestamp: number
    error?: string
}

function HourlyAnalysisPanel({ data }: { data: HourlyData }) {
    const [selectedHour, setSelectedHour] = useState<string | null>(null)

    const totalCacheRead = data.hourly.reduce((s, h) => s + h.cacheRead, 0)
    const totalCacheCreate = data.hourly.reduce((s, h) => s + h.cacheCreate, 0)
    const totalMessages = data.hourly.reduce((s, h) => s + h.messages, 0)

    return (
        <div className="rounded-lg bg-[var(--app-subtle-bg)] overflow-hidden">
            <div className="divide-y divide-[var(--app-divider)]">
                {/* Header */}
                <div className="px-3 py-3">
                    <div className="flex items-center gap-2 mb-1">
                        <div className="w-6 h-6 rounded bg-gradient-to-br from-purple-500 to-violet-600 flex items-center justify-center">
                            <span className="text-white text-xs font-bold">24</span>
                        </div>
                        <span className="text-sm font-medium">24h Analysis</span>
                    </div>
                    <div className="flex gap-4 text-[10px] text-[var(--app-hint)]">
                        <span>Cache Read: <span className="font-mono text-[var(--app-fg)]">{formatTokens(totalCacheRead)}</span></span>
                        <span>Cache Create: <span className="font-mono text-[var(--app-fg)]">{formatTokens(totalCacheCreate)}</span></span>
                        <span>{totalMessages} msgs</span>
                    </div>
                </div>

                {/* Hourly Bar Chart */}
                <div className="px-3 py-3">
                    <div className="text-[10px] text-[var(--app-hint)] mb-2">Hourly Cache Read</div>
                    <HourlyBarChart
                        hourly={data.hourly}
                        selectedHour={selectedHour}
                        onSelect={setSelectedHour}
                    />
                    {selectedHour && (
                        <HourDetail hourly={data.hourly} hour={selectedHour} />
                    )}
                </div>

                {/* Project Ranking */}
                {data.projects.length > 0 && (
                    <div className="px-3 py-3">
                        <div className="text-[10px] text-[var(--app-hint)] mb-2">By Project</div>
                        <div className="space-y-1.5">
                            {data.projects.map((p) => (
                                <div key={p.project} className="flex items-center justify-between text-[10px]">
                                    <span className="truncate flex-1 mr-2">{shortenProject(p.project)}</span>
                                    <div className="flex gap-3 shrink-0">
                                        <span className="font-mono text-[var(--app-fg)]">{formatTokens(p.cacheRead)}</span>
                                        <span className="text-[var(--app-hint)] w-14 text-right">{p.sessions}s / {p.messages}m</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Session Ranking */}
                {data.sessions.length > 0 && (
                    <div className="px-3 py-3">
                        <div className="text-[10px] text-[var(--app-hint)] mb-2">Top Sessions</div>
                        <div className="space-y-2">
                            {data.sessions.map((s, i) => (
                                <div key={`${s.project}/${s.sessionId}`} className="text-[10px]">
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-1.5 min-w-0">
                                            <span className="text-[var(--app-hint)] shrink-0">#{i + 1}</span>
                                            <span className="font-mono truncate">{s.sessionId}</span>
                                            <span className="text-[var(--app-hint)] shrink-0">{shortenProject(s.project)}</span>
                                        </div>
                                        <span className="font-mono text-[var(--app-fg)] shrink-0 ml-2">{formatTokens(s.cacheRead)}</span>
                                    </div>
                                    <div className="flex gap-3 text-[var(--app-hint)] ml-5">
                                        <span>{s.model === '<synthetic>' ? 'synthetic' : s.model.replace('claude-', '')}</span>
                                        <span>{s.firstSeen}-{s.lastSeen}</span>
                                        <span>{s.messages}m</span>
                                        <span>{s.toolCalls}t</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </div>
    )
}

function HourlyBarChart({ hourly, selectedHour, onSelect }: {
    hourly: HourlyData['hourly']
    selectedHour: string | null
    onSelect: (hour: string | null) => void
}) {
    const maxVal = Math.max(...hourly.map(h => h.cacheRead + h.cacheCreate), 1)

    return (
        <div className="flex items-end gap-px" style={{ height: 80 }}>
            {hourly.map((h) => {
                const crHeight = (h.cacheRead / maxVal) * 100
                const ccHeight = (h.cacheCreate / maxVal) * 100
                const isSelected = selectedHour === h.hour
                const hourLabel = h.hour.split(' ')[1]?.replace(':00', '') ?? ''

                return (
                    <div
                        key={h.hour}
                        className="flex-1 flex flex-col justify-end items-center cursor-pointer group"
                        style={{ height: '100%' }}
                        onClick={() => onSelect(isSelected ? null : h.hour)}
                    >
                        <div className="w-full flex flex-col justify-end" style={{ height: '100%' }}>
                            {/* Cache Create (stacked on top) */}
                            {ccHeight > 0 && (
                                <div
                                    className={`w-full rounded-t-[1px] ${isSelected ? 'bg-amber-400' : 'bg-amber-500/60 group-hover:bg-amber-400/80'}`}
                                    style={{ height: `${ccHeight}%`, minHeight: ccHeight > 0 ? 1 : 0 }}
                                />
                            )}
                            {/* Cache Read */}
                            {crHeight > 0 && (
                                <div
                                    className={`w-full ${ccHeight <= 0 ? 'rounded-t-[1px]' : ''} ${isSelected ? 'bg-purple-400' : 'bg-purple-500/60 group-hover:bg-purple-400/80'}`}
                                    style={{ height: `${crHeight}%`, minHeight: crHeight > 0 ? 1 : 0 }}
                                />
                            )}
                        </div>
                        {/* X-axis label: show every other hour */}
                        <div className="text-[8px] text-[var(--app-hint)] mt-0.5 leading-none">
                            {parseInt(hourLabel) % 2 === 0 ? hourLabel : ''}
                        </div>
                    </div>
                )
            })}
        </div>
    )
}

function HourDetail({ hourly, hour }: { hourly: HourlyData['hourly']; hour: string }) {
    const h = hourly.find(x => x.hour === hour)
    if (!h) return null

    return (
        <div className="mt-2 p-2 rounded bg-[var(--app-bg)] text-[10px]">
            <div className="font-medium mb-1">{h.hour}</div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
                <div className="flex justify-between">
                    <span className="text-[var(--app-hint)]">Cache Read</span>
                    <span className="font-mono">{formatTokens(h.cacheRead)}</span>
                </div>
                <div className="flex justify-between">
                    <span className="text-[var(--app-hint)]">Cache Create</span>
                    <span className="font-mono">{formatTokens(h.cacheCreate)}</span>
                </div>
                <div className="flex justify-between">
                    <span className="text-[var(--app-hint)]">Input</span>
                    <span className="font-mono">{formatTokens(h.input)}</span>
                </div>
                <div className="flex justify-between">
                    <span className="text-[var(--app-hint)]">Output</span>
                    <span className="font-mono">{formatTokens(h.output)}</span>
                </div>
                <div className="flex justify-between col-span-2">
                    <span className="text-[var(--app-hint)]">Messages</span>
                    <span className="font-mono">{h.messages}</span>
                </div>
            </div>
        </div>
    )
}
