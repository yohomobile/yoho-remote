import { useState, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAppContext } from '@/lib/app-context'
import { Spinner } from '@/components/Spinner'
import { queryKeys } from '@/lib/query-keys'
import type { AIProfile, AIProfileRole, AIProfileStatus } from '@/types/api'

const ROLE_LABELS: Record<AIProfileRole, string> = {
    developer: 'Developer',
    architect: 'Architect',
    reviewer: 'Reviewer',
    pm: 'PM',
    tester: 'Tester',
    devops: 'DevOps'
}

const ROLE_DESCRIPTIONS: Record<AIProfileRole, string> = {
    developer: 'Writes and maintains code',
    architect: 'Designs system architecture',
    reviewer: 'Reviews code and provides feedback',
    pm: 'Manages project and tasks',
    tester: 'Writes and runs tests',
    devops: 'Handles deployment and infrastructure'
}

const STATUS_COLORS: Record<AIProfileStatus, string> = {
    idle: 'bg-gray-500/20 text-gray-600',
    working: 'bg-green-500/20 text-green-600',
    resting: 'bg-blue-500/20 text-blue-600'
}

const STATUS_LABELS: Record<AIProfileStatus, string> = {
    idle: 'Idle',
    working: 'Working',
    resting: 'Resting'
}

const DEFAULT_EMOJIS = ['🤖', '👨‍💻', '👩‍💻', '🧑‍💻', '🦾', '🧠', '💡', '⚡']

type AIProfileFormData = {
    name: string
    role: AIProfileRole
    specialties: string
    personality: string
    greetingTemplate: string
    preferredProjects: string
    workStyle: string
    avatarEmoji: string
}

const defaultFormData: AIProfileFormData = {
    name: '',
    role: 'developer',
    specialties: '',
    personality: '',
    greetingTemplate: '',
    preferredProjects: '',
    workStyle: '',
    avatarEmoji: '🤖'
}

function ProfileForm({
    initial,
    onSubmit,
    onCancel,
    isPending,
    submitLabel,
    readOnly = false,
}: {
    initial?: AIProfileFormData
    onSubmit: (data: AIProfileFormData) => void
    onCancel: () => void
    isPending: boolean
    submitLabel: string
    readOnly?: boolean
}) {
    const [formData, setFormData] = useState<AIProfileFormData>(initial ?? defaultFormData)

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault()
        onSubmit(formData)
    }

    return (
        <form onSubmit={handleSubmit} className="px-3 py-2 border-b border-[var(--app-divider)] space-y-3">
            <div className="flex items-start gap-3">
                <div className="flex flex-col items-center gap-1">
                    <div
                        className={`w-12 h-12 rounded-full bg-[var(--app-secondary-bg)] flex items-center justify-center text-2xl transition-colors ${
                            readOnly ? 'cursor-default opacity-70' : 'cursor-pointer hover:bg-[var(--app-button)]/10'
                        }`}
                        onClick={() => {
                            if (readOnly) return
                            const currentIndex = DEFAULT_EMOJIS.indexOf(formData.avatarEmoji)
                            const nextIndex = (currentIndex + 1) % DEFAULT_EMOJIS.length
                            setFormData({ ...formData, avatarEmoji: DEFAULT_EMOJIS[nextIndex] })
                        }}
                        title="Click to change emoji"
                    >
                        {formData.avatarEmoji}
                    </div>
                    <span className="text-[10px] text-[var(--app-hint)]">Click to change</span>
                </div>
                <div className="flex-1 space-y-2">
                    <input
                        type="text"
                        value={formData.name}
                        onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                        placeholder="AI Employee Name"
                        className="w-full px-2 py-1.5 text-sm rounded border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-1 focus:ring-[var(--app-button)]"
                        disabled={isPending || readOnly}
                        required
                    />
                    <select
                        value={formData.role}
                        onChange={(e) => setFormData({ ...formData, role: e.target.value as AIProfileRole })}
                        className="w-full px-2 py-1.5 text-sm rounded border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--app-button)]"
                        disabled={isPending || readOnly}
                    >
                        {Object.entries(ROLE_LABELS).map(([role, label]) => (
                            <option key={role} value={role}>{label} - {ROLE_DESCRIPTIONS[role as AIProfileRole]}</option>
                        ))}
                    </select>
                </div>
            </div>

            <div>
                <label className="block text-xs text-[var(--app-hint)] mb-1">Specialties (comma separated)</label>
                <input
                    type="text"
                    value={formData.specialties}
                    onChange={(e) => setFormData({ ...formData, specialties: e.target.value })}
                    placeholder="e.g. TypeScript, React, Backend APIs"
                    className="w-full px-2 py-1.5 text-sm rounded border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-1 focus:ring-[var(--app-button)]"
                    disabled={isPending || readOnly}
                />
            </div>

            <div>
                <label className="block text-xs text-[var(--app-hint)] mb-1">Personality</label>
                <textarea
                    value={formData.personality}
                    onChange={(e) => setFormData({ ...formData, personality: e.target.value })}
                    placeholder="Describe this AI's personality and communication style..."
                    className="w-full px-2 py-1.5 text-sm rounded border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-1 focus:ring-[var(--app-button)] resize-none"
                    rows={2}
                    disabled={isPending || readOnly}
                />
            </div>

            <div>
                <label className="block text-xs text-[var(--app-hint)] mb-1">Greeting Template</label>
                <input
                    type="text"
                    value={formData.greetingTemplate}
                    onChange={(e) => setFormData({ ...formData, greetingTemplate: e.target.value })}
                    placeholder="e.g. Hey! Ready to code something awesome?"
                    className="w-full px-2 py-1.5 text-sm rounded border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-1 focus:ring-[var(--app-button)]"
                    disabled={isPending || readOnly}
                />
            </div>

            <div className="flex justify-end gap-2 pt-1">
                <button
                    type="button"
                    onClick={onCancel}
                    disabled={isPending || readOnly}
                    className="px-3 py-1.5 text-sm rounded border border-[var(--app-border)] text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)] transition-colors disabled:opacity-50"
                >
                    Cancel
                </button>
                <button
                    type="submit"
                    disabled={readOnly || isPending || !formData.name.trim()}
                    className="flex items-center gap-1 px-3 py-1.5 text-sm font-medium rounded bg-[var(--app-button)] text-[var(--app-button-text)] disabled:opacity-50 hover:opacity-90 transition-opacity"
                >
                    {isPending && <Spinner size="sm" label={null} />}
                    {submitLabel}
                </button>
            </div>
        </form>
    )
}

