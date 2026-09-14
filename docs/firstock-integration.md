# Firstock (trader_hub) Module — Implementation Guide

This guide creates the `modules/firstock` plugin module in `mintzy-api-gateway`, cloned
from the working `modules/bear_street` reference and adapted for the Firstock VM
(`trader_hub_vm_repo`).

**Firstock VM endpoint:** `http://34.205.29.123:8000` (same IP as before; override with
`FIRSTOCK_PLUGIN_BASE_URL` in `.env` if it changes).

The only functional difference from Bear Street is **authentication**: Firstock is
always a 2-step flow and takes `vendor_code` (step 1) + `totp` (step 2) — no
`second_auth`, no `source`, no auto-auth. Every trading / simulation / stop / live-handoff
endpoint is identical between the two VMs.

---

## 1. Copy the reference module

```bash
cd mintzy-api-gateway
cp -R modules/bear_street modules/firstock
```

All files under `modules/firstock/` are now correct except the 4 listed below.

## 2. Adapt `services/plugin.proxy.service.js`

Change the base-URL constant and both `[BearStreet Proxy]` log labels.

```js
// BEFORE
const PLUGIN_BASE = process.env.BEAR_STREET_PLUGIN_BASE_URL
    || process.env.PLUGIN_BASE_URL
    || "http://54.157.92.179:8000";

// AFTER
const PLUGIN_BASE = process.env.FIRSTOCK_PLUGIN_BASE_URL
    || process.env.PLUGIN_BASE_URL
    || "http://34.205.29.123:8000";
```

Then `[BearStreet Proxy]` → `[Firstock Proxy]` (two occurrences: `success` and `failed`
log lines).

## 3. Adapt `services/plugin.trading.service.js`

Three changes.

**(a)** `AUTO_AUTH_PLUGIN_BASE_URL` (top of file):

```js
// BEFORE
const AUTO_AUTH_PLUGIN_BASE_URL = process.env.BEAR_STREET_PLUGIN_AUTO_AUTH_BASE_URL
    || process.env.PLUGIN_AUTO_AUTH_BASE_URL
    || null;

// AFTER
const AUTO_AUTH_PLUGIN_BASE_URL = process.env.FIRSTOCK_PLUGIN_AUTO_AUTH_BASE_URL
    || process.env.PLUGIN_AUTO_AUTH_BASE_URL
    || null;
```

**(b)** Replace `normalizeCredentialsPayload` + `submitCredentials` (drop `second_auth`/`source`/`token`, add `vendor_code`):

```js
const normalizeCredentialsPayload = (payload = {}) => ({
    userId: payload.userId,
    api_key: payload.api_key,
    client_code: payload.client_code,
    password: payload.password,
    vendor_code: payload.vendor_code,
    base_url: payload.base_url
});

const submitCredentials = async (jwtUserId, payload = {}) => {
    const credentials = normalizeCredentialsPayload(payload);
    const {
        userId,
        api_key,
        client_code,
        password,
        vendor_code,
        base_url
    } = credentials;

    if (!userId || !api_key || !client_code || !password || !vendor_code) {
        throw new AppError("userId, api_key, client_code, password, and vendor_code are required", 400);
    }

    logger.info("Submitting Firstock credentials", { userId: jwtUserId, client_code });

    const targetBaseUrl = PLUGIN_BASE;
    const pluginPayload = {
        broker_type: "firstock",
        api_key,
        client_code,
        password,
        vendor_code,
        base_url
    };

    const pluginRes = await forwardToPlugin(
        "/api/auth/credentials",
        "post",
        pluginPayload,
        { "X-Forwarded-User": jwtUserId.toString() },
        {},
        { targetBaseUrl }
    );

    const pluginData = pluginRes.data || {};
    const pythonSessionId = pluginData.session_id;

    if (!pythonSessionId) {
        throw new AppError("Failed to create trading engine session", 502);
    }

    const initialStatus = pluginData.requires_totp === false
        ? "authenticated"
        : (pluginData.status || "credentials_received");

    const fingerprint = crypto
        .createHash("sha256")
        .update(`${api_key}:${client_code}`)
        .digest("hex");

    const ts = await TradingSession.create({
        user_id: jwtUserId,
        python_session_id: pythonSessionId,
        broker: "firstock",
        status: initialStatus,
        credentials_fingerprint: fingerprint,
        vm_url: targetBaseUrl
    });

    return {
        ...pluginData,
        node_session_id: ts._id,
        ts
    };
};
```

