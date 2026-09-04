# Mintzy API Gateway — Implementation Guide

## Important Note: API Key Management

**API keys are generated and provisioned manually by the admin team — never by the app.**  
Each client is given a pre-generated API key (format: `mintzy_<64-hex-chars>`) through an offline/administrative process. The app only validates these keys against the database during onboarding.

---

## Base URL

```
http://<host>:3000/api/v1
```

All endpoints are prefixed with `/api/v1`.

---

## Authentication

### Two-Tier Auth System

| Layer | Mechanism | Used For |
|---|---|---|
| **API Key** | Static key sent in request body | Onboarding (`POST /onboard`) |
| **JWT** | Bearer token in `Authorization` header | All trading/user operations |

### Flow

```
1. Client obtains API key (manual/admin process)
2. POST /users/onboard  { "apiKey": "mintzy_..." }  →  receives JWT
3. Use JWT for all subsequent requests:
   Authorization: Bearer <jwt>
```

### JWT Details
- Algorithm: HMAC-SHA256 (custom implementation)
- Expiry: 24 hours
- Auto-refresh: On every authenticated request, the gateway returns refreshed JWT headers:
  - `X-Refreshed-JWT` — new token
  - `X-JWT-Expires-In` — seconds until expiry
  - `X-JWT-Expires-At` — ISO timestamp

---

## Endpoints

---

### System

#### `GET /system/health`
Health check. No auth required.

**Response `200`**
```json
{
  "success": true,
  "message": "OK",
  "timestamp": "2026-07-21T12:00:00.000Z"
}
```

#### `GET /system/ready`
Readiness check (includes DB connectivity). No auth required.

**Response `200`**
```json
{
  "success": true,
  "message": "Ready",
  "dbState": 1,
  "uptime": 12345
}
```

---

### Users

#### `POST /users/onboard`
Authenticate with an API key and receive a JWT.

**Request Body**
```json
{
  "apiKey": "mintzy_<64-hex-chars>"
}
```

**Response `200`**
```json
{
  "success": true,
  "jwt": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expiresIn": 86400,
  "expiresAt": "2026-07-22T12:00:00.000Z",
  "broker": "angle one",
  "user": {
    "id": "60d21b4667d0d8992e610c85",
    "name": "John Doe",
    "email": "john@example.com"
  }
}
```

**Error `401`**
```json
{
  "success": false,
  "message": "Invalid API Key"
}
```

---

#### `POST /users/broker`
Update the user's broker. The API key is pre-provisioned by admin.

**Request Body**
```json
{
  "userId": "60d21b4667d0d8992e610c85",
  "broker": "angle one"
}
```

`broker` values: `"angle one"`, `"tradex"`

**Response `200`**
```json
{
  "success": true,
  "user": {
    "id": "60d21b4667d0d8992e610c85",
    "name": "John Doe",
    "email": "john@example.com",
    "broker": "angle one"
  }
}
```

---

#### `POST /users/refresh`
Refresh an existing JWT.

**Request** — Accepts JWT via:
- `Authorization: Bearer <jwt>` header, or
- `{ "jwt": "..." }` in body, or
- `{ "token": "..." }` in body

**Response `200`**
```json
{
  "success": true,
  "jwt": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expiresIn": 86400,
  "expiresAt": "2026-07-22T12:00:00.000Z",
  "broker": "angle one",
  "user": {
    "id": "60d21b4667d0d8992e610c85",
    "name": "John Doe",
    "email": "john@example.com"
  }
}
```

---

#### `POST /users/plan`
Get the user's active plan details using their API key.

**Request Body**
```json
{
  "apiKey": "mintzy_<64-hex-chars>"
}
```

**Response `200`**
```json
{
  "success": true,
  "user": {
    "id": "60d21b4667d0d8992e610c85",
    "name": "John Doe",
    "email": "john@example.com"
  },
  "plan": {
    "_id": "60d21b4667d0d8992e610c90",
    "name": "Pro Plan",
    "price": 999,
    "credits": 1000
  },
  "userPlan": {
    "id": "60d21b4667d0d8992e610c95",
    "creditsRemaining": 850,
    "isActive": true,
    "expiresAt": "2027-01-01T00:00:00.000Z",
    "createdAt": "2026-01-01T00:00:00.000Z",
    "updatedAt": "2026-07-21T00:00:00.000Z"
  }
}
```

