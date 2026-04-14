import { useCallback, useEffect, useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAppContext } from '@/lib/app-context'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { Spinner } from '@/components/Spinner'
import { getClientId, getDeviceType } from '@/lib/client-identity'
import { getCurrentUserSync, getExpiresAtSync } from '@/services/tokenStorage'
import { useNotificationPermission, useWebPushSubscription } from '@/hooks/useNotification'
import { useServerUrl } from '@/hooks/useServerUrl'
import { getLogoutUrl, clearTokens } from '@/services/keycloak'
import type { Project, Machine, OrgRole, OrgLicense } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import { deriveLicenseState, type LicenseDisplayStatus } from '@/lib/license'
import { useMyOrgs, useOrg } from '@/hooks/queries/useOrgs'
import { useCreateOrg, useInviteMember, useUpdateMemberRole, useRemoveMember } from '@/hooks/mutations/useOrgMutations'
import { formatMachineTimestamp, getMachineIp, getMachineTitle, sortMachinesForStableDisplay } from '@/lib/machines'

const ROLE_LABELS: Record<OrgRole, string> = {
    owner: 'Owner',
    admin: 'Admin',
    member: 'Member',
}

const ROLE_COLORS: Record<OrgRole, string> = {
    owner: 'from-amber-500 to-orange-600',
    admin: 'from-blue-500 to-indigo-600',
    member: 'from-gray-400 to-gray-500',
}

type ProjectScope = 'shared' | 'machine'

function getProjectScope(project: Pick<Project, 'machineId'>): ProjectScope {
    return project.machineId ? 'machine' : 'shared'
}

function normalizeWorkspaceGroupId(value: string | null | undefined): string | null {
    const trimmed = value?.trim()
    return trimmed ? trimmed : null
}

function getMachineWorkspaceGroupId(machine: Machine | null | undefined): string | null {
    return normalizeWorkspaceGroupId(machine?.metadata?.workspaceGroupId)
}

function getProjectMachineLabel(machineId: string | null, machinesById: Map<string, Machine>): string | null {
    if (!machineId) return null
    const machine = machinesById.get(machineId)
    return machine ? getMachineTitle(machine) : machineId.slice(0, 8)
}

function getProjectScopeBadge(project: Project, machinesById: Map<string, Machine>): { label: string; title: string; className: string } {
    if (!project.machineId && project.workspaceGroupId) {
        return {
            label: `Org Shared · ${project.workspaceGroupId}`,
            title: `Shared with machines in workspace group ${project.workspaceGroupId}`,
            className: 'border-sky-500/20 bg-sky-500/10 text-sky-700 dark:text-sky-300'
        }
    }

    if (!project.machineId) {
        return {
            label: 'Legacy Shared',
            title: 'Legacy shared project without a workspace group',
            className: 'border-fuchsia-500/20 bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-300'
        }
    }

    const machineLabel = getProjectMachineLabel(project.machineId, machinesById)
    return {
        label: machineLabel ? `Machine Local · ${machineLabel}` : 'Machine Local',
        title: machineLabel
            ? `Only available on ${machineLabel}`
            : 'Only available on the bound machine',
        className: 'border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300'
    }
}

function formatDate(ts: number): string {
    return new Date(ts).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

const LICENSE_STATUS_STYLE: Record<LicenseDisplayStatus, { badge: string; label: string }> = {
    active: { badge: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400', label: 'Active' },
    expired: { badge: 'bg-red-500/15 text-red-600 dark:text-red-400', label: 'Expired' },
    pending: { badge: 'bg-sky-500/15 text-sky-600 dark:text-sky-400', label: 'Pending' },
    suspended: { badge: 'bg-amber-500/15 text-amber-600 dark:text-amber-400', label: 'Suspended' },
}

function LicenseCard({
    license,
    licenseExempt,
    memberCount,
}: {
    license: OrgLicense | null
    licenseExempt: boolean
    memberCount: number
}) {
    if (licenseExempt) {
        return (
            <div className="rounded-lg bg-[var(--app-subtle-bg)] overflow-hidden">
                <div className="px-3 py-2 border-b border-[var(--app-divider)]">
                    <h3 className="text-sm font-medium">License</h3>
                </div>
                <div className="px-3 py-4 flex items-center gap-2.5">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-500/10">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-emerald-500"><circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" /></svg>
                    </div>
                    <div>
                        <div className="text-sm font-medium text-emerald-600 dark:text-emerald-400">License exempt</div>
                        <div className="text-[11px] text-[var(--app-hint)] mt-0.5">
                            {license
                                ? 'This organization is configured as the admin org. Stored license limits are not enforced here.'
                                : 'This organization is configured as the admin org and can run without a stored license.'}
                        </div>
                    </div>
                </div>
            </div>
        )
    }

    if (!license) {
        return (
            <div className="rounded-lg bg-[var(--app-subtle-bg)] overflow-hidden">
                <div className="px-3 py-2 border-b border-[var(--app-divider)]">
                    <h3 className="text-sm font-medium">License</h3>
                </div>
                <div className="px-3 py-4 flex items-center gap-2.5">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-red-500/10">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-red-500"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
                    </div>
                    <div>
                        <div className="text-sm font-medium text-red-600 dark:text-red-400">No license configured</div>
                        <div className="text-[11px] text-[var(--app-hint)] mt-0.5">Contact your administrator to activate a license.</div>
                    </div>
                </div>
            </div>
        )
    }

    const {
        daysSinceExpiry,
        daysUntilExpiry,
        daysUntilStart,
        displayStatus,
        isBlocked,
        isExpired,
        isNotStarted,
        isSuspended,
        isWarningSoon,
    } = deriveLicenseState(license)
    const style = LICENSE_STATUS_STYLE[displayStatus]
    const memberPct = Math.min(100, Math.round((memberCount / license.maxMembers) * 100))
    const memberFull = memberCount >= license.maxMembers

    function daysLabel(): string {
        if (isNotStarted) {
            if (daysUntilStart <= 0) return 'Starts today'
            return `Starts in ${daysUntilStart} day${daysUntilStart !== 1 ? 's' : ''}`
        }
        if (isExpired) {
            if (daysSinceExpiry <= 0) return 'Expired today'
            return `Expired ${daysSinceExpiry} day${daysSinceExpiry !== 1 ? 's' : ''} ago`
        }
        return `${daysUntilExpiry} day${daysUntilExpiry !== 1 ? 's' : ''}`
    }

    return (
        <div className="rounded-lg bg-[var(--app-subtle-bg)] overflow-hidden">
            <div className="px-3 py-2 border-b border-[var(--app-divider)] flex items-center justify-between">
                <h3 className="text-sm font-medium">License</h3>
                <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${style.badge}`}>
                    {style.label}
                </span>
            </div>

            {/* Alert banner */}
            {(isBlocked || isWarningSoon) && (
                <div className={`px-3 py-2 border-b border-[var(--app-divider)] flex items-start gap-2 ${
                    isBlocked ? 'bg-red-500/10' : 'bg-amber-500/10'
                }`}>
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`mt-0.5 shrink-0 ${isBlocked ? 'text-red-500' : 'text-amber-500'}`}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                    <div className={`text-[11px] leading-relaxed font-medium ${isBlocked ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400'}`}>
                        {isSuspended
                            ? 'License suspended — sessions are blocked. Contact your administrator.'
                            : isNotStarted
                                ? `License not active yet — sessions are blocked until ${formatDate(license.startsAt)}.`
                            : isExpired
                                ? 'License expired — sessions are blocked. Contact your administrator.'
                                : `License expires in ${daysUntilExpiry} day${daysUntilExpiry !== 1 ? 's' : ''}. Renew soon to avoid interruption.`
                        }
                    </div>
                </div>
            )}

            <div className="divide-y divide-[var(--app-divider)]">
                {/* Valid period */}
                <div className="px-3 py-2 flex items-center justify-between gap-2">
                    <span className="text-xs text-[var(--app-hint)]">Valid period</span>
                    <span className="text-xs font-medium">
                        {formatDate(license.startsAt)} – {formatDate(license.expiresAt)}
                    </span>
                </div>

                {/* Days remaining */}
                <div className="px-3 py-2 flex items-center justify-between gap-2">
                    <span className="text-xs text-[var(--app-hint)]">{isNotStarted ? 'Starts' : 'Expiry'}</span>
                    <span className={`text-xs font-semibold ${
                        isBlocked ? 'text-red-500' : isWarningSoon ? 'text-amber-500' : 'text-[var(--app-fg)]'
                    }`}>
                        {daysLabel()}
                    </span>
                </div>

                {/* Members */}
                <div className="px-3 py-2.5 space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                        <span className="text-xs text-[var(--app-hint)]">Members</span>
                        <span className={`text-xs font-semibold ${memberFull ? 'text-red-500' : 'text-[var(--app-fg)]'}`}>
                            {memberCount} / {license.maxMembers}
                        </span>
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-[var(--app-border)]">
                        <div
                            className={`h-1.5 rounded-full transition-all ${
                                memberFull ? 'bg-red-500' : memberPct >= 80 ? 'bg-amber-500' : 'bg-emerald-500'
                            }`}
                            style={{ width: `${memberPct}%` }}
                        />
                    </div>
                </div>

                {/* Concurrent sessions limit */}
                {license.maxConcurrentSessions !== null && (
                    <div className="px-3 py-2 flex items-center justify-between gap-2">
                        <span className="text-xs text-[var(--app-hint)]">Max concurrent sessions</span>
                        <span className="text-xs font-medium">{license.maxConcurrentSessions}</span>
                    </div>
                )}

                {/* Note */}
                {license.note && (
                    <div className="px-3 py-2">
                        <span className="text-[11px] text-[var(--app-hint)] italic">{license.note}</span>
                    </div>
                )}
            </div>
        </div>
    )
}

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

function TrashIcon(props: { className?: string }) {
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
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        </svg>
    )
}