**(c)** `ts.broker` string (two places) and the log labels:

- `.create({ ... broker: "bear_street" ... })` → `broker: "firstock"`
- `ts.broker = ts.broker || "bear_street";` → `ts.broker = ts.broker || "firstock";`
- All `"Bear Street"` log strings → `"Firstock"` (including the `"Bear Street plugin already live…"`, `"Bear Street plugin reported already running…"`, `"Verifying Bear Street TOTP"` etc.)

`verifyTotp` needs **no logic change** — it already posts `{ session_id, totp }` to
`/api/auth/totp`, which is exactly the Firstock contract.

## 4. Adapt `services/plugin.simulation.service.js`

Change the env-var block and `BROKER_KEY` (top of file):

```js
// BEFORE
const SIMULATION_BASE_URL = (process.env.BEAR_STREET_SIMULATION_BASE_URL || process.env.SIMULATION_BASE_URL || PLUGIN_BASE).replace(/\/$/, "");
const SIMULATION_START_PATH = process.env.BEAR_STREET_SIMULATION_START_PATH || process.env.SIMULATION_START_PATH || "/api/trading/start-simulation";
const SIMULATION_JOB_STATUS_PATH = process.env.BEAR_STREET_SIMULATION_JOB_STATUS_PATH || process.env.SIMULATION_JOB_STATUS_PATH || "/start-simulation/:jobId";
const SIMULATION_STOP_PATH = process.env.BEAR_STREET_SIMULATION_STOP_PATH || process.env.SIMULATION_STOP_PATH || "/stop";
const SIMULATION_STOP_METHOD = (process.env.BEAR_STREET_SIMULATION_STOP_METHOD || process.env.SIMULATION_STOP_METHOD || "POST").toUpperCase();
const BROKER_KEY = "bear_street";

// AFTER
const SIMULATION_BASE_URL = (process.env.FIRSTOCK_SIMULATION_BASE_URL || process.env.SIMULATION_BASE_URL || PLUGIN_BASE).replace(/\/$/, "");
const SIMULATION_START_PATH = process.env.FIRSTOCK_SIMULATION_START_PATH || process.env.SIMULATION_START_PATH || "/api/trading/start-simulation";
const SIMULATION_JOB_STATUS_PATH = process.env.FIRSTOCK_SIMULATION_JOB_STATUS_PATH || process.env.SIMULATION_JOB_STATUS_PATH || "/start-simulation/:jobId";
const SIMULATION_STOP_PATH = process.env.FIRSTOCK_SIMULATION_STOP_PATH || process.env.SIMULATION_STOP_PATH || "/stop";
const SIMULATION_STOP_METHOD = (process.env.FIRSTOCK_SIMULATION_STOP_METHOD || process.env.SIMULATION_STOP_METHOD || "POST").toUpperCase();
const BROKER_KEY = "firstock";
```

Then `"Bear Street"` → `"Firstock"` in the remaining log labels.

## 5. Adapt `validations/plugin.validation.js`

Replace `submitCredentialsSchema`:

