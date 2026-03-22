import { ComposerPrimitive } from '@assistant-ui/react'

function SettingsIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
    )
}

function SwitchToRemoteIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
            <line x1="12" y1="18" x2="12.01" y2="18" />
        </svg>
    )
}

function TerminalIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <rect x="3" y="4" width="18" height="16" rx="2" ry="2" />
            <polyline points="7 9 10 12 7 15" />
            <line x1="12" y1="15" x2="17" y2="15" />
        </svg>
    )
}

function MicIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
            <path d="M19 10a7 7 0 0 1-14 0" />
            <line x1="12" y1="19" x2="12" y2="23" />
            <line x1="8" y1="23" x2="16" y2="23" />
        </svg>
    )
}

function ImageIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <polyline points="21 15 16 10 5 21" />
        </svg>
    )
}

function AttachmentIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M21.44 11.05l-8.49 8.49a5 5 0 0 1-7.07-7.07l8.49-8.49a3.5 3.5 0 0 1 4.95 4.95L9.88 16.36a2 2 0 1 1-2.83-2.83L14.5 6.07" />
        </svg>
    )
}

function AbortIcon(props: { spinning: boolean }) {
    if (props.spinning) {
        return (
            <svg
                className="animate-spin"
                xmlns="http://www.w3.org/2000/svg"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
            >
                <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
                <path d="M12 2a10 10 0 0 1 10 10" strokeOpacity="0.75" />
            </svg>
        )
    }

    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 16 16"
            fill="currentColor"
        >
            <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm4-2.5a.5.5 0 0 1 .5-.5h4a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-.5.5h-4a.5.5 0 0 1-.5-.5v-4Z" />
        </svg>
    )
}

function SendIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <line x1="12" y1="19" x2="12" y2="5" />
            <polyline points="5 12 12 5 19 12" />
        </svg>
    )
}

function SpinnerIcon() {
    return (
        <svg
            className="animate-spin"
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
        >
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25" />
            <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        </svg>
    )
}

