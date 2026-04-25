import { useAppContext } from '@/lib/app-context'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { isFlutterApp } from '@/hooks/useFlutterApp'
import { ApprovalReviewPanel } from '@/components/ApprovalReviewPanel'

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

export default function ApprovalsPage() {
    const { currentOrgId } = useAppContext()
    const goBack = useAppGoBack()

    return (
        <div className="flex h-full flex-col bg-[var(--app-bg)]">
            {!isFlutterApp() && (
                <div className="bg-[var(--app-bg)] border-b border-[var(--app-divider)] pt-[env(safe-area-inset-top)]">
                    <div className="mx-auto w-full max-w-content flex items-center gap-2 px-3 py-1.5">
                        <button
                            type="button"
                            onClick={goBack}
                            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                        >
                            <BackIcon />
                        </button>
                        <div className="flex-1">
                            <div className="text-sm font-medium">统一审批流</div>
                            <div className="text-[11px] text-[var(--app-hint)]">
                                Identity 合并 / Team Memory / Observation / 记忆冲突 — 跨域审批一站式
                            </div>
                        </div>
                    </div>
                </div>
            )}

            <div className="flex-1 min-h-0 overflow-hidden pb-[env(safe-area-inset-bottom)]">
                <div className="h-full mx-auto w-full max-w-content p-3">
                    {!currentOrgId ? (
                        <div className="rounded-lg bg-[var(--app-subtle-bg)] p-4 text-sm text-[var(--app-hint)]">
                            请先选择组织。审批数据按 org 隔离。
                        </div>
                    ) : (
                        <ApprovalReviewPanel />
                    )}
                </div>
            </div>
        </div>
    )
}
