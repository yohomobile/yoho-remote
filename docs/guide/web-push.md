# Web Push 后台推送通知

本文档介绍 Yoho Remote 的 Web Push 后台推送通知功能，该功能使 iOS PWA 和其他平台能够在应用完全后台时接收任务完成通知。

## 功能概述

当 AI 任务完成时（thinking 状态从 `true` 变为 `false`），服务器会通过 Web Push Protocol 向用户的所有已订阅设备发送系统级推送通知，即使 PWA 完全在后台或被挂起也能收到。

### 支持的平台

| 平台 | 最低版本要求 |
|------|-------------|
| iOS Safari (PWA) | iOS 16.4+ |
| Chrome | 50+ |
| Firefox | 44+ |
| Edge | 17+ |
| Safari (macOS) | 16+ |

## 技术架构

```
AI 任务完成 (thinking: true → false)
         ↓
    syncEngine 检测状态变化
         ↓
    WebPushService.sendToNamespace()
         ↓
    web-push 库发送到推送服务
         ↓
    APNs (iOS) / FCM (Android/Chrome) / Mozilla Push
         ↓
    设备系统级推送通知
         ↓
    用户点击 → 打开 PWA → 跳转到对应 session
```

## 配置步骤

### 1. 生成 VAPID 密钥对

```bash
cd server
bun run scripts/generate-vapid-keys.ts
```

输出示例：
```
WEB_PUSH_VAPID_PUBLIC_KEY=BCDGmmh3tLfnz7SmTc...
WEB_PUSH_VAPID_PRIVATE_KEY=c_wzTJWWiGqNC_rn540i...
WEB_PUSH_VAPID_SUBJECT=mailto:your-email@example.com
```

### 2. 配置密钥

**方式一：环境变量**

```bash
export WEB_PUSH_VAPID_PUBLIC_KEY="BCDGmmh3tLfnz7SmTc..."
export WEB_PUSH_VAPID_PRIVATE_KEY="c_wzTJWWiGqNC_rn540i..."
export WEB_PUSH_VAPID_SUBJECT="mailto:your-email@example.com"
```

**方式二：settings.json**

编辑 `~/.yoho-remote/settings.json`：

```json
{
  "webPushVapidPublicKey": "BCDGmmh3tLfnz7SmTc...",
  "webPushVapidPrivateKey": "c_wzTJWWiGqNC_rn540i...",
  "webPushVapidSubject": "mailto:your-email@example.com"
}
```

### 3. 重启服务器

重启后日志应显示：
```
[Server] Web Push: enabled
```

如果显示 `[Server] Web Push: disabled (missing VAPID keys)`，请检查配置。

## 工作原理

### 服务器端

1. **WebPushService** (`server/src/services/webPush.ts`)
   - 使用 `web-push` 库实现 Web Push Protocol
   - 管理 VAPID 密钥和推送发送

2. **Push 订阅存储** (`server/src/store/index.ts`)
   - `push_subscriptions` 表存储用户的推送订阅
   - 按 namespace 隔离不同用户的订阅

3. **API 路由** (`server/src/web/routes/push.ts`)
   - `GET /api/push/vapid-public-key` - 获取 VAPID 公钥
   - `POST /api/push/subscribe` - 订阅推送
   - `POST /api/push/unsubscribe` - 取消订阅
   - `GET /api/push/subscriptions` - 查看订阅列表

4. **推送触发** (`server/src/sync/syncEngine.ts`)
   - 在 `handleSessionAlive` 中检测 `thinking: true → false`
   - 调用 `sendTaskCompletePushNotification()` 发送推送

### 客户端

1. **订阅管理** (`web/src/hooks/useNotification.ts`)
   - `useWebPushSubscription` hook 自动管理订阅
   - 在权限授予后自动订阅
   - 支持手动订阅/取消订阅

2. **Service Worker** (`web/public/sw-push.js`)
   - 处理 `push` 事件显示系统通知
   - 处理 `notificationclick` 事件打开应用并跳转

3. **App 集成** (`web/src/App.tsx`)
   - 在认证后自动调用 `useWebPushSubscription`

## 数据库结构

```sql
CREATE TABLE push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    namespace TEXT NOT NULL DEFAULT 'default',
    endpoint TEXT NOT NULL UNIQUE,
    keys_p256dh TEXT NOT NULL,
    keys_auth TEXT NOT NULL,
    user_agent TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
```

## 通知内容格式

```typescript
{
    title: `${projectName}: Task completed`,
    body: sessionSummary,
    icon: '/pwa-192x192.png',
    badge: '/pwa-64x64.png',
    tag: `task-complete-${sessionId}`,
    data: {
        type: 'task-complete',
        sessionId: string,
        url: `/sessions/${sessionId}`
    }
}
```

## 故障排查

### 推送未收到

1. **检查服务器日志**
   ```
   [webpush] initialized with VAPID subject: mailto:...
   [webpush] sending to N subscriptions in namespace: default
   [webpush] sent: { success: 1, failed: 0, removed: 0 }
   ```

2. **检查订阅状态**
   ```bash
   curl -H "Authorization: Bearer $TOKEN" https://your-server/api/push/subscriptions
   ```

3. **检查浏览器控制台**
   ```
   [webpush] subscribed successfully
   [sw-push] push event received
   ```

### iOS 特殊说明

- 必须将网站添加到主屏幕作为 PWA 运行
- 需要 iOS 16.4 或更高版本
- 首次需要用户明确授权通知权限
- 推送通知在"设置 > 通知"中可管理

### 订阅过期处理

当推送返回 404 或 410 错误时，服务器会自动删除过期的订阅：
```
[webpush] subscription expired, removing: https://...
```

## 相关文件

| 文件 | 说明 |
|------|------|
| `server/src/services/webPush.ts` | Web Push 服务模块 |
| `server/src/web/routes/push.ts` | Push API 路由 |
| `server/src/sync/syncEngine.ts` | 推送触发逻辑 |
| `server/src/store/index.ts` | 订阅存储 |
| `server/src/serverSettings.ts` | VAPID 配置加载 |
| `server/scripts/generate-vapid-keys.ts` | 密钥生成脚本 |
| `web/src/hooks/useNotification.ts` | 客户端订阅 hook |
| `web/public/sw-push.js` | Service Worker 推送处理 |
| `web/src/App.tsx` | 自动订阅集成 |

## 安全注意事项

- **VAPID 私钥必须保密**，不要提交到版本控制
- 推送内容通过 HTTPS 加密传输
- 每个订阅的 `auth` 密钥用于端到端加密推送内容
