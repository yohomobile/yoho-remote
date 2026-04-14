const POST_LOGIN_REDIRECT_KEY = 'yr-post-login-redirect'

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function normalizeRedirectPath(path: string | null | undefined): string | null {
    if (!path || !path.startsWith('/')) {
        return null
    }
    if (path.startsWith('//')) {
        return null
    }
    return path
}

function getStorage(storage?: StorageLike): StorageLike | null {
    if (storage) {
        return storage
    }
    if (typeof window === 'undefined') {
        return null
    }
    return window.sessionStorage
}

export function setPostLoginRedirect(path: string, storage?: StorageLike): void {
    const target = normalizeRedirectPath(path)
    const targetStorage = getStorage(storage)
    if (!target || !targetStorage) {
        return
    }
    targetStorage.setItem(POST_LOGIN_REDIRECT_KEY, target)
}

export function peekPostLoginRedirect(storage?: StorageLike): string | null {
    const targetStorage = getStorage(storage)
    if (!targetStorage) {
        return null
    }
    return normalizeRedirectPath(targetStorage.getItem(POST_LOGIN_REDIRECT_KEY))
}

export function consumePostLoginRedirect(storage?: StorageLike): string | null {
    const targetStorage = getStorage(storage)
    if (!targetStorage) {
        return null
    }
    const target = normalizeRedirectPath(targetStorage.getItem(POST_LOGIN_REDIRECT_KEY))
    targetStorage.removeItem(POST_LOGIN_REDIRECT_KEY)
    return target
}
