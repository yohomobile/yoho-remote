/**
 * MemoryInjector - 将 AI Profile 的相关记忆注入到会话 prompt 中
 *
 * 在会话启动时：
 * 1. 从 store 获取 Profile 的记忆
 * 2. 按重要性和最近访问时间排序
 * 3. 格式化为可读的 prompt 片段
 * 4. 更新记忆的 accessCount 和 lastAccessedAt
 */

import type { IStore, StoredAIProfileMemory, AIProfileMemoryType } from '../store/interface'

/**
 * 记忆注入配置
 */
export interface MemoryInjectorConfig {
    maxMemories: number           // 最多注入的记忆数量
    minImportance: number         // 最低重要性阈值
    maxPromptLength: number       // 生成的 prompt 片段最大长度
    minRelevance: number          // metadata 中 relevance/confidence 的最低阈值
    maxMemoryAgeDays: number      // 低重要性记忆的最大年龄
}

const DEFAULT_CONFIG: MemoryInjectorConfig = {
    maxMemories: 20,
    minImportance: 0.3,
    maxPromptLength: 3000,
    minRelevance: 0.35,
    maxMemoryAgeDays: 365
}

/**
 * 记忆类型的中文显示名称和图标
 */
const MEMORY_TYPE_LABELS: Record<AIProfileMemoryType, { label: string; icon: string }> = {
    context: { label: '项目上下文', icon: '📁' },
    preference: { label: '用户偏好', icon: '⚙️' },
    knowledge: { label: '技术知识', icon: '📚' },
    experience: { label: '经验教训', icon: '💡' }
}

/**
 * 格式化后的记忆信息（用于返回给调用者）
 */
export interface InjectedMemory {
    id: string
    type: AIProfileMemoryType
    content: string
    importance: number
}

/**
 * 记忆注入结果
 */
export interface MemoryInjectionResult {
    promptFragment: string      // 格式化的 prompt 片段
    memories: InjectedMemory[]  // 注入的记忆列表
    totalCount: number          // 实际注入的记忆数量
}

/**
 * 记忆注入器类
 */
export class MemoryInjector {
    private store: IStore
    private config: MemoryInjectorConfig

    constructor(store: IStore, config?: Partial<MemoryInjectorConfig>) {
        this.store = store
        this.config = { ...DEFAULT_CONFIG, ...config }
    }

    /**
     * 获取并格式化 Profile 的记忆，生成 prompt 片段
     * @param namespace 命名空间
     * @param profileId AI Profile ID
     * @returns 注入结果，包含格式化的 prompt 和记忆列表
     */
    async injectMemories(namespace: string, profileId: string): Promise<MemoryInjectionResult> {
        // 1. 从 store 获取候选记忆（已按重要性和访问时间排序），再做运行时过滤。
        const candidateLimit = Math.max(this.config.maxMemories, this.config.maxMemories * 3)
        const candidates = await this.store.getProfileMemories({
            namespace,
            profileId,
            minImportance: this.config.minImportance,
            limit: candidateLimit
        })
        const memories = this.filterMemoriesForInjection(candidates).slice(0, this.config.maxMemories)

        if (memories.length === 0) {
            return {
                promptFragment: '',
                memories: [],
                totalCount: 0
            }
        }

        // 2. 更新访问记录
        await this.updateAccessRecords(namespace, memories)

        // 3. 格式化为 prompt 片段
        const promptFragment = this.formatMemoriesAsPrompt(memories)

        // 4. 返回结果
        return {
            promptFragment,
            memories: memories.map(m => ({
                id: m.id,
                type: m.memoryType,
                content: m.content,
                importance: m.importance
            })),
            totalCount: memories.length
        }
    }

    private filterMemoriesForInjection(memories: StoredAIProfileMemory[]): StoredAIProfileMemory[] {
        const now = Date.now()
        const maxAgeMs = this.config.maxMemoryAgeDays * 24 * 60 * 60 * 1000

        return memories.filter((memory) => {
            if (memory.expiresAt !== null && memory.expiresAt <= now) {
                return false
            }

            const metadata = isRecord(memory.metadata) ? memory.metadata : null
            if (metadata) {
                if (metadata.conflict === true || metadata.valid === false) {
                    return false
                }

                const conflictStatus = readString(metadata.conflictStatus) ?? readString(metadata.conflict_status)
                if (conflictStatus && conflictStatus !== 'resolved' && conflictStatus !== 'none') {
                    return false
                }

                if (readString(metadata.supersededBy) || readString(metadata.superseded_by)) {
                    return false
                }

                const relevance = readNumber(metadata.relevance)
                    ?? readNumber(metadata.relevanceScore)
                    ?? readNumber(metadata.relevance_score)
                    ?? readNumber(metadata.confidence)
                if (relevance !== null && relevance < this.config.minRelevance) {
                    return false
                }
            }

            const ageMs = now - memory.updatedAt
            if (
                ageMs > maxAgeMs
                && memory.importance < 0.8
                && memory.memoryType !== 'preference'
            ) {
                return false
            }

            return true
        })
    }

    /**
     * 更新记忆的访问记录
     */
    private async updateAccessRecords(namespace: string, memories: StoredAIProfileMemory[]): Promise<void> {
        for (const memory of memories) {
            try {
                await this.store.updateMemoryAccess(namespace, memory.id)
            } catch (error) {
                console.warn(`[MemoryInjector] Failed to update access record for memory ${memory.id}:`, error)
            }
        }
    }

