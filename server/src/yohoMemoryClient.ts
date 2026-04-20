/**
 * Builds HTTP headers for yoho-memory API calls.
 * yoho-memory requires Bearer auth on all /api/* routes (requireHttpAuth middleware).
 * Token must be set in YOHO_MEMORY_HTTP_AUTH_TOKEN env var — same token on both sides.
 * Throws if the token is not configured so callers can log clearly instead of getting a 401.
 */
export function buildYohoMemoryHeaders(): Record<string, string> {
    const token = process.env.YOHO_MEMORY_HTTP_AUTH_TOKEN?.trim()
    if (!token) {
        throw new Error('YOHO_MEMORY_HTTP_AUTH_TOKEN is not configured — set this env var to enable yoho-memory HTTP integration')
    }
    return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
    }
}