function PlusIcon(props: { className?: string }) {
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
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
    )
}

function CheckIcon(props: { className?: string }) {
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
            <polyline points="20 6 9 17 4 12" />
        </svg>
    )
}

function EditIcon(props: { className?: string }) {
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
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
        </svg>
    )
}

type ProjectFormData = {
    name: string
    path: string
    description: string
    machineId: string | null
    workspaceGroupId: string | null
}

function ProjectForm(props: {
    initial?: ProjectFormData
    onSubmit: (data: ProjectFormData) => void
    onCancel: () => void
    isPending: boolean
    submitLabel: string
    scope: ProjectScope
    machine: Machine | null
}) {
    const [name, setName] = useState(props.initial?.name ?? '')
    const [path, setPath] = useState(props.initial?.path ?? '')
    const [description, setDescription] = useState(props.initial?.description ?? '')
    const selectedWorkspaceGroupId = getMachineWorkspaceGroupId(props.machine)
    const initialWorkspaceGroupId = normalizeWorkspaceGroupId(props.initial?.workspaceGroupId)
    const effectiveMachineId = props.scope === 'machine'
        ? (props.initial?.machineId ?? props.machine?.id ?? null)
        : null
    const effectiveWorkspaceGroupId = props.scope === 'shared'
        ? (initialWorkspaceGroupId ?? selectedWorkspaceGroupId)
        : null
    const requiresWorkspaceGroup = props.scope === 'shared' && !effectiveWorkspaceGroupId
    const scopeLabel = props.scope === 'shared' ? 'Org Shared Project' : 'Machine Local Project'
    const scopeHint = props.scope === 'shared'
        ? initialWorkspaceGroupId
            ? `Shared with machines in workspace group ${initialWorkspaceGroupId}.`
            : props.initial
                ? selectedWorkspaceGroupId
                    ? `Legacy shared project. Saving will move it into workspace group ${selectedWorkspaceGroupId}.`
                    : 'Legacy shared project. Pick a machine with a workspace group above before saving.'
            : selectedWorkspaceGroupId
                ? `Shared with machines in workspace group ${selectedWorkspaceGroupId}, based on the machine selected above.`
                : 'Pick a machine with a workspace group above before adding a shared project.'
        : `Only available on ${props.machine ? getMachineTitle(props.machine) : (props.initial?.machineId?.slice(0, 8) ?? 'the selected machine')}. Use this for standalone machines like a MacBook.`

    const handleSubmit = useCallback((e: React.FormEvent) => {
        e.preventDefault()
        if (!name.trim() || !path.trim()) return
        if (props.scope === 'machine' && !effectiveMachineId) return
        if (requiresWorkspaceGroup && !effectiveWorkspaceGroupId) return
        props.onSubmit({
            name: name.trim(),
            path: path.trim(),
            description: description.trim(),
            machineId: effectiveMachineId,
            workspaceGroupId: effectiveWorkspaceGroupId,
        })
    }, [description, effectiveMachineId, effectiveWorkspaceGroupId, name, path, props, requiresWorkspaceGroup])

    return (
        <form onSubmit={handleSubmit} className="px-3 py-2 space-y-2 border-b border-[var(--app-divider)]">
            <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)]/70 px-3 py-2">
                <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--app-hint)]">
                    {scopeLabel}
                </div>
                <div className="mt-1 text-[11px] leading-relaxed text-[var(--app-hint)]">
                    {scopeHint}
                </div>
            </div>
            <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Project name"
                className="w-full px-2 py-1.5 text-sm rounded border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-1 focus:ring-[var(--app-button)]"
                disabled={props.isPending}
            />
            <input
                type="text"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="Absolute path (e.g. /home/user/projects/myapp)"
                className="w-full px-2 py-1.5 text-sm rounded border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-1 focus:ring-[var(--app-button)]"
                disabled={props.isPending}
            />
            <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Description (optional)"
                className="w-full px-2 py-1.5 text-sm rounded border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-1 focus:ring-[var(--app-button)]"
                disabled={props.isPending}
            />
            <div className="flex justify-end gap-2 pt-1">
                <button
                    type="button"
                    onClick={props.onCancel}
                    disabled={props.isPending}
                    className="px-3 py-1.5 text-sm rounded border border-[var(--app-border)] text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)] transition-colors disabled:opacity-50"
                >
                    Cancel
                </button>
                <button
                    type="submit"
                    disabled={
                        props.isPending
                        || !name.trim()
                        || !path.trim()
                        || (props.scope === 'machine' && !effectiveMachineId)
                        || (requiresWorkspaceGroup && !effectiveWorkspaceGroupId)
                    }
                    className="flex items-center gap-1 px-3 py-1.5 text-sm font-medium rounded bg-[var(--app-button)] text-[var(--app-button-text)] disabled:opacity-50 hover:opacity-90 transition-opacity"
                >
                    {props.isPending && <Spinner size="sm" label={null} />}
                    {props.submitLabel}
                </button>
            </div>
        </form>
    )
}

function MachineDetail(props: {
    label: string
    value: React.ReactNode
    mono?: boolean
    tone?: 'default' | 'accent'
    fullWidth?: boolean
}) {
    return (
        <div className={`rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)]/70 px-3 py-2 ${props.fullWidth ? 'sm:col-span-2' : ''}`}>
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--app-hint)]">
                {props.label}
            </div>
            <div className={`mt-1 text-[11px] leading-relaxed break-all ${
                props.mono ? 'font-mono' : ''
            } ${
                props.tone === 'accent' ? 'text-[var(--app-fg)] font-medium' : 'text-[var(--app-hint)]'
            }`}>
                {props.value}
            </div>
        </div>
    )
}

