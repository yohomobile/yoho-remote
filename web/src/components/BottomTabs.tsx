import type { ComponentType } from 'react'
import { useNavigate, useLocation } from '@tanstack/react-router'

function SessionsIcon(props: { className?: string; filled?: boolean }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill={props.filled ? 'currentColor' : 'none'}
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <line x1="3" y1="9" x2="21" y2="9" />
            <line x1="9" y1="21" x2="9" y2="9" />
        </svg>
    )
}

function SettingsIcon(props: { className?: string; filled?: boolean }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill={props.filled ? 'currentColor' : 'none'}
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
    )
}

type TabItem = {
    key: string
    label: string
    path: string
    icon: ComponentType<{ className?: string; filled?: boolean }>
    matchPaths?: string[]  // Additional paths that should highlight this tab
}

const tabs: TabItem[] = [
    {
        key: 'sessions',
        label: 'Sessions',
        path: '/sessions',
        icon: SessionsIcon,
        matchPaths: ['/sessions/new']
    },
    {
        key: 'settings',
        label: 'Settings',
        path: '/settings',
        icon: SettingsIcon,
        matchPaths: ['/usage']
    }
]

// Pages where bottom tabs should be visible
const TOP_LEVEL_PATHS = ['/sessions', '/settings', '/usage', '/sessions/new']

export function useShowBottomTabs(): boolean {
    const location = useLocation()
    const pathname = location.pathname

    // Check if current path is a top-level path
    return TOP_LEVEL_PATHS.some(p => pathname === p || pathname === p + '/')
}

export function BottomTabs() {
    const navigate = useNavigate()
    const location = useLocation()
    const pathname = location.pathname

    const isActive = (tab: TabItem) => {
        if (pathname === tab.path || pathname === tab.path + '/') {
            return true
        }
        if (tab.matchPaths) {
            return tab.matchPaths.some(p => pathname === p || pathname.startsWith(p + '/'))
        }
        return false
    }

    return (
        <div className="bg-[var(--app-bg)] border-t border-[var(--app-divider)] pb-[env(safe-area-inset-bottom)]">
            <div className="mx-auto w-full max-w-content flex items-center justify-around h-14">
                {tabs.map((tab) => {
                    const active = isActive(tab)
                    const Icon = tab.icon
                    return (
                        <button
                            key={tab.key}
                            type="button"
                            onClick={() => navigate({ to: tab.path })}
                            className={`
                                flex flex-col items-center justify-center gap-0.5 min-w-[64px] h-full
                                transition-colors
                                ${active
                                    ? 'text-[var(--app-link)]'
                                    : 'text-[var(--app-hint)] hover:text-[var(--app-fg)]'
                                }
                            `}
                        >
                            <Icon className="w-6 h-6" filled={active} />
                            <span className="text-[10px] font-medium">{tab.label}</span>
                        </button>
                    )
                })}
            </div>
        </div>
    )
}
