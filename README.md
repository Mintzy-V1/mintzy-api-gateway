# Mintzy API Gateway

Node.js / Express API gateway for Mintzy broker integrations. Routes client requests to Python trading plugins and manages sessions, configurations, dashboards, and simulation-to-live handoff.

**Base URL:** `/api/v1`  
**Brokers:** `angle_one`, `tradex`

Full endpoint reference: [`docs/API.md`](docs/API.md)

---

## Quick start

```bash
npm install
cp .env.example .env   # configure MongoDB, JWT, plugin URLs, etc.
npm run dev            # nodemon
# or
npm start
```

Default port: `3000` (override with `PORT`).

---

## Recent updates (Aug 3, 2026)

### 1. Dashboard `/dashboard` 500 fix (angle_one + tradex)

Express 5 makes `req.query` read-only. `validateRequest` was assigning to it directly, which caused:

```
Cannot set property query of #<IncomingMessage> which has only a getter
```

**Fix:** Use `Object.assign(req[property], value)` for `query` and `params` in both modules’ `validateRequest` middleware.

---

### 2. PnL logic improvements (`plugin.data.service.js`)

- **`/dashboard/pnl`** — single session PnL
- **`/dashboard/pnl/aggregate`** — aggregated PnL across user sessions
- Added `resolveSymbolPnl()` fallback chain: `final_pnl` → `symbol_pnl` → `pnl` so live sessions are not stuck at `0`
- **Aggregate equity fix:** `total_equity`, `cash_balance`, `realized_pnl`, and `unrealized_pnl` now use only the **most recent session’s latest log** (avoids inflated sums across sessions)
- Debug endpoint: **`GET /debug/trading-logs/:sessionId`** (angle_one + tradex)

---

### 3. Angel One hybrid simulation → live flow

New morning simulation flow for **Angel One only** (not tradex).

| File | Purpose |
|------|---------|
| `models/tradingSession.js` | Simulation fields on session document |
| `modules/angle_one/services/plugin.simulation.service.js` | Start, stop, poll, auto-stop logic |
| `modules/angle_one/controllers/plugin.controller.js` | HTTP handlers |
| `modules/angle_one/routes/plugin.routes.js` | Routes |
| `modules/angle_one/validations/plugin.validation.js` | Request validation |
| `server.js` | Boots simulation poller on startup |

#### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/angle_one/start-simulation` | Start morning simulation on external VM |
| `POST` | `/api/v1/angle_one/stop-simulation` | Stop simulation and switch to live trading |
| `GET` | `/api/v1/angle_one/simulation/status/:sessionId` | Simulation status for a session |

All require JWT (`Authorization: Bearer <token>`).

#### Start simulation

```json
POST /api/v1/angle_one/start-simulation
{
  "session_id": "<python_session_id>",
  "saved_configuration_id": "<mongo_object_id>",
  "trade_date": "2026-07-28"
}
```

- Calls external simulation service, stores `simulation_job_id`, sets session `status` to `simulation_active`.

#### Stop simulation (manual)

```json
POST /api/v1/angle_one/stop-simulation
{
  "session_id": "<python_session_id>"
}
```

**Simplified handoff** — reuses existing trading service (no extra capital reallocation in gateway):

1. `stopTrading()` from `plugin.trading.service.js`
2. On success → `startTrading()` with the session’s `saved_configuration_id`
3. Updates simulation metadata on the session (`simulation_live_switch_triggered`, etc.)

---

### 4. Simulation environment defaults

If not set in `.env`, these defaults apply:

| Variable | Default |
|----------|---------|
| `SIMULATION_BASE_URL` | `http://18.205.165.28:8000` |
| `SIMULATION_START_PATH` | `/api/trading/start-simulation` |

Optional overrides:

```env
SIMULATION_JOB_STATUS_PATH=/start-simulation/:jobId
SIMULATION_STOP_PATH=/stop
SIMULATION_STOP_METHOD=POST
SIMULATION_POLL_INTERVAL_MS=60000
SIMULATION_POLL_START_HOUR_IST=12
SIMULATION_POLL_START_MINUTE_IST=45
SIMULATION_AUTO_STOP_HOUR_IST=12
SIMULATION_AUTO_STOP_MINUTE_IST=59
SIMULATION_REQUEST_TIMEOUT=60000
```

---

### 5. Automatic simulation stop at 12:59 PM IST

The gateway runs an internal scheduler (`startSimulationJobPoller()` in `server.js`) on startup.

**Behavior:**

- Poll interval: every 60s (configurable via `SIMULATION_POLL_INTERVAL_MS`)
- From **12:45 PM IST**: polls external simulation job status for early completion handoff (when job returns `completed`)
- At **12:59 PM IST** (once per day): automatically calls `stopSimulation()` for every session where:
  - `status === "simulation_active"`
  - `simulation_live_switch_triggered !== true`
  - `simulation_trade_date === today` (IST)

That triggers the same stop → live start flow as the manual `/stop-simulation` endpoint.

**Logs to watch:**

- `Simulation auto-stop triggered`
- `Simulation auto-stop completed`
- `Simulation auto-stop failed for session`

---

### 6. TradingSession simulation fields

```js
simulation_job_id
simulation_status          // pending | running | started | completed | failed | handoff_in_progress
simulation_started_at
simulation_completed_at
simulation_live_switch_triggered
simulation_live_started_at
simulation_trade_date
simulation_output
```

---

### 7. API documentation

Added [`docs/API.md`](docs/API.md) — full endpoint reference for system, auth, angle_one, and tradex.

---

### 8. Docker (local)

Added `Dockerfile` and `.dockerignore` for containerized runs. Build and run example:

```bash
docker build -t mintzy-api-gateway .
docker run --env-file .env -p 3000:3000 mintzy-api-gateway
```

---

## Frontend integration (Angel One)

1. **Start morning sim:** `POST /api/v1/angle_one/start-simulation` with `session_id` + `saved_configuration_id`
2. **Manual stop / go live:** `POST /api/v1/angle_one/stop-simulation` with `{ "session_id": "..." }`
3. **Poll status:** `GET /api/v1/angle_one/simulation/status/:sessionId`
4. **Auto handoff:** No frontend action needed at 12:59 PM if the gateway process is running

---

## Project structure (high level)

```
mintzy-api-gateway/
├── server.js                 # Entry point, DB connect, simulation poller
├── app.js                    # Express app
├── index.js                  # Route mounting
├── models/                   # Mongoose models (User, TradingSession, etc.)
├── modules/
│   ├── angle_one/            # Angel One broker plugin routes & services
│   └── tradex/               # Tradex broker plugin routes & services
├── routes/                   # Health, users, auth
└── docs/
    └── API.md                # Endpoint reference
```
