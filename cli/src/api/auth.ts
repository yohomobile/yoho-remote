import { configuration } from '@/configuration'

export function getAuthToken(): string {
    if (!configuration.cliApiToken) {
        throw new Error('CLI_API_TOKEN is required')
    }
    return configuration.cliApiToken
}

export function getRequiredOrgId(): string {
    const orgId = configuration.orgId.trim()
    if (!orgId) {
        throw new Error('YOHO_ORG_ID is required')
    }
    return orgId
}
