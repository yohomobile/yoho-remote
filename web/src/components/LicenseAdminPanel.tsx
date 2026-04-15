import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'
import type { AdminLicense, LicenseStatus, Organization } from '@/types/api'

type LicenseFormState = {
    startsAt: string
    expiresAt: string
    maxMembers: string
    maxConcurrentSessions: string
    note: string
}

const DAY_MS = 24 * 60 * 60 * 1000

function formatDateInput(timestamp: number): string {
    return new Date(timestamp).toISOString().slice(0, 10)
}

function createDefaultForm(): LicenseFormState {
    const now = new Date()
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    const expires = new Date(start.getTime() + 30 * DAY_MS)
    return {
        startsAt: formatDateInput(start.getTime()),
        expiresAt: formatDateInput(expires.getTime()),
        maxMembers: '5',
        maxConcurrentSessions: '',
        note: '',
    }
}

function createFormFromLicense(license: AdminLicense): LicenseFormState {
    return {
        startsAt: formatDateInput(license.startsAt),
        expiresAt: formatDateInput(license.expiresAt),
        maxMembers: String(license.maxMembers),
        maxConcurrentSessions: license.maxConcurrentSessions === null ? '' : String(license.maxConcurrentSessions),
        note: license.note ?? '',
    }
}

function parseDateStart(value: string): number {
    return new Date(`${value}T00:00:00.000Z`).getTime()
}

function parseDateEnd(value: string): number {
    return new Date(`${value}T23:59:59.999Z`).getTime()
}

function formatDateShort(timestamp: number): string {
    return new Date(timestamp).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
    })
}

function daysUntil(timestamp: number): number {
    return Math.ceil((timestamp - Date.now()) / DAY_MS)
}

function findOrgName(orgs: Organization[], orgId: string): string {
    return orgs.find(org => org.id === orgId)?.name ?? orgId
}

const statusColors: Record<LicenseStatus, string> = {
    active: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
    suspended: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
    expired: 'bg-red-500/15 text-red-600 dark:text-red-400',
}

