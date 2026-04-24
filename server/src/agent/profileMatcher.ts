/**
 * Profile Matcher - 智能任务推荐
 * 根据任务描述自动推荐最合适的 AI Profile
 */

import type { IStore } from '../store/interface'
import type { StoredAIProfile, AIProfileRole } from '../store/types'

/**
 * 匹配结果
 */
export interface ProfileMatchResult {
    profileId: string
    profileName: string
    score: number
    matchDetails: {
        specialtyScore: number
        roleScore: number
        projectScore: number
        statusScore: number
    }
}

/**
 * 角色关键词映射
 */
const ROLE_KEYWORDS: Record<AIProfileRole, string[]> = {
    developer: ['开发', '实现', '编写', '代码', 'implement', 'develop', 'code', 'feature', '功能', '新增', 'add'],
    architect: ['架构', '设计', '重构', 'architecture', 'design', 'refactor', '结构', 'structure', '模块'],
    reviewer: ['审查', '检查', '评审', 'review', 'check', '代码审查', 'code review', 'pr'],
    pm: ['产品', '需求', '规划', 'product', 'requirement', 'plan', '计划', '管理', 'manage'],
    tester: ['测试', '用例', 'test', 'case', 'unit test', '单元测试', '集成测试', 'integration', 'qa', '质量'],
    devops: ['部署', '运维', 'deploy', 'devops', 'ci', 'cd', 'pipeline', '容器', 'docker', 'k8s', 'kubernetes', '监控', 'monitor'],
    INTP: ['架构', '设计', '探索', '拆解', '前提', 'architecture', 'design', 'explore', '非常规', '排障'],
    INTJ: ['战略', '规划', '长期', 'strategy', 'plan', '目标', '决策', 'roadmap'],
    ENTP: ['头脑风暴', '挑战', '假设', 'brainstorm', 'review', '多角度', '发散', '评审'],
    ISTJ: ['部署', '合规', '流程', 'deploy', 'compliance', '规范', '运维', '低惊喜'],
    ISTP: ['排障', '修复', '线上', '快速', 'debug', 'fix', 'troubleshoot', '动手'],
    ENFP: ['产品', '讨论', '探索', 'product', '启发', '用户', '体验', 'discussion'],
    INFJ: ['沟通', '冲突', '协调', 'communication', '同理心', '深度', '洞察', '调解']
}

/**
 * 从任务描述中提取关键词
 */
function extractKeywords(taskDescription: string): string[] {
    // 转小写并分词
    const text = taskDescription.toLowerCase()

    // 中文分词（简单按常见边界分割）
    const segments = text.split(/[\s,，。！？;；:：\-_\/\\()（）\[\]【】{}""'']+/)

    // 过滤空串和过短的词
    return segments.filter(s => s.length >= 2)
}

/**
 * 计算 specialty 匹配分数
 */
function calculateSpecialtyScore(keywords: string[], specialties: string[]): number {
    let score = 0

    for (const specialty of specialties) {
        const specialtyLower = specialty.toLowerCase()

        for (const keyword of keywords) {
            // 完全匹配
            if (specialtyLower === keyword) {
                score += 10
            }
            // 部分匹配（包含关键词）
            else if (specialtyLower.includes(keyword) || keyword.includes(specialtyLower)) {
                score += 5
            }
        }
    }

    return score
}

/**
 * 计算 role 匹配分数
 */
function calculateRoleScore(keywords: string[], role: AIProfileRole): number {
    const roleKeywords = ROLE_KEYWORDS[role] || []

    for (const keyword of keywords) {
        for (const rk of roleKeywords) {
            if (rk.includes(keyword) || keyword.includes(rk)) {
                return 8
            }
        }
    }

    return 0
}

/**
 * 计算 preferredProject 匹配分数
 */
function calculateProjectScore(taskDescription: string, preferredProjects: string[]): number {
    const text = taskDescription.toLowerCase()

    for (const project of preferredProjects) {
        const projectLower = project.toLowerCase()
        if (text.includes(projectLower)) {
            return 6
        }
    }

    return 0
}

/**
 * 计算状态分数
 */
function calculateStatusScore(status: string): number {
    // idle 状态优先分配
    return status === 'idle' ? 3 : 0
}

/**
 * 查找最佳匹配的 Profile
 *
 * @param store - Store 实例
 * @param namespace - 命名空间
 * @param taskDescription - 任务描述
 * @returns 最佳匹配的 profileId，如果没有匹配则返回 null
 */
export async function findBestProfileForTask(
    store: IStore,
    namespace: string,
    taskDescription: string
): Promise<string | null> {
    // 获取所有 AI Profiles
    const profiles = await store.getAIProfiles(namespace)

    if (profiles.length === 0) {
        return null
    }

    // 提取关键词
    const keywords = extractKeywords(taskDescription)

    if (keywords.length === 0) {
        // 没有关键词时，优先返回 idle 状态的 profile
        const idleProfile = profiles.find(p => p.status === 'idle')
        return idleProfile?.id ?? profiles[0].id
    }

    // 计算每个 profile 的匹配分数
    const results: ProfileMatchResult[] = profiles.map(profile => {
        const specialtyScore = calculateSpecialtyScore(keywords, profile.specialties)
        const roleScore = calculateRoleScore(keywords, profile.role)
        const projectScore = calculateProjectScore(taskDescription, profile.preferredProjects)
        const statusScore = calculateStatusScore(profile.status)

        const totalScore = specialtyScore + roleScore + projectScore + statusScore

        return {
            profileId: profile.id,
            profileName: profile.name,
            score: totalScore,
            matchDetails: {
                specialtyScore,
                roleScore,
                projectScore,
                statusScore
            }
        }
    })

    // 按分数排序（降序）
    results.sort((a, b) => b.score - a.score)

    // 返回最高分的 profile
    const best = results[0]

    // 如果最高分为 0，说明没有任何匹配
    // 但仍返回第一个（优先 idle 状态的）
    if (best.score === 0) {
        const idleProfile = profiles.find(p => p.status === 'idle')
        return idleProfile?.id ?? profiles[0].id
    }

    console.log(`[ProfileMatcher] Best match for task: ${best.profileName} (score: ${best.score})`)
    console.log(`[ProfileMatcher] Match details:`, best.matchDetails)

    return best.profileId
}

/**
 * 获取所有匹配结果（用于调试或 UI 展示）
 */
export async function getAllProfileMatches(
    store: IStore,
    namespace: string,
    taskDescription: string
): Promise<ProfileMatchResult[]> {
    const profiles = await store.getAIProfiles(namespace)

    if (profiles.length === 0) {
        return []
    }

    const keywords = extractKeywords(taskDescription)

    const results: ProfileMatchResult[] = profiles.map(profile => {
        const specialtyScore = calculateSpecialtyScore(keywords, profile.specialties)
        const roleScore = calculateRoleScore(keywords, profile.role)
        const projectScore = calculateProjectScore(taskDescription, profile.preferredProjects)
        const statusScore = calculateStatusScore(profile.status)

        return {
            profileId: profile.id,
            profileName: profile.name,
            score: specialtyScore + roleScore + projectScore + statusScore,
            matchDetails: {
                specialtyScore,
                roleScore,
                projectScore,
                statusScore
            }
        }
    })

    // 按分数排序（降序）
    results.sort((a, b) => b.score - a.score)

    return results
}