function MachineCard(props: {
    machine: Machine
    onSaveWorkspaceGroup: (machineId: string, workspaceGroupId: string | null) => void
    isSavingWorkspaceGroup: boolean
    onSaveSupportedAgents: (machineId: string, supportedAgents: ('claude' | 'codex')[] | null) => void
    isSavingSupportedAgents: boolean
}) {
    const { machine } = props
    const currentWorkspaceGroupId = getMachineWorkspaceGroupId(machine)
    const [workspaceGroupDraft, setWorkspaceGroupDraft] = useState(currentWorkspaceGroupId ?? '')
    const [showAdvanced, setShowAdvanced] = useState(false)
    const machineIp = getMachineIp(machine)
    const platformLabel = [
        machine.metadata?.platform || null,
        machine.metadata?.arch || null,
    ].filter(Boolean).join(' / ') || '-'
    const daemonLabel = [
        machine.daemonState?.status || (machine.active ? 'running' : 'offline'),
        machine.daemonState?.pid ? `PID ${machine.daemonState.pid}` : null,
        machine.daemonState?.httpPort ? `Port ${machine.daemonState.httpPort}` : null,
    ].filter(Boolean).join(' · ') || '-'
    const machineSubtitle = machine.metadata?.host && machine.metadata?.displayName && machine.metadata.displayName !== machine.metadata.host
        ? `Host ${machine.metadata.host}`
        : machine.metadata?.user
            ? `User ${machine.metadata.user}`
            : null
    const nextWorkspaceGroupId = normalizeWorkspaceGroupId(workspaceGroupDraft)
    const isWorkspaceGroupDirty = nextWorkspaceGroupId !== currentWorkspaceGroupId

    useEffect(() => {
        setWorkspaceGroupDraft(currentWorkspaceGroupId ?? '')
    }, [currentWorkspaceGroupId, machine.id])

    return (
        <div className={`relative overflow-hidden rounded-2xl border p-3 shadow-sm ${
            machine.active
                ? 'border-emerald-500/20 bg-gradient-to-br from-emerald-500/10 via-[var(--app-subtle-bg)] to-sky-500/10'
                : 'border-[var(--app-border)] bg-gradient-to-br from-[var(--app-subtle-bg)] via-transparent to-[var(--app-subtle-bg)]'
        }`}>
            <div className={`absolute inset-x-4 top-0 h-px ${
                machine.active
                    ? 'bg-gradient-to-r from-transparent via-emerald-400/80 to-transparent'
                    : 'bg-gradient-to-r from-transparent via-[var(--app-border)] to-transparent'
            }`} />

            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                        <span className={`mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full ${
                            machine.active
                                ? 'bg-emerald-500 shadow-[0_0_0_4px_rgba(16,185,129,0.14)]'
                                : 'bg-slate-400 shadow-[0_0_0_4px_rgba(148,163,184,0.14)]'
                        }`} />
                        <div className="min-w-0 text-sm font-semibold tracking-tight text-[var(--app-fg)] truncate">
                            {getMachineTitle(machine)}
                        </div>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <span className="rounded-full border border-[var(--app-border)] bg-[var(--app-bg)]/70 px-2 py-0.5 text-[10px] font-medium text-[var(--app-hint)]">
                            {platformLabel}
                        </span>
                        <span className="rounded-full border border-[var(--app-border)] bg-[var(--app-bg)]/70 px-2 py-0.5 text-[10px] font-mono text-[var(--app-hint)]">
                            {machine.metadata?.yohoRemoteCliVersion || '-'}
                        </span>
                        {machineIp ? (
                            <span className="rounded-full border border-[var(--app-border)] bg-[var(--app-bg)]/70 px-2 py-0.5 text-[10px] font-mono text-[var(--app-hint)]">
                                {machineIp}
                            </span>
                        ) : null}
                        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-mono ${
                            currentWorkspaceGroupId
                                ? 'border-sky-500/20 bg-sky-500/10 text-sky-700 dark:text-sky-300'
                                : 'border-[var(--app-border)] bg-[var(--app-bg)]/70 text-[var(--app-hint)]'
                        }`}>
                            {currentWorkspaceGroupId ? `WG ${currentWorkspaceGroupId}` : 'Local only'}
                        </span>
                        <span className="rounded-full border border-[var(--app-border)] bg-[var(--app-bg)]/70 px-2 py-0.5 text-[10px] font-medium text-[var(--app-hint)]">
                            {machine.supportedAgents && machine.supportedAgents.length > 0
                                ? machine.supportedAgents.join(', ')
                                : 'All agents'}
                        </span>
                    </div>
                    {machineSubtitle ? (
                        <div className="mt-2 text-[11px] text-[var(--app-hint)]">
                            {machineSubtitle}
                        </div>
                    ) : null}
                </div>

                <div className="shrink-0 text-right">
                    <div className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-semibold ${
                        machine.active
                            ? 'bg-emerald-500/14 text-emerald-700 dark:text-emerald-300'
                            : 'bg-slate-500/14 text-slate-600 dark:text-slate-300'
                    }`}>
                        <span className={`h-1.5 w-1.5 rounded-full ${machine.active ? 'bg-emerald-500' : 'bg-slate-400'}`} />
                        {machine.active ? 'Online' : 'Offline'}
                    </div>
                    <div className="mt-1 text-[10px] font-mono text-[var(--app-hint)]">
                        {machine.id.slice(0, 8)}
                    </div>
                </div>
            </div>

            {/* Primary details */}
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <MachineDetail
                    label="Last Active"
                    value={formatMachineTimestamp(machine.activeAt)}
                    tone="accent"
                />
                <MachineDetail
                    label="Daemon"
                    value={daemonLabel}
                    mono
                    tone="accent"
                />
                {machine.metadata?.cwd ? (
                    <MachineDetail
                        label="CWD"
                        value={machine.metadata.cwd}
                        mono
                        fullWidth
                    />
                ) : null}
            </div>

            {/* Advanced details (collapsible) */}
            <button
                type="button"
                onClick={() => setShowAdvanced(v => !v)}
                className="mt-2 flex items-center gap-1 text-[11px] text-[var(--app-hint)] hover:text-[var(--app-fg)] transition-colors"
            >
                <span className={`transition-transform ${showAdvanced ? 'rotate-90' : ''}`}>&#9654;</span>
                Advanced Details
            </button>
            {showAdvanced && (
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <MachineDetail label="Home" value={machine.metadata?.homeDir || '-'} mono />
                    <MachineDetail label="Remote" value={machine.metadata?.yohoRemoteHomeDir || '-'} mono />
                    <MachineDetail label="Runtime" value={machine.metadata?.yohoRemoteLibDir || '-'} mono />
                    <MachineDetail label="Server" value={machine.metadata?.serverUrl || '-'} mono />
                    <MachineDetail label="Machine ID" value={machine.id} mono fullWidth />
                </div>
            )}

            {/* Workspace Group Config */}
            <div className="mt-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)]/60 px-3 py-3">
                <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--app-hint)]">
                    Workspace Group Config
                </div>
                <div className="mt-1 text-[11px] leading-relaxed text-[var(--app-hint)]">
                    Machines that can open the same shared disk or repo path should use the same group ID. Standalone machines like a MacBook can leave this empty.
                </div>
                <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                    <input
                        type="text"
                        value={workspaceGroupDraft}
                        onChange={(e) => setWorkspaceGroupDraft(e.target.value)}
                        placeholder="e.g. ncu-shared"
                        className="flex-1 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2.5 py-2 text-sm text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-1 focus:ring-[var(--app-button)]"
                        disabled={props.isSavingWorkspaceGroup}
                    />
                    <button
                        type="button"
                        onClick={() => props.onSaveWorkspaceGroup(machine.id, nextWorkspaceGroupId)}
                        disabled={props.isSavingWorkspaceGroup || !isWorkspaceGroupDirty}
                        className="inline-flex items-center justify-center rounded-lg bg-[var(--app-button)] px-3 py-2 text-sm font-medium text-[var(--app-button-text)] transition-opacity hover:opacity-90 disabled:opacity-50"
                    >
                        {props.isSavingWorkspaceGroup ? 'Saving...' : 'Save Group'}
                    </button>
                </div>
            </div>

            {/* Supported Agents Config */}
            <div className="mt-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)]/60 px-3 py-3">
                <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--app-hint)]">
                    Supported Agents
                </div>
                <div className="mt-1 text-[11px] leading-relaxed text-[var(--app-hint)]">
                    Which AI agents can run on this machine. Leave all checked to allow any agent.
                </div>
                <div className="mt-2 flex gap-3">
                    {(['claude', 'codex'] as const).map((agent) => {
                        const checked = !machine.supportedAgents || machine.supportedAgents.includes(agent)
                        return (
                            <label key={agent} className="flex items-center gap-1.5 text-sm text-[var(--app-fg)] cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={checked}
                                    disabled={props.isSavingSupportedAgents}
                                    onChange={() => {
                                        const current = machine.supportedAgents ?? ['claude', 'codex']
                                        const next = checked
                                            ? current.filter(a => a !== agent)
                                            : [...current, agent]
                                        props.onSaveSupportedAgents(
                                            machine.id,
                                            next.length === 0 || next.length === 2 ? null : next as ('claude' | 'codex')[],
                                        )
                                    }}
                                    className="accent-[var(--app-button)]"
                                />
                                {agent === 'claude' ? 'Claude Code' : 'Codex'}
                            </label>
                        )
                    })}
                </div>
            </div>
        </div>
    )
}

function SessionExpiry({ expiresAt }: { expiresAt: number }) {
    const [now, setNow] = useState(Date.now())
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 60_000)
        return () => clearInterval(timer)
    }, [])

    const remaining = expiresAt - now
    if (remaining <= 0) {
        return <span className="text-sm font-mono text-red-500">Expired</span>
    }
    const hours = Math.floor(remaining / 3_600_000)
    const minutes = Math.floor((remaining % 3_600_000) / 60_000)
    const text = hours > 0 ? `${hours}h ${minutes}m remaining` : `${minutes}m remaining`
    const isLow = remaining < 600_000 // < 10 min
    return <span className={`text-sm font-mono ${isLow ? 'text-amber-500' : 'text-[var(--app-hint)]'}`}>{text}</span>
}

