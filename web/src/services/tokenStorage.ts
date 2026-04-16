/**
 * IndexedDB-based token storage for PWA support
 * Service Workers can access IndexedDB but not localStorage
 * Falls back to localStorage if IndexedDB is unavailable
 */

const DB_NAME = 'yr-auth'
const DB_VERSION = 1
const STORE_NAME = 'tokens'
const LOCAL_STORAGE_KEY = 'yr-auth-tokens'

// Check if IndexedDB is available
let indexedDBAvailable = true

// Fallback to localStorage when IndexedDB fails
function saveTokensToLocal(data: TokenData): void {
    try {
        localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(data))
    } catch (e) {
        console.error('[TokenStorage] Failed to save to localStorage:', e)
    }
}

function getTokensFromLocal(): TokenData | null {
    try {
        const data = localStorage.getItem(LOCAL_STORAGE_KEY)
        return data ? JSON.parse(data) : null
    } catch (e) {
        console.error('[TokenStorage] Failed to read from localStorage:', e)
        return null
    }
}

function clearTokensFromLocal(): void {
    try {
        localStorage.removeItem(LOCAL_STORAGE_KEY)
    } catch (e) {
        console.error('[TokenStorage] Failed to clear from localStorage:', e)
    }
}

interface TokenData {
    accessToken: string
    refreshToken: string
    user: {
        email: string
        name: string | null
        sub: string
    }
    expiresAt: number
}

let db: IDBDatabase | null = null

// Timeout for IndexedDB operations (1 second for faster fallback)
const INIT_TIMEOUT = 1000

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) =>
            setTimeout(() => reject(new Error(errorMessage)), timeoutMs)
        )
    ])
}

/**
 * Open IndexedDB database
 */
async function openDB(): Promise<IDBDatabase> {
    if (db) return db

    return withTimeout(
        new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION)

            request.onerror = () => {
                reject(new Error(`Failed to open IndexedDB: ${request.error}`))
            }

            request.onsuccess = () => {
                db = request.result
                resolve(db)
            }

            request.onupgradeneeded = (event) => {
                const database = (event.target as IDBOpenDBRequest).result
                if (!database.objectStoreNames.contains(STORE_NAME)) {
                    database.createObjectStore(STORE_NAME)
                }
            }
        }),
        INIT_TIMEOUT,
        'IndexedDB open timeout'
    )
}

/**
 * Get token data from IndexedDB (with localStorage fallback)
 */
async function getTokens(): Promise<TokenData | null> {
    if (!indexedDBAvailable) {
        return getTokensFromLocal()
    }

    try {
        const database = await openDB()
        const result = await withTimeout(
            new Promise<TokenData | null>((resolve, reject) => {
                const transaction = database.transaction([STORE_NAME], 'readonly')
                const store = transaction.objectStore(STORE_NAME)
                const request = store.get('auth')

                request.onsuccess = () => {
                    resolve(request.result as TokenData | null ?? null)
                }

                request.onerror = () => {
                    reject(new Error(`Failed to get tokens: ${request.error}`))
                }
            }),
            INIT_TIMEOUT,
            'IndexedDB get timeout'
        )
        return result
    } catch (error) {
        console.warn('[TokenStorage] IndexedDB unavailable, falling back to localStorage:', error)
        indexedDBAvailable = false
        return getTokensFromLocal()
    }
}

/**
 * Save token data to IndexedDB (with localStorage fallback)
 */
async function saveTokenData(data: TokenData): Promise<void> {
    if (!indexedDBAvailable) {
        saveTokensToLocal(data)
        return
    }

    try {
        const database = await openDB()
        await withTimeout(
            new Promise<void>((resolve, reject) => {
                const transaction = database.transaction([STORE_NAME], 'readwrite')
                const store = transaction.objectStore(STORE_NAME)
                const request = store.put(data, 'auth')

                request.onsuccess = () => {
                    resolve()
                }

                request.onerror = () => {
                    reject(new Error(`Failed to save tokens: ${request.error}`))
                }
            }),
            INIT_TIMEOUT,
            'IndexedDB save timeout'
        )
    } catch (error) {
        console.warn('[TokenStorage] IndexedDB unavailable, falling back to localStorage:', error)
        indexedDBAvailable = false
        saveTokensToLocal(data)
    }
}

/**
 * Clear all tokens from IndexedDB (with localStorage fallback)
 */
async function clearTokenData(): Promise<void> {
    if (!indexedDBAvailable) {
        clearTokensFromLocal()
        return
    }

    try {
        const database = await openDB()
        await withTimeout(
            new Promise<void>((resolve, reject) => {
                const transaction = database.transaction([STORE_NAME], 'readwrite')
                const store = transaction.objectStore(STORE_NAME)
                const request = store.delete('auth')

                request.onsuccess = () => {
                    resolve()
                }

                request.onerror = () => {
                    reject(new Error(`Failed to clear tokens: ${request.error}`))
                }
            }),
            INIT_TIMEOUT,
            'IndexedDB clear timeout'
        )
    } catch (error) {
        console.warn('[TokenStorage] IndexedDB unavailable, falling back to localStorage:', error)
        indexedDBAvailable = false
        clearTokensFromLocal()
    }
}

