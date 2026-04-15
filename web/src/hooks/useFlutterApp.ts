declare global {
  interface Window {
    __YOHO_FLUTTER__?: boolean
    __YOHO_APP_VERSION__?: string
    YohoApp?: {
      on(event: string, cb: (data?: unknown) => void): void
      off(event: string): void
      _dispatch(event: string, data?: unknown): void
      onPushNotificationTapped(data: unknown): void
      onTokensRestored(tokens: unknown): void
      onAppResumed(): void
    }
    flutter_inappwebview?: {
      callHandler(name: string, ...args: unknown[]): Promise<unknown>
    }
  }
}

export function isFlutterApp(): boolean {
  return Boolean(window.__YOHO_FLUTTER__)
}

export function getFlutterAppVersion(): string | undefined {
  return window.__YOHO_APP_VERSION__
}

export async function callNativeHandler<T = unknown>(
  name: string,
  ...args: unknown[]
): Promise<T | null> {
  if (!isFlutterApp() || !window.flutter_inappwebview) return null
  try {
    return (await window.flutter_inappwebview.callHandler(name, ...args)) as T
  } catch {
    return null
  }
}
