// 生成随机客户端ID（大小写字母混合）
function generateClientId(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
    let result = ''
    for (let i = 0; i < 8; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length))
    }
    return result
}

// 获取或创建客户端ID
export function getClientId(): string {
    const key = 'yr_client_id'
    let clientId = localStorage.getItem(key)
    if (!clientId) {
        clientId = generateClientId()
        localStorage.setItem(key, clientId)
    }
    return clientId
}

// 检测设备类型
export function getDeviceType(): string {
    const ua = navigator.userAgent

    // 移动设备检测
    const isMobile = /Mobile|Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua)
    const isTablet = /iPad|Android(?!.*Mobile)/i.test(ua)

    // 浏览器检测
    let browser = 'Unknown'
    if (/Edg\//i.test(ua)) {
        browser = 'Edge'
    } else if (/Chrome/i.test(ua) && !/Chromium/i.test(ua)) {
        browser = 'Chrome'
    } else if (/Safari/i.test(ua) && !/Chrome/i.test(ua)) {
        browser = 'Safari'
    } else if (/Firefox/i.test(ua)) {
        browser = 'Firefox'
    } else if (/Opera|OPR/i.test(ua)) {
        browser = 'Opera'
    }

    // 组合设备类型
    if (isTablet) {
        return `${browser} Tablet`
    }
    if (isMobile) {
        return `${browser} Mobile`
    }
    return browser
}

// 获取存储的邮箱
export function getStoredEmail(): string | null {
    return localStorage.getItem('yr_email')
}
