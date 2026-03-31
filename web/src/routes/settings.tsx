import { useCallback, useState, useMemo, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useAppContext } from '@/lib/app-context'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { Spinner } from '@/components/Spinner'
import { getClientId, getDeviceType, getStoredEmail } from '@/lib/client-identity'
import { useNotificationPermission, useWebPushSubscription } from '@/hooks/useNotification'
import { useServerUrl } from '@/hooks/useServerUrl'
import { getLogoutUrl, clearTokens } from '@/services/keycloak'
import type { Project, Machine, OrgMember, OrgRole } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import { useMyOrgs, useOrg } from '@/hooks/queries/useOrgs'
import { useCreateOrg, useInviteMember, useUpdateMemberRole, useRemoveMember } from '@/hooks/mutations/useOrgMutations'
import { CRSApiKeyManager } from '@/components/CRSApiKeyManager'

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
}

function ProjectForm(props: {
    initial?: ProjectFormData
    onSubmit: (data: ProjectFormData) => void
    onCancel: () => void
    isPending: boolean
    submitLabel: string
    machines: Machine[]
}) {
    const [name, setName] = useState(props.initial?.name ?? '')
    const [path, setPath] = useState(props.initial?.path ?? '')
    const [description, setDescription] = useState(props.initial?.description ?? '')
    const [machineId, setMachineId] = useState<string | null>(props.initial?.machineId ?? null)

    const handleSubmit = useCallback((e: React.FormEvent) => {
        e.preventDefault()
        if (!name.trim() || !path.trim() || !machineId) return
        props.onSubmit({ name: name.trim(), path: path.trim(), description: description.trim(), machineId })
    }, [name, path, description, machineId, props])

    const getMachineTitle = (machine: Machine): string => {
        if (machine.metadata?.displayName) return machine.metadata.displayName
        if (machine.metadata?.host) return machine.metadata.host
        return machine.id.slice(0, 8)
    }

    return (
        <form onSubmit={handleSubmit} className="px-3 py-2 space-y-2 border-b border-[var(--app-divider)]">
            {/* Machine selector - first */}
            <select
                value={machineId ?? ''}
                onChange={(e) => setMachineId(e.target.value || null)}
                disabled={props.isPending}
                className="w-full px-2 py-1.5 text-sm rounded border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--app-button)] disabled:opacity-50"
            >
                <option value="" disabled>Select machine...</option>
                {props.machines.map((m) => (
                    <option key={m.id} value={m.id}>
                        {getMachineTitle(m)}{m.metadata?.platform ? ` (${m.metadata.platform})` : ''}
                    </option>
                ))}
            </select>
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
                    disabled={props.isPending || !name.trim() || !path.trim() || !machineId}
                    className="flex items-center gap-1 px-3 py-1.5 text-sm font-medium rounded bg-[var(--app-button)] text-[var(--app-button-text)] disabled:opacity-50 hover:opacity-90 transition-opacity"
                >
                    {props.isPending && <Spinner size="sm" label={null} />}
                    {props.submitLabel}
                </button>
            </div>
        </form>
    )
}

