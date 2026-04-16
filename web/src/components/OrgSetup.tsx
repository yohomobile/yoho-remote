import { useCallback, useState } from 'react'
import { useAppContext } from '@/lib/app-context'
import { useMyOrgs, usePendingInvitations } from '@/hooks/queries/useOrgs'
import { useCreateOrg, useAcceptInvitation } from '@/hooks/mutations/useOrgMutations'
import { LoadingState } from '@/components/LoadingState'

/**
 * OrgSetup - 无组织时的引导页面
 * 用户登录后如果没有 org，展示创建组织或接受邀请的界面
 */
export function OrgSetup({ onComplete }: { onComplete: () => void }) {
    const { api, setCurrentOrgId } = useAppContext()
    const { invitations, isLoading: invitationsLoading } = usePendingInvitations(api)
    const { createOrg, isPending: isCreating, error: createError } = useCreateOrg(api)
    const { acceptInvitation, isPending: isAccepting } = useAcceptInvitation(api)

    const [mode, setMode] = useState<'choose' | 'create'>('choose')
    const [orgName, setOrgName] = useState('')
    const [orgSlug, setOrgSlug] = useState('')
    const [slugTouched, setSlugTouched] = useState(false)

    const handleNameChange = useCallback((name: string) => {
        setOrgName(name)
        if (!slugTouched) {
            setOrgSlug(name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''))
        }
    }, [slugTouched])

    const handleCreate = useCallback(async () => {
        if (!orgName.trim() || !orgSlug.trim()) return
        try {
            const response = await createOrg({ name: orgName.trim(), slug: orgSlug.trim() })
            setCurrentOrgId(response.org.id)
            onComplete()
        } catch {
            // error handled by hook
        }
    }, [createOrg, onComplete, orgName, orgSlug, setCurrentOrgId])

    const handleAccept = useCallback(async (invitationId: string) => {
        try {
            const response = await acceptInvitation(invitationId)
            setCurrentOrgId(response.orgId)
            onComplete()
        } catch (e) {
            console.error('Failed to accept invitation:', e)
        }
    }, [acceptInvitation, onComplete, setCurrentOrgId])

    if (invitationsLoading) {
        return (
            <div className="flex h-full items-center justify-center">
                <LoadingState label="Loading..." className="text-sm" />
            </div>
        )
    }

    return (
        <div className="flex h-full items-center justify-center p-4">
            <div className="w-full max-w-sm space-y-6">
                {/* Header */}
                <div className="text-center space-y-2">
                    <div className="flex justify-center">
                        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 shadow-lg">
                            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>
                        </div>
                    </div>
                    <h2 className="text-lg font-bold text-[var(--app-fg)]">Welcome to Yoho Remote</h2>
                    <p className="text-sm text-[var(--app-hint)]">
                        Create or join an organization to get started.
                    </p>
                </div>

                {/* Pending Invitations */}
                {invitations.length > 0 && (
                    <div className="space-y-2">
                        <h3 className="text-xs font-semibold text-[var(--app-hint)] uppercase tracking-wide">
                            Pending Invitations
                        </h3>
                        {invitations.map((inv) => (
                            <div
                                key={inv.id}
                                className="flex items-center justify-between p-3 rounded-lg bg-[var(--app-subtle-bg)] border border-[var(--app-divider)]"
                            >
                                <div className="min-w-0">
                                    <div className="text-sm font-medium text-[var(--app-fg)] truncate">
                                        {inv.orgName}
                                    </div>
                                    <div className="text-xs text-[var(--app-hint)]">
                                        Invited by {inv.invitedBy} as {inv.role}
                                    </div>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => handleAccept(inv.id)}
                                    disabled={isAccepting}
                                    className="shrink-0 ml-2 px-3 py-1 text-sm rounded bg-gradient-to-r from-green-500 to-emerald-600 text-white disabled:opacity-50"
                                >
                                    {isAccepting ? '...' : 'Join'}
                                </button>
                            </div>
                        ))}
                    </div>
                )}

                {/* Create Org */}
                {mode === 'choose' ? (
                    <button
                        type="button"
                        onClick={() => setMode('create')}
                        className="w-full py-2.5 text-sm font-medium rounded-lg bg-gradient-to-r from-indigo-500 to-purple-600 text-white hover:shadow-md transition-shadow"
                    >
                        Create New Organization
                    </button>
                ) : (
                    <div className="space-y-3 p-4 rounded-lg bg-[var(--app-subtle-bg)] border border-[var(--app-divider)]">
                        <div>
                            <label className="block text-xs font-medium text-[var(--app-hint)] mb-1">Organization Name</label>
                            <input
                                type="text"
                                value={orgName}
                                onChange={(e) => handleNameChange(e.target.value)}
                                placeholder="My Team"
                                className="w-full px-3 py-2 text-sm rounded-lg bg-[var(--app-bg)] border border-[var(--app-divider)] text-[var(--app-fg)] placeholder:text-[var(--app-hint)]"
                                autoFocus
                            />
                        </div>
                        <div>
                            <label className="block text-xs font-medium text-[var(--app-hint)] mb-1">URL Slug</label>
                            <input
                                type="text"
                                value={orgSlug}
                                onChange={(e) => { setOrgSlug(e.target.value); setSlugTouched(true) }}
                                placeholder="my-team"
                                className="w-full px-3 py-2 text-sm rounded-lg bg-[var(--app-bg)] border border-[var(--app-divider)] text-[var(--app-fg)] placeholder:text-[var(--app-hint)]"
                            />
                            <div className="mt-1 text-[10px] text-[var(--app-hint)]">Lowercase letters, numbers, and hyphens only</div>
                        </div>
                        {createError && (
                            <div className="text-xs text-red-500">{createError}</div>
                        )}
                        <div className="flex gap-2">
                            <button
                                type="button"
                                onClick={() => setMode('choose')}
                                className="flex-1 py-2 text-sm rounded-lg bg-[var(--app-secondary-bg)] text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                onClick={handleCreate}
                                disabled={isCreating || !orgName.trim() || !orgSlug.trim()}
                                className="flex-1 py-2 text-sm font-medium rounded-lg bg-gradient-to-r from-indigo-500 to-purple-600 text-white disabled:opacity-50"
                            >
                                {isCreating ? 'Creating...' : 'Create'}
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    )
}
