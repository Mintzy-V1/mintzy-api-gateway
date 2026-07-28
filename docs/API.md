# Mintzy API Gateway — Endpoint Reference

All routes are mounted under:

```
/api/v1
```

Default port: `5000` (or `PORT` from environment).

---

## Table of Contents

1. [Authentication](#authentication)
2. [Common Conventions](#common-conventions)
3. [System](#system)
4. [Users & Auth](#users--auth)
5. [Angle One Broker](#angle-one-broker)
6. [Tradex Broker](#tradex-broker)

---

## Authentication

Most broker plugin routes require a JWT in the `Authorization` header:

```http
Authorization: Bearer <jwt>
```

### How to get a JWT

1. **Onboard** with your API key:

```http
POST /api/v1/auth/onboard
Content-Type: application/json

{
  "apiKey": "your-api-key"
}
```

Response includes `jwt`, `expiresIn`, `expiresAt`, `broker`, and `user`.

2. **Refresh** an existing JWT:

```http
POST /api/v1/auth/refresh
Authorization: Bearer <existing-jwt>
```

Or pass `jwt` / `token` in the request body.

### Auth behavior by module

| Module | Auth model |
|--------|------------|
| **angle_one** | **All routes** require JWT (`router.use(authMiddleware)`) |
| **tradex** | JWT required **per route** — some debug/session routes are public (listed below) |

When authenticated, responses may include refreshed token headers:

- `X-Refreshed-JWT`
- `X-JWT-Expires-In`
- `X-JWT-Expires-At`

---

## Common Conventions

### Success response shape

Most endpoints return JSON like:

```json
{
  "success": true,
  ...
}
```

### Error response shape

```json
{
  "success": false,
  "message": "Error description",
  "details": {}
}
```

### Session ID naming

- **`:sessionId`** — Python/plugin session ID (e.g. `session_20260413041316_b42ef9f3`)
- **`:id`** (Mongo) — MongoDB `_id` of a `TradingSession` document
- Query param **`session_id`** — same as Python session ID

---

## System

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/system/health` | No | Liveness check — uptime, status, environment |
| `GET` | `/api/v1/system/ready` | No | Readiness check — DB and dependency status |

### Example

```http
GET /api/v1/system/health
```

```json
{
  "success": true,
  "message": "Service is up and running",
  "status": "healthy",
  "uptime": 123.45,
  "environment": "development",
  "timestamp": "2026-07-25T10:00:00.000Z"
}
```

---

## Users & Auth

Available at `/api/v1/users`, `/api/v1/auth`, and `/api/v1/broker` (same router).

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/users/detail` | No | Get user by email |
| `POST` | `/api/v1/users/broker` | No | Set broker for a user and generate API key |
| `POST` | `/api/v1/users/onboard` | No | Exchange API key for JWT |
| `POST` | `/api/v1/users/plan` | No | Get active plan for user (by API key) |
| `POST` | `/api/v1/users/refresh` | Optional JWT | Refresh JWT token |

> Same paths work under `/api/v1/auth/*` and `/api/v1/broker/*`.

### `GET /users/detail`

**Query:** `email` (required)

```http
GET /api/v1/users/detail?email=user@example.com
```

### `POST /users/broker`

**Body:**

```json
{
  "userId": "<mongo-user-id>",
  "broker": "angle_one"
}
```

Returns new `apiKey` and updated user info.

### `POST /users/onboard` (or `/auth/onboard`)

**Body:**

```json
{
  "apiKey": "your-api-key"
}
```

**Response:**

```json
{
  "success": true,
  "jwt": "<token>",
  "expiresIn": 86400,
  "expiresAt": "2026-07-26T10:00:00.000Z",
  "broker": "angle_one",
  "user": { "id": "...", "name": "...", "email": "..." }
}
```

### `POST /users/plan`

**Body or query:** `apiKey`

Returns active plan details, credits, expiry.

### `POST /users/refresh`

**Headers:** `Authorization: Bearer <jwt>` (optional)  
**Body (alternative):** `{ "jwt": "..." }` or `{ "token": "..." }`

---

## Angle One Broker

Base path: `/api/v1/angle_one`

**All endpoints require JWT.**

---

### Health

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Check plugin engine health via proxy |

---

### Trading Flow (Credentials → Start → Stop)

Typical flow:

1. Submit credentials → get `session_id`
2. Submit TOTP → authenticate session
3. Start trading
4. Monitor via dashboard / live PnL
5. Stop trading

| Method | Path | Body / Params | Description |
|--------|------|---------------|-------------|
| `POST` | `/credentials` | See below | Submit broker credentials, create session |
| `POST` | `/totp` | `{ "session_id": "...", "totp": "123456" }` | Submit TOTP to authenticate |
| `POST` | `/start` | `{ "session_id": "..." }` | Start trading for session |
| `POST` | `/stop/:sessionId` | — | Stop trading (session ID in URL) |
| `POST` | `/stop` | `{ "session_id": "..." }` | Stop trading (session ID in body) |
| `POST` | `/sessions/:sessionId/stop` | — | Mark session stopped locally (no plugin call) |
| `POST` | `/trading/:sessionId/abandon` | — | Abandon a session that hasn't started trading |

#### `POST /credentials` body

```json
{
  "userId": "<user-id>",
  "access_key": "your-access-key",
  "access_secret": "your-access-secret"
}
```

Also accepts camelCase: `accessKey`, `accessSecret`.

---

### Sessions

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/tradingsessions` | List all trading sessions for logged-in user |
| `GET` | `/trading/sessions` | Same as above (alias) |
| `GET` | `/trading/sessions/:id` | Get one session by Python `session_id` |
| `GET` | `/trading/active-session` | Get current active/pending session |
| `DELETE` | `/tradingsession/:id` | Delete session by Mongo `_id` |
| `DELETE` | `/trading/session/:sessionId` | Delete session by Python session ID |
| `DELETE` | `/sessions/flush` | Delete all sessions for logged-in user |
| `DELETE` | `/sessions/invalid` | Clean up invalid sessions (maintenance) |
| `POST` | `/sessions/stop-old` | Mark old active sessions as stopped |

---

### Dashboard & PnL

| Method | Path | Query Params | Description |
|--------|------|--------------|-------------|
| `GET` | `/dashboard` | `session_id` (optional) | Aggregated dashboard: status, snapshot, logs |
| `GET` | `/dashboard/pnl` | `session_id`, `year`, `month` | Monthly PnL summary for a session |
| `GET` | `/dashboard/pnl/aggregate` | `year`, `month` | Aggregated PnL across all user sessions |
| `GET` | `/session` | `token` (optional) | Full session state, or restore via token |

#### `GET /dashboard` response

```json
{
  "success": true,
  "session_id": "session_...",
  "status": { ... },
  "snapshot": { ... },
  "logs": [ ... ]
}
```

If no session exists:

```json
{
  "success": true,
  "session_id": null,
  "status": null,
  "snapshot": null,
  "logs": [],
  "message": "No trading session found"
}
```

#### `GET /dashboard/pnl` query

- `session_id` — optional; defaults to latest session
- `year` — optional; defaults to current year (IST)
- `month` — optional; defaults to current month (IST, 1–12)

---

### Live PnL

| Method | Path | Query | Description |
|--------|------|-------|-------------|
| `GET` | `/trading/live-pnl/:session_id` | — | Current live PnL from plugin |
| `GET` | `/trading/live-pnl/:session_id/history` | `date` (optional) | Saved live PnL snapshot history |

**Live PnL response:**

```json
{
  "success": true,
  "ready": true,
  "data": { ... },
  "stopped": false,
  "status": "running"
}
```

---

### Saved Trading Configurations

Max **5** saved configurations per user.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/saved-configurations` | List all saved configs |
| `GET` | `/saved-configurations/:configId` | Get one config |
| `POST` | `/saved-configurations` | Create config |
| `PUT` | `/saved-configurations/:configId` | Update config |
| `DELETE` | `/saved-configurations/:configId` | Delete config |

#### `POST /saved-configurations` body

```json
{
  "name": "My Strategy",
  "description": "Optional description",
  "configuration": { ... }
}
```

---

### Trading Logs & Downloads

| Method | Path | Response | Description |
|--------|------|----------|-------------|
| `GET` | `/sessions/:sessionId/trades` | JSON array | Raw trading logs from plugin DB |
| `GET` | `/sessions/:sessionId/status` | JSON object | Plugin session status |
| `GET` | `/sessions/:sessionId/download` | CSV file | Download trading logs as CSV |
| `GET` | `/trading/:sessionId/final-tradebook` | CSV stream | Final tradebook from plugin engine |

#### Download examples

```http
GET /api/v1/angle_one/sessions/session_20260413041316_b42ef9f3/download
Authorization: Bearer <jwt>
```

```http
GET /api/v1/angle_one/trading/session_20260413041316_b42ef9f3/final-tradebook
Authorization: Bearer <jwt>
```

Returns `404` if no logs / tradebook found.

---

### Symbol Exit

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/:sessionId/exit-symbol/:symbol` | Exit/stop trading for a specific symbol |

Example:

```http
POST /api/v1/angle_one/session_abc123/exit-symbol/RELIANCE
Authorization: Bearer <jwt>
```

---

### Admin

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/admin/sessions/:sessionId/stop` | Force-stop a session (admin) |
| `POST` | `/admin/force-stop-all` | Force-stop all sessions for user |

---

### Debug / Internal (Angle One)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/fetch/all-sessions` | JWT | All sessions from plugin DB |
| `GET` | `/debug/all-logs` | JWT | Hardcoded session CSV download (debug) |
| `GET` | `/debug/final-pnl/:sessionId` | JWT | Check `final_pnl` stamped on logs |
| `POST` | `/debug/stop-plugin-session/:sessionId` | JWT | Mark plugin session stopped (debug) |

---

## Tradex Broker

Base path: `/api/v1/tradex`

Tradex mirrors Angle One for most endpoints. Differences are noted below.

---

### Auth summary

| Auth | Routes |
|------|--------|
| **JWT required** | Credentials, TOTP, start/stop, dashboard, saved configs, live PnL, admin, most trading routes |
| **No JWT** | `/health`, `/sessions/:sessionId/trades`, `/sessions/:sessionId/status`, `/sessions/:sessionId/download`, `/sessions/:sessionId/stop`, `/sessions/stop-old`, `/sessions/invalid`, `/fetch/all-sessions`, `/debug/*` |

> Consider adding JWT to the public session log routes for production parity with Angle One.

---

### Tradex-only endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/debug/routing` | JWT | Debug plugin VM routing for a session or API key |
| `POST` | `/debug/test-forward` | No | Test proxy forwarding to localhost:8000 |

#### `GET /debug/routing` query

- `sessionId` — optional; looks up trading session VM URL
- `apiKey` — optional; shows API-key-based routing map

---

### All Tradex endpoints (same usage as Angle One unless noted)

#### Health

| Method | Path | Auth |
|--------|------|------|
| `GET` | `/health` | No |

#### Trading flow

| Method | Path | Auth |
|--------|------|------|
| `POST` | `/credentials` | JWT |
| `POST` | `/totp` | JWT |
| `POST` | `/start` | JWT |
| `POST` | `/stop/:sessionId` | JWT |
| `POST` | `/stop` | JWT |
| `POST` | `/sessions/:sessionId/stop` | **No** |
| `POST` | `/trading/:sessionId/abandon` | JWT |

#### Sessions

| Method | Path | Auth |
|--------|------|------|
| `GET` | `/tradingsessions` | JWT |
| `GET` | `/trading/sessions` | JWT |
| `GET` | `/trading/sessions/:id` | JWT |
| `GET` | `/trading/active-session` | JWT |
| `DELETE` | `/tradingsession/:id` | JWT |
| `DELETE` | `/trading/session/:sessionId` | JWT |
| `DELETE` | `/sessions/flush` | JWT |
| `DELETE` | `/sessions/invalid` | **No** |
| `POST` | `/sessions/stop-old` | **No** |

#### Dashboard & PnL

| Method | Path | Auth |
|--------|------|------|
| `GET` | `/dashboard` | JWT |
| `GET` | `/dashboard/pnl` | JWT |
| `GET` | `/dashboard/pnl/aggregate` | JWT |
| `GET` | `/session` | JWT |

#### Live PnL

| Method | Path | Auth |
|--------|------|------|
| `GET` | `/trading/live-pnl/:session_id` | JWT |
| `GET` | `/trading/live-pnl/:session_id/history` | JWT |

#### Saved configurations

| Method | Path | Auth |
|--------|------|------|
| `GET` | `/saved-configurations` | JWT |
| `GET` | `/saved-configurations/:configId` | JWT |
| `POST` | `/saved-configurations` | JWT |
| `PUT` | `/saved-configurations/:configId` | JWT |
| `DELETE` | `/saved-configurations/:configId` | JWT |

#### Logs & downloads

| Method | Path | Auth |
|--------|------|------|
| `GET` | `/sessions/:sessionId/trades` | **No** |
| `GET` | `/sessions/:sessionId/status` | **No** |
| `GET` | `/sessions/:sessionId/download` | **No** |
| `GET` | `/trading/:sessionId/final-tradebook` | JWT |

#### Symbol exit

| Method | Path | Auth |
|--------|------|------|
| `POST` | `/:sessionId/exit-symbol/:symbol` | JWT |

#### Admin

| Method | Path | Auth |
|--------|------|------|
| `POST` | `/admin/sessions/:sessionId/stop` | JWT |
| `POST` | `/admin/force-stop-all` | JWT |

#### Debug

| Method | Path | Auth |
|--------|------|------|
| `GET` | `/fetch/all-sessions` | **No** |
| `GET` | `/debug/all-logs` | **No** |
| `GET` | `/debug/final-pnl/:sessionId` | **No** |
| `POST` | `/debug/stop-plugin-session/:sessionId` | **No** |
| `GET` | `/debug/routing` | JWT |
| `POST` | `/debug/test-forward` | **No** |

---

## Quick Reference — Common Client Flows

### 1. Authenticate

```http
POST /api/v1/auth/onboard
{ "apiKey": "..." }
```

### 2. Start trading (Angle One example)

```http
POST /api/v1/angle_one/credentials
Authorization: Bearer <jwt>
{ "userId": "...", "access_key": "...", "access_secret": "..." }

POST /api/v1/angle_one/totp
{ "session_id": "...", "totp": "123456" }

POST /api/v1/angle_one/start
{ "session_id": "..." }
```

### 3. Monitor dashboard

```http
GET /api/v1/angle_one/dashboard
Authorization: Bearer <jwt>

GET /api/v1/angle_one/dashboard?session_id=session_abc123
Authorization: Bearer <jwt>
```

### 4. Download logs

```http
GET /api/v1/angle_one/sessions/session_abc123/download
Authorization: Bearer <jwt>
```

### 5. Stop trading

```http
POST /api/v1/angle_one/stop/session_abc123
Authorization: Bearer <jwt>
```

---

## Environment Variables (relevant to API behavior)

| Variable | Purpose |
|----------|---------|
| `PORT` | Server port (default `5000`) |
| `MONGO_URI` | MongoDB connection string |
| `JWT_SECRET` / `API_JWT_SECRET` | JWT signing secret |
| `PLUGIN_BASE_URL` / `ANGLE_ONE_PLUGIN_BASE_URL` | Default plugin engine URL |
| `PLUGIN_API_KEY` | API key sent to plugin engine |
| `PLUGIN_FORCE_LOCAL` | Force local plugin routing |
| `PLUGIN_USE_VM_ROUTING` | Enable VM routing by API key |

---

*Generated from route definitions in `index.js`, `routes/`, and `modules/angle_one/` / `modules/tradex/`.*