export function ComposerButtons(props: {
    canSend: boolean
    controlsDisabled: boolean
    showVoiceButton: boolean
    voiceDisabled: boolean
    voiceActive: boolean
    voiceStopping: boolean
    voiceModeActive: boolean
    onVoiceToggle: () => void
    showImageButton: boolean
    imageDisabled: boolean
    isUploadingImage: boolean
    onImageClick: () => void
    showFileButton: boolean
    fileDisabled: boolean
    isUploadingFile: boolean
    onFileClick: () => void
    showSettingsButton: boolean
    onSettingsToggle: () => void
    showTerminalButton: boolean
    terminalDisabled: boolean
    onTerminal: () => void
    showAbortButton: boolean
    abortDisabled: boolean
    isAborting: boolean
    onAbort: () => void
    showSwitchButton: boolean
    switchDisabled: boolean
    isSwitching: boolean
    onSwitch: () => void
    autoOptimizeEnabled: boolean
    isOptimizing: boolean
    onOptimizeSend?: () => void
    hasAttachments?: boolean
    onSendWithAttachments?: () => void
}) {
    return (
        <div className="flex items-center justify-between px-2 pb-2">
            <div className="flex items-center gap-1">
                {props.showVoiceButton ? (
                    <button
                        type="button"
                        aria-label={props.voiceModeActive ? 'Exit voice mode' : 'Enable voice mode'}
                        aria-pressed={props.voiceModeActive}
                        title={props.voiceModeActive ? 'Exit voice mode' : 'Enable voice mode'}
                        disabled={props.voiceDisabled || props.controlsDisabled}
                        className={`flex h-8 w-8 touch-none items-center justify-center rounded-full text-[var(--app-fg)]/60 transition-all duration-150 hover:bg-[var(--app-bg)] disabled:cursor-not-allowed disabled:opacity-50 ${
                            props.voiceActive
                                ? 'bg-red-500 text-white ring-2 ring-red-300/70 shadow-[0_0_18px_rgba(239,68,68,0.65)] scale-110'
                                : props.voiceModeActive
                                    ? 'bg-[var(--app-bg)] text-[var(--app-link)] ring-2 ring-[var(--app-link)]/50'
                                    : 'hover:text-[var(--app-fg)]'
                        } ${props.voiceStopping ? 'animate-pulse' : ''}`}
                        onClick={props.onVoiceToggle}
                    >
                        <MicIcon />
                    </button>
                ) : null}

                {props.showImageButton ? (
                    <button
                        type="button"
                        aria-label={props.isUploadingImage ? 'Uploading...' : 'Upload image'}
                        title={props.isUploadingImage ? 'Uploading...' : 'Upload image'}
                        disabled={props.imageDisabled || props.controlsDisabled || props.isUploadingImage}
                        className={`flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-fg)]/60 transition-colors hover:bg-[var(--app-bg)] hover:text-[var(--app-link)] disabled:cursor-not-allowed disabled:opacity-50 ${
                            props.isUploadingImage ? 'animate-pulse text-[var(--app-link)]' : ''
                        }`}
                        onClick={props.onImageClick}
                    >
                        <ImageIcon />
                    </button>
                ) : null}

                {props.showFileButton ? (
                    <button
                        type="button"
                        aria-label={props.isUploadingFile ? 'Uploading...' : 'Upload file'}
                        title={props.isUploadingFile ? 'Uploading...' : 'Upload file'}
                        disabled={props.fileDisabled || props.controlsDisabled || props.isUploadingFile}
                        className={`flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-fg)]/60 transition-colors hover:bg-[var(--app-bg)] hover:text-[var(--app-link)] disabled:cursor-not-allowed disabled:opacity-50 ${
                            props.isUploadingFile ? 'animate-pulse text-[var(--app-link)]' : ''
                        }`}
                        onClick={props.onFileClick}
                    >
                        <AttachmentIcon />
                    </button>
                ) : null}

                {props.showSettingsButton ? (
                    <button
                        type="button"
                        aria-label="Settings"
                        title="Settings"
                        className="settings-button flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-fg)]/60 transition-colors hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]"
                        onClick={props.onSettingsToggle}
                        disabled={props.controlsDisabled}
                    >
                        <SettingsIcon />
                    </button>
                ) : null}

                {props.showTerminalButton ? (
                    <button
                        type="button"
                        aria-label="Terminal"
                        title="Terminal"
                        className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-fg)]/60 transition-colors hover:bg-[var(--app-bg)] hover:text-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
                        onClick={props.onTerminal}
                        disabled={props.terminalDisabled}
                    >
                        <TerminalIcon />
                    </button>
                ) : null}

                {props.showAbortButton ? (
                    <button
                        type="button"
                        aria-label="Abort"
                        title="Abort"
                        disabled={props.abortDisabled}
                        className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-fg)]/60 transition-colors hover:bg-[var(--app-bg)] hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-50"
                        onClick={props.onAbort}
                    >
                        <AbortIcon spinning={props.isAborting} />
                    </button>
                ) : null}

                {props.showSwitchButton ? (
                    <button
                        type="button"
                        aria-label="Switch to remote"
                        title="Switch to remote mode"
                        disabled={props.switchDisabled}
                        className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-fg)]/60 transition-colors hover:bg-[var(--app-bg)] hover:text-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
                        onClick={props.onSwitch}
                    >
                        <SwitchToRemoteIcon />
                    </button>
                ) : null}
            </div>

            {props.autoOptimizeEnabled && props.onOptimizeSend ? (
                <button
                    type="button"
                    disabled={props.controlsDisabled || !props.canSend || props.isOptimizing}
                    aria-label={props.isOptimizing ? "Optimizing..." : "Optimize and Send"}
                    title={props.isOptimizing ? "Optimizing..." : "Optimize and Send"}
                    className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
                        props.isOptimizing
                            ? 'bg-purple-600 text-white'
                            : props.canSend && !props.controlsDisabled
                                ? 'bg-purple-600 text-white hover:bg-purple-700'
                                : 'bg-[#C0C0C0] text-white'
                    } disabled:cursor-not-allowed`}
                    onClick={props.onOptimizeSend}
                >
                    {props.isOptimizing ? <SpinnerIcon /> : <SendIcon />}
                </button>
            ) : props.hasAttachments && props.onSendWithAttachments ? (
                <button
                    type="button"
                    disabled={props.controlsDisabled || !props.canSend || props.isOptimizing}
                    aria-label="Send"
                    title="Send"
                    className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
                        props.canSend && !props.controlsDisabled
                            ? 'bg-black text-white'
                            : 'bg-[#C0C0C0] text-white'
                    } disabled:cursor-not-allowed`}
                    onClick={props.onSendWithAttachments}
                >
                    <SendIcon />
                </button>
            ) : (
                <ComposerPrimitive.Send
                    disabled={props.controlsDisabled || !props.canSend || props.isOptimizing}
                    aria-label="Send"
                    title="Send"
                    className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
                        props.canSend && !props.controlsDisabled
                            ? 'bg-black text-white'
                            : 'bg-[#C0C0C0] text-white'
                    } disabled:cursor-not-allowed`}
                >
                    <SendIcon />
                </ComposerPrimitive.Send>
            )}
        </div>
    )
}
