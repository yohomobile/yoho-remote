# Yoho Remote License Issue Investigation Report

## Executive Summary

**Problem**: Project creation is being blocked on a Hong Kong machine due to a **missing license for the organization**.

**Root Cause**: The system implements a comprehensive license validation system that prevents operations (sessions, projects) when:
1. An organization does not have a license configured in the database
2. The license has expired or been suspended
3. Session/member limits are exceeded

**Impact on Hong Kong Machine**: The organization associated with the machine likely has **no license entry** in the `org_licenses` database table, triggering the `NO_LICENSE` error.

---

## License System Architecture

### 1. License Service (`server/src/license/licenseService.ts`)

#### Key Features:
- **Singleton pattern**: Single LicenseService instance per server
- **10-minute memory cache**: Avoids repeated DB queries
- **Admin org bypass**: Organizations with admin role skip all license checks

#### License Validation Flow:
```
Session/Project Creation Request
  ↓
LicenseService.validateLicense(orgId)
  ↓
├─ No orgId? → ALLOW (personal sessions)
├─ Admin org? → ALLOW
├─ No license in DB? → BLOCK (NO_LICENSE)
├─ License suspended? → BLOCK (LICENSE_SUSPENDED)
├─ Not started yet? → BLOCK (LICENSE_NOT_STARTED)
├─ Expired? → BLOCK (LICENSE_EXPIRED)
└─ 7 days to expiry? → ALLOW + WARNING
```

#### Error Codes:
- `NO_LICENSE` - Organization has no license
- `LICENSE_EXPIRED` - License past expiration date
- `LICENSE_SUSPENDED` - Admin manually suspended
- `LICENSE_NOT_STARTED` - License start date is in future
- `MEMBER_LIMIT` - Member count exceeds license limit
- `SESSION_LIMIT` - Concurrent sessions exceed license limit

---

## Project Creation License Checks

### Where Checks Happen:

#### 1. **Brain Session Spawn** (server/src/web/routes/cli.ts:340-352)
Validates `canCreateSession()` when spawning child sessions:
```typescript
const licenseCheck = await licenseService.canCreateSession(brainOrgId)
if (!licenseCheck.valid) {
    return c.json({ type: 'error', message: licenseCheck.message, code: licenseCheck.code }, 403)
}
```

#### 2. **Session Alive Heartbeat** (server/src/socket/handlers/cli.ts:370-402)
Checks license on every `session-alive` event:
```typescript
const licenseCheck = await licenseService.validateLicense(licenseOrgId)
if (!licenseCheck.valid) {
    socket.emit('error', { message: licenseCheck.message, code: `license-${licenseCheck.code}` })
    onLicenseBlock?.(data.sid, licenseCheck.code)
    return
}
```

#### 3. **Project CRUD** (server/src/web/routes/cli.ts:581-607)
Project is tied to orgId - no explicit check, but session must be valid:
```typescript
const orgId = await resolveOrgId(sessionId, c.get('namespace'))
const project = await store.addProject(
    name, path, description, machineId,
    orgId,  // ← Organization must have valid license
    workspaceGroupId
)
```

---

## Database Schema

### `org_licenses` Table

```sql
CREATE TABLE IF NOT EXISTS org_licenses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
    starts_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    max_members INT NOT NULL DEFAULT 5,
    max_concurrent_sessions INT,
    status VARCHAR(20) NOT NULL DEFAULT 'active',  -- active, expired, suspended
    issued_by VARCHAR(255),
    note TEXT,
    created_at BIGINT NOT NULL DEFAULT extract(epoch from now()) * 1000,
    updated_at BIGINT NOT NULL DEFAULT extract(epoch from now()) * 1000
);
```

**Key Issue**: If org_id has no row in this table, license validation returns `NO_LICENSE`.

---

## Server Initialization (server/src/index.ts:101-108)

```typescript
const adminOrgId = process.env.ADMIN_ORG_ID || null
createLicenseService(store, adminOrgId)
if (adminOrgId) {
    console.log(`[Server] License: admin org ID = ${adminOrgId}`)
} else {
    console.log('[Server] License: no admin org configured (all orgs require license)')
}
```

**Critical Point**: If `ADMIN_ORG_ID` is not set, **all organizations require a license**.

---

## License Management API (server/src/web/routes/licenses.ts)

Admin-only endpoints (requires admin org owner/admin role):

```
POST /licenses
  Creates/updates license for organization

GET /licenses
  Lists all org licenses

PATCH /licenses/:orgId/status
  Changes status (active/expired/suspended)

DELETE /licenses/:orgId
  Removes license
```

---

## Why Hong Kong Machine Fails

1. **Organization created** → No corresponding `org_licenses` entry
2. **Session/project creation request** → Resolves to Hong Kong org ID
3. **License validation** → Queries `org_licenses WHERE org_id = ?`
4. **Empty result** → Returns `NO_LICENSE` error
5. **Request blocked** → Session killed, project creation fails

---

## Fix Options

### Option 1: Create License Entry (RECOMMENDED)

Via database (if admin access available):
```sql
INSERT INTO org_licenses (org_id, starts_at, expires_at, max_members, max_concurrent_sessions, status, issued_by, note)
VALUES (
    'hong-kong-org-uuid',
    EXTRACT(EPOCH FROM NOW())::BIGINT * 1000,
    EXTRACT(EPOCH FROM NOW() + INTERVAL '1 year')::BIGINT * 1000,
    100,
    NULL,
    'active',
    'system',
    'Hong Kong machine license'
);
```

### Option 2: Set Admin Org

```bash
export ADMIN_ORG_ID="hong-kong-org-uuid"
systemctl restart yoho-remote-server
```

This bypasses all license checks for that organization.

---

## Complete File Reference

| Location | Purpose |
|----------|---------|
| `server/src/license/licenseService.ts` | Core validation logic (29-173 lines) |
| `server/src/web/routes/licenses.ts` | Admin API for license management (1-167 lines) |
| `server/src/socket/handlers/cli.ts:370-402` | Session heartbeat license check |
| `server/src/web/routes/cli.ts:340-352` | Brain spawn license check |
| `server/src/web/routes/cli.ts:581-607` | Project CRUD (org-tied) |
| `server/src/index.ts:101-108` | LicenseService initialization |
| `web/src/components/LicenseBanner.tsx` | Frontend license status warning UI |