function ProfileCard({
    profile,
    onEdit,
    onDelete,
    isDeleting,
    readOnly = false,
}: {
    profile: AIProfile
    onEdit: () => void
    onDelete: () => void
    isDeleting: boolean
    readOnly?: boolean
}) {
    return (
        <div className="px-3 py-2">
            <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-full bg-[var(--app-secondary-bg)] flex items-center justify-center text-xl shrink-0">
                    {profile.avatarEmoji}
                </div>
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">{profile.name}</span>
                        <span className={`px-1.5 py-0.5 text-[10px] font-medium rounded ${STATUS_COLORS[profile.status]}`}>
                            {STATUS_LABELS[profile.status]}
                        </span>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-xs text-[var(--app-hint)]">{ROLE_LABELS[profile.role]}</span>
                        {profile.specialties.length > 0 && (
                            <>
                                <span className="text-[var(--app-hint)]">·</span>
                                <span className="text-xs text-[var(--app-hint)] truncate">
                                    {profile.specialties.slice(0, 3).join(', ')}
                                    {profile.specialties.length > 3 && ` +${profile.specialties.length - 3}`}
                                </span>
                            </>
                        )}
                    </div>
                    {profile.personality && (
                        <div className="text-xs text-[var(--app-hint)] mt-1 line-clamp-1 italic">
                            "{profile.personality}"
                        </div>
                    )}
                    <div className="flex items-center gap-3 mt-1.5 text-[10px] text-[var(--app-hint)]">
                        <span>{profile.stats.tasksCompleted} tasks</span>
                        <span>{Math.floor(profile.stats.activeMinutes / 60)}h active</span>
                    </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                    <button
                        type="button"
                        onClick={onEdit}
                        disabled={isDeleting || readOnly}
                        className="flex h-7 w-7 items-center justify-center rounded text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)] transition-colors disabled:opacity-50"
                        title="Edit profile"
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                        </svg>
                    </button>
                    <button
                        type="button"
                        onClick={onDelete}
                        disabled={isDeleting || readOnly}
                        className="flex h-7 w-7 items-center justify-center rounded text-[var(--app-hint)] hover:text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                        title="Delete profile"
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="3 6 5 6 21 6" />
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        </svg>
                    </button>
                </div>
            </div>
        </div>
    )
}

