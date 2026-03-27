import { ComposerPrimitive, useAssistantApi, useAssistantState } from '@assistant-ui/react'
import {
    type ChangeEvent as ReactChangeEvent,
    type ClipboardEvent as ReactClipboardEvent,
    type CSSProperties as ReactCSSProperties,
    type KeyboardEvent as ReactKeyboardEvent,
    type PointerEvent as ReactPointerEvent,
    type SyntheticEvent as ReactSyntheticEvent,
    type TouchEvent as ReactTouchEvent,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState
} from 'react'
import type { TypingUser } from '@/types/api'
import { useSessionDraft } from '@/hooks/useSessionDraft'
import { useInputHistory } from '@/hooks/useInputHistory'
import { createPortal } from 'react-dom'
import type { AgentState, ModelMode, ModelReasoningEffort, PermissionMode } from '@/types/api'
import type { Suggestion } from '@/hooks/useActiveSuggestions'
import { useActiveWord } from '@/hooks/useActiveWord'
import { useActiveSuggestions } from '@/hooks/useActiveSuggestions'
import { applySuggestion } from '@/utils/applySuggestion'
import { usePlatform } from '@/hooks/usePlatform'
import { usePWAInstall } from '@/hooks/usePWAInstall'
import { useSpeechToText } from '@/hooks/useSpeechToText'
import { FloatingOverlay } from '@/components/ChatInput/FloatingOverlay'
import { Autocomplete } from '@/components/ChatInput/Autocomplete'
import { StatusBar } from '@/components/AssistantChat/StatusBar'
import { ComposerButtons } from '@/components/AssistantChat/ComposerButtons'
import { FileIcon } from '@/components/FileIcon'
import type { ApiClient } from '@/api/client'

export interface TextInputState {
    text: string
    selection: { start: number; end: number }
}

const CLAUDE_PERMISSION_MODES = ['bypassPermissions'] as const
const CODEX_PERMISSION_MODES = ['read-only', 'safe-yolo', 'yolo'] as const
const PERMISSION_MODE_LABELS: Record<string, string> = {
    bypassPermissions: 'Yolo',
    'read-only': 'Read Only',
    'safe-yolo': 'Safe Yolo',
    yolo: 'Yolo'
}

const MODEL_MODES = ['default', 'sonnet', 'opus'] as const
const MODEL_MODE_LABELS: Record<string, string> = {
    default: 'Default',
    sonnet: 'Sonnet',
    opus: 'Opus'
}

const CODEX_MODELS = [
    {
        id: 'gpt-5.3-codex',
        label: 'gpt-5.3-codex',
        description: 'Latest frontier agentic coding model.'
    },
    {
        id: 'gpt-5.2-codex',
        label: 'gpt-5.2-codex',
        description: 'Previous generation agentic coding model.'
    },
    {
        id: 'gpt-5.1-codex-max',
        label: 'gpt-5.1-codex-max',
        description: 'Codex-optimized flagship for deep and fast reasoning.'
    },
    {
        id: 'gpt-5.1-codex-mini',
        label: 'gpt-5.1-codex-mini',
        description: 'Optimized for codex. Cheaper, faster, but less capable.'
    },
    {
        id: 'gpt-5.2',
        label: 'gpt-5.2',
        description: 'Latest frontier model with improvements across knowledge, reasoning and coding.'
    }
] as const

const CODEX_MODEL_IDS = new Set(CODEX_MODELS.map((model) => model.id))

const GROK_MODELS = [
    {
        id: 'grok-4-1-fast-reasoning',
        label: 'grok-4-1-fast-reasoning',
        description: '2M context, fast reasoning model.'
    },
    {
        id: 'grok-4-1-fast-non-reasoning',
        label: 'grok-4-1-fast-non-reasoning',
        description: '2M context, fast non-reasoning model.'
    },
    {
        id: 'grok-code-fast-1',
        label: 'grok-code-fast-1',
        description: '256K context, optimized for coding.'
    },
    {
        id: 'grok-4-fast-reasoning',
        label: 'grok-4-fast-reasoning',
        description: '2M context, fast reasoning.'
    },
    {
        id: 'grok-4-fast-non-reasoning',
        label: 'grok-4-fast-non-reasoning',
        description: '2M context, fast non-reasoning.'
    },
    {
        id: 'grok-4-0709',
        label: 'grok-4-0709',
        description: '256K context, flagship model.'
    },
    {
        id: 'grok-3-mini',
        label: 'grok-3-mini',
        description: '131K context, lightweight model.'
    },
    {
        id: 'grok-3',
        label: 'grok-3',
        description: '131K context, previous generation.'
    }
] as const

