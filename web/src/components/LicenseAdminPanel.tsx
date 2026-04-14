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
    status: LicenseStatus
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
        status: 'active',
        note: '',
    }
}

function createFormFromLicense(license: AdminLicense): LicenseFormState {
    return {
        startsAt: formatDateInput(license.startsAt),
        expiresAt: formatDateInput(license.expiresAt),
        maxMembers: String(license.maxMembers),
        maxConcurrentSessions: license.maxConcurrentSessions === null ? '' : String(license.maxConcurrentSessions),
        status: license.status,
        note: license.note ?? '',
    }
}

function parseDateStart(value: string): number {
    return new Date(`${value}T00:00:00.000Z`).getTime()
}

function parseDateEnd(value: string): number {
    return new Date(`${value}T23:59:59.999Z`).getTime()
}

function formatDateDisplay(timestamp: number): string {
    return new Date(timestamp).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
    })
}

function findOrgName(orgs: Organization[], orgId: string): string {
    return orgs.find(org => org.id === orgId)?.name ?? orgId
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
                status: form.status,
                note: form.note.trim() ? form.note.trim() : null,
            })
        },
        onSuccess: async () => {
            await invalidateData(selectedOrgId)
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
            <div className="px-3 py-2 border-b border-[var(--app-divider)]">
                <h3 className="text-sm font-medium">License Admin</h3>
                <p className="text-[11px] text-[var(--app-hint)] mt-0.5">
                    Manage organization licenses from the admin org.
                </p>
            </div>

            <div className="p-3 space-y-3">
                <div className="grid gap-3 md:grid-cols-2">
                    <label className="space-y-1">
                        <span className="text-xs text-[var(--app-hint)]">Target organization</span>
                        <select
                            value={selectedOrgId}
                            onChange={(event) => setSelectedOrgId(event.target.value)}
                            className="w-full rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] px-3 py-2 text-sm"
                            disabled={orgOptionsLoading || isBusy}
                        >
                            {orgOptions.length === 0 && <option value="">No organizations</option>}
                            {orgOptions.map((org) => (
                                <option key={org.id} value={org.id}>
                                    {org.name} ({org.slug})
                                </option>
                            ))}
                        </select>
                    </label>

                    <div className="rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] px-3 py-2 text-xs">
                        {selectedLicense ? (
                            <div className="space-y-1">
                                <div className="font-medium">
                                    Current license: {selectedLicense.orgName} ({selectedLicense.orgSlug})
                                </div>
                                <div className="text-[var(--app-hint)]">
                                    {selectedLicense.status} · {formatDateDisplay(selectedLicense.startsAt)} - {formatDateDisplay(selectedLicense.expiresAt)}
                                </div>
                            </div>
                        ) : (
                            <div className="text-[var(--app-hint)]">
                                No license exists for the selected organization yet.
                            </div>
                        )}
                    </div>
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                    <label className="space-y-1">
                        <span className="text-xs text-[var(--app-hint)]">Starts on</span>
                        <input
                            type="date"
                            value={form.startsAt}
                            onChange={(event) => setForm(current => ({ ...current, startsAt: event.target.value }))}
                            className="w-full rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] px-3 py-2 text-sm"
                            disabled={isBusy}
                        />
                    </label>
                    <label className="space-y-1">
                        <span className="text-xs text-[var(--app-hint)]">Expires on</span>
                        <input
                            type="date"
                            value={form.expiresAt}
                            onChange={(event) => setForm(current => ({ ...current, expiresAt: event.target.value }))}
                            className="w-full rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] px-3 py-2 text-sm"
                            disabled={isBusy}
                        />
                    </label>
                    <label className="space-y-1">
                        <span className="text-xs text-[var(--app-hint)]">Max members</span>
                        <input
                            type="number"
                            min="1"
                            value={form.maxMembers}
                            onChange={(event) => setForm(current => ({ ...current, maxMembers: event.target.value }))}
                            className="w-full rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] px-3 py-2 text-sm"
                            disabled={isBusy}
                        />
                    </label>
                    <label className="space-y-1">
                        <span className="text-xs text-[var(--app-hint)]">Max concurrent sessions</span>
                        <input
                            type="number"
                            min="1"
                            value={form.maxConcurrentSessions}
                            onChange={(event) => setForm(current => ({ ...current, maxConcurrentSessions: event.target.value }))}
                            placeholder="Leave blank for unlimited"
                            className="w-full rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] px-3 py-2 text-sm"
                            disabled={isBusy}
                        />
                    </label>
                    <label className="space-y-1 md:col-span-2">
                        <span className="text-xs text-[var(--app-hint)]">Status</span>
                        <select
                            value={form.status}
                            onChange={(event) => setForm(current => ({ ...current, status: event.target.value as LicenseStatus }))}
                            className="w-full rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] px-3 py-2 text-sm"
                            disabled={isBusy}
                        >
                            <option value="active">active</option>
                            <option value="suspended">suspended</option>
                            <option value="expired">expired</option>
                        </select>
                    </label>
                    <label className="space-y-1 md:col-span-2">
                        <span className="text-xs text-[var(--app-hint)]">Note</span>
                        <textarea
                            value={form.note}
                            onChange={(event) => setForm(current => ({ ...current, note: event.target.value }))}
                            rows={3}
                            className="w-full rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] px-3 py-2 text-sm"
                            disabled={isBusy}
                        />
                    </label>
                </div>

                {message && <div className="text-xs text-emerald-600 dark:text-emerald-400">{message}</div>}
                {errorMessage && <div className="text-xs text-red-500">{errorMessage}</div>}

                <div className="flex flex-wrap gap-2">
                    <button
                        type="button"
                        onClick={() => void saveMutation.mutateAsync()}
                        disabled={isBusy || !selectedOrgId}
                        className="rounded-lg bg-gradient-to-r from-indigo-500 to-purple-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                    >
                        {saveMutation.isPending ? 'Saving...' : selectedLicense ? 'Update License' : 'Create License'}
                    </button>
                    <button
                        type="button"
                        onClick={() => void statusMutation.mutateAsync('active')}
                        disabled={isBusy || !selectedLicense || selectedLicense.status === 'active'}
                        className="rounded-lg border border-[var(--app-divider)] px-3 py-2 text-sm disabled:opacity-50"
                    >
                        Activate
                    </button>
                    <button
                        type="button"
                        onClick={() => void statusMutation.mutateAsync('suspended')}
                        disabled={isBusy || !selectedLicense || selectedLicense.status === 'suspended'}
                        className="rounded-lg border border-[var(--app-divider)] px-3 py-2 text-sm disabled:opacity-50"
                    >
                        Suspend
                    </button>
                    <button
                        type="button"
                        onClick={() => {
                            if (!selectedLicense) return
                            if (!confirm(`Delete license for ${selectedLicense.orgName}?`)) return
                            void deleteMutation.mutateAsync()
                        }}
                        disabled={isBusy || !selectedLicense}
                        className="rounded-lg border border-red-500/30 px-3 py-2 text-sm text-red-600 disabled:opacity-50"
                    >
                        Delete
                    </button>
                </div>

                <div className="rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] overflow-hidden">
                    <div className="px-3 py-2 border-b border-[var(--app-divider)] text-xs font-semibold uppercase tracking-wide text-[var(--app-hint)]">
                        Existing licenses
                    </div>
                    <div className="divide-y divide-[var(--app-divider)]">
                        {licensesLoading && (
                            <div className="px-3 py-3 text-sm text-[var(--app-hint)]">Loading licenses...</div>
                        )}
                        {!licensesLoading && licenses.length === 0 && (
                            <div className="px-3 py-3 text-sm text-[var(--app-hint)]">No licenses issued yet.</div>
                        )}
                        {licenses.map((license) => (
                            <button
                                key={license.id}
                                type="button"
                                onClick={() => setSelectedOrgId(license.orgId)}
                                className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-[var(--app-subtle-bg)]"
                            >
                                <div className="min-w-0">
                                    <div className="truncate text-sm font-medium">
                                        {license.orgName}
                                    </div>
                                    <div className="truncate text-[11px] text-[var(--app-hint)]">
                                        {license.orgSlug} · {formatDateDisplay(license.expiresAt)}
                                    </div>
                                </div>
                                <div className="shrink-0 rounded-full border border-[var(--app-divider)] px-2 py-0.5 text-[10px] font-semibold uppercase">
                                    {license.status}
                                </div>
                            </button>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    )
}