**Error `404`** (no active plan)
```json
{
  "success": false,
  "message": "No active plan found for this user",
  "user": {
    "id": "60d21b4667d0d8992e610c85",
    "name": "John Doe",
    "email": "john@example.com"
  }
}
```

---

#### `GET /users/detail?email=john@example.com`
Get user details by email.

**Query Parameters**
| Param | Type | Required |
|---|---|---|
| `email` | string | Yes |

**Response `200`**
```json
{
  "success": true,
  "user": {
    "_id": "60d21b4667d0d8992e610c85",
    "email": "john@example.com",
    "name": "John Doe",
    "broker": "angle one",
    "isActive": true,
    "lastLogin": "2026-07-21T10:00:00.000Z",
    "createdAt": "...",
    "updatedAt": "..."
  }
}
```

---

### Angle One Trading (`/angle_one`)

All endpoints require `Authorization: Bearer <jwt>`.

#### Trading Sessions

| Method | Path | Description |
|---|---|---|
| POST | `/angle_one/start` | Start a trading session |
| POST | `/angle_one/stop/:sessionId` | Stop a session by URL param |
| POST | `/angle_one/stop` | Stop a session (body: `{ "sessionId": "..." }`) |
| POST | `/angle_one/sessions/:sessionId/stop` | Stop specific session |
| POST | `/angle_one/sessions/stop-old` | Stop all old sessions |
| DELETE | `/angle_one/sessions/flush` | Flush all sessions |
| DELETE | `/angle_one/sessions/invalid` | Delete invalid sessions |

#### Trading Data

| Method | Path | Description |
|---|---|---|
| GET | `/angle_one/sessions/:sessionId/trades` | Get trading logs |
| GET | `/angle_one/sessions/:sessionId/status` | Get session status |
| GET | `/angle_one/sessions/:sessionId/download` | Download trading logs as CSV |
| GET | `/angle_one/trading/sessions` | List all user's trading sessions |
| GET | `/angle_one/trading/sessions/:id` | Get session by ID |
| GET | `/angle_one/trading/active-session` | Get active session |
| GET | `/angle_one/trading/live-pnl/:session_id` | Get live P&L |
| GET | `/angle_one/trading/live-pnl/:session_id/history` | Get live P&L history |
| GET | `/angle_one/trading/:sessionId/final-tradebook` | Download final tradebook |

#### Symbol & Session Control

| Method | Path | Description |
|---|---|---|
| POST | `/angle_one/:sessionId/exit-symbol/:symbol` | Exit a specific symbol |
| DELETE | `/angle_one/trading/session/:sessionId` | Delete a trading session |
| POST | `/angle_one/trading/:sessionId/abandon` | Abandon a session |

#### Credentials & Auth

| Method | Path | Description |
|---|---|---|
| POST | `/angle_one/credentials` | Submit broker credentials |
| POST | `/angle_one/totp` | Submit TOTP |

#### Saved Configurations

| Method | Path | Description |
|---|---|---|
| GET | `/angle_one/saved-configurations` | List saved configs |
| GET | `/angle_one/saved-configurations/:configId` | Get config by ID |
| POST | `/angle_one/saved-configurations` | Create saved config |
| PUT | `/angle_one/saved-configurations/:configId` | Update saved config |
| DELETE | `/angle_one/saved-configurations/:configId` | Delete saved config |

#### Dashboard

| Method | Path | Description |
|---|---|---|
| GET | `/angle_one/dashboard` | Get dashboard data |
| GET | `/angle_one/dashboard/pnl` | Get P&L summary |
| GET | `/angle_one/dashboard/pnl/aggregate` | Get aggregate user P&L |

#### Admin

| Method | Path | Description |
|---|---|---|
| POST | `/angle_one/admin/sessions/:sessionId/stop` | Admin force-stop session |
| POST | `/angle_one/admin/force-stop-all` | Admin force-stop all sessions |

#### Health

| Method | Path | Description |
|---|---|---|
| GET | `/angle_one/health` | Module health check |

---

### TradeX Trading (`/tradex`)

All endpoints mirror the Angle One routes with identical request/response structures, mounted under `/api/v1/tradex`:

| Method | Path | Description |
|---|---|---|
| POST | `/tradex/start` | Start a trading session |
| POST | `/tradex/stop/:sessionId` | Stop a session by URL param |
| POST | `/tradex/stop` | Stop a session (body) |
| POST | `/tradex/credentials` | Submit credentials |
| POST | `/tradex/totp` | Submit TOTP |
| POST | `/tradex/sessions/:sessionId/stop` | Stop specific session |
| POST | `/tradex/sessions/stop-old` | Stop old sessions |
| DELETE | `/tradex/sessions/flush` | Flush sessions |
| DELETE | `/tradex/sessions/invalid` | Delete invalid sessions |
| GET | `/tradex/sessions/:sessionId/trades` | Get trading logs |
| GET | `/tradex/sessions/:sessionId/status` | Get session status |
| GET | `/tradex/sessions/:sessionId/download` | Download logs CSV |
| DELETE | `/tradex/trading/session/:sessionId` | Delete session |
| GET | `/tradex/trading/sessions` | List sessions |
| GET | `/tradex/trading/sessions/:id` | Get session by ID |
| GET | `/tradex/trading/active-session` | Get active session |
| GET | `/tradex/trading/live-pnl/:session_id` | Get live P&L |
| GET | `/tradex/trading/live-pnl/:session_id/history` | Live P&L history |
| POST | `/tradex/trading/:sessionId/abandon` | Abandon session |
| GET | `/tradex/trading/:sessionId/final-tradebook` | Download final tradebook |
| POST | `/tradex/admin/sessions/:sessionId/stop` | Admin stop session |
| POST | `/tradex/admin/force-stop-all` | Admin force stop all |
| GET | `/tradex/saved-configurations` | List saved configs |
| GET | `/tradex/saved-configurations/:configId` | Get config |
| POST | `/tradex/saved-configurations` | Create config |
| PUT | `/tradex/saved-configurations/:configId` | Update config |
| DELETE | `/tradex/saved-configurations/:configId` | Delete config |
| GET | `/tradex/session` | Get session state |
| GET | `/tradex/health` | Module health |
| GET | `/tradex/dashboard` | Dashboard data |
| GET | `/tradex/dashboard/pnl` | P&L summary |
| GET | `/tradex/dashboard/pnl/aggregate` | Aggregate P&L |
| GET | `/tradex/fetch/all-sessions` | All sessions (debug) |
| GET | `/tradex/debug/all-logs` | All trading logs |
| GET | `/tradex/debug/final-pnl/:sessionId` | Test final P&L |
| POST | `/tradex/debug/stop-plugin-session/:sessionId` | Debug stop |
| GET | `/tradex/debug/routing` | Plugin routing debug |

---

## Error Response Format

All errors follow this structure:

```json
{
  "success": false,
  "message": "Human-readable error description",
  "details": {}
}
```

### Common HTTP Status Codes

| Code | Meaning |
|---|---|
| 200 | Success |
| 400 | Bad request (missing/invalid fields) |
| 401 | Unauthorized (invalid API key, invalid/expired JWT) |
| 404 | Resource not found |
| 500 | Internal server error |

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `MONGO_URI` | — | MongoDB Atlas connection string |
| `JWT_SECRET` | `"mintzy-dev-jwt-secret"` | JWT signing secret |
| `API_JWT_SECRET` | (fallback) | Alternate JWT secret |
| `PLUGIN_BASE_URL` | `"https://plugin.mintzy.in"` | Angle One plugin backend |
| `TRADEX_PLUGIN_BASE_URL` | — | TradeX plugin backend |
| `PLUGIN_API_KEY` | — | API key for plugin backend auth |
| `PLUGIN_REQUEST_TIMEOUT` | `60000` | Plugin request timeout (ms) |
| `PLUGIN_REQUEST_RETRIES` | `2` | Plugin request retry count |
| `NODE_ENV` | — | Environment name |

---

## Key Implementation Rules

1. **Never generate API keys in the app.** They are pre-provisioned by admin.
2. **Validate API keys against the database** during onboarding.
3. **Issue JWTs** only after successful API key validation and plan checks.
4. **Apply JWT auth middleware** consistently to all trading routes.
5. **Send JWT refresh headers** (`X-Refreshed-JWT`, `X-JWT-Expires-In`, `X-JWT-Expires-At`) on every authenticated response.
6. **Never expose API keys** in response payloads or logs after onboarding.