export default function SettingsPage() {
    const { api, currentOrgId, setCurrentOrgId } = useAppContext()
    const goBack = useAppGoBack()
    const navigate = useNavigate()
    const queryClient = useQueryClient()
    const { baseUrl } = useServerUrl()
    const [projectError, setProjectError] = useState<string | null>(null)
    const [showAddProject, setShowAddProject] = useState(false)
    const [editingProject, setEditingProject] = useState<Project | null>(null)
    // 当前会话信息
    const currentSession = useMemo(() => ({
        email: getStoredEmail() || '-',
        clientId: getClientId(),
        deviceType: getDeviceType()
    }), [])

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
    const { members, myRole: orgRole } = useOrg(api, currentOrgId ?? '')
    const { inviteMember, isPending: isInviting, error: inviteError } = useInviteMember(api, currentOrgId ?? '')
    const { updateRole } = useUpdateMemberRole(api, currentOrgId ?? '')
    const { removeMember } = useRemoveMember(api, currentOrgId ?? '')
    const [inviteEmail, setInviteEmail] = useState('')
    const [inviteRole, setInviteRole] = useState<'admin' | 'member'>('member')
    const [showInviteForm, setShowInviteForm] = useState(false)
    const canManageMembers = orgRole === 'owner' || orgRole === 'admin'

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

    // Machines (for project form)
    const { data: machinesData } = useQuery({
        queryKey: ['machines', currentOrgId],
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return await api.getMachines(currentOrgId ?? undefined)
        },
        enabled: Boolean(api)
    })
    const machines = machinesData?.machines ?? []

    // Machine filter for projects
    const [selectedMachineId, setSelectedMachineId] = useState<string | null>(null)

    // Projects
    const { data: projectsData, isLoading: projectsLoading } = useQuery({
        queryKey: ['projects', selectedMachineId, currentOrgId],
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return await api.getProjects(selectedMachineId ?? undefined, currentOrgId)
        },
        enabled: Boolean(api)
    })

    const addProjectMutation = useMutation({
        mutationFn: async (data: ProjectFormData) => {
            if (!api) throw new Error('API unavailable')
            return await api.addProject(data.name, data.path, data.description || undefined, data.machineId, currentOrgId)
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
            return await api.updateProject(id, data.name, data.path, data.description || undefined, data.machineId, currentOrgId)
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

    // Filter projects by platform for global projects (machineId = null)
    const projects = useMemo(() => {
        const allProjects = Array.isArray(projectsData?.projects) ? projectsData.projects : []

        // If no machine filter selected, return all projects
        if (!selectedMachineId) {
            return allProjects
        }

        // Find the selected machine's platform
        const selectedMachine = machines.find(m => m.id === selectedMachineId)
        const platform = selectedMachine?.metadata?.platform ?? ''

        return allProjects.filter(project => {
            // If project has machineId, only show if it matches selected machine
            if (project.machineId) {
                return project.machineId === selectedMachineId
            }
            // Global project: check if path is compatible with selected platform
            if (platform === 'darwin') {
                // macOS: paths start with /Users
                return project.path.startsWith('/Users/')
            } else {
                // Linux: paths start with /home or /root or /opt
                return project.path.startsWith('/home/') ||
                       project.path.startsWith('/root/') ||
                       project.path.startsWith('/opt/')
            }
        })
    }, [projectsData, selectedMachineId, machines])

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
                            <div className="divide-y divide-[var(--app-divider)]">
                                <div className="px-3 py-2 flex items-center justify-between gap-2">
                                    <span className="text-sm text-[var(--app-hint)]">Email</span>
                                    <span className="text-sm font-mono truncate">{currentSession.email}</span>
                                </div>
                                <div className="px-3 py-2 flex items-center justify-between gap-2">
                                    <span className="text-sm text-[var(--app-hint)]">Device</span>
                                    <span className="text-sm font-mono">{currentSession.deviceType}</span>
                                </div>
                                <div className="px-3 py-2 flex items-center justify-between gap-2">
                                    <span className="text-sm text-[var(--app-hint)]">Client ID</span>
                                    <span className="text-sm font-mono">{currentSession.clientId}</span>
                                </div>
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

                            {/* API Keys Section - Only for owners */}
                            {api && orgs.find(o => o.id === currentOrgId)?.myRole === 'owner' && (
                                <div id="section-api-keys" className="rounded-lg bg-[var(--app-subtle-bg)] overflow-hidden">
                                    <div className="px-3 py-2 border-b border-[var(--app-divider)]">
                                        <h3 className="text-sm font-medium">API Keys</h3>
                                        <p className="text-[11px] text-[var(--app-hint)] mt-0.5">
                                            Manage Claude API keys and monitor token usage
                                        </p>
                                    </div>
                                    <div className="p-3">
                                        <CRSApiKeyManager
                                            api={api}
                                            orgId={currentOrgId}
                                            orgSlug={orgs.find(o => o.id === currentOrgId)?.slug ?? ''}
                                        />
                                    </div>
                                </div>
                            )}

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
                                            Saved project paths for quick access
                                        </p>
                                    </div>
                                    {!showAddProject && !editingProject && (
                                        <div className="flex items-center gap-2">
                                            <select
                                                value={selectedMachineId ?? ''}
                                                onChange={(e) => setSelectedMachineId(e.target.value || null)}
                                                className="text-xs px-2 py-1 rounded border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--app-button)]"
                                            >
                                                <option value="">All machines</option>
                                                {machines.map((m) => (
                                                    <option key={m.id} value={m.id}>
                                                        {m.metadata?.displayName || m.metadata?.host || m.id.slice(0, 8)}
                                                    </option>
                                                ))}
                                            </select>
                                            <button
                                                type="button"
                                                onClick={() => setShowAddProject(true)}
                                                className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded bg-[var(--app-button)] text-[var(--app-button-text)] hover:opacity-90 transition-opacity"
                                            >
                                                <PlusIcon className="w-3 h-3" />
                                                Add
                                            </button>
                                        </div>
                                    )}
                                </div>
                                {showAddProject && (
                                    <ProjectForm
                                        onSubmit={handleAddProject}
                                        onCancel={() => {
                                            setShowAddProject(false)
                                            setProjectError(null)
                                        }}
                                        isPending={addProjectMutation.isPending}
                                        submitLabel="Add Project"
                                        machines={machines}
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
                                        No projects saved yet.
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
                                                        machineId: project.machineId
                                                    }}
                                                    onSubmit={handleUpdateProject}
                                                    onCancel={() => {
                                                        setEditingProject(null)
                                                        setProjectError(null)
                                                    }}
                                                    isPending={updateProjectMutation.isPending}
                                                    submitLabel="Save"
                                                    machines={machines}
                                                />
                                            ) : (
                                                <div key={project.id} className="px-3 py-2">
                                                    <div className="flex items-start justify-between gap-2">
                                                        <div className="min-w-0 flex-1">
                                                            <div className="text-sm font-medium truncate">{project.name}</div>
                                                            <div className="text-xs text-[var(--app-hint)] font-mono truncate mt-0.5">{project.path}</div>
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
                                <div className="px-3 py-2 border-b border-[var(--app-divider)]">
                                    <h3 className="text-sm font-medium">Machines</h3>
                                    <p className="text-[11px] text-[var(--app-hint)] mt-0.5">
                                        Machines connected to this organization
                                    </p>
                                </div>
                                {machines.length === 0 ? (
                                    <div className="px-3 py-4 text-center text-sm text-[var(--app-hint)]">
                                        No machines connected yet.
                                    </div>
                                ) : (
                                    <div className="divide-y divide-[var(--app-divider)]">
                                        {machines.map((machine) => (
                                            <div key={machine.id} className="px-3 py-2.5">
                                                <div className="flex items-start justify-between gap-2">
                                                    <div className="min-w-0 flex-1">
                                                        <div className="text-sm font-medium truncate">
                                                            {machine.metadata?.host || machine.id.slice(0, 8)}
                                                        </div>
                                                        <div className="text-xs text-[var(--app-hint)] mt-1 space-y-0.5">
                                                            <div className="flex items-center gap-2">
                                                                <span className="text-[10px] font-medium">Platform:</span>
                                                                <span className="font-mono">{machine.metadata?.platform || '-'}</span>
                                                            </div>
                                                            <div className="flex items-center gap-2">
                                                                <span className="text-[10px] font-medium">Version:</span>
                                                                <span className="font-mono text-[10px]">{machine.metadata?.yohoRemoteCliVersion || '-'}</span>
                                                            </div>
                                                            <div className="flex items-center gap-2">
                                                                <span className="text-[10px] font-medium">ID:</span>
                                                                <span className="font-mono text-[10px]">{machine.id}</span>
                                                            </div>
                                                        </div>
                                                    </div>
                                                    <div className={`shrink-0 px-2 py-1 rounded text-[10px] font-medium ${
                                                        machine.active
                                                            ? 'bg-green-500/10 text-green-600 dark:text-green-400'
                                                            : 'bg-gray-500/10 text-gray-600 dark:text-gray-400'
                                                    }`}>
                                                        {machine.active ? 'Active' : 'Inactive'}
                                                    </div>
                                                </div>
                                            </div>
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