export function LicenseAdminPanel({
    api,
    currentOrgId,
}: {
    api: ApiClient | null
    currentOrgId: string | null
}) {
    const queryClient = useQueryClient()
    const [selectedOrgId, setSelectedOrgId] = useState<string>(currentOrgId ?? '')
    const [form, setForm] = useState<LicenseFormState>(() => createDefaultForm())
    const [editing, setEditing] = useState(false)
    const [message, setMessage] = useState<string | null>(null)

    const { data: orgOptionsData, isLoading: orgOptionsLoading } = useQuery({
        queryKey: queryKeys.licenseOrganizations,
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return await api.getLicenseOrganizations()
        },
        enabled: Boolean(api),
    })
    const { data: licensesData, isLoading: licensesLoading } = useQuery({
        queryKey: queryKeys.adminLicenses,
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return await api.getAdminLicenses()
        },
        enabled: Boolean(api),
    })

    const orgOptions = orgOptionsData?.orgs ?? []
    const licenses = licensesData?.licenses ?? []
    const licensesByOrgId = useMemo(() => {
        return new Map(licenses.map(license => [license.orgId, license]))
    }, [licenses])
    const selectedLicense = selectedOrgId ? licensesByOrgId.get(selectedOrgId) ?? null : null

    useEffect(() => {
        if (selectedOrgId) return
        if (currentOrgId && orgOptions.some(org => org.id === currentOrgId)) {
            setSelectedOrgId(currentOrgId)
            return
        }
        if (orgOptions.length > 0) {
            setSelectedOrgId(orgOptions[0].id)
        }
    }, [currentOrgId, orgOptions, selectedOrgId])

    useEffect(() => {
        if (!selectedOrgId) return
        const existing = licensesByOrgId.get(selectedOrgId)
        setForm(existing ? createFormFromLicense(existing) : createDefaultForm())
        setEditing(!existing)
        setMessage(null)
    }, [licensesByOrgId, selectedOrgId])

    const invalidateData = async (orgId?: string) => {
        await Promise.all([
            queryClient.invalidateQueries({ queryKey: queryKeys.adminLicenses }),
            queryClient.invalidateQueries({ queryKey: queryKeys.licenseOrganizations }),
            queryClient.invalidateQueries({ queryKey: queryKeys.orgs }),
            orgId ? queryClient.invalidateQueries({ queryKey: queryKeys.org(orgId) }) : Promise.resolve(),
            currentOrgId ? queryClient.invalidateQueries({ queryKey: queryKeys.org(currentOrgId) }) : Promise.resolve(),
        ])
    }

    const saveMutation = useMutation({
        mutationFn: async () => {
            if (!api) throw new Error('API unavailable')
            if (!selectedOrgId) throw new Error('Select an organization first')
            return await api.upsertLicense({
                orgId: selectedOrgId,
                startsAt: parseDateStart(form.startsAt),
                expiresAt: parseDateEnd(form.expiresAt),
                maxMembers: Number(form.maxMembers),
                maxConcurrentSessions: form.maxConcurrentSessions.trim()
                    ? Number(form.maxConcurrentSessions)
                    : null,
                status: selectedLicense?.status ?? 'active',
                note: form.note.trim() ? form.note.trim() : null,
            })
        },
        onSuccess: async () => {
            await invalidateData(selectedOrgId)
            setEditing(false)
            setMessage(`Saved license for ${findOrgName(orgOptions, selectedOrgId)}`)
        },
    })

    const statusMutation = useMutation({
        mutationFn: async (status: LicenseStatus) => {
            if (!api) throw new Error('API unavailable')
            if (!selectedOrgId) throw new Error('Select an organization first')
            return await api.updateLicenseStatus(selectedOrgId, status)
        },
        onSuccess: async (_result, status) => {
            await invalidateData(selectedOrgId)
            setMessage(`Updated license status to ${status}`)
        },
    })

    const deleteMutation = useMutation({
        mutationFn: async () => {
            if (!api) throw new Error('API unavailable')
            if (!selectedOrgId) throw new Error('Select an organization first')
            return await api.deleteLicense(selectedOrgId)
        },
        onSuccess: async () => {
            await invalidateData(selectedOrgId)
            setMessage(`Deleted license for ${findOrgName(orgOptions, selectedOrgId)}`)
        },
    })

    const isBusy = saveMutation.isPending || statusMutation.isPending || deleteMutation.isPending
    const errorMessage =
        (saveMutation.error instanceof Error && saveMutation.error.message)
        || (statusMutation.error instanceof Error && statusMutation.error.message)
        || (deleteMutation.error instanceof Error && deleteMutation.error.message)
        || null

    return (
        <div className="rounded-lg bg-[var(--app-subtle-bg)] overflow-hidden">
            {/* Header with org selector */}
            <div className="flex items-center gap-3 px-3 py-2 border-b border-[var(--app-divider)]">
                <h3 className="text-sm font-medium shrink-0">Licenses</h3>
                <select
                    value={selectedOrgId}
                    onChange={(event) => setSelectedOrgId(event.target.value)}
                    className="ml-auto min-w-0 max-w-[200px] rounded-md border border-[var(--app-divider)] bg-[var(--app-bg)] px-2 py-1 text-xs"
                    disabled={orgOptionsLoading || isBusy}
                >
                    {orgOptions.length === 0 && <option value="">No organizations</option>}
                    {orgOptions.map((org) => (
                        <option key={org.id} value={org.id}>
                            {org.name}
                        </option>
                    ))}
                </select>
            </div>

            <div className="p-3 space-y-3">
                {/* Selected license detail or create form */}
                {selectedLicense && !editing ? (
                    <div className="rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] p-3">
                        <div className="flex items-start justify-between gap-2">
                            <div>
                                <div className="text-sm font-medium">{selectedLicense.orgName}</div>
                                <div className="text-[11px] text-[var(--app-hint)]">{selectedLicense.orgSlug}</div>
                            </div>
                            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${statusColors[selectedLicense.status]}`}>
                                {selectedLicense.status}
                            </span>
                        </div>

                        <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                            <div>
                                <span className="text-[var(--app-hint)]">Period</span>
                                <div>{formatDateShort(selectedLicense.startsAt)} — {formatDateShort(selectedLicense.expiresAt)}</div>
                                {selectedLicense.status === 'active' && (
                                    <div className={`text-[11px] ${daysUntil(selectedLicense.expiresAt) <= 7 ? 'text-amber-500' : 'text-[var(--app-hint)]'}`}>
                                        {daysUntil(selectedLicense.expiresAt) > 0
                                            ? `${daysUntil(selectedLicense.expiresAt)}d remaining`
                                            : 'Expired'}
                                    </div>
                                )}
                            </div>
                            <div>
                                <span className="text-[var(--app-hint)]">Limits</span>
                                <div>{selectedLicense.maxMembers} members</div>
                                <div className="text-[11px] text-[var(--app-hint)]">
                                    {selectedLicense.maxConcurrentSessions === null ? 'Unlimited' : selectedLicense.maxConcurrentSessions} sessions
                                </div>
                            </div>
                        </div>

                        {selectedLicense.note && (
                            <div className="mt-2 text-xs text-[var(--app-hint)] italic">{selectedLicense.note}</div>
                        )}

                        {/* Actions */}
                        <div className="mt-3 flex items-center gap-2 pt-2 border-t border-[var(--app-divider)]">
                            <button
                                type="button"
                                onClick={() => setEditing(true)}
                                className="rounded-md border border-[var(--app-divider)] px-2.5 py-1 text-xs hover:bg-[var(--app-subtle-bg)] transition-colors"
                                disabled={isBusy}
                            >
                                Edit
                            </button>
                            {selectedLicense.status !== 'active' && (
                                <button
                                    type="button"
                                    onClick={() => void statusMutation.mutateAsync('active')}
                                    className="rounded-md bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20 transition-colors"
                                    disabled={isBusy}
                                >
                                    Activate
                                </button>
                            )}
                            {selectedLicense.status === 'active' && (
                                <button
                                    type="button"
                                    onClick={() => void statusMutation.mutateAsync('suspended')}
                                    className="rounded-md bg-amber-500/10 px-2.5 py-1 text-xs text-amber-600 dark:text-amber-400 hover:bg-amber-500/20 transition-colors"
                                    disabled={isBusy}
                                >
                                    Suspend
                                </button>
                            )}
                            <button
                                type="button"
                                onClick={() => {
                                    if (!confirm(`Delete license for ${selectedLicense.orgName}?`)) return
                                    void deleteMutation.mutateAsync()
                                }}
                                className="ml-auto rounded-md px-2.5 py-1 text-xs text-red-500 hover:bg-red-500/10 transition-colors"
                                disabled={isBusy}
                            >
                                Delete
                            </button>
                        </div>
                    </div>
                ) : selectedOrgId ? (
                    <div className="rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] p-3 space-y-2.5">
                        <div className="flex items-center justify-between">
                            <div className="text-xs font-medium">
                                {selectedLicense ? `Edit — ${selectedLicense.orgName}` : `New license — ${findOrgName(orgOptions, selectedOrgId)}`}
                            </div>
                            {selectedLicense && (
                                <button
                                    type="button"
                                    onClick={() => setEditing(false)}
                                    className="text-[11px] text-[var(--app-hint)] hover:text-[var(--app-text)] transition-colors"
                                >
                                    Cancel
                                </button>
                            )}
                        </div>

                        <div className="grid grid-cols-2 gap-2">
                            <label className="space-y-0.5">
                                <span className="text-[11px] text-[var(--app-hint)]">Start</span>
                                <input
                                    type="date"
                                    value={form.startsAt}
                                    onChange={(e) => setForm(c => ({ ...c, startsAt: e.target.value }))}
                                    className="w-full rounded-md border border-[var(--app-divider)] bg-[var(--app-subtle-bg)] px-2 py-1.5 text-xs"
                                    disabled={isBusy}
                                />
                            </label>
                            <label className="space-y-0.5">
                                <span className="text-[11px] text-[var(--app-hint)]">Expiry</span>
                                <input
                                    type="date"
                                    value={form.expiresAt}
                                    onChange={(e) => setForm(c => ({ ...c, expiresAt: e.target.value }))}
                                    className="w-full rounded-md border border-[var(--app-divider)] bg-[var(--app-subtle-bg)] px-2 py-1.5 text-xs"
                                    disabled={isBusy}
                                />
                            </label>
                            <label className="space-y-0.5">
                                <span className="text-[11px] text-[var(--app-hint)]">Max members</span>
                                <input
                                    type="number"
                                    min="1"
                                    value={form.maxMembers}
                                    onChange={(e) => setForm(c => ({ ...c, maxMembers: e.target.value }))}
                                    className="w-full rounded-md border border-[var(--app-divider)] bg-[var(--app-subtle-bg)] px-2 py-1.5 text-xs"
                                    disabled={isBusy}
                                />
                            </label>
                            <label className="space-y-0.5">
                                <span className="text-[11px] text-[var(--app-hint)]">Concurrent sessions</span>
                                <input
                                    type="number"
                                    min="1"
                                    value={form.maxConcurrentSessions}
                                    onChange={(e) => setForm(c => ({ ...c, maxConcurrentSessions: e.target.value }))}
                                    placeholder="Unlimited"
                                    className="w-full rounded-md border border-[var(--app-divider)] bg-[var(--app-subtle-bg)] px-2 py-1.5 text-xs"
                                    disabled={isBusy}
                                />
                            </label>
                        </div>
                        <label className="block space-y-0.5">
                            <span className="text-[11px] text-[var(--app-hint)]">Note</span>
                            <input
                                type="text"
                                value={form.note}
                                onChange={(e) => setForm(c => ({ ...c, note: e.target.value }))}
                                placeholder="Optional"
                                className="w-full rounded-md border border-[var(--app-divider)] bg-[var(--app-subtle-bg)] px-2 py-1.5 text-xs"
                                disabled={isBusy}
                            />
                        </label>
                        <button
                            type="button"
                            onClick={() => void saveMutation.mutateAsync()}
                            disabled={isBusy || !selectedOrgId}
                            className="w-full rounded-md bg-gradient-to-r from-indigo-500 to-purple-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                        >
                            {saveMutation.isPending ? 'Saving...' : selectedLicense ? 'Update' : 'Create'}
                        </button>
                    </div>
                ) : null}

                {message && <div className="text-[11px] text-emerald-600 dark:text-emerald-400">{message}</div>}
                {errorMessage && <div className="text-[11px] text-red-500">{errorMessage}</div>}

                {/* License list */}
                {licenses.length > 0 && (
                    <div className="space-y-1">
                        <div className="text-[11px] font-medium text-[var(--app-hint)] uppercase tracking-wider px-0.5">
                            All licenses ({licenses.length})
                        </div>
                        <div className="rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] divide-y divide-[var(--app-divider)] overflow-hidden">
                            {licenses.map((license) => {
                                const isSelected = license.orgId === selectedOrgId
                                const days = daysUntil(license.expiresAt)
                                return (
                                    <button
                                        key={license.id}
                                        type="button"
                                        onClick={() => { setSelectedOrgId(license.orgId); setEditing(false) }}
                                        className={`flex w-full items-center gap-3 px-3 py-2 text-left transition-colors ${isSelected ? 'bg-[var(--app-subtle-bg)]' : 'hover:bg-[var(--app-subtle-bg)]/50'}`}
                                    >
                                        <div className="min-w-0 flex-1">
                                            <div className="flex items-center gap-1.5">
                                                <span className={`truncate text-xs ${isSelected ? 'font-semibold' : 'font-medium'}`}>
                                                    {license.orgName}
                                                </span>
                                                <span className={`shrink-0 rounded-full px-1.5 py-px text-[9px] font-semibold uppercase leading-tight ${statusColors[license.status]}`}>
                                                    {license.status}
                                                </span>
                                            </div>
                                            <div className="text-[11px] text-[var(--app-hint)]">
                                                {license.maxMembers} members
                                                {' · '}
                                                {days > 0 ? `${days}d left` : 'expired'}
                                            </div>
                                        </div>
                                    </button>
                                )
                            })}
                        </div>
                    </div>
                )}
                {licensesLoading && (
                    <div className="text-xs text-[var(--app-hint)]">Loading...</div>
                )}
            </div>
        </div>
    )
}