export function AIProfileSettings(props: {
    orgId?: string | null
    canManage?: boolean
}) {
    const { api } = useAppContext()
    const queryClient = useQueryClient()
    const orgId = props.orgId ?? null
    const canManage = props.canManage !== false
    const [showAddForm, setShowAddForm] = useState(false)
    const [editingProfile, setEditingProfile] = useState<AIProfile | null>(null)
    const [error, setError] = useState<string | null>(null)

    const { data, isLoading } = useQuery({
        queryKey: queryKeys.aiProfiles(orgId),
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return await api.getAIProfiles(orgId)
        },
        enabled: Boolean(api)
    })

    const createMutation = useMutation({
        mutationFn: async (formData: AIProfileFormData) => {
            if (!api) throw new Error('API unavailable')
            return await api.createAIProfile({
                name: formData.name,
                role: formData.role,
                specialties: formData.specialties.split(',').map(s => s.trim()).filter(Boolean),
                personality: formData.personality || null,
                greetingTemplate: formData.greetingTemplate || null,
                preferredProjects: formData.preferredProjects.split(',').map(s => s.trim()).filter(Boolean),
                workStyle: formData.workStyle || null,
                avatarEmoji: formData.avatarEmoji
            }, orgId)
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: queryKeys.aiProfiles(orgId) })
            setShowAddForm(false)
            setError(null)
        },
        onError: (err: Error) => {
            setError(err.message)
        }
    })

    const updateMutation = useMutation({
        mutationFn: async ({ id, formData }: { id: string; formData: AIProfileFormData }) => {
            if (!api) throw new Error('API unavailable')
            return await api.updateAIProfile(id, {
                name: formData.name,
                role: formData.role,
                specialties: formData.specialties.split(',').map(s => s.trim()).filter(Boolean),
                personality: formData.personality || null,
                greetingTemplate: formData.greetingTemplate || null,
                preferredProjects: formData.preferredProjects.split(',').map(s => s.trim()).filter(Boolean),
                workStyle: formData.workStyle || null,
                avatarEmoji: formData.avatarEmoji
            }, orgId)
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: queryKeys.aiProfiles(orgId) })
            setEditingProfile(null)
            setError(null)
        },
        onError: (err: Error) => {
            setError(err.message)
        }
    })

    const deleteMutation = useMutation({
        mutationFn: async (id: string) => {
            if (!api) throw new Error('API unavailable')
            return await api.deleteAIProfile(id, orgId)
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: queryKeys.aiProfiles(orgId) })
            setError(null)
        },
        onError: (err: Error) => {
            setError(err.message)
        }
    })

    const handleCreate = useCallback((formData: AIProfileFormData) => {
        if (!canManage) return
        createMutation.mutate(formData)
    }, [canManage, createMutation])

    const handleUpdate = useCallback((formData: AIProfileFormData) => {
        if (!editingProfile || !canManage) return
        updateMutation.mutate({ id: editingProfile.id, formData })
    }, [canManage, editingProfile, updateMutation])

    const handleDelete = useCallback((id: string) => {
        if (!canManage) return
        if (confirm('Are you sure you want to delete this AI profile?')) {
            deleteMutation.mutate(id)
        }
    }, [canManage, deleteMutation])

    const profiles = Array.isArray(data?.profiles) ? data.profiles : []

    const profileToFormData = (profile: AIProfile): AIProfileFormData => ({
        name: profile.name,
        role: profile.role,
        specialties: profile.specialties.join(', '),
        personality: profile.personality ?? '',
        greetingTemplate: profile.greetingTemplate ?? '',
        preferredProjects: profile.preferredProjects.join(', '),
        workStyle: profile.workStyle ?? '',
        avatarEmoji: profile.avatarEmoji
    })

    return (
        <div className="rounded-lg bg-[var(--app-subtle-bg)] overflow-hidden">
            <div className="px-3 py-2 border-b border-[var(--app-divider)] flex items-center justify-between">
                <div>
                    <h2 className="text-sm font-medium">AI Employees</h2>
                    <p className="text-[11px] text-[var(--app-hint)] mt-0.5">
                        Create AI profiles with unique personalities and roles
                    </p>
                </div>
                {!showAddForm && !editingProfile && (
                    <button
                        type="button"
                        onClick={() => setShowAddForm(true)}
                        disabled={!canManage}
                        className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded bg-[var(--app-button)] text-[var(--app-button-text)] hover:opacity-90 transition-opacity"
                    >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="12" y1="5" x2="12" y2="19" />
                            <line x1="5" y1="12" x2="19" y2="12" />
                        </svg>
                        Add
                    </button>
                )}
            </div>

            {!canManage && (
                <div className="px-3 py-2 text-xs text-[var(--app-hint)] border-b border-[var(--app-divider)]">
                    Only platform operators can create or edit AI profiles for the shared K1 Brain configuration.
                </div>
            )}

            {showAddForm && (
                <ProfileForm
                    onSubmit={handleCreate}
                    onCancel={() => {
                        setShowAddForm(false)
                        setError(null)
                    }}
                    isPending={createMutation.isPending}
                    submitLabel="Create"
                    readOnly={!canManage}
                />
            )}

            {error && (
                <div className="px-3 py-2 text-sm text-red-500 border-b border-[var(--app-divider)]">
                    {error}
                </div>
            )}

            {isLoading ? (
                <div className="px-3 py-4 flex justify-center">
                    <Spinner size="sm" label="Loading..." />
                </div>
            ) : profiles.length === 0 && !showAddForm ? (
                <div className="px-3 py-4 text-center text-sm text-[var(--app-hint)]">
                    No AI employees yet. Create one to get started!
                </div>
            ) : (
                <div className="divide-y divide-[var(--app-divider)]">
                    {profiles.map((profile) =>
                        editingProfile?.id === profile.id ? (
                            <ProfileForm
                                key={profile.id}
                                initial={profileToFormData(profile)}
                                onSubmit={handleUpdate}
                                onCancel={() => {
                                    setEditingProfile(null)
                                    setError(null)
                                }}
                                isPending={updateMutation.isPending}
                                submitLabel="Save"
                                readOnly={!canManage}
                            />
                        ) : (
                            <ProfileCard
                                key={profile.id}
                                profile={profile}
                                onEdit={() => setEditingProfile(profile)}
                                onDelete={() => handleDelete(profile.id)}
                                isDeleting={deleteMutation.isPending}
                                readOnly={!canManage}
                            />
                        )
                    )}
                </div>
            )}
        </div>
    )
}
