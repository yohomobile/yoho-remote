import { useEffect, useState } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import { useAppContext } from '@/lib/app-context'
import { LoadingState } from '@/components/LoadingState'
import { setPostLoginRedirect } from '@/services/postLoginRedirect'

/**
 * AcceptInvitationPage - 接受组织邀请页面
 * 通过邮件链接进入，自动接受邀请并跳转到组织
 */
export function AcceptInvitationPage() {
    const { api, userEmail } = useAppContext()
    const navigate = useNavigate()
    const { invitationId } = useParams({ from: '/invitations/accept/$invitationId' })
    const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading')
    const [error, setError] = useState<string>('')

    useEffect(() => {
        let mounted = true
        let timeoutId: ReturnType<typeof setTimeout> | null = null

        const acceptInvitation = async () => {
            if (!userEmail) {
                setPostLoginRedirect(`/invitations/accept/${invitationId}`)
                navigate({ to: '/login', replace: true })
                return
            }

            try {
                setStatus('loading')
                const response = await api.acceptInvitation(invitationId)

                if (!mounted) return

                if (response.ok) {
                    setStatus('success')
                    // 等待 1 秒后跳转到组织列表
                    timeoutId = setTimeout(() => {
                        if (mounted) {
                            navigate({ to: '/' })
                        }
                    }, 1000)
                } else {
                    setStatus('error')
                    setError('Failed to accept invitation')
                }
            } catch (err) {
                if (!mounted) return
                setStatus('error')
                setError(err instanceof Error ? err.message : 'Failed to accept invitation')
            }
        }

        acceptInvitation()

        return () => {
            mounted = false
            if (timeoutId) clearTimeout(timeoutId)
        }
    }, [invitationId, userEmail]) // 移除 api 和 navigate，它们是稳定的引用

    return (
        <div className="flex h-full items-center justify-center p-4">
            <div className="w-full max-w-md text-center space-y-6">
                {/* Icon */}
                <div className="flex justify-center">
                    <div className={`flex h-16 w-16 items-center justify-center rounded-full ${
                        status === 'loading' ? 'bg-gradient-to-br from-indigo-500 to-purple-600' :
                        status === 'success' ? 'bg-gradient-to-br from-green-500 to-emerald-600' :
                        'bg-gradient-to-br from-red-500 to-rose-600'
                    } shadow-lg`}>
                        {status === 'loading' && (
                            <LoadingState label="" className="text-white" />
                        )}
                        {status === 'success' && (
                            <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="20 6 9 17 4 12" />
                            </svg>
                        )}
                        {status === 'error' && (
                            <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <line x1="18" y1="6" x2="6" y2="18" />
                                <line x1="6" y1="6" x2="18" y2="18" />
                            </svg>
                        )}
                    </div>
                </div>

                {/* Status Message */}
                {status === 'loading' && (
                    <div>
                        <h2 className="text-xl font-bold text-[var(--app-fg)] mb-2">Accepting Invitation</h2>
                        <p className="text-sm text-[var(--app-hint)]">Please wait...</p>
                    </div>
                )}

                {status === 'success' && (
                    <div>
                        <h2 className="text-xl font-bold text-[var(--app-fg)] mb-2">✓ Invitation Accepted!</h2>
                        <p className="text-sm text-[var(--app-hint)]">
                            Redirecting to your organization...
                        </p>
                    </div>
                )}

                {status === 'error' && (
                    <div>
                        <h2 className="text-xl font-bold text-[var(--app-fg)] mb-2">Failed to Accept Invitation</h2>
                        <p className="text-sm text-red-500 mb-4">{error}</p>
                        <div className="space-y-2">
                            <p className="text-xs text-[var(--app-hint)]">
                                This invitation may have expired, been revoked, or already accepted.
                            </p>
                            <button
                                type="button"
                                onClick={() => navigate({ to: '/' })}
                                className="mt-4 px-4 py-2 text-sm rounded bg-gradient-to-r from-indigo-500 to-purple-600 text-white"
                            >
                                Go to Dashboard
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    )
}

export default AcceptInvitationPage