// Synchronous API for backward compatibility
// Falls back to async operations for IndexedDB
const syncCache = {
    accessToken: null as string | null,
    refreshToken: null as string | null,
    user: null as { email: string; name: string | null; sub: string } | null,
    expiresAt: null as number | null,
}

// Initialize sync cache from IndexedDB
let initPromise: Promise<void> | null = null
let isInitialized = false

function ensureInitialized(): Promise<void> {
    if (!initPromise) {
        initPromise = (async () => {
            try {
                // Add timeout to prevent hanging
                const data = await withTimeout(
                    getTokens(),
                    INIT_TIMEOUT,
                    'Token storage initialization timeout'
                )
                if (data) {
                    syncCache.accessToken = data.accessToken
                    syncCache.refreshToken = data.refreshToken
                    syncCache.user = data.user
                    syncCache.expiresAt = data.expiresAt
                }
            } catch (error) {
                console.error('[TokenStorage] Failed to initialize cache:', error)
                // If IndexedDB fails, continue with empty cache (user will need to login)
            } finally {
                isInitialized = true
            }
        })()
    }
    return initPromise
}

// Export for checking if initialization is complete
export function isStorageInitialized(): boolean {
    return isInitialized
}

/**
 * Get access token (sync with async initialization)
 */
export async function getAccessToken(): Promise<string | null> {
    await ensureInitialized()
    return syncCache.accessToken
}

/**
 * Get refresh token (sync with async initialization)
 */
export async function getRefreshToken(): Promise<string | null> {
    await ensureInitialized()
    return syncCache.refreshToken
}

/**
 * Get current user (sync with async initialization)
 */
export async function getCurrentUser(): Promise<{ email: string; name: string | null; sub: string } | null> {
    await ensureInitialized()
    return syncCache.user
}

/**
 * Get expiration time (sync with async initialization)
 */
export async function getExpiresAt(): Promise<number | null> {
    await ensureInitialized()
    return syncCache.expiresAt
}

/**
 * Check if token is expired
 */
export async function isTokenExpired(): Promise<boolean> {
    const expiresAt = await getExpiresAt()
    if (!expiresAt) return true
    return Date.now() >= expiresAt
}

/**
 * Check if user is authenticated
 */
export async function isAuthenticated(): Promise<boolean> {
    const token = await getAccessToken()
    if (!token) return false
    return !(await isTokenExpired())
}

/**
 * Save tokens to both IndexedDB and sync cache
 */
export async function saveTokens(data: {
    accessToken: string
    refreshToken: string
    expiresIn: number
    user: { email: string; name: string | null; sub: string }
}): Promise<void> {
    // Calculate expiration time (subtract 60 seconds for buffer)
    const expiresAt = Date.now() + (data.expiresIn - 60) * 1000

    const normalizedUser = {
        ...data.user,
        email: data.user.email.trim().toLowerCase(),
    }

    const tokenData: TokenData = {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        user: normalizedUser,
        expiresAt,
    }

    await saveTokenData(tokenData)

    // Sync to Flutter native secure storage
    if ((window as any).__YOHO_FLUTTER__ && (window as any).flutter_inappwebview) {
        (window as any).flutter_inappwebview.callHandler('saveTokens', tokenData).catch(() => {})
    }

    // Update sync cache
    syncCache.accessToken = data.accessToken
    syncCache.refreshToken = data.refreshToken
    syncCache.user = normalizedUser
    syncCache.expiresAt = expiresAt
}

/**
 * Clear all tokens from both IndexedDB and sync cache
 */
export async function clearTokens(): Promise<void> {
    await clearTokenData()

    // Clear from Flutter native secure storage
    if ((window as any).__YOHO_FLUTTER__ && (window as any).flutter_inappwebview) {
        (window as any).flutter_inappwebview.callHandler('clearTokens').catch(() => {})
    }

    // Clear sync cache
    syncCache.accessToken = null
    syncCache.refreshToken = null
    syncCache.user = null
    syncCache.expiresAt = null
}

/**
 * Sync versions for backward compatibility
 * These are used in React hooks that need synchronous access
 */

// Synchronous get from cache (may return null until async load completes)
export function getAccessTokenSync(): string | null {
    return syncCache.accessToken
}

export function getRefreshTokenSync(): string | null {
    return syncCache.refreshToken
}

export function getCurrentUserSync(): { email: string; name: string | null; sub: string } | null {
    return syncCache.user
}

export function getExpiresAtSync(): number | null {
    return syncCache.expiresAt
}

export function isTokenExpiredSync(): boolean {
    if (!syncCache.expiresAt) return true
    return Date.now() >= syncCache.expiresAt
}

export function isAuthenticatedSync(): boolean {
    const token = getAccessTokenSync()
    if (!token) return false
    return !isTokenExpiredSync()
}
