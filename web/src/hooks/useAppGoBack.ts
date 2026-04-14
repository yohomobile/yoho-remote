import { useCallback } from 'react'
import { useLocation, useNavigate, useRouter } from '@tanstack/react-router'
import { DEFAULT_SESSION_LIST_SEARCH, type SessionListSearch } from '@/lib/session-filters'

export function useAppGoBack(): () => void {
    const navigate = useNavigate()
    const router = useRouter()
    const pathname = useLocation({ select: (location) => location.pathname })
    const search = useLocation({
        select: (location) => {
            const current = location.search as Partial<SessionListSearch> | undefined
            return {
                archive: current?.archive ?? DEFAULT_SESSION_LIST_SEARCH.archive,
                owner: current?.owner ?? DEFAULT_SESSION_LIST_SEARCH.owner,
            } satisfies SessionListSearch
        }
    })

    return useCallback(() => {
        // Use explicit path navigation for consistent behavior across all environments
        if (pathname === '/sessions/new') {
            navigate({ to: '/sessions', search })
            return
        }

        // For session routes, navigate to parent path
        if (pathname.startsWith('/sessions/')) {
            navigate({ to: '/sessions', search })
            return
        }

        // Fallback to history.back() for other cases
        router.history.back()
    }, [navigate, pathname, router, search])
}
