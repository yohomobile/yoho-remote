import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { resolve, join } from 'node:path'
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const base = process.env.VITE_BASE_URL || '/'

// Get build version (timestamp in Asia/Shanghai timezone)
function getBuildVersion() {
    try {
        const now = new Date()
        // Format: v2026.01.02.1344 (Asia/Shanghai timezone)
        const formatter = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Shanghai',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        })
        const parts = formatter.formatToParts(now)
        const get = (type: string) => parts.find(p => p.type === type)?.value || ''
        const version = `v${get('year')}.${get('month')}.${get('day')}.${get('hour')}${get('minute')}`

        // Use cwd option to ensure git command works from any directory
        const commitMessage = execSync('git log -1 --format=%s', {
            encoding: 'utf-8',
            cwd: resolve(__dirname, '..')
        }).trim()
        return { version, commitMessage }
    } catch (e) {
        console.warn('[getBuildVersion] Failed to get version:', e)
        // Fallback: still use the timestamp version even if git fails
        const now = new Date()
        const formatter = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Shanghai',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        })
        const parts = formatter.formatToParts(now)
        const get = (type: string) => parts.find(p => p.type === type)?.value || ''
        const version = `v${get('year')}.${get('month')}.${get('day')}.${get('hour')}${get('minute')}`
        return { version, commitMessage: 'unknown' }
    }
}

const buildInfo = getBuildVersion()

// Plugin to inject build version into sw-push.js
// We inject into public/sw-push.js BEFORE build so Workbox calculates correct hash
function swVersionPlugin(): Plugin {
    const publicSwPushPath = join(__dirname, 'public', 'sw-push.js')
    let originalContent: string | null = null

    return {
        name: 'sw-version-inject',
        apply: 'build',
        buildStart() {
            try {
                // Save original content
                originalContent = readFileSync(publicSwPushPath, 'utf-8')
                // Inject version before build so Workbox sees the updated file
                const injected = originalContent.replace("'__SW_BUILD_VERSION__'", `'${buildInfo.version}'`)
                writeFileSync(publicSwPushPath, injected)
                console.log(`[sw-version-inject] Injected version ${buildInfo.version} into public/sw-push.js`)
            } catch (error) {
                console.warn('[sw-version-inject] Failed to inject version:', error)
            }
        },
        closeBundle() {
            // Restore original content after build
            if (originalContent) {
                try {
                    writeFileSync(publicSwPushPath, originalContent)
                    console.log('[sw-version-inject] Restored public/sw-push.js')
                } catch (error) {
                    console.warn('[sw-version-inject] Failed to restore sw-push.js:', error)
                }
            }
        }
    }
}

export default defineConfig({
    define: {
        __GIT_COMMIT_HASH__: JSON.stringify(buildInfo.version),
        __GIT_COMMIT_MESSAGE__: JSON.stringify(buildInfo.commitMessage)
    },
    server: {
        host: true,
        allowedHosts: ['remote.yohomobile.com'],
        proxy: {
            '/api': {
                target: 'http://127.0.0.1:3006',
                changeOrigin: true
            },
            '/socket.io': {
                target: 'http://127.0.0.1:3006',
                ws: true
            }
        }
    },
    plugins: [
        react(),
        swVersionPlugin(),
        VitePWA({
            registerType: 'autoUpdate',
            includeAssets: ['favicon.ico', 'apple-touch-icon-180x180.png', 'pwa-192x192.png'],
            manifest: {
                name: 'Yoho Remote',
                short_name: 'Yoho',
                description: 'AI-powered development assistant',
                theme_color: '#ffffff',
                background_color: '#ffffff',
                display: 'standalone',
                orientation: 'portrait',
                scope: base,
                start_url: base,
                icons: [
                    {
                        src: 'pwa-64x64.png?v=3',
                        sizes: '64x64',
                        type: 'image/png'
                    },
                    {
                        src: 'pwa-192x192.png?v=3',
                        sizes: '192x192',
                        type: 'image/png'
                    },
                    {
                        src: 'pwa-512x512.png?v=3',
                        sizes: '512x512',
                        type: 'image/png'
                    },
                    {
                        src: 'maskable-icon-512x512.png?v=3',
                        sizes: '512x512',
                        type: 'image/png',
                        purpose: 'maskable'
                    }
                ]
            },
            workbox: {
                skipWaiting: true,
                clientsClaim: true,
                globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}'],
                maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
                // Import custom push notification handlers
                importScripts: ['/sw-push.js'],
                // 不要对 /api/ 路径使用 navigateFallback
                navigateFallbackDenylist: [/^\/api\//],
                runtimeCaching: [
                    // 所有 API 请求都不缓存，始终走网络
                    // Service Worker 无法访问 IndexedDB 中的 token，无法正确处理认证请求
                    {
                        urlPattern: /^\/api\//,
                        handler: 'NetworkOnly',
                    },
                    {
                        urlPattern: /^https:\/\/cdn\.socket\.io\/.*/,
                        handler: 'CacheFirst',
                        options: {
                            cacheName: 'cdn-socketio',
                            expiration: {
                                maxEntries: 5,
                                maxAgeSeconds: 60 * 60 * 24 * 30
                            }
                        }
                    },
                    {
                        urlPattern: /^https:\/\/telegram\.org\/.*/,
                        handler: 'CacheFirst',
                        options: {
                            cacheName: 'cdn-telegram',
                            expiration: {
                                maxEntries: 5,
                                maxAgeSeconds: 60 * 60 * 24 * 7
                            }
                        }
                    }
                ]
            },
            devOptions: {
                enabled: true,
                type: 'module'
            }
        })
    ],
    base,
    resolve: {
        alias: {
            '@': resolve(__dirname, 'src')
        }
    },
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        minify: false,
        sourcemap: true
    }
})