    /**
     * 将记忆列表格式化为可读的 prompt 片段
     */
    private formatMemoriesAsPrompt(memories: StoredAIProfileMemory[]): string {
        // 按类型分组
        const grouped = this.groupMemoriesByType(memories)

        const sections: string[] = []

        // 按类型顺序输出：context -> preference -> knowledge -> experience
        const typeOrder: AIProfileMemoryType[] = ['context', 'preference', 'knowledge', 'experience']

        for (const type of typeOrder) {
            const typeMemories = grouped.get(type)
            if (typeMemories && typeMemories.length > 0) {
                const typeInfo = MEMORY_TYPE_LABELS[type]
                const section = this.formatMemorySection(typeInfo, typeMemories)
                sections.push(section)
            }
        }

        if (sections.length === 0) {
            return ''
        }

        // 构建完整的记忆部分
        let prompt = `## 历史记忆\n\n以下是从之前会话中积累的相关记忆，可以帮助你更好地理解上下文：\n\n`
        prompt += sections.join('\n\n')

        // 如果超过最大长度，进行截断
        if (prompt.length > this.config.maxPromptLength) {
            prompt = this.truncatePrompt(prompt, this.config.maxPromptLength)
        }

        return prompt + '\n'
    }

    /**
     * 按类型分组记忆
     */
    private groupMemoriesByType(memories: StoredAIProfileMemory[]): Map<AIProfileMemoryType, StoredAIProfileMemory[]> {
        const grouped = new Map<AIProfileMemoryType, StoredAIProfileMemory[]>()

        for (const memory of memories) {
            const existing = grouped.get(memory.memoryType) || []
            existing.push(memory)
            grouped.set(memory.memoryType, existing)
        }

        return grouped
    }

    /**
     * 格式化单个类型的记忆部分
     */
    private formatMemorySection(
        typeInfo: { label: string; icon: string },
        memories: StoredAIProfileMemory[]
    ): string {
        const lines: string[] = []
        lines.push(`### ${typeInfo.icon} ${typeInfo.label}`)

        for (const memory of memories) {
            const importanceTag = this.getImportanceTag(memory.importance)
            const content = this.cleanContent(memory.content)
            lines.push(`- ${content}${importanceTag}`)
        }

        return lines.join('\n')
    }

    /**
     * 根据重要性生成标签
     */
    private getImportanceTag(importance: number): string {
        if (importance >= 0.8) {
            return ' ⭐'
        }
        return ''
    }

    /**
     * 清理记忆内容，确保适合在 prompt 中显示
     */
    private cleanContent(content: string): string {
        return content
            .trim()
            .replace(/\n/g, ' ')  // 移除换行
            .replace(/\s+/g, ' ') // 合并多个空格
            .slice(0, 200)        // 限制单条记忆长度
    }

    /**
     * 截断 prompt 以不超过最大长度
     */
    private truncatePrompt(prompt: string, maxLength: number): string {
        if (prompt.length <= maxLength) {
            return prompt
        }

        // 在合适的位置截断（尝试在行尾截断）
        const truncated = prompt.slice(0, maxLength - 50)
        const lastNewline = truncated.lastIndexOf('\n')

        if (lastNewline > maxLength * 0.7) {
            return truncated.slice(0, lastNewline) + '\n\n...(更多记忆已省略)'
        }

        return truncated + '...(更多记忆已省略)'
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object'
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function readNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * 创建记忆注入器实例
 */
export function createMemoryInjector(
    store: IStore,
    config?: Partial<MemoryInjectorConfig>
): MemoryInjector {
    return new MemoryInjector(store, config)
}

/**
 * 便捷函数：直接获取格式化的记忆 prompt 片段
 * 适用于简单场景，无需创建 MemoryInjector 实例
 */
export async function getMemoryPromptFragment(
    store: IStore,
    namespace: string,
    profileId: string,
    config?: Partial<MemoryInjectorConfig>
): Promise<string> {
    const injector = new MemoryInjector(store, config)
    const result = await injector.injectMemories(namespace, profileId)
    return result.promptFragment
}

// ==================== 向后兼容的导出 ====================

/**
 * 获取用于注入的记忆列表（向后兼容）
 * @deprecated 请使用 MemoryInjector 类的 injectMemories 方法
 */
export async function getMemoriesForInjection(
    store: IStore,
    namespace: string,
    profileId: string,
    limit: number = 10
): Promise<{ type: string; content: string; importance: number }[]> {
    const injector = new MemoryInjector(store, { maxMemories: limit })
    const result = await injector.injectMemories(namespace, profileId)

    return result.memories.map(m => ({
        type: m.type,
        content: m.content,
        importance: m.importance
    }))
}

/**
 * 将记忆列表格式化为 prompt 片段（向后兼容）
 * @deprecated 请使用 MemoryInjector 类的 injectMemories 方法
 */
export function formatMemoriesForPrompt(memories: { type: string; content: string; importance: number }[]): string {
    if (memories.length === 0) return ''

    const lines = memories.map(m => `- [${m.type}] ${m.content}`)
    return `\n## 历史记忆\n${lines.join('\n')}\n`
}
