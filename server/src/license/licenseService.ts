/**
 * License 校验服务
 *
 * 所有 license 相关的校验逻辑集中在这里。
 * Server 端是唯一的授权中心，Daemon 无法绕过。
 */

import type { IStore, StoredOrgLicense } from '../store'

const LICENSE_CACHE_TTL = 10 * 60 * 1000 // 10 分钟

export type LicenseErrorCode =
    | 'NO_LICENSE'
    | 'LICENSE_EXPIRED'
    | 'LICENSE_SUSPENDED'
    | 'LICENSE_NOT_STARTED'
    | 'MEMBER_LIMIT'
    | 'SESSION_LIMIT'

export type LicenseValidation =
    | { valid: true; warning?: string }
    | { valid: false; code: LicenseErrorCode; message: string }

type CachedLicense = {
    license: StoredOrgLicense | null
    fetchedAt: number
}

export class LicenseService {
    private cache = new Map<string, CachedLicense>()

    constructor(
        private store: IStore,
        private _adminOrgId: string | null
    ) {}

    get adminOrgId(): string | null {
        return this._adminOrgId
    }

    /**
     * 判断是否是管理员 org（免 license 检查）
     */
    isAdminOrg(orgId: string): boolean {
        return this._adminOrgId !== null && orgId === this._adminOrgId
    }

    /**
     * 获取 org 的 license（带内存缓存，TTL 10 分钟）
     */
    private async getCachedLicense(orgId: string): Promise<StoredOrgLicense | null> {
        const now = Date.now()
        const cached = this.cache.get(orgId)
        if (cached && now - cached.fetchedAt < LICENSE_CACHE_TTL) {
            return cached.license
        }
        const license = await this.store.getOrgLicense(orgId)
        this.cache.set(orgId, { license, fetchedAt: now })
        return license
    }

    /**
     * 手动清除某个 org 的缓存（license 变更时调用）
     */
    invalidateCache(orgId: string): void {
        this.cache.delete(orgId)
    }

    /**
     * 校验 org 的 license 是否有效（时间维度）
     * - 无 org_id → 允许（个人会话）
     * - admin org → 允许
     * - 无 license → 阻断
     * - 过期/暂停 → 阻断
     * - 7 天内到期 → 放行但附带 warning
     */
    async validateLicense(orgId: string | null): Promise<LicenseValidation> {
        if (!orgId) return { valid: true }
        if (this.isAdminOrg(orgId)) return { valid: true }

        const license = await this.getCachedLicense(orgId)
        if (!license) {
            return { valid: false, code: 'NO_LICENSE', message: 'No valid license found for this organization' }
        }

        if (license.status === 'suspended') {
            return { valid: false, code: 'LICENSE_SUSPENDED', message: 'Organization license has been suspended' }
        }

        const now = Date.now()

        if (now < license.startsAt) {
            return { valid: false, code: 'LICENSE_NOT_STARTED', message: 'Organization license is not yet active' }
        }

        if (now > license.expiresAt || license.status === 'expired') {
            // 自动标记过期
            if (license.status === 'active') {
                this.store.updateOrgLicenseStatus(orgId, 'expired').catch(err => {
                    console.error(`[LicenseService] Failed to auto-expire license for org ${orgId}:`, err)
                })
                this.invalidateCache(orgId)
            }
            return { valid: false, code: 'LICENSE_EXPIRED', message: 'Organization license has expired' }
        }

        // 到期预警（7 天内）
        const daysLeft = (license.expiresAt - now) / (1000 * 60 * 60 * 24)
        if (daysLeft <= 7) {
            return { valid: true, warning: `License expires in ${Math.ceil(daysLeft)} day(s)` }
        }

        return { valid: true }
    }

    /**
     * 校验是否可以新增成员（人数维度）
     * 检查 license 有效性 + 成员数上限
     */
    async canAddMember(orgId: string): Promise<LicenseValidation> {
        if (this.isAdminOrg(orgId)) return { valid: true }

        const license = await this.getCachedLicense(orgId)
        if (!license) {
            return { valid: false, code: 'NO_LICENSE', message: 'No valid license found for this organization' }
        }

        // 先校验时间
        const timeCheck = await this.validateLicense(orgId)
        if (!timeCheck.valid) return timeCheck

        const members = await this.store.getOrgMembers(orgId)
        if (members.length >= license.maxMembers) {
            return {
                valid: false,
                code: 'MEMBER_LIMIT',
                message: `Organization has reached member limit (${license.maxMembers}). Upgrade your license to add more members.`,
            }
        }

        return { valid: true }
    }

    /**
     * 校验是否可以创建新会话（并发维度）
     */
    async canCreateSession(orgId: string | null): Promise<LicenseValidation> {
        if (!orgId) return { valid: true }
        if (this.isAdminOrg(orgId)) return { valid: true }

        const license = await this.getCachedLicense(orgId)
        if (!license) {
            return { valid: false, code: 'NO_LICENSE', message: 'No valid license found for this organization' }
        }

        // 先校验时间
        const timeCheck = await this.validateLicense(orgId)
        if (!timeCheck.valid) return timeCheck

        if (license.maxConcurrentSessions === null) return { valid: true }

        const count = await this.store.getActiveSessionCount(orgId)
        if (count >= license.maxConcurrentSessions) {
            return {
                valid: false,
                code: 'SESSION_LIMIT',
                message: `Organization has reached concurrent session limit (${license.maxConcurrentSessions}). Wait for existing sessions to end or upgrade your license.`,
            }
        }

        return { valid: true }
    }
}

// Singleton
let _licenseService: LicenseService | null = null

export function createLicenseService(store: IStore, adminOrgId: string | null): LicenseService {
    _licenseService = new LicenseService(store, adminOrgId)
    return _licenseService
}

export function getLicenseService(): LicenseService {
    if (!_licenseService) {
        throw new Error('LicenseService not initialized. Call createLicenseService() first.')
    }
    return _licenseService
}