const OPENROUTER_MODELS = [
    // === Anthropic Claude ===
    { id: 'anthropic/claude-opus-4.5', label: 'Claude Opus 4.5', description: 'Anthropic\'s most capable model.' },
    { id: 'anthropic/claude-sonnet-4.5', label: 'Claude Sonnet 4.5', description: 'Anthropic\'s latest efficient model.' },
    { id: 'anthropic/claude-opus-4', label: 'Claude Opus 4', description: 'Anthropic\'s previous flagship.' },
    { id: 'anthropic/claude-sonnet-4', label: 'Claude Sonnet 4', description: 'Balanced performance.' },
    { id: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5', description: 'Fast and affordable.' },
    { id: 'anthropic/claude-3.7-sonnet', label: 'Claude 3.7 Sonnet', description: 'Previous generation.' },
    { id: 'anthropic/claude-3.5-sonnet', label: 'Claude 3.5 Sonnet', description: 'Previous generation.' },
    { id: 'anthropic/claude-3.5-haiku', label: 'Claude 3.5 Haiku', description: 'Fast, previous gen.' },
    { id: 'anthropic/claude-3-opus', label: 'Claude 3 Opus', description: 'Claude 3 flagship.' },
    { id: 'anthropic/claude-3-haiku', label: 'Claude 3 Haiku', description: 'Claude 3 fast.' },
    // === OpenAI ===
    { id: 'openai/gpt-5.2', label: 'GPT-5.2', description: 'OpenAI\'s latest flagship.' },
    { id: 'openai/gpt-5.1', label: 'GPT-5.1', description: 'OpenAI flagship.' },
    { id: 'openai/gpt-5', label: 'GPT-5', description: 'OpenAI GPT-5.' },
    { id: 'openai/gpt-5-mini', label: 'GPT-5 Mini', description: 'Lighter GPT-5.' },
    { id: 'openai/gpt-5.1-codex', label: 'GPT-5.1 Codex', description: 'Coding optimized.' },
    { id: 'openai/gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max', description: 'Max coding.' },
    { id: 'openai/o4-mini', label: 'o4 Mini', description: 'Fast reasoning.' },
    { id: 'openai/o3', label: 'o3', description: 'Reasoning model.' },
    { id: 'openai/o3-mini', label: 'o3 Mini', description: 'Fast reasoning.' },
    { id: 'openai/o1', label: 'o1', description: 'Reasoning model.' },
    { id: 'openai/gpt-4o', label: 'GPT-4o', description: 'Multimodal flagship.' },
    { id: 'openai/gpt-4o-mini', label: 'GPT-4o Mini', description: 'Fast multimodal.' },
    { id: 'openai/gpt-4.1', label: 'GPT-4.1', description: 'GPT-4 series.' },
    { id: 'openai/gpt-4-turbo', label: 'GPT-4 Turbo', description: 'Fast GPT-4.' },
    // === Google Gemini ===
    { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro', description: 'Google\'s best model.' },
    { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash', description: 'Fast and capable.' },
    { id: 'google/gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite', description: 'Lightweight.' },
    { id: 'google/gemini-3-pro-preview', label: 'Gemini 3 Pro Preview', description: 'Next gen preview.' },
    { id: 'google/gemini-3-flash-preview', label: 'Gemini 3 Flash Preview', description: 'Next gen flash.' },
    { id: 'google/gemini-2.0-flash-001', label: 'Gemini 2.0 Flash', description: 'Previous gen fast.' },
    { id: 'google/gemma-3-27b-it', label: 'Gemma 3 27B', description: 'Open model.' },
    // === xAI Grok ===
    { id: 'x-ai/grok-4', label: 'Grok 4', description: 'xAI flagship.' },
    { id: 'x-ai/grok-4.1-fast', label: 'Grok 4.1 Fast', description: 'Fast Grok.' },
    { id: 'x-ai/grok-4-fast', label: 'Grok 4 Fast', description: 'Fast version.' },
    { id: 'x-ai/grok-3', label: 'Grok 3', description: 'Previous gen.' },
    { id: 'x-ai/grok-3-mini', label: 'Grok 3 Mini', description: 'Lightweight.' },
    { id: 'x-ai/grok-code-fast-1', label: 'Grok Code Fast 1', description: 'Coding optimized.' },
    // === DeepSeek ===
    { id: 'deepseek/deepseek-v3.2', label: 'DeepSeek V3.2', description: 'Latest DeepSeek.' },
    { id: 'deepseek/deepseek-chat-v3.1', label: 'DeepSeek V3.1', description: 'Previous version.' },
    { id: 'deepseek/deepseek-chat', label: 'DeepSeek V3', description: 'DeepSeek chat.' },
    { id: 'deepseek/deepseek-r1', label: 'DeepSeek R1', description: 'Reasoning model.' },
    { id: 'deepseek/deepseek-r1-0528', label: 'DeepSeek R1 0528', description: 'R1 updated.' },
    // === Qwen ===
    { id: 'qwen/qwen3-235b-a22b', label: 'Qwen3 235B', description: 'Alibaba flagship.' },
    { id: 'qwen/qwen3-coder', label: 'Qwen3 Coder 480B', description: 'Coding model.' },
    { id: 'qwen/qwen3-32b', label: 'Qwen3 32B', description: 'Medium size.' },
    { id: 'qwen/qwq-32b', label: 'QwQ 32B', description: 'Reasoning model.' },
    { id: 'qwen/qwen-max', label: 'Qwen Max', description: 'Commercial API.' },
    { id: 'qwen/qwen-plus', label: 'Qwen Plus', description: 'Commercial API.' },
    // === Meta Llama ===
    { id: 'meta-llama/llama-4-maverick', label: 'Llama 4 Maverick', description: 'Latest Llama.' },
    { id: 'meta-llama/llama-4-scout', label: 'Llama 4 Scout', description: 'Llama 4 variant.' },
    { id: 'meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B', description: 'Open model.' },
    { id: 'meta-llama/llama-3.1-405b-instruct', label: 'Llama 3.1 405B', description: 'Largest Llama.' },
    { id: 'meta-llama/llama-3.1-70b-instruct', label: 'Llama 3.1 70B', description: 'Large Llama.' },
    { id: 'meta-llama/llama-3.1-8b-instruct', label: 'Llama 3.1 8B', description: 'Small Llama.' },
    // === Mistral ===
    { id: 'mistralai/mistral-large-2512', label: 'Mistral Large 2512', description: 'Latest Mistral.' },
    { id: 'mistralai/mistral-medium-3.1', label: 'Mistral Medium 3.1', description: 'Medium model.' },
    { id: 'mistralai/mistral-small-3.2-24b-instruct', label: 'Mistral Small 3.2', description: 'Small model.' },
    { id: 'mistralai/codestral-2508', label: 'Codestral 2508', description: 'Coding model.' },
    { id: 'mistralai/devstral-2512', label: 'Devstral 2512', description: 'Dev model.' },
    { id: 'mistralai/mixtral-8x22b-instruct', label: 'Mixtral 8x22B', description: 'MoE model.' },
    // === MiniMax ===
    { id: 'minimax/minimax-m2.1', label: 'MiniMax M2.1', description: 'Latest MiniMax.' },
    { id: 'minimax/minimax-m2', label: 'MiniMax M2', description: 'MiniMax model.' },
    // === Moonshot/Kimi ===
    { id: 'moonshotai/kimi-k2-0905', label: 'Kimi K2 0905', description: 'Moonshot flagship.' },
    { id: 'moonshotai/kimi-k2-thinking', label: 'Kimi K2 Thinking', description: 'Reasoning mode.' },
    { id: 'moonshotai/kimi-k2', label: 'Kimi K2', description: 'Kimi model.' },
    // === Z.AI GLM ===
    { id: 'z-ai/glm-4.7', label: 'GLM 4.7', description: 'Zhipu AI latest.' },
    { id: 'z-ai/glm-4.6', label: 'GLM 4.6', description: 'Zhipu AI model.' },
    { id: 'z-ai/glm-4.5', label: 'GLM 4.5', description: 'Zhipu AI model.' },
    // === NVIDIA ===
    { id: 'nvidia/llama-3.1-nemotron-ultra-253b-v1', label: 'Nemotron Ultra 253B', description: 'NVIDIA flagship.' },
    { id: 'nvidia/llama-3.3-nemotron-super-49b-v1.5', label: 'Nemotron Super 49B', description: 'NVIDIA model.' },
    // === Cohere ===
    { id: 'cohere/command-a', label: 'Command A', description: 'Cohere latest.' },
    { id: 'cohere/command-r-plus-08-2024', label: 'Command R+', description: 'Cohere R+.' },
    // === Perplexity ===
    { id: 'perplexity/sonar-pro', label: 'Sonar Pro', description: 'Search enhanced.' },
    { id: 'perplexity/sonar-reasoning-pro', label: 'Sonar Reasoning Pro', description: 'Reasoning + search.' },
    { id: 'perplexity/sonar-deep-research', label: 'Sonar Deep Research', description: 'Deep research.' },
    // === Free Models ===
    { id: 'meta-llama/llama-3.3-70b-instruct:free', label: 'Llama 3.3 70B (free)', description: 'Free tier.' },
    { id: 'qwen/qwen3-coder:free', label: 'Qwen3 Coder (free)', description: 'Free coding.' },
    { id: 'google/gemma-3-27b-it:free', label: 'Gemma 3 27B (free)', description: 'Free open model.' },
    { id: 'deepseek/deepseek-r1-0528:free', label: 'DeepSeek R1 (free)', description: 'Free reasoning.' },
    { id: 'mistralai/devstral-2512:free', label: 'Devstral (free)', description: 'Free dev model.' }
] as const

function isCodexModel(mode: ModelMode | undefined): mode is typeof CODEX_MODELS[number]['id'] {
    return Boolean(mode && CODEX_MODEL_IDS.has(mode as typeof CODEX_MODELS[number]['id']))
}

type CodexReasoningLevel = {
    id: ModelReasoningEffort
    label: string
    description: string
    warning?: string
}

const CODEX_REASONING_LEVELS: CodexReasoningLevel[] = [
    {
        id: 'low',
        label: 'Low',
        description: 'Fast responses with lighter reasoning'
    },
    {
        id: 'medium',
        label: 'Medium (default)',
        description: 'Balances speed and reasoning depth for everyday tasks'
    },
    {
        id: 'high',
        label: 'High',
        description: 'Greater reasoning depth for complex problems'
    },
    {
        id: 'xhigh',
        label: 'Extra high',
        description: 'Extra high reasoning depth for complex problems',
        warning: 'Extra high reasoning effort can quickly consume Plus plan rate limits.'
    }
] as const

const defaultSuggestionHandler = async (): Promise<Suggestion[]> => []

export function HappyComposer(props: {
    apiClient: ApiClient
    sessionId: string
    disabled?: boolean
    permissionMode?: PermissionMode
    modelMode?: ModelMode
    modelReasoningEffort?: ModelReasoningEffort
    active?: boolean
    thinking?: boolean
    agentState?: AgentState | null
    contextSize?: number
    controlledByUser?: boolean
    agentFlavor?: string | null
    onRequestResume?: () => void
    resumePending?: boolean
    resumeError?: string | null
    onPermissionModeChange?: (mode: PermissionMode) => void
    onModelModeChange?: (config: { model: ModelMode; reasoningEffort?: ModelReasoningEffort | null }) => void
    fastMode?: boolean
    onFastModeChange?: (fastMode: boolean) => Promise<void>
    onSwitchToRemote?: () => void
    onTerminal?: () => void
    autocompletePrefixes?: string[]
    autocompleteSuggestions?: (query: string) => Promise<Suggestion[]>
    otherUserTyping?: TypingUser | null
    setTextRef?: React.MutableRefObject<((text: string) => void) | null>
}) {
    const {
        apiClient,
        sessionId,
        disabled = false,
        permissionMode: rawPermissionMode,
        modelMode: rawModelMode,
        modelReasoningEffort,
        active = true,
        thinking = false,
        agentState,
        contextSize,
        controlledByUser = false,
        agentFlavor,
        onRequestResume,
        resumePending = false,
        resumeError = null,
        onPermissionModeChange,
        onModelModeChange,
        fastMode: rawFastMode,
        onFastModeChange,
        onSwitchToRemote,
        onTerminal,
        autocompletePrefixes = ['@', '/'],
        autocompleteSuggestions = defaultSuggestionHandler,
        otherUserTyping = null
    } = props

    // Use ?? so missing values fall back to default (destructuring defaults only handle undefined)
    const permissionMode = rawPermissionMode ?? 'bypassPermissions'
    const modelMode = rawModelMode ?? 'default'
    const serverFastMode = rawFastMode ?? false
    const [optimisticFastMode, setOptimisticFastMode] = useState<boolean | null>(null)
    const fastMode = optimisticFastMode ?? serverFastMode
    const isClaude = agentFlavor === 'claude' || !agentFlavor

    const assistantApi = useAssistantApi()
    const composerText = useAssistantState(({ composer }) => composer.text)
    const threadIsRunning = useAssistantState(({ thread }) => thread.isRunning)
    const threadIsDisabled = useAssistantState(({ thread }) => thread.isDisabled)

    const [uploadedImages, setUploadedImages] = useState<Array<{ path: string; previewUrl: string }>>([])
    const [uploadedFiles, setUploadedFiles] = useState<Array<{ path: string; name: string; size: number }>>([])
    const MAX_IMAGES = 5
    const MAX_FILES = 5
    const MAX_IMAGE_BYTES = 100 * 1024 * 1024
    // Claude API base64 limit is ~5MB; keep under 3.5MB raw to be safe
    const MAX_BASE64_BYTES = 3.5 * 1024 * 1024
    const MAX_FILE_BYTES = 100 * 1024 * 1024

    const showResumeOverlay = !active && Boolean(onRequestResume)
    const resumeLabel = resumePending
        ? 'Resuming...'
        : resumeError
            ? 'Resume failed. Tap to retry.'
            : 'Tap to resume session'

    const [inputState, setInputState] = useState<TextInputState>({
        text: '',
        selection: { start: 0, end: 0 }
    })
    const [showSettings, setShowSettings] = useState(false)
    const [isAborting, setIsAborting] = useState(false)
    const [isSwitching, setIsSwitching] = useState(false)
    const [showContinueHint, setShowContinueHint] = useState(false)
    const [voiceMode, setVoiceMode] = useState(false)
    const [isOptimizing, setIsOptimizing] = useState(false)
    const [autoOptimize, setAutoOptimize] = useState(() => {
        if (typeof window !== 'undefined') {
            return localStorage.getItem('yr-auto-optimize') === 'true'
        }
        return false
    })
    const [optimizePreview, setOptimizePreview] = useState<{ original: string; optimized: string } | null>(null)
    const fastModeSyncedRef = useRef(false)

    const textareaRef = useRef<HTMLTextAreaElement>(null)
    const imageInputRef = useRef<HTMLInputElement>(null)
    const fileInputRef = useRef<HTMLInputElement>(null)
    const prevControlledByUser = useRef(controlledByUser)
    const sttPrefixRef = useRef<string>('')
    const [isUploadingImage, setIsUploadingImage] = useState(false)
    const [isUploadingFile, setIsUploadingFile] = useState(false)

    const controlsDisabled = disabled || !active || threadIsDisabled
    const trimmed = composerText.trim()
    const hasText = trimmed.length > 0
    const hasImages = uploadedImages.length > 0
    const hasFiles = uploadedFiles.length > 0
    const hasAttachments = hasImages || hasFiles
    const canSend = (hasText || hasAttachments)
        && !controlsDisabled
        && !threadIsRunning
        && !isUploadingImage
        && !isUploadingFile
    const showAttachmentPreview = hasAttachments || isUploadingImage || isUploadingFile

    // Session 草稿管理
    const { getDraft, setDraft, clearDraft } = useSessionDraft(sessionId)

    const draftLoadedRef = useRef(false)
    const prevSessionIdRef = useRef(sessionId)

    // 历史记录管理
    const { addToHistory, navigateUp, navigateDown, resetNavigation, isNavigating } = useInputHistory()

    // 输入同步防抖
    const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    // 加载草稿（切换 session 时）
    useEffect(() => {
        // 保存前一个 session 的草稿
        if (prevSessionIdRef.current !== sessionId && prevSessionIdRef.current) {
            const currentText = composerText.trim()
            if (currentText) {
                // 使用 localStorage 直接保存，因为 setDraft 可能还指向旧的 sessionId
                try {
                    const stored = localStorage.getItem('yr:sessionDrafts')
                    const data = stored ? JSON.parse(stored) : {}
                    data[prevSessionIdRef.current] = composerText
                    localStorage.setItem('yr:sessionDrafts', JSON.stringify(data))
                } catch {
                    // Ignore
                }
            }
        }
        prevSessionIdRef.current = sessionId

        // 加载新 session 的草稿
        const draft = getDraft()
        if (draft) {
            assistantApi.composer().setText(draft)
            setInputState({
                text: draft,
                selection: { start: draft.length, end: draft.length }
            })
        } else if (composerText) {
            // 如果有 composerText 但没有草稿，清空输入
            assistantApi.composer().setText('')
            setInputState({
                text: '',
                selection: { start: 0, end: 0 }
            })
        }
        draftLoadedRef.current = true
        resetNavigation()
        // 清空上传的图片
        setUploadedImages([])
    }, [sessionId]) // eslint-disable-line react-hooks/exhaustive-deps

    // 实时保存草稿
    useEffect(() => {
        if (!draftLoadedRef.current) return
        setDraft(composerText)
    }, [composerText, setDraft])

    // Clear optimistic fast mode when server value catches up
    useEffect(() => {
        setOptimisticFastMode(null)
    }, [serverFastMode])

    // Sync stored fast mode preference to new active sessions (Claude only)
    useEffect(() => {
        if (!isClaude || !active || !onFastModeChange) return
        if (fastModeSyncedRef.current) return
        fastModeSyncedRef.current = true
        const stored = localStorage.getItem('yr-fast-mode')
        if (stored === 'true' && !serverFastMode) {
            onFastModeChange(true)
        } else if (stored === 'false' && serverFastMode) {
            onFastModeChange(false)
        }
    }, [sessionId, active]) // eslint-disable-line react-hooks/exhaustive-deps

    // Reset sync flag when session changes
    useEffect(() => {
        fastModeSyncedRef.current = false
    }, [sessionId])

    // 同步输入给其他用户（防抖 500ms，增加防抖时间减少请求频率）
    // 用 ref 跟踪是否是本地输入，避免把远程同步的内容再发回去
    const isLocalInputRef = useRef(true)
    // 跟踪上次发送的内容，避免重复发送相同内容
    const lastSentTextRef = useRef<string>('')

    useEffect(() => {
        if (!sessionId || !active) return
        // 如果不是本地输入，不发送
        if (!isLocalInputRef.current) {
            isLocalInputRef.current = true
            return
        }
        // 如果内容与上次发送的相同，不发送
        if (composerText === lastSentTextRef.current) {
            return
        }

        if (typingTimeoutRef.current) {
            clearTimeout(typingTimeoutRef.current)
        }

        typingTimeoutRef.current = setTimeout(() => {
            // 再次检查是否与上次发送的相同
            if (composerText === lastSentTextRef.current) {
                return
            }
            lastSentTextRef.current = composerText
            apiClient.sendTyping(sessionId, composerText).catch(() => {
                // Ignore errors
            })
        }, 500)  // 增加到 500ms 减少请求频率

        return () => {
            if (typingTimeoutRef.current) {
                clearTimeout(typingTimeoutRef.current)
            }
        }
    }, [composerText, sessionId, active, apiClient])

    // 接收其他用户的输入并同步到输入框
    const prevOtherUserTextRef = useRef<string | null>(null)
    // 使用 useMemo 提取 otherUserTyping 的 text，避免对象引用变化导致的重复触发
    const otherUserText = otherUserTyping?.text ?? null

    useEffect(() => {
        if (otherUserText === null) {
            prevOtherUserTextRef.current = null
            return
        }
        // 只有当其他用户输入内容变化时才同步
        if (otherUserText === prevOtherUserTextRef.current) return
        prevOtherUserTextRef.current = otherUserText

        // 标记为非本地输入，避免把同步过来的内容再发回去
        isLocalInputRef.current = false
        // 同时更新 lastSentTextRef，防止发送这个同步过来的内容
        lastSentTextRef.current = otherUserText
        assistantApi.composer().setText(otherUserText)
        setInputState({
            text: otherUserText,
            selection: { start: otherUserText.length, end: otherUserText.length }
        })
    }, [otherUserText, assistantApi])

    useEffect(() => {
        setInputState((prev) => {
            if (prev.text === composerText) return prev
            // When syncing from composerText, update selection to end of text
            // This ensures activeWord detection works correctly
            const newPos = composerText.length
            return { text: composerText, selection: { start: newPos, end: newPos } }
        })
    }, [composerText])

    // Track one-time "continue" hint after switching from local to remote.
    useEffect(() => {
        if (prevControlledByUser.current === true && controlledByUser === false) {
            setShowContinueHint(true)
        }
        if (controlledByUser) {
            setShowContinueHint(false)
        }
        prevControlledByUser.current = controlledByUser
    }, [controlledByUser])

    const { haptic: platformHaptic, isTouch } = usePlatform()
    const { isStandalone, isIOS } = usePWAInstall()
    const isIOSPWA = isIOS && isStandalone
    // iOS PWA 使用 safe-area-inset-bottom 适配底部安全距离，同时保证最小 padding
    const bottomPaddingClass = isIOSPWA ? 'pb-[max(env(safe-area-inset-bottom),0.75rem)]' : 'pb-3'
    const activeWord = useActiveWord(inputState.text, inputState.selection, autocompletePrefixes)
    const [suggestions, selectedIndex, moveUp, moveDown, clearSuggestions] = useActiveSuggestions(
        activeWord,
        autocompleteSuggestions,
        { clampSelection: true, wrapAround: true }
    )

    const haptic = useCallback((type: 'light' | 'success' | 'error' = 'light') => {
        if (type === 'light') {
            platformHaptic.impact('light')
        } else if (type === 'success') {
            platformHaptic.notification('success')
        } else {
            platformHaptic.notification('error')
        }
    }, [platformHaptic])

    const handleSuggestionSelect = useCallback((index: number) => {
        const suggestion = suggestions[index]
        if (!suggestion || !textareaRef.current) return

        const result = applySuggestion(
            inputState.text,
            inputState.selection,
            suggestion.text,
            autocompletePrefixes,
            true
        )

        assistantApi.composer().setText(result.text)
        setInputState({
            text: result.text,
            selection: { start: result.cursorPosition, end: result.cursorPosition }
        })

        setTimeout(() => {
            const el = textareaRef.current
            if (!el) return
            el.setSelectionRange(result.cursorPosition, result.cursorPosition)
            try {
                el.focus({ preventScroll: true })
            } catch {
                el.focus()
            }
        }, 0)

        haptic('light')
    }, [assistantApi, suggestions, inputState, autocompletePrefixes, haptic])

    // 暴露 setText 方法供外部调用（用于芯片选择）
    useEffect(() => {
        if (props.setTextRef) {
            props.setTextRef.current = (text: string) => {
                assistantApi.composer().setText(text)
                setInputState({
                    text,
                    selection: { start: text.length, end: text.length }
                })
                setTimeout(() => {
                    textareaRef.current?.focus()
                }, 0)
            }
        }
        return () => {
            if (props.setTextRef) {
                props.setTextRef.current = null
            }
        }
    }, [assistantApi, props.setTextRef])

    const abortDisabled = controlsDisabled || isAborting || !threadIsRunning
    const switchDisabled = controlsDisabled || isSwitching || !controlledByUser
    const showSwitchButton = Boolean(controlledByUser && onSwitchToRemote)
    const showTerminalButton = Boolean(onTerminal)

    useEffect(() => {
        if (!isAborting) return
        if (threadIsRunning) return
        setIsAborting(false)
    }, [isAborting, threadIsRunning])

    useEffect(() => {
        if (!isSwitching) return
        if (controlledByUser) return
        setIsSwitching(false)
    }, [isSwitching, controlledByUser])

    const handleAbort = useCallback(() => {
        if (abortDisabled) return
        haptic('error')
        setIsAborting(true)
        assistantApi.thread().cancelRun()
    }, [abortDisabled, assistantApi, haptic])

    const handleSwitch = useCallback(async () => {
        if (switchDisabled || !onSwitchToRemote) return
        haptic('light')
        setIsSwitching(true)
        try {
            await onSwitchToRemote()
        } catch {
            setIsSwitching(false)
        }
    }, [switchDisabled, onSwitchToRemote, haptic])

    const permissionModes = useMemo(() => {
        if (agentFlavor === 'codex') {
            return CODEX_PERMISSION_MODES as readonly PermissionMode[]
        }
        if (agentFlavor === 'gemini') {
            return [] as readonly PermissionMode[]
        }
        return CLAUDE_PERMISSION_MODES as readonly PermissionMode[]
    }, [agentFlavor])

    const optimizeText = useCallback(async (text: string): Promise<string> => {
        const result = await apiClient.optimizeText(text)
        return result.optimized
    }, [apiClient])

    const buildMessageWithAttachments = useCallback((baseText: string) => {
        const imageRefs = uploadedImages.map(img => `[Image: ${img.path}]`).join('\n')
        const fileRefs = uploadedFiles.map(file => `[File: ${file.path}]`).join('\n')
        const attachmentRefs = [imageRefs, fileRefs].filter(Boolean).join('\n')
        const currentText = baseText.trim()
        if (!attachmentRefs) {
            return currentText
        }
        const separator = currentText ? '\n\n' : ''
        return `${currentText}${separator}${attachmentRefs}`
    }, [uploadedImages, uploadedFiles])

    // 处理带附件的消息发送
    const handleSendWithAttachments = useCallback((baseText?: string) => {
        const newText = buildMessageWithAttachments(baseText ?? composerText)
        if (!newText) {
            return
        }
        assistantApi.composer().setText(newText)

        // 立即清空附件列表，不等待表单提交
        if (uploadedImages.length > 0) {
            setUploadedImages([])
        }
        if (uploadedFiles.length > 0) {
            setUploadedFiles([])
        }

        // 延迟提交，等待文本更新
        setTimeout(() => {
            const form = textareaRef.current?.closest('form')
            if (form) {
                form.requestSubmit()
            }
        }, 50)
    }, [buildMessageWithAttachments, composerText, assistantApi, uploadedImages.length, uploadedFiles.length])

    const handleOptimizeForPreview = useCallback(async () => {
        if (controlsDisabled || isOptimizing) return
        if (!hasText) {
            if (hasAttachments) {
                handleSendWithAttachments()
            }
            return
        }

        setIsOptimizing(true)
        haptic('light')

        try {
            const optimizedResult = await optimizeText(trimmed)
            // If text is the same, just send directly
            if (optimizedResult === trimmed) {
                if (hasAttachments) {
                    handleSendWithAttachments(optimizedResult)
                } else {
                    const form = textareaRef.current?.closest('form')
                    if (form) {
                        form.requestSubmit()
                    }
                }
            } else {
                // Show preview dialog
                setOptimizePreview({ original: trimmed, optimized: optimizedResult })
            }
        } catch (error) {
            console.error('Failed to optimize text:', error)
            haptic('error')
            // On error, just send the original
            if (hasAttachments) {
                handleSendWithAttachments(trimmed)
            } else {
                const form = textareaRef.current?.closest('form')
                if (form) {
                    form.requestSubmit()
                }
            }
        } finally {
            setIsOptimizing(false)
        }
    }, [controlsDisabled, hasText, hasAttachments, isOptimizing, trimmed, optimizeText, haptic, handleSendWithAttachments])

    const handleKeyDown = useCallback((e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
        const key = e.key

        // Avoid intercepting IME composition keystrokes (Enter, arrows, etc.)
        if (e.nativeEvent.isComposing) {
            return
        }

        if (suggestions.length > 0) {
            if (key === 'ArrowUp') {
                e.preventDefault()
                moveUp()
                return
            }
            if (key === 'ArrowDown') {
                e.preventDefault()
                moveDown()
                return
            }
            if ((key === 'Enter' || key === 'Tab') && !e.shiftKey) {
                e.preventDefault()
                const indexToSelect = selectedIndex >= 0 ? selectedIndex : 0
                handleSuggestionSelect(indexToSelect)
                return
            }
            if (key === 'Escape') {
                e.preventDefault()
                clearSuggestions()
                return
            }
        }

        // 历史记录导航（输入框为空时）
        if (!hasText && suggestions.length === 0) {
            if (key === 'ArrowUp') {
                const historyText = navigateUp(inputState.text)
                if (historyText !== null) {
                    e.preventDefault()
                    assistantApi.composer().setText(historyText)
                    setInputState({
                        text: historyText,
                        selection: { start: historyText.length, end: historyText.length }
                    })
                }
                return
            }
            if (key === 'ArrowDown' && isNavigating()) {
                const historyText = navigateDown()
                if (historyText !== null) {
                    e.preventDefault()
                    assistantApi.composer().setText(historyText)
                    setInputState({
                        text: historyText,
                        selection: { start: historyText.length, end: historyText.length }
                    })
                }
                return
            }
        }

        if (key === 'Escape' && threadIsRunning) {
            e.preventDefault()
            handleAbort()
            return
        }

        if (key === 'Tab' && e.shiftKey && onPermissionModeChange && permissionModes.length > 1) {
            e.preventDefault()
            const currentIndex = permissionModes.indexOf(permissionMode)
            const nextIndex = (currentIndex + 1) % permissionModes.length
            const nextMode = permissionModes[nextIndex] ?? 'bypassPermissions'
            onPermissionModeChange(nextMode)
            haptic('light')
            return
        }

        if (key === 'Enter' && !e.shiftKey && !controlsDisabled && !threadIsRunning && !isUploadingImage && !isUploadingFile) {
            if (autoOptimize && hasText && !isOptimizing) {
                e.preventDefault()
                handleOptimizeForPreview()
                return
            }
            if (hasAttachments) {
                e.preventDefault()
                handleSendWithAttachments()
            }
        }
    }, [
        suggestions,
        selectedIndex,
        moveUp,
        moveDown,
        clearSuggestions,
        handleSuggestionSelect,
        threadIsRunning,
        handleAbort,
        onPermissionModeChange,
        permissionMode,
        permissionModes,
        haptic,
        autoOptimize,
        hasText,
        hasAttachments,
        isOptimizing,
        isUploadingImage,
        isUploadingFile,
        controlsDisabled,
        handleOptimizeForPreview,
        handleSendWithAttachments,
        navigateUp,
        navigateDown,
        isNavigating,
        inputState.text,
        assistantApi
    ])

    useEffect(() => {
        const handleGlobalKeyDown = (e: globalThis.KeyboardEvent) => {
            if (e.key === 'm' && (e.metaKey || e.ctrlKey) && onModelModeChange && agentFlavor !== 'codex' && agentFlavor !== 'gemini') {
                e.preventDefault()
                const currentIndex = MODEL_MODES.indexOf(modelMode as typeof MODEL_MODES[number])
                const nextIndex = (currentIndex + 1) % MODEL_MODES.length
                onModelModeChange({ model: MODEL_MODES[nextIndex] })
                haptic('light')
            }
        }

        window.addEventListener('keydown', handleGlobalKeyDown)
        return () => window.removeEventListener('keydown', handleGlobalKeyDown)
    }, [modelMode, onModelModeChange, haptic, agentFlavor])

    const handleChange = useCallback((e: ReactChangeEvent<HTMLTextAreaElement>) => {
        const selection = {
            start: e.target.selectionStart,
            end: e.target.selectionEnd
        }
        setInputState({ text: e.target.value, selection })
    }, [])

    const handleSelect = useCallback((e: ReactSyntheticEvent<HTMLTextAreaElement>) => {
        const target = e.target as HTMLTextAreaElement
        setInputState(prev => ({
            ...prev,
            selection: { start: target.selectionStart, end: target.selectionEnd }
        }))
    }, [])

    const handleSettingsToggle = useCallback(() => {
        haptic('light')
        setShowSettings(prev => !prev)
    }, [haptic])


    const handleSubmit = useCallback(() => {
        setShowContinueHint(false)

        // 添加到历史记录
        if (trimmed || uploadedImages.length > 0 || uploadedFiles.length > 0) {
            addToHistory(trimmed)
        }
        // 清除草稿
        clearDraft()
        // 重置历史导航
        resetNavigation()
        // 清空图片列表（提交后清理）
        if (uploadedImages.length > 0) {
            setUploadedImages([])
        }
        if (uploadedFiles.length > 0) {
            setUploadedFiles([])
        }
    }, [trimmed, addToHistory, clearDraft, resetNavigation, uploadedImages, uploadedFiles])

    const handlePermissionChange = useCallback((mode: PermissionMode) => {
        if (!onPermissionModeChange || controlsDisabled) return
        onPermissionModeChange(mode)
        setShowSettings(false)
        haptic('light')
    }, [onPermissionModeChange, controlsDisabled, haptic])

    const handleModelChange = useCallback((config: { model: ModelMode; reasoningEffort?: ModelReasoningEffort | null }) => {
        if (!onModelModeChange || controlsDisabled) return
        onModelModeChange(config)
        setShowSettings(false)
        haptic('light')
    }, [onModelModeChange, controlsDisabled, haptic])

    const handleFastModeToggle = useCallback(async () => {
        if (!onFastModeChange) return
        const newValue = !fastMode
        setOptimisticFastMode(newValue)
        localStorage.setItem('yr-fast-mode', String(newValue))
        haptic('light')
        try {
            await onFastModeChange(newValue)
        } catch {
            // Revert optimistic state on failure
            setOptimisticFastMode(null)
            localStorage.setItem('yr-fast-mode', String(!newValue))
        }
    }, [onFastModeChange, fastMode, haptic])

    const handleAutoOptimizeToggle = useCallback(() => {
        setAutoOptimize(prev => {
            const newValue = !prev
            localStorage.setItem('yr-auto-optimize', String(newValue))
            return newValue
        })
        haptic('light')
    }, [haptic])

    const handleImageClick = useCallback(() => {
        imageInputRef.current?.click()
    }, [])

    const handleFileClick = useCallback(() => {
        fileInputRef.current?.click()
    }, [])

    const compressImage = useCallback(async (file: File, maxBytes: number): Promise<{ dataUrl: string; base64: string; mimeType: string }> => {
        // Read original file
        const reader = new FileReader()
        const originalUrl = await new Promise<string>((resolve, reject) => {
            reader.onload = () => resolve(reader.result as string)
            reader.onerror = reject
            reader.readAsDataURL(file)
        })

        const originalBase64 = originalUrl.split(',')[1]
        // If already under limit, return as-is
        if (originalBase64.length <= maxBytes) {
            return { dataUrl: originalUrl, base64: originalBase64, mimeType: file.type || 'image/png' }
        }

        // Load into an Image to get dimensions
        const img = new Image()
        const imgLoaded = new Promise<void>((resolve, reject) => {
            img.onload = () => resolve()
            img.onerror = reject
        })
        img.src = originalUrl
        await imgLoaded

        // Iteratively scale down and reduce quality until under limit
        let scale = 1
        const MAX_DIM = 2048
        // If image is very large, start by capping dimensions
        if (img.width > MAX_DIM || img.height > MAX_DIM) {
            scale = MAX_DIM / Math.max(img.width, img.height)
        }

        let quality = 0.85
        let resultBase64 = originalBase64
        let resultDataUrl = originalUrl

        for (let attempt = 0; attempt < 6; attempt++) {
            const canvas = document.createElement('canvas')
            canvas.width = Math.round(img.width * scale)
            canvas.height = Math.round(img.height * scale)
            const ctx = canvas.getContext('2d')!
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height)

            resultDataUrl = canvas.toDataURL('image/jpeg', quality)
            resultBase64 = resultDataUrl.split(',')[1]

            if (resultBase64.length <= maxBytes) break

            // Reduce quality and scale for next attempt
            quality = Math.max(0.3, quality - 0.15)
            scale = Math.max(0.2, scale * 0.7)
        }

        return { dataUrl: resultDataUrl, base64: resultBase64, mimeType: 'image/jpeg' }
    }, [])

    const uploadImageFile = useCallback(async (file: File) => {
        // Check max images limit
        if (uploadedImages.length >= MAX_IMAGES) {
            haptic('error')
            console.error(`Maximum ${MAX_IMAGES} images allowed`)
            return
        }

        // Validate file type
        if (!file.type.startsWith('image/')) {
            haptic('error')
            console.error('Selected file is not an image')
            return
        }

        // Validate file size (max 100MB)
        if (file.size > MAX_IMAGE_BYTES) {
            haptic('error')
            console.error('Image file too large (max 100MB)')
            return
        }

        setIsUploadingImage(true)
        haptic('light')

        try {
            // Compress image to fit Claude API base64 limit
            const { dataUrl, base64: base64Content, mimeType } = await compressImage(file, MAX_BASE64_BYTES)
            let filename = file.name || 'pasted-image.png'
            // If compression changed format to JPEG, update the file extension to match
            if (mimeType === 'image/jpeg' && !/\.jpe?g$/i.test(filename)) {
                filename = filename.replace(/\.[^.]+$/, '.jpg')
            }

            // Upload to server
            const result = await apiClient.uploadImage(sessionId, filename, base64Content, mimeType)

            if (result.success && result.path) {
                haptic('success')
                // Add to uploaded images list with preview
                setUploadedImages(prev => [...prev, { path: result.path!, previewUrl: dataUrl }])
            } else {
                haptic('error')
                console.error('Failed to upload image:', result.error)
            }
        } catch (error) {
            haptic('error')
            console.error('Failed to upload image:', error)
        } finally {
            setIsUploadingImage(false)
        }
    }, [apiClient, sessionId, uploadedImages.length, haptic, MAX_IMAGE_BYTES, MAX_BASE64_BYTES, compressImage])

    const handleImageChange = useCallback(async (e: ReactChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        if (!file) return

        // Reset input for next selection
        e.target.value = ''

        await uploadImageFile(file)
    }, [uploadImageFile])

    const handlePaste = useCallback((e: ReactClipboardEvent<HTMLTextAreaElement>) => {
        const items = e.clipboardData?.items
        if (!items) return

        for (const item of items) {
            if (item.type.startsWith('image/')) {
                e.preventDefault()
                const file = item.getAsFile()
                if (file) {
                    uploadImageFile(file)
                }
                return
            }
        }
    }, [uploadImageFile])

    const handleFileChange = useCallback(async (e: ReactChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        if (!file) return

        // Reset input for next selection
        e.target.value = ''

        // Check max files limit
        if (uploadedFiles.length >= MAX_FILES) {
            haptic('error')
            console.error(`Maximum ${MAX_FILES} files allowed`)
            return
        }

        // Validate file size (max 100MB)
        if (file.size > MAX_FILE_BYTES) {
            haptic('error')
            console.error('File too large (max 100MB)')
            return
        }

        setIsUploadingFile(true)
        haptic('light')

        try {
            const reader = new FileReader()
            const dataUrlPromise = new Promise<string>((resolve, reject) => {
                reader.onload = () => {
                    resolve(reader.result as string)
                }
                reader.onerror = reject
            })
            reader.readAsDataURL(file)
            const dataUrl = await dataUrlPromise
            const base64Content = dataUrl.split(',')[1]
            const mimeType = file.type || 'application/octet-stream'

            const result = await apiClient.uploadFile(sessionId, file.name, base64Content, mimeType)

            if (result.success && result.path) {
                haptic('success')
                setUploadedFiles(prev => [...prev, { path: result.path!, name: file.name, size: file.size }])
            } else {
                haptic('error')
                console.error('Failed to upload file:', result.error)
            }
        } catch (error) {
            haptic('error')
            console.error('Failed to upload file:', error)
        } finally {
            setIsUploadingFile(false)
        }
    }, [apiClient, sessionId, uploadedFiles.length, haptic, MAX_FILES, MAX_FILE_BYTES])

    const handleRemoveImage = useCallback((index: number) => {
        setUploadedImages(prev => prev.filter((_, i) => i !== index))
        haptic('light')
    }, [haptic])

    const handleRemoveFile = useCallback((index: number) => {
        setUploadedFiles(prev => prev.filter((_, i) => i !== index))
        haptic('light')
    }, [haptic])

    const handlePreviewConfirm = useCallback(() => {
        if (!optimizePreview) return
        const nextText = buildMessageWithAttachments(optimizePreview.optimized)
        assistantApi.composer().setText(nextText)
        setInputState({
            text: nextText,
            selection: { start: nextText.length, end: nextText.length }
        })
        setOptimizePreview(null)
        // Send after state update
        setTimeout(() => {
            const form = textareaRef.current?.closest('form')
            if (form) {
                form.requestSubmit()
            }
        }, 50)
    }, [optimizePreview, buildMessageWithAttachments, assistantApi])

    const handlePreviewCancel = useCallback(() => {
        setOptimizePreview(null)
        // Focus back to textarea
        textareaRef.current?.focus()
    }, [])

    const handlePreviewSendOriginal = useCallback(() => {
        if (!optimizePreview) return
        const nextText = buildMessageWithAttachments(optimizePreview.original)
        assistantApi.composer().setText(nextText)
        setInputState({
            text: nextText,
            selection: { start: nextText.length, end: nextText.length }
        })
        setOptimizePreview(null)
        // Send original text
        setTimeout(() => {
            const form = textareaRef.current?.closest('form')
            if (form) {
                form.requestSubmit()
            }
        }, 50)
    }, [optimizePreview, buildMessageWithAttachments, assistantApi])

    const showPermissionSettings = Boolean(onPermissionModeChange && permissionModes.length > 1)
    const showModelSettings = Boolean(onModelModeChange && agentFlavor !== 'gemini')
    const showSettingsButton = true // Always show settings for auto-optimize toggle
    const showAbortButton = true
    const isCodex = agentFlavor === 'codex'
    const isGrok = agentFlavor === 'grok'
    const isOpenRouter = agentFlavor === 'openrouter'
    const codexModel = isCodex && isCodexModel(modelMode) ? modelMode : 'gpt-5.3-codex'
    const grokModel = isGrok ? (modelMode as string || 'grok-code-fast-1') : 'grok-code-fast-1'
    const openrouterModel = isOpenRouter ? (modelMode as string || 'anthropic/claude-sonnet-4') : 'anthropic/claude-sonnet-4'
    const codexReasoningEffort: ModelReasoningEffort = modelReasoningEffort ?? 'medium'
    const shouldShowCodexReasoning = isCodex && (codexModel === 'gpt-5.3-codex' || codexModel === 'gpt-5.2-codex')
    const speechToText = useSpeechToText({
        onPartial: (text) => {
            const prefix = sttPrefixRef.current
            assistantApi.composer().setText(`${prefix}${text}`)
        },
        onFinal: (text) => {
            const prefix = sttPrefixRef.current
            const finalText = `${prefix}${text}`
            assistantApi.composer().setText(finalText)
            sttPrefixRef.current = finalText
        },
        onError: (message) => {
            console.error('Speech-to-text error:', message)
            haptic('error')
        }
    })

    const handleVoicePressStart = useCallback(async () => {
        if (!speechToText.isSupported || controlsDisabled) return
        if (speechToText.status === 'connecting' || speechToText.status === 'recording' || speechToText.status === 'stopping') return
        const spacer = composerText && !/\s$/.test(composerText) ? ' ' : ''
        sttPrefixRef.current = `${composerText}${spacer}`
        await speechToText.start()
    }, [composerText, controlsDisabled, speechToText])

    const handleVoicePressEnd = useCallback(() => {
        if (speechToText.status === 'recording' || speechToText.status === 'connecting') {
            speechToText.stop()
        }
    }, [speechToText])

    const handleVoiceToggle = useCallback(() => {
        if (!speechToText.isSupported || controlsDisabled) return
        if (voiceMode) {
            if (speechToText.status === 'recording') {
                speechToText.stop()
            }
            speechToText.teardown()
            setVoiceMode(false)
        } else {
            setVoiceMode(true)
            speechToText.prepare().catch(() => {})
        }
    }, [controlsDisabled, speechToText, voiceMode])

    // Track if we're currently pressing the voice button
    const voicePressActiveRef = useRef(false)
    // Prevent touch and pointer events from both firing
    const touchHandledRef = useRef(false)

    const startVoiceCapture = useCallback(() => {
        if (!voiceMode || controlsDisabled) return false
        if (speechToText.status === 'connecting' || speechToText.status === 'stopping') return false
        if (voicePressActiveRef.current) return false

        voicePressActiveRef.current = true
        console.log('[stt] voice capture start', { status: speechToText.status })
        handleVoicePressStart().catch(() => {})
        return true
    }, [voiceMode, controlsDisabled, speechToText.status, handleVoicePressStart])

    const stopVoiceCapture = useCallback(() => {
        if (!voicePressActiveRef.current) return
        voicePressActiveRef.current = false
        console.log('[stt] voice capture stop')
        handleVoicePressEnd()
    }, [handleVoicePressEnd])

    // Touch events - primary handler for iOS
    const handleTouchStart = useCallback((event: ReactTouchEvent<HTMLButtonElement>) => {
        touchHandledRef.current = true
        event.preventDefault()
        startVoiceCapture()
    }, [startVoiceCapture])

    const handleTouchEnd = useCallback((event: ReactTouchEvent<HTMLButtonElement>) => {
        event.preventDefault()
        stopVoiceCapture()
        // Reset touch flag after a short delay
        setTimeout(() => { touchHandledRef.current = false }, 300)
    }, [stopVoiceCapture])

    // Pointer events - fallback for desktop
    const handleVoicePadPointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
        // Skip if touch already handled this interaction
        if (touchHandledRef.current) return
        event.preventDefault()
        startVoiceCapture()
    }, [startVoiceCapture])

    // Global listener to catch pointer/touch end anywhere on screen
    useEffect(() => {
        if (!voiceMode) {
            if (voicePressActiveRef.current) {
                voicePressActiveRef.current = false
                handleVoicePressEnd()
            }
            touchHandledRef.current = false
            return
        }

        const handleGlobalEnd = (event: PointerEvent | TouchEvent) => {
            if (!voicePressActiveRef.current) return
            // For touch events on iOS, prevent the synthetic pointer events
            if (event.type === 'touchend' || event.type === 'touchcancel') {
                touchHandledRef.current = true
                setTimeout(() => { touchHandledRef.current = false }, 300)
            }
            stopVoiceCapture()
        }

        // Listen on document to ensure we catch events even if finger moves off button
        document.addEventListener('pointerup', handleGlobalEnd, { capture: true, passive: true })
        document.addEventListener('pointercancel', handleGlobalEnd, { capture: true, passive: true })
        document.addEventListener('touchend', handleGlobalEnd, { capture: true, passive: true })
        document.addEventListener('touchcancel', handleGlobalEnd, { capture: true, passive: true })

        return () => {
            document.removeEventListener('pointerup', handleGlobalEnd, { capture: true })
            document.removeEventListener('pointercancel', handleGlobalEnd, { capture: true })
            document.removeEventListener('touchend', handleGlobalEnd, { capture: true })
            document.removeEventListener('touchcancel', handleGlobalEnd, { capture: true })
        }
    }, [voiceMode, handleVoicePressEnd, stopVoiceCapture])

    useEffect(() => {
        if (!active && speechToText.status === 'recording') {
            speechToText.stop()
        }
    }, [active, speechToText])

    const overlays = useMemo(() => {
        if (showSettings) {
            return (
                <div className="absolute bottom-[100%] mb-2 w-full">
                    <FloatingOverlay maxHeight={320}>
                        {/* Fast Mode Toggle (Claude only) */}
                        {isClaude ? (
                            <>
                                <div className="py-2">
                                    <div className="px-3 pb-1 text-xs font-semibold text-[var(--app-hint)]">
                                        Fast Mode
                                    </div>
                                    <button
                                        type="button"
                                        className="flex w-full items-center justify-between px-3 py-2 text-left text-sm transition-colors cursor-pointer hover:bg-[var(--app-secondary-bg)]"
                                        onClick={handleFastModeToggle}
                                        onMouseDown={(e) => e.preventDefault()}
                                    >
                                        <span>Higher throughput (higher cost)</span>
                                        <div className={`relative h-5 w-9 rounded-full transition-colors ${fastMode ? 'bg-amber-500' : 'bg-gray-300'}`}>
                                            <div className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${fastMode ? 'translate-x-4' : 'translate-x-0.5'}`} />
                                        </div>
                                    </button>
                                </div>
                                <div className="mx-3 h-px bg-[var(--app-divider)]" />
                            </>
                        ) : null}
                        {/* Auto Optimize Toggle */}
                        <div className="py-2">
                            <div className="px-3 pb-1 text-xs font-semibold text-[var(--app-hint)]">
                                AI Optimize
                            </div>
                            <button
                                type="button"
                                className="flex w-full items-center justify-between px-3 py-2 text-left text-sm transition-colors cursor-pointer hover:bg-[var(--app-secondary-bg)]"
                                onClick={handleAutoOptimizeToggle}
                                onMouseDown={(e) => e.preventDefault()}
                            >
                                <span>Auto-optimize before sending</span>
                                <div className={`relative h-5 w-9 rounded-full transition-colors ${autoOptimize ? 'bg-purple-600' : 'bg-gray-300'}`}>
                                    <div className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${autoOptimize ? 'translate-x-4' : 'translate-x-0.5'}`} />
                                </div>
                            </button>
                        </div>

                        {showPermissionSettings ? (
                            <div className="mx-3 h-px bg-[var(--app-divider)]" />
                        ) : null}

                        {showPermissionSettings ? (
                            <div className="py-2">
                                <div className="px-3 pb-1 text-xs font-semibold text-[var(--app-hint)]">
                                    Permission Mode
                                </div>
                                {permissionModes.map((mode) => (
                                    <button
                                        key={mode}
                                        type="button"
                                        disabled={controlsDisabled}
                                        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                                            controlsDisabled
                                                ? 'cursor-not-allowed opacity-50'
                                                : 'cursor-pointer hover:bg-[var(--app-secondary-bg)]'
                                        }`}
                                        onClick={() => handlePermissionChange(mode)}
                                        onMouseDown={(e) => e.preventDefault()}
                                    >
                                        <div
                                            className={`flex h-4 w-4 items-center justify-center rounded-full border-2 ${
                                                permissionMode === mode
                                                    ? 'border-[var(--app-link)]'
                                                    : 'border-[var(--app-hint)]'
                                            }`}
                                        >
                                            {permissionMode === mode && (
                                                <div className="h-2 w-2 rounded-full bg-[var(--app-link)]" />
                                            )}
                                        </div>
                                        <span className={permissionMode === mode ? 'text-[var(--app-link)]' : ''}>
                                            {PERMISSION_MODE_LABELS[mode]}
                                        </span>
                                    </button>
                                ))}
                            </div>
                        ) : null}

                        {showPermissionSettings && showModelSettings ? (
                            <div className="mx-3 h-px bg-[var(--app-divider)]" />
                        ) : null}

                        {showModelSettings ? (
                            <div className="py-2">
                                <div className="px-3 pb-1 text-xs font-semibold text-[var(--app-hint)]">
                                    Model
                                </div>
                                {isCodex ? (
                                    <div className="space-y-1">
                                        {CODEX_MODELS.map((mode) => (
                                            <button
                                                key={mode.id}
                                                type="button"
                                                disabled={controlsDisabled}
                                                className={`flex w-full items-start gap-2 px-3 py-2 text-left text-sm transition-colors ${
                                                    controlsDisabled
                                                        ? 'cursor-not-allowed opacity-50'
                                                        : 'cursor-pointer hover:bg-[var(--app-secondary-bg)]'
                                                }`}
                                                onClick={() => handleModelChange({ model: mode.id, reasoningEffort: codexReasoningEffort })}
                                                onMouseDown={(e) => e.preventDefault()}
                                            >
                                                <div
                                                    className={`mt-0.5 flex h-4 w-4 items-center justify-center rounded-full border-2 ${
                                                        codexModel === mode.id
                                                            ? 'border-[var(--app-link)]'
                                                            : 'border-[var(--app-hint)]'
                                                    }`}
                                                >
                                                    {codexModel === mode.id && (
                                                        <div className="h-2 w-2 rounded-full bg-[var(--app-link)]" />
                                                    )}
                                                </div>
                                                <div className="flex flex-col gap-0.5">
                                                    <span className={codexModel === mode.id ? 'text-[var(--app-link)]' : ''}>
                                                        {mode.label}
                                                    </span>
                                                    <span className="text-xs text-[var(--app-hint)]">
                                                        {mode.description}
                                                    </span>
                                                </div>
                                            </button>
                                        ))}
                                    </div>
                                ) : isGrok ? (
                                    <div className="space-y-1">
                                        {GROK_MODELS.map((mode) => (
                                            <button
                                                key={mode.id}
                                                type="button"
                                                disabled={controlsDisabled}
                                                className={`flex w-full items-start gap-2 px-3 py-2 text-left text-sm transition-colors ${
                                                    controlsDisabled
                                                        ? 'cursor-not-allowed opacity-50'
                                                        : 'cursor-pointer hover:bg-[var(--app-secondary-bg)]'
                                                }`}
                                                onClick={() => handleModelChange({ model: mode.id as ModelMode })}
                                                onMouseDown={(e) => e.preventDefault()}
                                            >
                                                <div
                                                    className={`mt-0.5 flex h-4 w-4 items-center justify-center rounded-full border-2 ${
                                                        grokModel === mode.id
                                                            ? 'border-[var(--app-link)]'
                                                            : 'border-[var(--app-hint)]'
                                                    }`}
                                                >
                                                    {grokModel === mode.id && (
                                                        <div className="h-2 w-2 rounded-full bg-[var(--app-link)]" />
                                                    )}
                                                </div>
                                                <div className="flex flex-col gap-0.5">
                                                    <span className={grokModel === mode.id ? 'text-[var(--app-link)]' : ''}>
                                                        {mode.label}
                                                    </span>
                                                    <span className="text-xs text-[var(--app-hint)]">
                                                        {mode.description}
                                                    </span>
                                                </div>
                                            </button>
                                        ))}
                                    </div>
                                ) : isOpenRouter ? (
                                    <div className="space-y-1">
                                        {OPENROUTER_MODELS.map((mode) => (
                                            <button
                                                key={mode.id}
                                                type="button"
                                                disabled={controlsDisabled}
                                                className={`flex w-full items-start gap-2 px-3 py-2 text-left text-sm transition-colors ${
                                                    controlsDisabled
                                                        ? 'cursor-not-allowed opacity-50'
                                                        : 'cursor-pointer hover:bg-[var(--app-secondary-bg)]'
                                                }`}
                                                onClick={() => handleModelChange({ model: mode.id as ModelMode })}
                                                onMouseDown={(e) => e.preventDefault()}
                                            >
                                                <div
                                                    className={`mt-0.5 flex h-4 w-4 items-center justify-center rounded-full border-2 ${
                                                        openrouterModel === mode.id
                                                            ? 'border-[var(--app-link)]'
                                                            : 'border-[var(--app-hint)]'
                                                    }`}
                                                >
                                                    {openrouterModel === mode.id && (
                                                        <div className="h-2 w-2 rounded-full bg-[var(--app-link)]" />
                                                    )}
                                                </div>
                                                <div className="flex flex-col gap-0.5">
                                                    <span className={openrouterModel === mode.id ? 'text-[var(--app-link)]' : ''}>
                                                        {mode.label}
                                                    </span>
                                                    <span className="text-xs text-[var(--app-hint)]">
                                                        {mode.description}
                                                    </span>
                                                </div>
                                            </button>
                                        ))}
                                    </div>
                                ) : (
                                    MODEL_MODES.map((mode) => (
                                        <button
                                            key={mode}
                                            type="button"
                                            disabled={controlsDisabled}
                                            className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                                                controlsDisabled
                                                    ? 'cursor-not-allowed opacity-50'
                                                    : 'cursor-pointer hover:bg-[var(--app-secondary-bg)]'
                                            }`}
                                            onClick={() => handleModelChange({ model: mode })}
                                            onMouseDown={(e) => e.preventDefault()}
                                        >
                                            <div
                                                className={`flex h-4 w-4 items-center justify-center rounded-full border-2 ${
                                                    modelMode === mode
                                                        ? 'border-[var(--app-link)]'
                                                        : 'border-[var(--app-hint)]'
                                                }`}
                                            >
                                                {modelMode === mode && (
                                                    <div className="h-2 w-2 rounded-full bg-[var(--app-link)]" />
                                                )}
                                            </div>
                                            <span className={modelMode === mode ? 'text-[var(--app-link)]' : ''}>
                                                {MODEL_MODE_LABELS[mode]}
                                            </span>
                                        </button>
                                    ))
                                )}
                                {shouldShowCodexReasoning ? (
                                    <div className="mt-2 border-t border-[var(--app-divider)] pt-2">
                                        <div className="px-3 pb-1 text-xs font-semibold text-[var(--app-hint)]">
                                            Select Reasoning Level for {codexModel}
                                        </div>
                                        <div className="space-y-1">
                                            {CODEX_REASONING_LEVELS.map((level) => (
                                                <button
                                                    key={level.id}
                                                    type="button"
                                                    disabled={controlsDisabled}
                                                    className={`flex w-full items-start gap-2 px-3 py-2 text-left text-sm transition-colors ${
                                                        controlsDisabled
                                                            ? 'cursor-not-allowed opacity-50'
                                                            : 'cursor-pointer hover:bg-[var(--app-secondary-bg)]'
                                                    }`}
                                                    onClick={() => handleModelChange({ model: codexModel, reasoningEffort: level.id })}
                                                    onMouseDown={(e) => e.preventDefault()}
                                                >
                                                    <div
                                                        className={`mt-0.5 flex h-4 w-4 items-center justify-center rounded-full border-2 ${
                                                            codexReasoningEffort === level.id
                                                                ? 'border-[var(--app-link)]'
                                                                : 'border-[var(--app-hint)]'
                                                        }`}
                                                    >
                                                        {codexReasoningEffort === level.id && (
                                                            <div className="h-2 w-2 rounded-full bg-[var(--app-link)]" />
                                                        )}
                                                    </div>
                                                    <div className="flex flex-col gap-0.5">
                                                        <span className={codexReasoningEffort === level.id ? 'text-[var(--app-link)]' : ''}>
                                                            {level.label}
                                                        </span>
                                                        <span className="text-xs text-[var(--app-hint)]">
                                                            {level.description}
                                                        </span>
                                                        {level.warning ? (
                                                            <span className="text-xs text-amber-500">
                                                                ⚠ {level.warning}
                                                            </span>
                                                        ) : null}
                                                    </div>
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                ) : null}
                            </div>
                        ) : null}
                    </FloatingOverlay>
                </div>
            )
        }

        if (suggestions.length > 0) {
            return (
                <div className="absolute bottom-[100%] mb-2 w-full">
                    <FloatingOverlay>
                        <Autocomplete
                            suggestions={suggestions}
                            selectedIndex={selectedIndex}
                            onSelect={(index) => handleSuggestionSelect(index)}
                        />
                    </FloatingOverlay>
                </div>
            )
        }

        return null
    }, [
        showSettings,
        showPermissionSettings,
        showModelSettings,
        suggestions,
        selectedIndex,
        controlsDisabled,
        permissionMode,
        modelMode,
        isCodex,
        codexModel,
        codexReasoningEffort,
        shouldShowCodexReasoning,
        isGrok,
        grokModel,
        permissionModes,
        handlePermissionChange,
        handleModelChange,
        handleSuggestionSelect,
        apiClient,
        autoOptimize,
        handleAutoOptimizeToggle,
        isClaude,
        fastMode,
        handleFastModeToggle
    ])

    const volumePercent = Math.max(0, Math.min(100, Math.round((speechToText.volume ?? 0) * 100)))
    const volumeAngle = `${Math.round(volumePercent * 3.6)}deg`
    const meterStyle = {
        ['--stt-progress' as string]: volumeAngle,
        ['--stt-alpha' as string]: speechToText.status === 'recording' ? '1' : '0.15'
    } as ReactCSSProperties

    return (
        <div className={`px-3 ${bottomPaddingClass} pt-2 bg-[var(--app-bg)]`}>
            <div className="mx-auto w-full max-w-content">
                <ComposerPrimitive.Root className="relative">
                    {overlays}
                    {showResumeOverlay ? (
                        <button
                            type="button"
                            disabled={resumePending}
                            onClick={resumePending ? undefined : onRequestResume}
                            className="absolute inset-0 z-10 flex items-center justify-center gap-2 rounded-[20px] bg-[var(--app-bg)]/80 text-sm font-medium text-[var(--app-hint)] backdrop-blur-sm"
                        >
                            {resumeLabel}
                        </button>
                    ) : null}

                    <StatusBar
                        active={active}
                        thinking={thinking}
                        agentState={agentState}
                        contextSize={contextSize}
                        modelMode={modelMode}
                        permissionMode={permissionMode}
                        agentFlavor={agentFlavor}
                        otherUserTyping={otherUserTyping}
                    />

                    <div className="overflow-hidden rounded-[20px] bg-[var(--app-secondary-bg)]">
                        {/* Attachment Preview Area */}
                        {showAttachmentPreview ? (
                            <div className="px-3 pt-3 pb-2 space-y-2">
                                {uploadedImages.length > 0 || isUploadingImage ? (
                                    <div className="flex gap-2 overflow-x-auto pt-2 pr-2">
                                        {uploadedImages.map((img, index) => (
                                            <div key={img.path} className="relative flex-shrink-0 group">
                                                <img
                                                    src={img.previewUrl}
                                                    alt={`Upload ${index + 1}`}
                                                    className="h-16 w-16 rounded-lg object-cover border border-[var(--app-divider)]"
                                                />
                                                <button
                                                    type="button"
                                                    onClick={() => handleRemoveImage(index)}
                                                    className="absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-white text-xs shadow-md opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-600"
                                                    aria-label="Remove image"
                                                >
                                                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                                        <line x1="18" y1="6" x2="6" y2="18" />
                                                        <line x1="6" y1="6" x2="18" y2="18" />
                                                    </svg>
                                                </button>
                                            </div>
                                        ))}
                                        {uploadedImages.length < MAX_IMAGES && !isUploadingImage ? (
                                            <button
                                                type="button"
                                                onClick={handleImageClick}
                                                className="flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-lg border-2 border-dashed border-[var(--app-divider)] text-[var(--app-hint)] hover:border-[var(--app-link)] hover:text-[var(--app-link)] transition-colors"
                                                aria-label="Add more images"
                                            >
                                                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                    <line x1="12" y1="5" x2="12" y2="19" />
                                                    <line x1="5" y1="12" x2="19" y2="12" />
                                                </svg>
                                            </button>
                                        ) : null}
                                        {isUploadingImage ? (
                                            <div className="flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-lg border-2 border-dashed border-[var(--app-link)] text-[var(--app-link)]">
                                                <svg className="animate-spin" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none">
                                                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeOpacity="0.25" />
                                                    <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                                                </svg>
                                            </div>
                                        ) : null}
                                    </div>
                                ) : null}

                                {uploadedFiles.length > 0 || isUploadingFile ? (
                                    <div className="flex flex-wrap gap-2">
                                        {uploadedFiles.map((file, index) => (
                                            <div key={file.path} className="group flex items-center gap-2 rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)]/70 px-2 py-1 text-xs text-[var(--app-fg)]">
                                                <FileIcon fileName={file.name} size={16} />
                                                <span className="max-w-[160px] truncate">{file.name}</span>
                                                <button
                                                    type="button"
                                                    onClick={() => handleRemoveFile(index)}
                                                    className="flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-white text-[10px] opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-600"
                                                    aria-label="Remove file"
                                                >
                                                    <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                                        <line x1="18" y1="6" x2="6" y2="18" />
                                                        <line x1="6" y1="6" x2="18" y2="18" />
                                                    </svg>
                                                </button>
                                            </div>
                                        ))}
                                        {isUploadingFile ? (
                                            <div className="flex h-7 items-center justify-center rounded-lg border border-dashed border-[var(--app-link)] px-2 text-[var(--app-link)]">
                                                <svg className="animate-spin" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none">
                                                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeOpacity="0.25" />
                                                    <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                                                </svg>
                                            </div>
                                        ) : null}
                                    </div>
                                ) : null}
                            </div>
                        ) : null}

                        <div className="relative flex items-center px-4 py-3">
                            <ComposerPrimitive.Input
                                ref={textareaRef}
                                autoFocus={!controlsDisabled && !isTouch}
                                placeholder={showContinueHint ? "Type 'continue' to resume..." : "Type a message..."}
                                disabled={controlsDisabled || isOptimizing || speechToText.status === 'connecting' || speechToText.status === 'recording' || speechToText.status === 'stopping'}
                                maxRows={5}
                                submitOnEnter={!autoOptimize}
                                cancelOnEscape={false}
                                enterKeyHint="send"
                                onChange={handleChange}
                                onSelect={handleSelect}
                                onKeyDown={handleKeyDown}
                                onPaste={handlePaste}
                                onSubmit={handleSubmit}
                                className="flex-1 resize-none bg-transparent text-sm leading-snug text-[var(--app-fg)] placeholder-[var(--app-hint)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                            />
                        </div>

                        {voiceMode ? (
                            <div className="px-3 pb-3">
                                <button
                                    type="button"
                                    aria-label={speechToText.status === 'recording' ? 'Release to stop' : 'Hold to talk'}
                                    className={`relative w-full select-none touch-none overflow-hidden rounded-[16px] border px-4 py-4 text-center transition-all duration-150 ${
                                        speechToText.status === 'recording'
                                            ? 'border-red-400 bg-red-500/15 text-red-600 shadow-[0_0_24px_rgba(239,68,68,0.35)]'
                                            : 'border-[var(--app-divider)] bg-[var(--app-bg)]/70 text-[var(--app-hint)]'
                                    } ${speechToText.status === 'stopping' ? 'animate-pulse' : ''}`}
                                    style={{ WebkitTouchCallout: 'none' }}
                                    onTouchStart={handleTouchStart}
                                    onTouchEnd={handleTouchEnd}
                                    onTouchCancel={handleTouchEnd}
                                    onPointerDown={handleVoicePadPointerDown}
                                >
                                    <div
                                        className={`stt-meter ${speechToText.status === 'recording' ? 'stt-meter--active' : ''}`}
                                        style={meterStyle}
                                    />
                                    <div className="flex flex-col items-center gap-2">
                                        <span className={`inline-flex h-10 w-10 items-center justify-center rounded-full text-lg ${
                                            speechToText.status === 'recording'
                                                ? 'bg-red-500 text-white shadow-[0_0_18px_rgba(239,68,68,0.6)]'
                                                : 'bg-[var(--app-secondary-bg)] text-[var(--app-hint)]'
                                        }`}>
                                            🎙️
                                        </span>
                                        <span className="text-sm font-semibold">
                                            {speechToText.status === 'connecting' ? '连接中...' : speechToText.status === 'recording' ? '录音中，松开结束' : '按住说话'}
                                        </span>
                                    </div>
                                </button>
                            </div>
                        ) : null}

                        <ComposerButtons
                            canSend={canSend}
                            controlsDisabled={controlsDisabled}
                            showVoiceButton={speechToText.isSupported}
                            voiceDisabled={controlsDisabled}
                            voiceActive={speechToText.status === 'recording'}
                            voiceStopping={speechToText.status === 'stopping'}
                            voiceModeActive={voiceMode}
                            onVoiceToggle={handleVoiceToggle}
                            showImageButton={active}
                            imageDisabled={controlsDisabled}
                            isUploadingImage={isUploadingImage}
                            onImageClick={handleImageClick}
                            showFileButton={active}
                            fileDisabled={controlsDisabled}
                            isUploadingFile={isUploadingFile}
                            onFileClick={handleFileClick}
                            showSettingsButton={showSettingsButton}
                            onSettingsToggle={handleSettingsToggle}
                            showTerminalButton={showTerminalButton}
                            terminalDisabled={controlsDisabled}
                            onTerminal={onTerminal ?? (() => {})}
                            showAbortButton={showAbortButton}
                            abortDisabled={abortDisabled}
                            isAborting={isAborting}
                            onAbort={handleAbort}
                            showSwitchButton={showSwitchButton}
                            switchDisabled={switchDisabled}
                            isSwitching={isSwitching}
                            onSwitch={handleSwitch}
                            autoOptimizeEnabled={autoOptimize}
                            isOptimizing={isOptimizing}
                            onOptimizeSend={handleOptimizeForPreview}
                            hasAttachments={hasAttachments}
                            onSendWithAttachments={handleSendWithAttachments}
                        />
                        {/* Hidden image input */}
                        <input
                            ref={imageInputRef}
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={handleImageChange}
                        />
                        {/* Hidden file input */}
                        <input
                            ref={fileInputRef}
                            type="file"
                            className="hidden"
                            onChange={handleFileChange}
                        />
                    </div>
                </ComposerPrimitive.Root>
            </div>

            {/* Optimize Preview Dialog */}
            {optimizePreview ? createPortal(
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
                    <div className="w-full max-w-lg rounded-2xl bg-[var(--app-bg)] p-4 shadow-xl">
                        <div className="mb-4 text-lg font-semibold text-[var(--app-fg)]">
                            AI Optimization Result
                        </div>

                        <div className="mb-4 space-y-3">
                            <div>
                                <div className="mb-1 text-xs font-medium text-[var(--app-hint)]">Original</div>
                                <div className="rounded-lg bg-[var(--app-secondary-bg)] p-3 text-sm text-[var(--app-fg)]/70 line-through">
                                    {optimizePreview.original}
                                </div>
                            </div>
                            <div>
                                <div className="mb-1 text-xs font-medium text-purple-500">Optimized (editable)</div>
                                <textarea
                                    value={optimizePreview.optimized}
                                    onChange={(e) => setOptimizePreview(prev => prev ? { ...prev, optimized: e.target.value } : null)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                                            e.preventDefault()
                                            handlePreviewConfirm()
                                        }
                                    }}
                                    autoFocus
                                    rows={3}
                                    className="w-full resize-none rounded-lg bg-purple-50 p-3 text-sm text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-purple-500 dark:bg-purple-900/20"
                                />
                            </div>
                        </div>

                        <div className="flex gap-2">
                            <button
                                type="button"
                                onClick={handlePreviewCancel}
                                className="flex-1 rounded-lg border border-[var(--app-divider)] px-4 py-2 text-sm font-medium text-[var(--app-fg)] transition-colors hover:bg-[var(--app-secondary-bg)]"
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                onClick={handlePreviewSendOriginal}
                                className="flex-1 rounded-lg border border-[var(--app-divider)] px-4 py-2 text-sm font-medium text-[var(--app-fg)] transition-colors hover:bg-[var(--app-secondary-bg)]"
                            >
                                Send Original
                            </button>
                            <button
                                type="button"
                                onClick={handlePreviewConfirm}
                                className="flex-1 rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-purple-700"
                            >
                                Send
                            </button>
                        </div>
                    </div>
                </div>,
                document.body
            ) : null}
        </div>
    )
}