```js
const submitCredentialsSchema = createSchema((body) => {
    const errors = [
        requireString(body.userId, "User ID is required"),
        requireString(body.api_key, "API key is required"),
        requireString(body.client_code, "Client code is required"),
        requireString(body.password, "Password is required"),
        requireString(body.vendor_code, "Vendor code is required")
    ].filter(Boolean);

    if (body.base_url !== undefined && body.base_url !== null && typeof body.base_url !== "string") {
        errors.push("Base URL must be a string");
    }

    if (errors.length > 0) {
        return { error: validationError(errors.join(", ")) };
    }

    return {
        value: {
            ...body,
            userId: body.userId.trim(),
            api_key: body.api_key.trim(),
            client_code: body.client_code.trim(),
            password: body.password.trim(),
            vendor_code: body.vendor_code.trim(),
            base_url: body.base_url?.trim() || body.base_url
        }
    };
});
```

## 6. Cosmetic log labels (optional but keep logs clean)

- `services/plugin.admin.service.js`: `[BearStreet Admin]` / `[BearStreet Maintenance]` → `[Firstock Admin]` / `[Firstock Maintenance]`.
- `services/plugin.data.service.js`: the ~12 `"Bear Street"` strings → `"Firstock"`.

## 7. Wire into the gateway

**`index.js`** — add the import and route:

```js
import firstockRoutes from "./modules/firstock/routes/plugin.routes.js";
...
router.use("/firstock", firstockRoutes);
```

**`server.js`** — add the simulation poller:

```js
import { startSimulationJobPoller as startFirstockSimulationJobPoller } from './modules/firstock/services/plugin.simulation.service.js';
...
startFirstockSimulationJobPoller();
```

**`.env`** — add:

```env
FIRSTOCK_PLUGIN_BASE_URL=http://34.205.29.123:8000
```

---

## Gateway → Firstock VM field mapping

| Gateway field | Firstock `BrokerCredentials` | Notes |
|---|---|---|
| `api_key` | `api_key` | Firstock `apiKey` |
| `client_code` | `client_code` | = Firstock `userId` |
| `password` | `password` | plain; the VM SHA256-hashes before `/login` |
| `vendor_code` | `vendor_code` | e.g. `AB1234_API` (VM defaults to `{client_code}_API` if omitted) |
| `totp` (via `/totp`) | `totp` | authenticator code, step 2 |
| *(not sent)* | `user_id_broker` | VM defaults to `client_code` |
| *(not sent)* | `websocket_url` | optional, VM has a default |

## Endpoints the gateway already calls (all present on the Firstock VM)

`/api/auth/credentials`, `/api/auth/totp`, `/api/trading/start`,
`/api/trading/start-simulation`, `/api/trading/stop-simulation/{id}` (+ `/status`),
`/api/trading/stop/{id}`, `/api/session/{id}/status`,
`/api/trading/{id}/exit-symbol/{sym}`, `/api/trading/{id}/final-tradebook`,
`/api/trading/live-pnl/{id}`, `/api/trading/exited-symbols/{id}`,
`/api/trading/pyramid-pnl/{id}` — identical response shapes to Bear Street.

## Verification

1. `node server.js` boots with `Firstock simulation poller started` in the logs.
2. `POST /api/v1/firstock/credentials` with `{ userId, api_key, client_code, password, vendor_code }` → returns `requires_totp: true` + `session_id`.
3. `POST /api/v1/firstock/totp` with `{ session_id, totp }` → session becomes `authenticated`.
4. `GET /api/v1/firstock/health` → shows `pluginBase: http://34.205.29.123:8000`.

## Gotchas

- **Firstock always requires TOTP.** `submitCredentials` will never land the session in
  `authenticated`; the frontend must always call `/totp`. The `auto_auth_on_credentials`
  path in `startTrading` is inert for Firstock (that's correct).
- **No silent re-login on the VM.** An expired `jKey` surfaces as
  `SESSION_EXPIRED_RELOGIN_REQUIRED` → user re-runs credentials + TOTP. The gateway's
  existing "not authenticated → 401" handling already covers this.
- **If the VM IP changes**, update `FIRSTOCK_PLUGIN_BASE_URL` in `.env` — do not rely on
  the hardcoded default.