export default function SettingsPage() {
    const { api, currentOrgId, setCurrentOrgId } = useAppContext()
    const goBack = useAppGoBack()
    const queryClient = useQueryClient()
    const { baseUrl } = useServerUrl()
    const [projectError, setProjectError] = useState<string | null>(null)
    const [machineWorkspaceError, setMachineWorkspaceError] = useState<string | null>(null)
    const [showAddProject, setShowAddProject] = useState(false)
    const [editingProject, setEditingProject] = useState<Project | null>(null)
    const [projectScope, setProjectScope] = useState<ProjectScope>('shared')
    const [selectedLocalProjectMachineId, setSelectedLocalProjectMachineId] = useState<string | null>(null)
    const [selectedSharedProjectMachineId, setSelectedSharedProjectMachineId] = useState<string | null>(null)
    // 当前会话信息
    const currentSession = useMemo(() => ({
        name: getCurrentUserSync()?.name || '-',
        email: getCurrentUserSync()?.email || '-',
        clientId: getClientId(),
        deviceType: getDeviceType(),
        expiresAt: getExpiresAtSync()
    }), [])

    // 获取当前用户的角色和组织信息
    const { data: meData } = useQuery({
        queryKey: queryKeys.me,
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return await api.getMe()
        },
        enabled: Boolean(api)
    })

    // Organizations
    const { orgs } = useMyOrgs(api)
    const { createOrg, isPending: isCreatingOrg, error: createOrgError } = useCreateOrg(api)
    const [showCreateOrg, setShowCreateOrg] = useState(false)
    const [newOrgName, setNewOrgName] = useState('')
    const [newOrgSlug, setNewOrgSlug] = useState('')
    const [newOrgSlugTouched, setNewOrgSlugTouched] = useState(false)

    const handleNewOrgNameChange = useCallback((name: string) => {
        setNewOrgName(name)
        if (!newOrgSlugTouched) {
            setNewOrgSlug(name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''))
        }
    }, [newOrgSlugTouched])

    const handleCreateOrg = useCallback(async () => {
        if (!newOrgName.trim() || !newOrgSlug.trim()) return
        try {
            const result = await createOrg({ name: newOrgName.trim(), slug: newOrgSlug.trim() })
            if (result?.org) {
                setCurrentOrgId(result.org.id)
            }
            setShowCreateOrg(false)
            setNewOrgName('')
            setNewOrgSlug('')
            setNewOrgSlugTouched(false)
        } catch {
            // error handled by hook
        }
    }, [createOrg, newOrgName, newOrgSlug, setCurrentOrgId])

    // Members management
    const { members, myRole: orgRole, license: orgLicense, licenseExempt } = useOrg(api, currentOrgId ?? '')
    const { inviteMember, isPending: isInviting, error: inviteError } = useInviteMember(api, currentOrgId ?? '')
    const { updateRole } = useUpdateMemberRole(api, currentOrgId ?? '')
    const { removeMember } = useRemoveMember(api, currentOrgId ?? '')
    const [inviteEmail, setInviteEmail] = useState('')
    const [inviteRole, setInviteRole] = useState<'admin' | 'member'>('member')
    const [showInviteForm, setShowInviteForm] = useState(false)
    const canManageMembers = orgRole === 'owner' || orgRole === 'admin'

    // K1 Brain Config
    const { data: brainConfig, isLoading: brainConfigLoading } = useQuery({
        queryKey: ['brain-config'],
        queryFn: () => api.getBrainConfig(),
    })
    const brainConfigMutation = useMutation({
        mutationFn: (config: { agent: 'claude' | 'codex'; claudeModelMode?: string; codexModel?: string }) =>
            api.updateBrainConfig(config),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['brain-config'] }),
    })


    const handleInvite = useCallback(async () => {
        if (!inviteEmail.trim()) return
        try {
            await inviteMember({ email: inviteEmail.trim(), role: inviteRole })
            setInviteEmail('')
            setShowInviteForm(false)
        } catch {
            // error is handled by hook
        }
    }, [inviteMember, inviteEmail, inviteRole])

    const handleRoleChange = useCallback(async (email: string, newRole: string) => {
        try {
            await updateRole({ email, role: newRole })
        } catch (e) {
            console.error('Failed to update role:', e)
        }
    }, [updateRole])

    const handleRemoveMember = useCallback(async (email: string) => {
        if (!confirm(`Remove ${email} from organization?`)) return
        try {
            await removeMember(email)
        } catch (e) {
            console.error('Failed to remove member:', e)
        }
    }, [removeMember])

    // Machines
    const { data: machinesData } = useQuery({
        queryKey: ['machines', currentOrgId],
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return await api.getMachines(currentOrgId ?? undefined)
        },
        enabled: Boolean(api)
    })
    const machines = machinesData?.machines ?? []
    // Compute which agents are supported by at least one online machine
    const supportedAgentSet = useMemo(() => {
        const onlineMachines = machines.filter(m => m.active)
        const supported = new Set<string>()
        for (const m of onlineMachines) {
            if (!m.supportedAgents || m.supportedAgents.length === 0) {
                supported.add('claude')
                supported.add('codex')
            } else {
                for (const a of m.supportedAgents) supported.add(a)
            }
        }
        return supported
    }, [machines])
    const displayMachines = useMemo(() => sortMachinesForStableDisplay(machines), [machines])
    const machinesById = useMemo(() => new Map(displayMachines.map((machine) => [machine.id, machine])), [displayMachines])
    const sharedProjectMachines = useMemo(
        () => displayMachines.filter((machine) => Boolean(getMachineWorkspaceGroupId(machine))),
        [displayMachines]
    )
    const hasWorkspaceGroups = sharedProjectMachines.length > 0
    const selectedLocalProjectMachine = useMemo(() => {
        if (!selectedLocalProjectMachineId) return null
        return machinesById.get(selectedLocalProjectMachineId) ?? null
    }, [machinesById, selectedLocalProjectMachineId])
    const selectedSharedProjectMachine = useMemo(() => {
        if (!selectedSharedProjectMachineId) return null
        return machinesById.get(selectedSharedProjectMachineId) ?? null
    }, [machinesById, selectedSharedProjectMachineId])

    useEffect(() => {
        if (displayMachines.length === 0) {
            setSelectedLocalProjectMachineId(null)
            return
        }
        if (selectedLocalProjectMachineId && displayMachines.some((machine) => machine.id === selectedLocalProjectMachineId)) {
            return
        }
        setSelectedLocalProjectMachineId(displayMachines[0]?.id ?? null)
    }, [displayMachines, selectedLocalProjectMachineId])

    useEffect(() => {
        if (sharedProjectMachines.length === 0) {
            setSelectedSharedProjectMachineId(null)
            return
        }
        if (selectedSharedProjectMachineId && sharedProjectMachines.some((machine) => machine.id === selectedSharedProjectMachineId)) {
            return
        }
        setSelectedSharedProjectMachineId(sharedProjectMachines[0]?.id ?? null)
    }, [selectedSharedProjectMachineId, sharedProjectMachines])

    // Default to 'machine' scope when no workspace groups exist
    useEffect(() => {
        if (!hasWorkspaceGroups) {
            setProjectScope('machine')
        }
    }, [hasWorkspaceGroups])

    useEffect(() => {
        setShowAddProject(false)
        setEditingProject(null)
        setProjectError(null)
    }, [projectScope, selectedLocalProjectMachineId, selectedSharedProjectMachineId])

    // Projects
    const { data: sharedProjectsData, isLoading: sharedProjectsLoading } = useQuery({
        queryKey: ['projects', currentOrgId, 'shared', selectedSharedProjectMachineId],
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            if (!selectedSharedProjectMachineId) return { projects: [] }
            return await api.getProjects(currentOrgId, selectedSharedProjectMachineId)
        },
        enabled: Boolean(api && selectedSharedProjectMachineId)
    })

    const { data: machineProjectsData, isLoading: machineProjectsLoading } = useQuery({
        queryKey: ['projects', currentOrgId, 'machine', selectedLocalProjectMachineId],
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            if (!selectedLocalProjectMachineId) return { projects: [] }
            return await api.getProjects(currentOrgId, selectedLocalProjectMachineId)
        },
        enabled: Boolean(api && selectedLocalProjectMachineId)
    })

    const sharedProjects = useMemo(() => {
        return selectedSharedProjectMachineId && Array.isArray(sharedProjectsData?.projects)
            ? sharedProjectsData.projects.filter((project) => project.machineId === null)
            : []
    }, [selectedSharedProjectMachineId, sharedProjectsData])

    const machineProjects = useMemo(() => {
        if (!selectedLocalProjectMachineId || !Array.isArray(machineProjectsData?.projects)) {
            return []
        }
        return hasWorkspaceGroups
            ? machineProjectsData.projects.filter((project) => project.machineId === selectedLocalProjectMachineId)
            : machineProjectsData.projects
    }, [hasWorkspaceGroups, machineProjectsData, selectedLocalProjectMachineId])

    const projects = useMemo(() => {
        return projectScope === 'shared' ? sharedProjects : machineProjects
    }, [machineProjects, projectScope, sharedProjects])

    const projectsLoading = projectScope === 'shared'
        ? Boolean(selectedSharedProjectMachineId) && sharedProjectsLoading
        : Boolean(selectedLocalProjectMachineId) && machineProjectsLoading

    const canAddProject = projectScope === 'shared'
        ? Boolean(getMachineWorkspaceGroupId(selectedSharedProjectMachine))
        : Boolean(selectedLocalProjectMachineId)
    const projectSectionDescription = projectScope === 'shared'
        ? selectedSharedProjectMachine && getMachineWorkspaceGroupId(selectedSharedProjectMachine)
            ? `Paths shared with workspace group ${getMachineWorkspaceGroupId(selectedSharedProjectMachine)}`
            : 'Select a machine with a workspace group to manage shared paths'
        : selectedLocalProjectMachine
            ? hasWorkspaceGroups
                ? `Paths stored only on ${getMachineTitle(selectedLocalProjectMachine)}`
                : `Paths visible on ${getMachineTitle(selectedLocalProjectMachine)}. Legacy shared paths appear here until migrated.`
            : 'Select a machine to manage local-only project paths'
    const projectEmptyState = projectScope === 'shared'
        ? selectedSharedProjectMachine && getMachineWorkspaceGroupId(selectedSharedProjectMachine)
            ? `No shared projects saved for workspace group ${getMachineWorkspaceGroupId(selectedSharedProjectMachine)} yet.`
            : 'Configure a workspace group on at least one machine first.'
        : selectedLocalProjectMachine
            ? hasWorkspaceGroups
                ? `No local projects saved for ${getMachineTitle(selectedLocalProjectMachine)} yet.`
                : `No projects visible on ${getMachineTitle(selectedLocalProjectMachine)} yet.`
            : 'Select a machine first.'

    const addProjectMutation = useMutation({
        mutationFn: async (data: ProjectFormData) => {
            if (!api) throw new Error('API unavailable')
            return await api.addProject(
                data.name,
                data.path,
                data.description || undefined,
                currentOrgId,
                data.machineId,
                data.workspaceGroupId
            )
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['projects'] })
            setShowAddProject(false)
            setProjectError(null)
        },
        onError: (err) => {
            setProjectError(err instanceof Error ? err.message : 'Failed to add project')
        }
    })

    const updateProjectMutation = useMutation({
        mutationFn: async ({ id, data }: { id: string; data: ProjectFormData }) => {
            if (!api) throw new Error('API unavailable')
            return await api.updateProject(
                id,
                data.name,
                data.path,
                data.description || undefined,
                currentOrgId,
                data.machineId,
                data.workspaceGroupId
            )
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['projects'] })
            setEditingProject(null)
            setProjectError(null)
        },
        onError: (err) => {
            setProjectError(err instanceof Error ? err.message : 'Failed to update project')
        }
    })

    const removeProjectMutation = useMutation({
        mutationFn: async (id: string) => {
            if (!api) throw new Error('API unavailable')
            return await api.removeProject(id, currentOrgId)
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['projects'] })
        },
        onError: (err) => {
            setProjectError(err instanceof Error ? err.message : 'Failed to remove project')
        }
    })

    const updateMachineWorkspaceGroupMutation = useMutation({
        mutationFn: async ({ machineId, workspaceGroupId }: { machineId: string; workspaceGroupId: string | null }) => {
            if (!api) throw new Error('API unavailable')
            return await api.updateMachineWorkspaceGroup(machineId, workspaceGroupId)
        },
        onSuccess: () => {
            setMachineWorkspaceError(null)
            queryClient.invalidateQueries({ queryKey: queryKeys.machines })
            queryClient.invalidateQueries({ queryKey: ['projects'] })
        },
        onError: (err) => {
            setMachineWorkspaceError(err instanceof Error ? err.message : 'Failed to update workspace group')
        }
    })

    const handleAddProject = useCallback((data: ProjectFormData) => {
        addProjectMutation.mutate(data)
    }, [addProjectMutation])

    const handleUpdateProject = useCallback((data: ProjectFormData) => {
        if (!editingProject) return
        updateProjectMutation.mutate({ id: editingProject.id, data })
    }, [editingProject, updateProjectMutation])

    const handleRemoveProject = useCallback((id: string) => {
        removeProjectMutation.mutate(id)
    }, [removeProjectMutation])

    const handleSaveWorkspaceGroup = useCallback((machineId: string, workspaceGroupId: string | null) => {
        updateMachineWorkspaceGroupMutation.mutate({ machineId, workspaceGroupId })
    }, [updateMachineWorkspaceGroupMutation])

    const updateMachineSupportedAgentsMutation = useMutation({
        mutationFn: async ({ machineId, supportedAgents }: { machineId: string; supportedAgents: ('claude' | 'codex')[] | null }) => {
            if (!api) throw new Error('API unavailable')
            return await api.setMachineSupportedAgents(machineId, supportedAgents)
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: queryKeys.machines })
        },
    })

    const handleSaveSupportedAgents = useCallback((machineId: string, supportedAgents: ('claude' | 'codex')[] | null) => {
        updateMachineSupportedAgentsMutation.mutate({ machineId, supportedAgents })
    }, [updateMachineSupportedAgentsMutation])

    const handleLogout = useCallback(async () => {
        try {
            // 获取 Keycloak 登出 URL
            const redirectUri = window.location.origin + '/login'
            const logoutUrl = await getLogoutUrl(baseUrl, redirectUri)

            // 清除本地 tokens
            await clearTokens()

            // 清除其他 localStorage
            localStorage.clear()

            // 注销 PWA service worker
            if ('serviceWorker' in navigator) {
                const registrations = await navigator.serviceWorker.getRegistrations()
                for (const registration of registrations) {
                    await registration.unregister()
                }
            }

            // 清除所有缓存
            if ('caches' in window) {
                const cacheNames = await caches.keys()
                for (const cacheName of cacheNames) {
                    await caches.delete(cacheName)
                }
            }

            // 跳转到 Keycloak 登出页面
            window.location.href = logoutUrl
        } catch (error) {
            console.error('[Logout] Failed to get logout URL:', error)
            // 如果获取登出 URL 失败，仍然清除本地状态并跳转到登录页
            await clearTokens()
            localStorage.clear()
            window.location.href = '/login'
        }
    }, [baseUrl])

    // Notification settings
    const {
        permission: notificationPermission,
        enabled: notificationEnabled,
        setEnabled: setNotificationEnabled,
        requestPermission,
        isSupported: isNotificationSupported
    } = useNotificationPermission()

    // Web Push subscription
    const { subscribe: subscribePush, unsubscribe: unsubscribePush } = useWebPushSubscription(api)

    // User Preferences (Privacy Settings)
    const { data: userPreferences, isLoading: preferencesLoading } = useQuery({
        queryKey: queryKeys.userPreferences,
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return await api.getUserPreferences()
        },
        enabled: Boolean(api)
    })

    const updatePreferencesMutation = useMutation({
        mutationFn: async (preferences: { shareAllSessions?: boolean; viewOthersSessions?: boolean }) => {
            if (!api) throw new Error('API unavailable')
            return await api.updateUserPreferences(preferences)
        },
        onSuccess: (result, variables) => {
            queryClient.setQueryData(queryKeys.userPreferences, {
                shareAllSessions: result.shareAllSessions,
                viewOthersSessions: result.viewOthersSessions
            })
            // 如果修改了 viewOthersSessions，需要刷新 session 列表
            if (variables.viewOthersSessions !== undefined) {
                queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
            }
        }
    })

    const handleToggleShareAllSessions = useCallback(() => {
        const newValue = !userPreferences?.shareAllSessions
        updatePreferencesMutation.mutate({ shareAllSessions: newValue })
    }, [userPreferences?.shareAllSessions, updatePreferencesMutation])

    const handleToggleViewOthersSessions = useCallback(() => {
        const newValue = !userPreferences?.viewOthersSessions
        updatePreferencesMutation.mutate({ viewOthersSessions: newValue })
    }, [userPreferences?.viewOthersSessions, updatePreferencesMutation])

    const handleNotificationToggle = useCallback(async () => {
        if (notificationPermission === 'default') {
            const result = await requestPermission()
            if (result === 'granted') {
                // 权限获取成功后立即订阅 Web Push
                await subscribePush()
            }
        } else if (notificationPermission === 'granted') {
            const newEnabled = !notificationEnabled
            setNotificationEnabled(newEnabled)
            if (newEnabled) {
                // 开启通知时订阅 Web Push
                await subscribePush()
            } else {
                // 关闭通知时取消订阅
                await unsubscribePush()
            }
        }
    }, [notificationPermission, notificationEnabled, requestPermission, setNotificationEnabled, subscribePush, unsubscribePush])

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
                    <div className="flex-1 font-medium text-sm">Settings</div>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
                <div className="mx-auto w-full max-w-content p-3 space-y-4">
                    {/* ========== GENERAL SETTINGS ========== */}
                    <div className="space-y-4">
                        <h2 className="text-xs font-semibold text-[var(--app-hint)] uppercase tracking-wide px-1">General Settings</h2>

                        {/* Current Session Section */}
                        <div className="rounded-lg bg-[var(--app-subtle-bg)] overflow-hidden">
                            <div className="px-3 py-2 border-b border-[var(--app-divider)]">
                                <h3 className="text-sm font-medium">Current Session</h3>
                            </div>

                            {/* Profile header */}
                            <div className="px-3 py-3 flex items-center gap-3 border-b border-[var(--app-divider)]">
                                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-500/15 text-blue-500 font-semibold text-sm">
                                    {currentSession.name !== '-'
                                        ? currentSession.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
                                        : '?'}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                        <span className="text-sm font-medium truncate">{currentSession.name}</span>
                                        {meData?.role && (
                                            <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium leading-none ${
                                                meData.role === 'operator'
                                                    ? 'bg-amber-500/15 text-amber-500'
                                                    : 'bg-emerald-500/15 text-emerald-500'
                                            }`}>
                                                {meData.role === 'operator' ? 'Operator' : 'Developer'}
                                            </span>
                                        )}
                                    </div>
                                    <div className="text-xs text-[var(--app-hint)] truncate mt-0.5">{currentSession.email}</div>
                                    {meData?.orgs && meData.orgs.length > 0 && (
                                        <div className="text-xs text-[var(--app-hint)] truncate mt-0.5">
                                            {meData.orgs.map(o => o.name).join(', ')}
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Session details */}
                            <div className="divide-y divide-[var(--app-divider)]">
                                <div className="px-3 py-2 flex items-center justify-between gap-2">
                                    <span className="text-sm text-[var(--app-hint)]">Device</span>
                                    <span className="text-sm font-mono">{currentSession.deviceType}</span>
                                </div>
                                <div className="px-3 py-2 flex items-center justify-between gap-2">
                                    <span className="text-sm text-[var(--app-hint)]">Client ID</span>
                                    <span className="text-sm font-mono">{currentSession.clientId}</span>
                                </div>
                                {currentSession.expiresAt && (
                                    <div className="px-3 py-2 flex items-center justify-between gap-2">
                                        <span className="text-sm text-[var(--app-hint)]">Session</span>
                                        <SessionExpiry expiresAt={currentSession.expiresAt} />
                                    </div>
                                )}
                                <div className="px-3 py-2">
                                    <button
                                        type="button"
                                        onClick={handleLogout}
                                        className="w-full px-3 py-2 text-sm font-medium rounded bg-red-500/10 text-red-500 hover:bg-red-500/20 transition-colors"
                                    >
                                        Logout
                                    </button>
                                </div>
                            </div>
                        </div>

                        {/* Privacy Settings Section */}
                        <div className="rounded-lg bg-[var(--app-subtle-bg)] overflow-hidden">
                            <div className="px-3 py-2 border-b border-[var(--app-divider)]">
                                <h3 className="text-sm font-medium">Privacy</h3>
                            </div>
                            <div className="divide-y divide-[var(--app-divider)]">
                                <div className="px-3 py-2.5 flex items-center justify-between gap-3">
                                    <div className="flex-1">
                                        <div className="text-sm">Share My Sessions</div>
                                        <div className="text-[11px] text-[var(--app-hint)] mt-0.5">
                                            Allow team members to view and interact with your sessions
                                        </div>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={handleToggleShareAllSessions}
                                        disabled={preferencesLoading || updatePreferencesMutation.isPending}
                                        className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none disabled:opacity-50 ${
                                            userPreferences?.shareAllSessions ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'
                                        }`}
                                    >
                                        <span
                                            className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                                                userPreferences?.shareAllSessions ? 'translate-x-5' : 'translate-x-0'
                                            }`}
                                        />
                                    </button>
                                </div>
                                <div className="px-3 py-2.5 flex items-center justify-between gap-3">
                                    <div className="flex-1">
                                        <div className="text-sm">View Others' Sessions</div>
                                        <div className="text-[11px] text-[var(--app-hint)] mt-0.5">
                                            Show sessions shared by other team members
                                        </div>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={handleToggleViewOthersSessions}
                                        disabled={preferencesLoading || updatePreferencesMutation.isPending}
                                        className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none disabled:opacity-50 ${
                                            userPreferences?.viewOthersSessions ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'
                                        }`}
                                    >
                                        <span
                                            className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                                                userPreferences?.viewOthersSessions ? 'translate-x-5' : 'translate-x-0'
                                            }`}
                                        />
                                    </button>
                                </div>
                            </div>
                        </div>

                        {/* Notifications Section */}
                        {isNotificationSupported && (
                            <div className="rounded-lg bg-[var(--app-subtle-bg)] overflow-hidden">
                                <div className="px-3 py-2 border-b border-[var(--app-divider)]">
                                    <h3 className="text-sm font-medium">Notifications</h3>
                                    <p className="text-[11px] text-[var(--app-hint)] mt-0.5">
                                        Get notified when AI tasks complete.
                                    </p>
                                </div>
                                <div className="divide-y divide-[var(--app-divider)]">
                                    <div className="px-3 py-2.5 flex items-center justify-between gap-3">
                                        <div className="flex-1 min-w-0">
                                            <div className="text-sm">Push Notifications</div>
                                            <div className="text-[11px] text-[var(--app-hint)] mt-0.5">
                                                {notificationPermission === 'denied'
                                                    ? 'Blocked by browser. Enable in system settings.'
                                                    : notificationPermission === 'default'
                                                        ? 'Click to enable notifications.'
                                                        : 'Receive alerts when tasks finish.'}
                                            </div>
                                        </div>
                                        <button
                                            type="button"
                                            onClick={handleNotificationToggle}
                                            disabled={notificationPermission === 'denied'}
                                            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed ${
                                                notificationPermission === 'granted' && notificationEnabled
                                                    ? 'bg-green-500'
                                                    : 'bg-gray-300 dark:bg-gray-600'
                                            }`}
                                        >
                                            <span
                                                className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                                                    notificationPermission === 'granted' && notificationEnabled ? 'translate-x-5' : 'translate-x-0'
                                                }`}
                                            />
                                        </button>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* ========== K1 BRAIN CONFIG ========== */}
                    <div className="space-y-4">
                        <h2 className="text-xs font-semibold text-[var(--app-hint)] uppercase tracking-wide px-1">K1 Brain</h2>
                        <div className="rounded-lg bg-[var(--app-subtle-bg)] overflow-hidden">
                            <div className="px-3 py-2 border-b border-[var(--app-divider)]">
                                <h3 className="text-sm font-medium">Session Agent</h3>
                                <p className="text-[11px] text-[var(--app-hint)] mt-0.5">
                                    Configure which AI agent K1 uses for Brain sessions
                                </p>
                            </div>
                            {brainConfigLoading ? (
                                <div className="px-3 py-4 flex justify-center"><Spinner /></div>
                            ) : (
                                <div className="divide-y divide-[var(--app-divider)]">
                                    {/* Agent selector */}
                                    <div className="px-3 py-2.5">
                                        <div className="flex gap-2">
                                            {([
                                                { value: 'claude' as const, label: 'Claude Code', desc: 'Anthropic Claude' },
                                                { value: 'codex' as const, label: 'Codex', desc: 'OpenAI Codex' },
                                            ] as const).map((opt) => {
                                                const isActive = (brainConfig?.agent ?? 'claude') === opt.value
                                                const isSupported = supportedAgentSet.size === 0 || supportedAgentSet.has(opt.value)
                                                return (
                                                    <button
                                                        key={opt.value}
                                                        type="button"
                                                        disabled={brainConfigMutation.isPending || !isSupported}
                                                        title={!isSupported ? 'No online machine supports this agent' : undefined}
                                                        onClick={() => {
                                                            brainConfigMutation.mutate({ agent: opt.value })
                                                        }}
                                                        className={`flex-1 px-3 py-2 rounded-lg border text-sm font-medium transition-colors ${
                                                            isActive
                                                                ? 'border-[var(--app-button)] bg-[var(--app-button)]/10 text-[var(--app-button)]'
                                                                : 'border-[var(--app-border)] text-[var(--app-hint)] hover:border-[var(--app-fg)]/30'
                                                        } disabled:opacity-50`}
                                                    >
                                                        <div>{opt.label}</div>
                                                        <div className="text-[10px] font-normal mt-0.5 opacity-70">
                                                            {!isSupported ? 'No machine available' : opt.desc}
                                                        </div>
                                                    </button>
                                                )
                                            })}
                                        </div>
                                    </div>
                                    {/* Status */}
                                    {brainConfigMutation.isError && (
                                        <div className="px-3 py-2 text-xs text-red-500">
                                            Failed to update: {(brainConfigMutation.error as Error)?.message || 'Unknown error'}
                                        </div>
                                    )}
                                    {brainConfig?.updatedAt ? (
                                        <div className="px-3 py-2 text-[11px] text-[var(--app-hint)]">
                                            Last updated: {new Date(brainConfig.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
                                            {brainConfig.updatedBy ? ` by ${brainConfig.updatedBy}` : ''}
                                        </div>
                                    ) : null}
                                </div>
                            )}
                        </div>
                    </div>

                    {/* ========== ORGANIZATION SWITCHER ========== */}
                    <div className="rounded-lg bg-[var(--app-subtle-bg)] overflow-hidden">
                        <div className="px-3 py-2 border-b border-[var(--app-divider)]">
                            <h2 className="text-sm font-medium">Organization</h2>
                            <p className="text-[11px] text-[var(--app-hint)] mt-0.5">
                                Select an organization to view its settings below
                            </p>
                        </div>
                        <div className="divide-y divide-[var(--app-divider)]">
                            {orgs.map((org) => {
                                const isCurrent = org.id === currentOrgId
                                return (
                                    <button
                                        key={org.id}
                                        type="button"
                                        onClick={() => setCurrentOrgId(org.id)}
                                        className={`w-full px-3 py-2.5 flex items-center justify-between gap-2 transition-colors ${
                                            isCurrent ? 'bg-[var(--app-button)]/10' : 'hover:bg-[var(--app-secondary-bg)]'
                                        }`}
                                    >
                                        <div className="flex items-center gap-2 min-w-0">
                                            <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-white text-xs font-bold ${
                                                isCurrent
                                                    ? 'bg-gradient-to-br from-indigo-500 to-purple-600 ring-2 ring-[var(--app-button)] ring-offset-2 ring-offset-[var(--app-subtle-bg)]'
                                                    : 'bg-gradient-to-br from-indigo-500/50 to-purple-600/50'
                                            }`}>
                                                {org.name.charAt(0).toUpperCase()}
                                            </div>
                                            <div className="min-w-0 text-left">
                                                <div className={`text-sm font-medium truncate ${isCurrent ? 'text-[var(--app-button)]' : ''}`}>
                                                    {org.name}
                                                    {isCurrent && (
                                                        <span className="ml-1.5 text-[10px] font-normal px-1.5 py-0.5 rounded bg-[var(--app-button)]/10 text-[var(--app-button)]">
                                                            Current
                                                        </span>
                                                    )}
                                                </div>
                                                <div className={`text-[10px] ${isCurrent ? 'text-[var(--app-button)]/70' : 'text-[var(--app-hint)]'}`}>
                                                    {org.myRole}
                                                </div>
                                            </div>
                                        </div>
                                        {isCurrent && (
                                            <CheckIcon className="shrink-0 text-[var(--app-button)]" />
                                        )}
                                    </button>
                                )
                            })}
                        </div>
                        {!showCreateOrg ? (
                            <div className="border-t border-[var(--app-divider)] px-3 py-2">
                                <button
                                    type="button"
                                    onClick={() => setShowCreateOrg(true)}
                                    className="w-full py-2 text-sm font-medium rounded-lg text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)] transition-colors flex items-center justify-center gap-1.5"
                                >
                                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
                                    Create Organization
                                </button>
                            </div>
                        ) : (
                            <div className="border-t border-[var(--app-divider)] p-3 space-y-3">
                                <div>
                                    <label className="block text-xs font-medium text-[var(--app-hint)] mb-1">Organization Name</label>
                                    <input
                                        type="text"
                                        value={newOrgName}
                                        onChange={(e) => handleNewOrgNameChange(e.target.value)}
                                        placeholder="My Team"
                                        className="w-full px-3 py-2 text-sm rounded-lg bg-[var(--app-bg)] border border-[var(--app-divider)] text-[var(--app-fg)] placeholder:text-[var(--app-hint)]"
                                        autoFocus
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-medium text-[var(--app-hint)] mb-1">URL Slug</label>
                                    <input
                                        type="text"
                                        value={newOrgSlug}
                                        onChange={(e) => { setNewOrgSlug(e.target.value); setNewOrgSlugTouched(true) }}
                                        placeholder="my-team"
                                        className="w-full px-3 py-2 text-sm rounded-lg bg-[var(--app-bg)] border border-[var(--app-divider)] text-[var(--app-fg)] placeholder:text-[var(--app-hint)]"
                                    />
                                    <div className="mt-1 text-[10px] text-[var(--app-hint)]">Lowercase letters, numbers, and hyphens only</div>
                                </div>
                                {createOrgError && (
                                    <div className="text-xs text-red-500">{createOrgError}</div>
                                )}
                                <div className="flex gap-2">
                                    <button
                                        type="button"
                                        onClick={() => { setShowCreateOrg(false); setNewOrgName(''); setNewOrgSlug(''); setNewOrgSlugTouched(false) }}
                                        className="flex-1 py-2 text-sm rounded-lg bg-[var(--app-secondary-bg)] text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] transition-colors"
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        type="button"
                                        onClick={handleCreateOrg}
                                        disabled={isCreatingOrg || !newOrgName.trim() || !newOrgSlug.trim()}
                                        className="flex-1 py-2 text-sm font-medium rounded-lg bg-gradient-to-r from-indigo-500 to-purple-600 text-white disabled:opacity-50"
                                    >
                                        {isCreatingOrg ? 'Creating...' : 'Create'}
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* ========== ORGANIZATION SETTINGS ========== */}
                    {currentOrgId && (
                        <div className="space-y-4">
                            <h2 className="text-xs font-semibold text-[var(--app-hint)] uppercase tracking-wide px-1">
                                Organization Settings
                            </h2>

                            {/* License Section */}
                            <LicenseCard license={orgLicense} licenseExempt={licenseExempt} memberCount={members.length} />

                            {/* Members Section */}
                            <div id="section-members" className="rounded-lg bg-[var(--app-subtle-bg)] overflow-hidden">
                                <div className="px-3 py-2 border-b border-[var(--app-divider)] flex items-center justify-between">
                                    <div>
                                        <h3 className="text-sm font-medium">Members</h3>
                                        <p className="text-[11px] text-[var(--app-hint)] mt-0.5">
                                            {members.length} member{members.length !== 1 ? 's' : ''} in this organization
                                        </p>
                                    </div>
                                    {canManageMembers && (
                                        <button
                                            type="button"
                                            onClick={() => setShowInviteForm(!showInviteForm)}
                                            className="text-xs px-2 py-1 rounded bg-[var(--app-button)] text-[var(--app-button-text)] hover:opacity-90 transition-opacity"
                                        >
                                            + Invite
                                        </button>
                                    )}
                                </div>
                                {showInviteForm && canManageMembers && (
                                    <div className="px-3 py-2.5 border-b border-[var(--app-divider)] space-y-2">
                                        <input
                                            type="email"
                                            value={inviteEmail}
                                            onChange={(e) => setInviteEmail(e.target.value)}
                                            placeholder="Email address"
                                            className="w-full px-2.5 py-1.5 text-sm rounded bg-[var(--app-bg)] border border-[var(--app-divider)] text-[var(--app-fg)] placeholder:text-[var(--app-hint)]"
                                            onKeyDown={(e) => { if (e.key === 'Enter') handleInvite() }}
                                        />
                                        <div className="flex items-center gap-2">
                                            <select
                                                value={inviteRole}
                                                onChange={(e) => setInviteRole(e.target.value as 'admin' | 'member')}
                                                className="flex-1 px-2 py-1.5 text-sm rounded bg-[var(--app-bg)] border border-[var(--app-divider)] text-[var(--app-fg)]"
                                            >
                                                <option value="member">Member</option>
                                                {orgRole === 'owner' && <option value="admin">Admin</option>}
                                            </select>
                                            <button
                                                type="button"
                                                onClick={handleInvite}
                                                disabled={isInviting || !inviteEmail.trim()}
                                                className="px-3 py-1.5 text-sm rounded bg-gradient-to-r from-indigo-500 to-purple-600 text-white disabled:opacity-50"
                                            >
                                                {isInviting ? '...' : 'Send'}
                                            </button>
                                        </div>
                                        {inviteError && (
                                            <div className="text-xs text-red-500">{inviteError}</div>
                                        )}
                                    </div>
                                )}
                                <div className="divide-y divide-[var(--app-divider)]">
                                    {members.map((member) => {
                                        const isCurrentUser = member.userEmail === currentSession.email
                                        const canEdit = canManageMembers && !isCurrentUser
                                        const canChangeRole = orgRole === 'owner' && !isCurrentUser
                                        return (
                                            <div key={member.userEmail} className="px-3 py-2 flex items-center gap-2">
                                                <div className="flex-1 min-w-0">
                                                    <div className="text-sm truncate text-[var(--app-fg)]">
                                                        {member.userEmail}
                                                        {isCurrentUser && <span className="text-[var(--app-hint)] ml-1">(you)</span>}
                                                    </div>
                                                </div>
                                                {canChangeRole ? (
                                                    <select
                                                        value={member.role}
                                                        onChange={(e) => handleRoleChange(member.userEmail, e.target.value)}
                                                        className="text-[11px] px-1.5 py-0.5 rounded bg-[var(--app-bg)] border border-[var(--app-divider)] text-[var(--app-fg)]"
                                                    >
                                                        <option value="owner">Owner</option>
                                                        <option value="admin">Admin</option>
                                                        <option value="member">Member</option>
                                                    </select>
                                                ) : (
                                                    <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full text-white bg-gradient-to-r ${ROLE_COLORS[member.role as OrgRole]}`}>
                                                        {ROLE_LABELS[member.role as OrgRole] ?? member.role}
                                                    </span>
                                                )}
                                                {canEdit && member.role !== 'owner' && (
                                                    <button
                                                        type="button"
                                                        onClick={() => handleRemoveMember(member.userEmail)}
                                                        className="text-[var(--app-hint)] hover:text-red-500 transition-colors"
                                                        title="Remove member"
                                                    >
                                                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                                                    </button>
                                                )}
                                            </div>
                                        )
                                    })}
                                </div>
                            </div>

                            {/* Projects Section */}
                            <div id="section-projects" className="rounded-lg bg-[var(--app-subtle-bg)] overflow-hidden">
                                <div className="px-3 py-2 border-b border-[var(--app-divider)] flex items-center justify-between">
                                    <div>
                                        <h3 className="text-sm font-medium">Projects</h3>
                                        <p className="text-[11px] text-[var(--app-hint)] mt-0.5">
                                            {projectSectionDescription}
                                        </p>
                                    </div>
                                    {!showAddProject && !editingProject && (
                                        <div className="flex items-center gap-2">
                                            <button
                                                type="button"
                                                onClick={() => setShowAddProject(true)}
                                                disabled={!canAddProject}
                                                className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded bg-[var(--app-button)] text-[var(--app-button-text)] hover:opacity-90 transition-opacity disabled:opacity-50"
                                            >
                                                <PlusIcon className="w-3 h-3" />
                                                {projectScope === 'shared' ? 'Add Shared' : 'Add Local'}
                                            </button>
                                        </div>
                                    )}
                                </div>
                                <div className="px-3 py-2.5 border-b border-[var(--app-divider)] space-y-2">
                                        <div className="inline-flex rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)]/70 p-1">
                                            <button
                                                type="button"
                                                onClick={() => setProjectScope('shared')}
                                                disabled={sharedProjectMachines.length === 0}
                                                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                                                    projectScope === 'shared'
                                                        ? 'bg-[var(--app-button)] text-[var(--app-button-text)]'
                                                        : 'text-[var(--app-hint)] hover:text-[var(--app-fg)] disabled:opacity-40 disabled:cursor-not-allowed'
                                                }`}
                                            >
                                                Org Shared
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setProjectScope('machine')}
                                                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                                                    projectScope === 'machine'
                                                        ? 'bg-[var(--app-button)] text-[var(--app-button-text)]'
                                                        : 'text-[var(--app-hint)] hover:text-[var(--app-fg)]'
                                                }`}
                                            >
                                                Machine Local
                                            </button>
                                        </div>
                                        {projectScope === 'machine' ? (
                                            displayMachines.length > 0 ? (
                                                <div className="space-y-1.5">
                                                    <select
                                                        value={selectedLocalProjectMachineId ?? ''}
                                                        onChange={(e) => setSelectedLocalProjectMachineId(e.target.value || null)}
                                                        className="w-full px-2 py-1.5 text-sm rounded border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--app-button)]"
                                                    >
                                                        {displayMachines.map((machine) => (
                                                            <option key={machine.id} value={machine.id}>
                                                                {getMachineTitle(machine)}
                                                                {machine.metadata?.platform ? ` (${machine.metadata.platform})` : ''}
                                                            </option>
                                                        ))}
                                                    </select>
                                                    <div className="text-[11px] text-[var(--app-hint)]">
                                                        Standalone machines like a MacBook should manage their own local project paths here.
                                                    </div>
                                                </div>
                                            ) : (
                                                <div className="text-[11px] text-[var(--app-hint)]">
                                                    No machines available yet.
                                                </div>
                                            )
                                        ) : (
                                            <div className="space-y-1.5">
                                                <select
                                                    value={selectedSharedProjectMachineId ?? ''}
                                                    onChange={(e) => setSelectedSharedProjectMachineId(e.target.value || null)}
                                                    className="w-full px-2 py-1.5 text-sm rounded border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--app-button)]"
                                                >
                                                    {sharedProjectMachines.map((machine) => {
                                                        const workspaceGroupId = getMachineWorkspaceGroupId(machine)
                                                        return (
                                                            <option key={machine.id} value={machine.id}>
                                                                {getMachineTitle(machine)}
                                                                {workspaceGroupId ? ` · ${workspaceGroupId}` : ''}
                                                            </option>
                                                        )
                                                    })}
                                                </select>
                                                <div className="text-[11px] text-[var(--app-hint)]">
                                                    Shared projects created here will be visible to every machine in the selected workspace group.
                                                </div>
                                            </div>
                                        )}
                                </div>
                                {showAddProject && (
                                    <ProjectForm
                                        scope={projectScope}
                                        machine={projectScope === 'shared' ? selectedSharedProjectMachine : selectedLocalProjectMachine}
                                        onSubmit={handleAddProject}
                                        onCancel={() => {
                                            setShowAddProject(false)
                                            setProjectError(null)
                                        }}
                                        isPending={addProjectMutation.isPending}
                                        submitLabel="Add Project"
                                    />
                                )}
                                {projectError && (
                                    <div className="px-3 py-2 text-sm text-red-500 border-b border-[var(--app-divider)]">
                                        {projectError}
                                    </div>
                                )}
                                {projectsLoading ? (
                                    <div className="px-3 py-4 flex justify-center">
                                        <Spinner size="sm" label="Loading..." />
                                    </div>
                                ) : projects.length === 0 && !showAddProject ? (
                                    <div className="px-3 py-4 text-center text-sm text-[var(--app-hint)]">
                                        {projectEmptyState}
                                    </div>
                                ) : (
                                    <div className="divide-y divide-[var(--app-divider)]">
                                        {projects.map((project) => (
                                            editingProject?.id === project.id ? (
                                                <ProjectForm
                                                    key={project.id}
                                                    initial={{
                                                        name: project.name,
                                                        path: project.path,
                                                        description: project.description ?? '',
                                                        machineId: project.machineId,
                                                        workspaceGroupId: project.workspaceGroupId,
                                                    }}
                                                    scope={getProjectScope(project)}
                                                    machine={project.machineId
                                                        ? (machinesById.get(project.machineId) ?? null)
                                                        : displayMachines.find((machine) => getMachineWorkspaceGroupId(machine) === project.workspaceGroupId) ?? selectedSharedProjectMachine}
                                                    onSubmit={handleUpdateProject}
                                                    onCancel={() => {
                                                        setEditingProject(null)
                                                        setProjectError(null)
                                                    }}
                                                    isPending={updateProjectMutation.isPending}
                                                    submitLabel="Save"
                                                />
                                            ) : (
                                                <div key={project.id} className="px-3 py-2">
                                                    <div className="flex items-start justify-between gap-2">
                                                        <div className="min-w-0 flex-1">
                                                            <div className="text-sm font-medium truncate">{project.name}</div>
                                                            <div className="text-xs text-[var(--app-hint)] font-mono truncate mt-0.5">{project.path}</div>
                                                            {(
                                                                <>
                                                                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                                                                        {(() => {
                                                                            const badge = getProjectScopeBadge(project, machinesById)
                                                                            return (
                                                                                <span
                                                                                    title={badge.title}
                                                                                    className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${badge.className}`}
                                                                                >
                                                                                    {badge.label}
                                                                                </span>
                                                                            )
                                                                        })()}
                                                                    </div>
                                                                    {project.machineId ? (
                                                                        <div className="text-xs text-[var(--app-hint)] mt-1">
                                                                            Only on {getProjectMachineLabel(project.machineId, machinesById)}
                                                                        </div>
                                                                    ) : project.workspaceGroupId ? (
                                                                        <div className="text-xs text-[var(--app-hint)] mt-1">
                                                                            Org shared · {project.workspaceGroupId}
                                                                        </div>
                                                                    ) : (
                                                                        <div className="text-xs text-[var(--app-hint)] mt-1">
                                                                            Legacy shared project. Assign a workspace group when editing.
                                                                        </div>
                                                                    )}
                                                                </>
                                                            )}
                                                            {project.description && (
                                                                <div className="text-xs text-[var(--app-hint)] mt-0.5 line-clamp-2">{project.description}</div>
                                                            )}
                                                        </div>
                                                        <div className="flex items-center gap-1 shrink-0">
                                                            <button
                                                                type="button"
                                                                onClick={() => setEditingProject(project)}
                                                                disabled={removeProjectMutation.isPending}
                                                                className="flex h-7 w-7 items-center justify-center rounded text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)] transition-colors disabled:opacity-50"
                                                                title="Edit project"
                                                            >
                                                                <EditIcon />
                                                            </button>
                                                            <button
                                                                type="button"
                                                                onClick={() => handleRemoveProject(project.id)}
                                                                disabled={removeProjectMutation.isPending}
                                                                className="flex h-7 w-7 items-center justify-center rounded text-[var(--app-hint)] hover:text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                                                                title="Remove project"
                                                            >
                                                                <TrashIcon />
                                                            </button>
                                                        </div>
                                                    </div>
                                                </div>
                                            )
                                        ))}
                                    </div>
                                )}
                            </div>

                            {/* Machines Section */}
                            <div className="rounded-lg bg-[var(--app-subtle-bg)] overflow-hidden">
                                <div className="px-3 py-2.5 border-b border-[var(--app-divider)] flex items-center justify-between gap-3">
                                    <div>
                                        <h3 className="text-sm font-medium">Machines</h3>
                                        <p className="text-[11px] text-[var(--app-hint)] mt-0.5">
                                            {displayMachines.filter((machine) => machine.active).length} / {displayMachines.length} online · runtime and path details
                                        </p>
                                    </div>
                                    <div className="shrink-0 rounded-full border border-[var(--app-border)] bg-[var(--app-bg)]/70 px-2.5 py-1 text-[10px] font-semibold text-[var(--app-hint)]">
                                        {displayMachines.length} total
                                    </div>
                                </div>
                                {machineWorkspaceError ? (
                                    <div className="border-b border-[var(--app-divider)] px-3 py-2 text-sm text-red-500">
                                        {machineWorkspaceError}
                                    </div>
                                ) : null}
                                {displayMachines.length === 0 ? (
                                    <div className="px-3 py-4 text-center text-sm text-[var(--app-hint)]">
                                        No machines connected yet.
                                    </div>
                                ) : (
                                    <div className="space-y-3 p-3">
                                        {displayMachines.map((machine) => (
                                            <MachineCard
                                                key={machine.id}
                                                machine={machine}
                                                onSaveWorkspaceGroup={handleSaveWorkspaceGroup}
                                                isSavingWorkspaceGroup={
                                                    updateMachineWorkspaceGroupMutation.isPending
                                                    && updateMachineWorkspaceGroupMutation.variables?.machineId === machine.id
                                                }
                                                onSaveSupportedAgents={handleSaveSupportedAgents}
                                                isSavingSupportedAgents={
                                                    updateMachineSupportedAgentsMutation.isPending
                                                    && updateMachineSupportedAgentsMutation.variables?.machineId === machine.id
                                                }
                                            />
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                </div>
            </div>
        </div>
    )
}
