import { useCallback, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useAppContext } from '@/lib/app-context'
import { useMachines } from '@/hooks/queries/useMachines'
import type { AiTaskSchedule, CreateAiTaskScheduleInput } from '@/types/api'
import { getMachineTitle } from '@/lib/machines'

function BackIcon() {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
        </svg>
    )
}

function formatCronSummary(schedule: AiTaskSchedule): string {
    const cron = schedule.cron
    if (cron.startsWith('+')) {
        const ms = Number(cron.slice(1))
        const mins = Math.round(ms / 60_000)
        return `Delay ${mins} min`
    }
    return cron
}

function formatTime(iso: string | null): string {
    if (!iso) return '—'
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleString()
}

function ScheduleRow({
    schedule,
    machineLabel,
    onToggle,
    onDelete,
    onOpen,
    opening,
}: {
    schedule: AiTaskSchedule
    machineLabel: string | null
    onToggle: (id: string, enabled: boolean) => void
    onDelete: (id: string) => void
    onOpen: (id: string) => void
    opening: boolean
}) {
    const tags = schedule.tags ?? []
    const stop = (e: React.MouseEvent) => e.stopPropagation()
    return (
        <div
            className="border-b border-[var(--app-divider)] px-3 py-2.5 cursor-pointer hover:bg-[var(--app-subtle-bg)]"
            role="button"
            tabIndex={0}
            onClick={() => onOpen(schedule.scheduleId)}
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onOpen(schedule.scheduleId)
                }
            }}
        >
            <div className="flex items-center gap-2">
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium truncate">
                            {schedule.label || schedule.scheduleId.slice(0, 8)}
                        </span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded ${schedule.enabled ? 'bg-green-500/15 text-green-600' : 'bg-gray-500/15 text-gray-600'}`}>
                            {schedule.enabled ? 'Enabled' : 'Disabled'}
                        </span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--app-subtle-bg)] text-[var(--app-hint)]">
                            {formatCronSummary(schedule)}
                        </span>
                        {schedule.recurring && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-600">
                                recurring
                            </span>
                        )}
                        {tags.map(t => (
                            <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-600">
                                #{t}
                            </span>
                        ))}
                    </div>
                    <div className="text-[11px] text-[var(--app-hint)] mt-1 truncate">
                        {schedule.directory} · {machineLabel ?? schedule.machineId?.slice(0, 8)} · next: {formatTime(schedule.nextFireAt)}
                    </div>
                    {schedule.prompt && (
                        <div className="text-[11px] text-[var(--app-fg)] mt-1 line-clamp-2">
                            {schedule.prompt}
                        </div>
                    )}
                    {schedule.systemPrompt && (
                        <div className="text-[11px] text-[var(--app-hint)] mt-1 line-clamp-1 italic">
                            system: {schedule.systemPrompt}
                        </div>
                    )}
                </div>
                <div className="flex flex-col gap-1 shrink-0">
                    <button
                        type="button"
                        onClick={(e) => { stop(e); onToggle(schedule.scheduleId, !schedule.enabled) }}
                        className="px-2 py-1 text-[11px] rounded bg-[var(--app-subtle-bg)] hover:bg-[var(--app-secondary-bg)]"
                    >
                        {schedule.enabled ? 'Pause' : 'Resume'}
                    </button>
                    <button
                        type="button"
                        onClick={(e) => { stop(e); onDelete(schedule.scheduleId) }}
                        className="px-2 py-1 text-[11px] rounded bg-red-500/15 text-red-600 hover:bg-red-500/25"
                    >
                        Delete
                    </button>
                </div>
            </div>
            {opening && (
                <div className="mt-1 text-[10px] text-[var(--app-hint)]">Opening session…</div>
            )}
        </div>
    )
}

function NewScheduleForm({
    onSubmit,
    onCancel,
    isSubmitting,
}: {
    onSubmit: (input: CreateAiTaskScheduleInput) => void
    onCancel: () => void
    isSubmitting: boolean
}) {
    const { api, currentOrgId } = useAppContext()
    const { machines } = useMachines(api, true, currentOrgId)
    const [machineId, setMachineId] = useState(machines[0]?.id ?? '')
    const [directory, setDirectory] = useState('')
    const [cronOrDelay, setCronOrDelay] = useState('PT5M')
    const [recurring, setRecurring] = useState(false)
    const [label, setLabel] = useState('')
    const [prompt, setPrompt] = useState('')
    const [systemPrompt, setSystemPrompt] = useState('')
    const [tagsInput, setTagsInput] = useState('')
    const [agent, setAgent] = useState<'claude' | 'codex'>('claude')
    const [error, setError] = useState<string | null>(null)

    const { data: projectsData } = useQuery({
        queryKey: ['projects', machineId],
        queryFn: async () => machineId ? api.getProjects(currentOrgId, machineId) : { projects: [] },
        enabled: !!machineId,
    })
    const projects = projectsData?.projects ?? []

    const canSubmit = machineId && directory && prompt.trim() && cronOrDelay

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault()
        setError(null)
        if (!canSubmit) {
            setError('Fill in machine, directory, prompt, and schedule')
            return
        }
        const tags = tagsInput
            .split(',')
            .map(t => t.trim())
            .filter(t => t.length > 0)
        onSubmit({
            machineId,
            directory,
            cronOrDelay,
            recurring,
            label: label.trim() || undefined,
            agent,
            prompt: prompt.trim(),
            systemPrompt: systemPrompt.trim() || undefined,
            tags: tags.length > 0 ? tags : undefined,
        })
    }

    const quickPresets = [
        { label: 'In 5 min', value: 'PT5M', recurring: false },
        { label: 'In 30 min', value: 'PT30M', recurring: false },
        { label: 'In 1 hour', value: 'PT1H', recurring: false },
        { label: 'Hourly', value: '7 * * * *', recurring: true },
        { label: 'Daily 9am UTC', value: '3 9 * * *', recurring: true },
    ]

    return (
        <form onSubmit={handleSubmit} className="flex flex-col gap-3 p-3">
            <div className="flex flex-col gap-1">
                <label className="text-xs text-[var(--app-hint)]">Machine</label>
                <select
                    value={machineId}
                    onChange={e => setMachineId(e.target.value)}
                    className="px-2 py-1.5 text-sm rounded bg-[var(--app-subtle-bg)] border border-[var(--app-border)]"
                >
                    <option value="">Select machine...</option>
                    {machines.map(m => (
                        <option key={m.id} value={m.id}>{getMachineTitle(m)}</option>
                    ))}
                </select>
            </div>

            <div className="flex flex-col gap-1">
                <label className="text-xs text-[var(--app-hint)]">Directory</label>
                <select
                    value={directory}
                    onChange={e => setDirectory(e.target.value)}
                    className="px-2 py-1.5 text-sm rounded bg-[var(--app-subtle-bg)] border border-[var(--app-border)]"
                >
                    <option value="">Select project directory...</option>
                    {projects.map(p => (
                        <option key={p.id} value={p.path}>{p.path}</option>
                    ))}
                </select>
            </div>

            <div className="flex flex-col gap-1">
                <label className="text-xs text-[var(--app-hint)]">Schedule</label>
                <div className="flex flex-wrap gap-1 mb-1">
                    {quickPresets.map(preset => (
                        <button
                            key={preset.label}
                            type="button"
                            onClick={() => { setCronOrDelay(preset.value); setRecurring(preset.recurring) }}
                            className={`text-[11px] px-1.5 py-0.5 rounded ${cronOrDelay === preset.value ? 'bg-indigo-500 text-white' : 'bg-[var(--app-subtle-bg)] text-[var(--app-hint)]'}`}
                        >
                            {preset.label}
                        </button>
                    ))}
                </div>
                <input
                    type="text"
                    value={cronOrDelay}
                    onChange={e => setCronOrDelay(e.target.value)}
                    placeholder="ISO-8601 duration or cron expr (UTC)"
                    className="px-2 py-1.5 text-sm rounded bg-[var(--app-subtle-bg)] border border-[var(--app-border)] font-mono"
                />
                <label className="flex items-center gap-2 text-xs mt-1">
                    <input type="checkbox" checked={recurring} onChange={e => setRecurring(e.target.checked)} />
                    Recurring (cron only)
                </label>
            </div>

            <div className="flex flex-col gap-1">
                <label className="text-xs text-[var(--app-hint)]">Agent</label>
                <div className="flex gap-1">
                    {(['claude', 'codex'] as const).map(a => (
                        <button
                            key={a}
                            type="button"
                            onClick={() => setAgent(a)}
                            className={`px-2 py-1 text-xs rounded ${agent === a ? 'bg-indigo-500 text-white' : 'bg-[var(--app-subtle-bg)]'}`}
                        >
                            {a}
                        </button>
                    ))}
                </div>
            </div>

            <div className="flex flex-col gap-1">
                <label className="text-xs text-[var(--app-hint)]">Label (optional)</label>
                <input
                    type="text"
                    value={label}
                    onChange={e => setLabel(e.target.value)}
                    placeholder="e.g. nightly-git-digest"
                    className="px-2 py-1.5 text-sm rounded bg-[var(--app-subtle-bg)] border border-[var(--app-border)]"
                />
            </div>

            <div className="flex flex-col gap-1">
                <label className="text-xs text-[var(--app-hint)]">Tags (comma separated)</label>
                <input
                    type="text"
                    value={tagsInput}
                    onChange={e => setTagsInput(e.target.value)}
                    placeholder="ops, daily, git"
                    className="px-2 py-1.5 text-sm rounded bg-[var(--app-subtle-bg)] border border-[var(--app-border)]"
                />
            </div>

            <div className="flex flex-col gap-1">
                <label className="text-xs text-[var(--app-hint)]">Prompt (sent each time schedule fires)</label>
                <textarea
                    value={prompt}
                    onChange={e => setPrompt(e.target.value)}
                    rows={4}
                    className="px-2 py-1.5 text-sm rounded bg-[var(--app-subtle-bg)] border border-[var(--app-border)]"
                    placeholder="summarize git commits in the last hour..."
                />
            </div>

            <div className="flex flex-col gap-1">
                <label className="text-xs text-[var(--app-hint)]">System Prompt (optional, appended each run)</label>
                <textarea
                    value={systemPrompt}
                    onChange={e => setSystemPrompt(e.target.value)}
                    rows={3}
                    className="px-2 py-1.5 text-sm rounded bg-[var(--app-subtle-bg)] border border-[var(--app-border)]"
                    placeholder="You are an automation bot. Keep outputs under 500 chars..."
                />
            </div>

            {error && <div className="text-xs text-red-600">{error}</div>}

            <div className="flex gap-2">
                <button
                    type="submit"
                    disabled={!canSubmit || isSubmitting}
                    className="px-3 py-1.5 text-sm rounded bg-gradient-to-r from-indigo-500 to-purple-600 text-white disabled:opacity-50"
                >
                    {isSubmitting ? 'Creating...' : 'Create Schedule'}
                </button>
                <button
                    type="button"
                    onClick={onCancel}
                    className="px-3 py-1.5 text-sm rounded bg-[var(--app-subtle-bg)]"
                >
                    Cancel
                </button>
            </div>
        </form>
    )
}

export function AutomationPage() {
    const { api, currentOrgId } = useAppContext()
    const navigate = useNavigate()
    const queryClient = useQueryClient()
    const [showForm, setShowForm] = useState(false)
    const [submitting, setSubmitting] = useState(false)
    const [openingId, setOpeningId] = useState<string | null>(null)

    const { machines } = useMachines(api, true, currentOrgId)
    const machineMap = useMemo(() => new Map(machines.map(m => [m.id, m])), [machines])

    const { data, isLoading, error, refetch } = useQuery({
        queryKey: ['ai-task-schedules', currentOrgId],
        queryFn: async () => api.listAiTaskSchedules({ includeDisabled: true }),
    })
    const schedules = data?.schedules ?? []

    const handleCreate = useCallback(async (input: CreateAiTaskScheduleInput) => {
        setSubmitting(true)
        try {
            await api.createAiTaskSchedule(input)
            setShowForm(false)
            await queryClient.invalidateQueries({ queryKey: ['ai-task-schedules'] })
        } catch (err) {
            console.error('Failed to create schedule', err)
            alert(`Failed: ${err instanceof Error ? err.message : String(err)}`)
        } finally {
            setSubmitting(false)
        }
    }, [api, queryClient])

    const handleToggle = useCallback(async (id: string, enabled: boolean) => {
        try {
            await api.updateAiTaskSchedule(id, { enabled })
            await queryClient.invalidateQueries({ queryKey: ['ai-task-schedules'] })
        } catch (err) {
            console.error('Failed to toggle schedule', err)
        }
    }, [api, queryClient])

    const handleOpen = useCallback(async (id: string) => {
        setOpeningId(id)
        try {
            const { runs } = await api.getAiTaskSchedule(id)
            const latest = (runs ?? []).find(r => r.subsessionId || r.sessionId)
            const target = latest?.subsessionId || latest?.sessionId
            if (target) {
                navigate({ to: '/sessions/$sessionId', params: { sessionId: target } })
                return
            }
            alert('This schedule has not fired yet. Come back after its next run.')
        } catch (err) {
            console.error('Failed to open schedule session', err)
            alert(`Failed to open session: ${err instanceof Error ? err.message : String(err)}`)
        } finally {
            setOpeningId(null)
        }
    }, [api, navigate])

    const handleDelete = useCallback(async (id: string) => {
        if (!confirm('Delete this schedule? It will be paused permanently.')) return
        try {
            await api.deleteAiTaskSchedule(id)
            await queryClient.invalidateQueries({ queryKey: ['ai-task-schedules'] })
        } catch (err) {
            console.error('Failed to delete schedule', err)
        }
    }, [api, queryClient])

    return (
        <div className="flex h-full flex-col">
            <div className="bg-[var(--app-bg)] border-b border-[var(--app-divider)] pt-[env(safe-area-inset-top)]">
                <div className="mx-auto w-full max-w-content flex items-center gap-2 px-3 py-1.5">
                    <button
                        type="button"
                        onClick={() => navigate({ to: '/sessions', search: { owner: 'automation' } })}
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)]"
                    >
                        <BackIcon />
                    </button>
                    <div className="flex-1 font-medium text-sm">
                        🤖 Automation Schedules
                    </div>
                    <button
                        type="button"
                        onClick={() => { setShowForm(v => !v); void refetch() }}
                        className="px-2 py-1 text-xs rounded bg-gradient-to-r from-purple-500 to-fuchsia-600 text-white"
                    >
                        {showForm ? 'Close' : '+ New'}
                    </button>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
                <div className="mx-auto w-full max-w-content">
                    {showForm && (
                        <div className="border-b-2 border-[var(--app-border)]">
                            <NewScheduleForm
                                onSubmit={handleCreate}
                                onCancel={() => setShowForm(false)}
                                isSubmitting={submitting}
                            />
                        </div>
                    )}

                    {error ? (
                        <div className="p-3 text-sm text-red-600">
                            {error instanceof Error ? error.message : String(error)}
                        </div>
                    ) : null}

                    {isLoading && schedules.length === 0 ? (
                        <div className="p-6 text-center text-sm text-[var(--app-hint)]">Loading...</div>
                    ) : schedules.length === 0 ? (
                        <div className="p-6 text-center text-sm text-[var(--app-hint)]">
                            No schedules yet. Click “+ New” to create one.
                        </div>
                    ) : (
                        schedules.map(s => (
                            <ScheduleRow
                                key={s.scheduleId}
                                schedule={s}
                                machineLabel={s.machineId ? getMachineTitle(machineMap.get(s.machineId) ?? { id: s.machineId } as never) : null}
                                onToggle={handleToggle}
                                onDelete={handleDelete}
                                onOpen={handleOpen}
                                opening={openingId === s.scheduleId}
                            />
                        ))
                    )}
                </div>
            </div>
        </div>
    )
}

export default AutomationPage
