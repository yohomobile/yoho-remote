import { useCallback, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from '@tanstack/react-router'
import { useAppContext } from '@/lib/app-context'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { useOrg } from '@/hooks/queries/useOrgs'
import { useInviteMember, useUpdateMemberRole, useRemoveMember, useUpdateOrg } from '@/hooks/mutations/useOrgMutations'
import { queryKeys } from '@/lib/query-keys'
import { LoadingState } from '@/components/LoadingState'
import { CRSApiKeyManager } from '@/components/CRSApiKeyManager'
import type { OrgMember, OrgRole } from '@/types/api'

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

export function OrgDetailPage() {
    const { api, userEmail } = useAppContext()
    const goBack = useAppGoBack()
    const { orgId } = useParams({ from: '/orgs/$orgId' })
    const { org, members, myRole, isLoading, error } = useOrg(api, orgId)
    const { inviteMember, isPending: isInviting, error: inviteError } = useInviteMember(api, orgId)
    const { updateRole } = useUpdateMemberRole(api, orgId)
    const { removeMember } = useRemoveMember(api, orgId)
    const { updateOrg, isPending: isUpdating, error: updateError } = useUpdateOrg(api, orgId)

    const [inviteEmail, setInviteEmail] = useState('')
    const [inviteRole, setInviteRole] = useState<'admin' | 'member'>('member')
    const [showInviteForm, setShowInviteForm] = useState(false)
    const [isEditingName, setIsEditingName] = useState(false)
    const [editingName, setEditingName] = useState('')

    const canManageMembers = myRole === 'owner' || myRole === 'admin'
    const canEditOrg = myRole === 'owner'

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

    const handleStartEditName = useCallback(() => {
        setEditingName(org?.name ?? '')
        setIsEditingName(true)
    }, [org?.name])

    const handleSaveName = useCallback(async () => {
        if (!editingName.trim()) return
        try {
            await updateOrg({ name: editingName.trim() })
            setIsEditingName(false)
        } catch {
            // error is handled by hook
        }
    }, [updateOrg, editingName])

    const handleCancelEditName = useCallback(() => {
        setEditingName(org?.name ?? '')
        setIsEditingName(false)
    }, [org?.name])

    const handleRoleChange = useCallback(async (email: string, newRole: string) => {
        try {
            await updateRole({ email, role: newRole })
        } catch (e) {
            console.error('Failed to update role:', e)
        }
    }, [updateRole])

    const handleRemove = useCallback(async (email: string) => {
        if (!confirm(`Remove ${email} from organization?`)) return
        try {
            await removeMember(email)
        } catch (e) {
            console.error('Failed to remove member:', e)
        }
    }, [removeMember])

    if (isLoading) {
        return (
            <div className="flex h-full items-center justify-center">
                <LoadingState label="Loading..." className="text-sm" />
            </div>
        )
    }

    if (error || !org) {
        return (
            <div className="flex h-full items-center justify-center p-4">
                <div className="text-sm text-red-500">{error || 'Organization not found'}</div>
            </div>
        )
    }

    return (
        <div className="flex h-full flex-col">
            <div className="bg-[var(--app-bg)] border-b border-[var(--app-divider)] pt-[env(safe-area-inset-top)]">
                <div className="mx-auto w-full max-w-content flex items-center gap-2 px-3 py-1.5">
                    <button
                        type="button"
                        onClick={goBack}
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)] transition-colors"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
                    </button>
                    <div className="flex-1 min-w-0">
                        {isEditingName && canEditOrg ? (
                            <div className="flex items-center gap-1">
                                <input
                                    type="text"
                                    value={editingName}
                                    onChange={(e) => setEditingName(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') handleSaveName()
                                        if (e.key === 'Escape') handleCancelEditName()
                                    }}
                                    className="flex-1 px-1.5 py-0.5 text-sm font-medium rounded bg-[var(--app-subtle-bg)] border border-[var(--app-divider)] text-[var(--app-fg)]"
                                    autoFocus
                                />
                                <button
                                    type="button"
                                    onClick={handleSaveName}
                                    disabled={isUpdating || !editingName.trim()}
                                    className="p-1 rounded text-green-600 hover:bg-green-50 disabled:opacity-50"
                                >
                                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                                </button>
                                <button
                                    type="button"
                                    onClick={handleCancelEditName}
                                    className="p-1 rounded text-red-600 hover:bg-red-50"
                                >
                                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                                </button>
                            </div>
                        ) : (
                            <div className="flex items-center gap-1">
                                <div className="text-sm font-medium truncate">{org.name}</div>
                                {canEditOrg && (
                                    <button
                                        type="button"
                                        onClick={handleStartEditName}
                                        className="p-0.5 rounded text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)] transition-colors"
                                        title="Edit name"
                                    >
                                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
                                    </button>
                                )}
                            </div>
                        )}
                        <div className="text-[10px] text-[var(--app-hint)]">{org.slug}</div>
                        {updateError && (
                            <div className="text-[10px] text-red-500">{updateError}</div>
                        )}
                    </div>
                    {myRole && (
                        <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full text-white bg-gradient-to-r ${ROLE_COLORS[myRole]}`}>
                            {ROLE_LABELS[myRole]}
                        </span>
                    )}
                </div>
            </div>

            <div className="flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
                <div className="mx-auto w-full max-w-content px-3 py-3 space-y-4">
                    {/* Members Section */}
                    <div>
                        <div className="flex items-center justify-between mb-2">
                            <h3 className="text-xs font-semibold text-[var(--app-hint)] uppercase tracking-wide">
                                Members ({members.length})
                            </h3>
                            {canManageMembers && (
                                <button
                                    type="button"
                                    onClick={() => setShowInviteForm(!showInviteForm)}
                                    className="text-xs px-2 py-1 rounded bg-[var(--app-subtle-bg)] text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)] transition-colors"
                                >
                                    + Invite
                                </button>
                            )}
                        </div>

                        {/* Invite Form */}
                        {showInviteForm && canManageMembers && (
                            <div className="mb-3 p-3 rounded-lg bg-[var(--app-subtle-bg)] space-y-2">
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
                                        {myRole === 'owner' && <option value="admin">Admin</option>}
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

                        {/* Members List */}
                        <div className="space-y-1">
                            {members.map((member) => (
                                <MemberRow
                                    key={member.userEmail}
                                    member={member}
                                    myRole={myRole}
                                    isCurrentUser={member.userEmail === userEmail}
                                    onRoleChange={handleRoleChange}
                                    onRemove={handleRemove}
                                />
                            ))}
                        </div>
                    </div>

                    {/* API Keys Section - Only for owners */}
                    {canEditOrg && api && (
                        <div>
                            <div className="mb-2">
                                <h3 className="text-xs font-semibold text-[var(--app-hint)] uppercase tracking-wide">
                                    API Keys
                                </h3>
                                <p className="text-[11px] text-[var(--app-hint)] mt-0.5">
                                    Manage Claude API keys and monitor token usage
                                </p>
                            </div>
                            <CRSApiKeyManager api={api} orgId={orgId} orgSlug={org.slug} />
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
}

function MemberRow({
    member,
    myRole,
    isCurrentUser,
    onRoleChange,
    onRemove,
}: {
    member: OrgMember
    myRole?: OrgRole
    isCurrentUser: boolean
    onRoleChange: (email: string, role: string) => void
    onRemove: (email: string) => void
}) {
    const canEdit = (myRole === 'owner' || myRole === 'admin') && !isCurrentUser
    const canChangeRole = myRole === 'owner' && !isCurrentUser

    return (
        <div className="flex items-center gap-2 px-2.5 py-2 rounded-lg hover:bg-[var(--app-subtle-bg)] transition-colors">
            <div className="flex-1 min-w-0">
                <div className="text-sm truncate text-[var(--app-fg)]">
                    {member.userEmail}
                    {isCurrentUser && <span className="text-[var(--app-hint)] ml-1">(you)</span>}
                </div>
            </div>

            {canChangeRole ? (
                <select
                    value={member.role}
                    onChange={(e) => onRoleChange(member.userEmail, e.target.value)}
                    className="text-[11px] px-1.5 py-0.5 rounded bg-[var(--app-subtle-bg)] border border-[var(--app-divider)] text-[var(--app-fg)]"
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
                    onClick={() => onRemove(member.userEmail)}
                    className="text-[var(--app-hint)] hover:text-red-500 transition-colors"
                    title="Remove member"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                </button>
            )}
        </div>
    )
}

export default OrgDetailPage
