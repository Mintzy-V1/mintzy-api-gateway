# Angle One Simulation Flow

## Short Summary

Angle One simulation starts after a user already has an authenticated broker/plugin session. When `start-simulation` is called, the gateway takes the selected saved trading configuration, converts it into a plugin-ready payload, forces it into strategy `B`, and starts a paper simulation worker on the plugin. The gateway stores the returned simulation job id and marks the session as `simulation_active`. After that, a background poller keeps watching the simulation. When the simulation finishes early, or when the configured auto-stop time arrives, the gateway stops the simulation worker, asks the plugin which symbols are suitable for live trading, and then either closes the session if there are no profitable symbols or switches the same session into live trading with strategy `C`. So the thing to remember is: strategy `B` runs the morning paper test, then stop/handoff filters the winners, and strategy `C` starts real trading only if there are winners.

## Main Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/angle_one/start-simulation` | Starts paper simulation for an authenticated Angle One session. |
| `POST` | `/api/v1/angle_one/stop-simulation` | Stops simulation, reads profitable symbols, and starts live trading if allowed. |
| `GET` | `/api/v1/angle_one/simulation/status/:sessionId` | Returns gateway simulation fields and external job status when available. |

## Start Simulation Flow

The request enters through `app.js`, then `index.js`, then `modules/angle_one/routes/plugin.routes.js`. The route points to `pluginController.startSimulation`, which extracts the logged-in user id and calls `simulationService.startSimulation(userId, req.body)`.

Inside `startSimulation`, the gateway reads `session_id`, `saved_configuration_id`, and optionally `trade_date`. If `trade_date` is not passed, it uses today's IST date. It loads the matching `TradingSession` and makes sure this same session is not already running simulation or live trading. Then it loads the selected `SavedTradingConfiguration`.

The saved configuration and request overrides are merged into a plugin payload by `buildSimulationStartPayload`. This payload always uses strategy `B`, includes normalized symbols, capital, stop loss, timeframe, candle when present, `use_broker_cash: false`, configuration id, and leverage if available. The gateway then checks that the payload shape looks compatible and that at least one valid symbol exists.

Before starting the simulation, the gateway asks the plugin for the session status with `GET /api/session/:session_id/status`. The plugin status must be exactly `authenticated`; otherwise the simulation is rejected because the plugin start-simulation endpoint expects an authenticated session.

After that, the gateway calls the plugin start-simulation endpoint, normally `POST /api/trading/start-simulation`, using the resolved plugin target URL. The plugin returns a simulation response, usually with a `job_id`. The gateway stores that job id in the session, marks the gateway session as `simulation_active`, stores `broker: "angle_one"`, records timestamps and the saved configuration id, and returns the job id and simulation status to the client.

## Manual Stop Simulation Flow

Manual stop starts from `POST /api/v1/angle_one/stop-simulation`. The controller calls `simulationService.stopSimulation(userId, req.body)`.

Inside `stopSimulation`, the gateway loads the session by `session_id` and user id. It requires that the session still has a `saved_configuration_id`, because the live handoff needs to know which configuration to start from. If the session says it already switched to live, the gateway verifies that both the gateway and plugin really agree live trading is active. If live is confirmed, it blocks duplicate handoff. If the flag is stale, it resets the flag and retries the handoff.

The real work happens in `executeSimulationToLiveHandoff`. First, it calls `stopSimulationTrading`, which sends `POST /api/trading/stop-simulation/:session_id` to the plugin. That tells the plugin to stop the paper simulation worker and return the simulation result, including whether live trading is allowed and which symbols should go live.

If the plugin returns `live_allowed: false`, the gateway does not start live trading. It calls `finalizeNoProfitableSymbolsSession`, marks the session as `stopped`, marks simulation as `completed`, stores the plugin stop/pyramid output, and returns a no-live response.

If live trading is allowed, the gateway prepares the session for live trading. `prepareSessionForLiveTrading` checks the plugin status, resets stale `trading_active` state back to `authenticated` when needed, and updates the saved configuration strategy to `C`. Then the gateway builds a live start payload using the saved configuration and any `symbols_for_live` returned by the plugin. It calls `startTrading`, which sends `POST /api/trading/start` to the plugin. After the plugin starts live trading, the gateway marks the session as `trading_active`, starts the live PnL snapshot monitor, marks the plugin DB session as trading active, confirms live status, and finally saves simulation handoff metadata.

## Automatic Stop And Handoff

The automatic behavior starts in `server.js`. When the server boots, it connects to MongoDB and calls `startAngleOneSimulationJobPoller()`, which is the `startSimulationJobPoller` export from the Angle One simulation service.

The poller runs every `SIMULATION_POLL_INTERVAL_MS`, default `60000` milliseconds. On every tick it calls two functions: `pollDueSimulationJobs()` and `autoStopDueSimulations()`.

`pollDueSimulationJobs()` starts working only after the configured poll window opens, default `12:45 PM IST`. It finds Angle One sessions where the gateway status is `simulation_active`, there is a `simulation_job_id`, the handoff flag is not already set, and the simulation status is still active. For each session it calls `processSimulationSession`. That function asks the external simulation status endpoint for the job status. If the job failed, the gateway marks the simulation failed. If the job is still running, the gateway just refreshes `simulation_status`. If the job is completed, the gateway locks the session into `handoff_in_progress` and calls `applySimulationOutputAndStartLive`.

`applySimulationOutputAndStartLive()` uses the external job result to update the saved configuration with the winning symbols. If the external result has no tradeable symbols, it stops the simulation worker and finalizes the day as no-trade. Otherwise, it calls the same core handoff logic used by manual stop: stop the simulation worker, switch strategy to `C`, start live trading, confirm live, and save completion metadata.

`autoStopDueSimulations()` is the clock-based path. After the configured auto-stop time, default `13:00 IST` unless environment variables override it, it finds today's active Angle One simulations and calls `stopSimulation(session.user_id, { session_id })` for each one. This means time-based auto-stop uses the exact same flow as the manual `/stop-simulation` endpoint.

## Important State Changes

| Moment | Session State |
| --- | --- |
| Simulation starts | `status = "simulation_active"`, `simulation_status = "running"` or mapped plugin status, `simulation_job_id` saved. |
| Simulation is still running | Poller keeps refreshing `simulation_status`. |
| Simulation fails externally | `simulation_status = "failed"`, external job result saved. |
| Simulation finishes with no winners | `status = "stopped"`, `simulation_status = "completed"`, no live trading. |
| Simulation switches to live | `status = "trading_active"`, `simulation_status = "completed"`, `simulation_live_switch_triggered = true`. |

## Controller Functions

File: `modules/angle_one/controllers/plugin.controller.js`

| Function | Purpose |
| --- | --- |
| `getRequestUserId` | Reads the authenticated user id from the request and throws if missing. |
| `getUserTradingSessions` | Returns all gateway trading sessions for the current user. |
| `getSavedTradingConfigurations` | Lists the user's saved trading configurations. |
| `getSavedTradingConfigurationById` | Fetches one saved configuration owned by the user. |
| `createSavedTradingConfiguration` | Creates a saved trading configuration, enforcing the per-user limit. |
| `updateSavedTradingConfiguration` | Updates name, description, or configuration fields for a saved configuration. |
| `deleteSavedTradingConfiguration` | Deletes a saved configuration owned by the user. |
| `updateLeverageMultiplier` | Updates leverage multiplier on a saved configuration. |
| `getActiveSession` | Returns the latest active-ish session for the user. |
| `getSessionById` | Returns one trading session by plugin/python session id. |
| `submitCredentials` | Passes broker credentials to the trading service. |
| `submitTotp` | Passes TOTP to the trading service for authentication. |
| `startSimulation` | Starts the Angle One simulation flow. |
| `stopSimulation` | Stops simulation and begins simulation-to-live handoff. |
| `getSimulationStatus` | Returns saved simulation status for a session. |
| `getPyramidPnl` | Returns pyramid PnL data for a session. |
| `startTrading` | Starts normal live trading. |
| `stopTradingBySessionId` | Stops live trading by URL session id and saves final PnL snapshot. |
| `stopTradingByBodyId` | Stops live trading by body `session_id` and saves final PnL snapshot. |
| `stopSession` | Marks a gateway session stopped and syncs monitor state. |
| `abandonSession` | Marks a non-live session as abandoned. |
| `getDashboardData` | Returns dashboard state for a requested or latest session. |
| `getPnlSummary` | Returns monthly PnL summary for one session. |
| `getUserPnlSummary` | Returns monthly PnL summary across the user. |
| `getSessionState` | Returns current session state or restores it from token. |
| `getTradingLogs` | Returns raw trading logs from plugin DB. |
| `getSessionStatus` | Returns plugin DB session status. |
| `downloadTradingLogs` | Sends trading logs as CSV. |
| `downloadFinalTradebook` | Streams final tradebook CSV from the plugin. |
| `adminStopSession` | Admin stop for a specific session plus monitor cleanup. |
| `adminForceStopAll` | Admin force-stop of all active plugin sessions plus monitor cleanup. |
| `deleteInvalidSessions` | Deletes bad gateway sessions missing plugin session ids. |
| `flushSessions` | Deletes all gateway sessions for the current user. |
| `stopOldSessions` | Marks previous-day sessions as stopped. |
| `deleteTradingSession` | Deletes a session by Mongo `_id` for the current user. |
| `deleteTradingSessionByIdParam` | Duplicate delete-by-id controller using `id` param. |
| `getAllSessions` | Returns all plugin DB sessions. |
| `getAllTradingLogs` | Debug helper that downloads logs for a hard-coded session. |
| `debugTradingLogs` | Shows debug shape, cycles, and samples for trading logs. |
| `testFinalPnl` | Debug helper to inspect final PnL stamped logs. |
| `getHealth` | Checks plugin health through the proxy. |
| `getLivePnl` | Returns current live PnL for a session. |
| `getLivePnlHistory` | Returns saved live PnL history. |
| `debugStopPluginSession` | Debug helper that marks plugin/gateway session stopped. |
| `stopSymbol` | Exits a single symbol from a live trading session. |

## Service Functions

### `plugin.simulation.service.js`

| Function | Purpose |
| --- | --- |
| `simGwElapsedMs` | Calculates elapsed milliseconds for timing logs. |
| `logSimGwTiming` | Writes simulation gateway timing logs. |
| `getIstDateParts` | Gets IST date, hour, and minute from a date. |
| `getTodayTradeDateIst` | Returns today's IST date key. |
| `isSimulationPollWindowOpen` | Checks whether the poller is allowed to poll completed jobs. |
| `getIstMinutesSinceMidnight` | Converts current IST time to minutes since midnight. |
| `getAutoStopMinutesSinceMidnight` | Converts configured auto-stop time to minutes since midnight. |
| `isSimulationAutoStopDue` | Checks whether the configured auto-stop time has arrived. |
| `buildSimulationJobStatusPath` | Builds the external job-status path by injecting the job id. |
| `buildSimulationStopPath` | Builds the external simulation stop path. |
| `parseResponseBody` | Parses fetch response as JSON when possible. |
| `formatSimulationErrorDetail` | Extracts readable error text from plugin/external responses. |
| `callSimulationService` | Calls the external simulation service for job status/stop style endpoints. |
| `callPluginForSimulation` | Calls the plugin for simulation start and wraps logging/errors. |
| `extractSymbolsFromJobResult` | Converts external job output into live-ready symbol/capital entries. |
| `mapExternalSimulationStatus` | Maps external job statuses into gateway simulation statuses. |
| `startSimulation` | Main start-simulation service: builds strategy `B` payload, calls plugin, saves simulation state. |
| `finalizeSimulationNoTradeDay` | Stops and records a completed simulation when external output has no tradeable symbols. |
| `finalizeNoProfitableSymbolsSession` | Stops and records a completed simulation when plugin says live is not allowed. |
| `applySimulationOutputAndStartLive` | Applies external simulation output and starts live trading when symbols exist. |
| `triggerLiveHandoffInBackground` | Commented-out older background handoff helper, not active. |
| `fetchSimulationJobStatus` | Fetches external simulation job status. |
| `stopSimulationJob` | Stops an external simulation job using configured method/path; currently not the main manual handoff path. |
| `updateSavedConfigurationStrategyForLive` | Updates saved config strategy to `C` before live trading. |
| `fetchPluginSessionStatus` | Gets plugin session status through the plugin proxy. |
| `isLiveTradingConfirmed` | Confirms both gateway and plugin report live trading. |
| `executeSimulationToLiveHandoff` | Core handoff: stop simulation worker, prepare live, start live, confirm live. |
| `finalizeSimulationHandoff` | Saves completed handoff metadata on the gateway session. |
| `prepareSessionForLiveTrading` | Resets stale live state if needed and prepares saved config for strategy `C`. |
| `stopSimulation` | Public manual/time-based stop flow that calls the core handoff. |
| `processSimulationSession` | Poller handler for one simulation session. |
| `pollDueSimulationJobs` | Finds active simulations and processes external job status after poll window opens. |
| `autoStopDueSimulations` | At configured time, automatically calls `stopSimulation` for today's active simulations. |
| `getSimulationStatus` | Returns gateway simulation fields and external job status if available. |
| `startSimulationJobPoller` | Starts the interval that polls jobs and performs auto-stop. |

### `plugin.trading.service.js`

| Function | Purpose |
| --- | --- |
| `sleep` | Waits before retry/poll attempts. |
| `isLivePluginStatus` | Checks if a plugin status means live trading is active. |
| `isTransientStopSimulationFailure` | Detects temporary stop-simulation failures worth retrying. |
| `invokeStopSimulationPlugin` | Calls plugin `POST /api/trading/stop-simulation/:sessionId`. |
| `extractPluginErrorDetail` | Extracts readable detail from plugin errors. |
| `checkMarketHours` | Checks whether current IST time is before market close; currently not enforced in this service. |
| `submitCredentials` | Sends Angle One credentials to plugin and creates/updates gateway session. |
| `verifyTotp` | Sends TOTP to plugin and marks gateway session authenticated. |
| `startTrading` | Starts live trading through plugin, updates session, starts live PnL monitor. |
| `stopSimulationTrading` | Stops the plugin simulation worker with one retry for transient failures. |
| `stopTrading` | Stops live trading and marks gateway/plugin state stopped. |
| `stopTradingSymbol` | Exits one symbol from a live trading session. |

### `plugin.payload.util.js`

| Function | Purpose |
| --- | --- |
| `normalizeSymbolKey` | Converts symbol/ticker text to uppercase trimmed form. |
| `normalizeStopLoss` | Converts stop-loss input into decimal form, defaulting to `0.05`. |
| `normalizePluginSymbol` | Converts a raw symbol entry into `{ symbol, capital, stop_loss }`. |
| `resolvePluginSymbols` | Chooses `symbols` or `alphas` from config and normalizes them. |
| `resolveLeverageMultiplier` | Finds the first valid non-negative leverage value. |
| `buildSimulationStartPayload` | Builds strategy `B` simulation payload for plugin start-simulation. |
| `summarizeSimulationStartPayload` | Produces a concise payload summary for logs/debugging. |
| `checkSimulationStartPayloadCompatibility` | Checks required shape before sending simulation payload to plugin. |
| `buildLiveTradingStartPayload` | Builds strategy `C` live trading payload for plugin start. |

### `plugin.proxy.service.js`

| Function | Purpose |
| --- | --- |
| `normalizeApiKey` | Removes whitespace from API keys before routing checks. |
| `shouldAutoAuthenticateApiKey` | Detects special API keys that should auto-authenticate. |
| `getTargetBaseUrlByApiKey` | Routes certain API keys to specific plugin VMs. |
| `resolvePluginTargetUrl` | Chooses session `vm_url` or default plugin base URL. |
| `getRoutingDebugInfo` | Returns useful routing/debug metadata. |
| `parseResponseBody` | Parses plugin response body as JSON when possible. |
| `forwardToPlugin` | Generic HTTP proxy helper for all plugin calls, with timeout/retry/error wrapping. |

### `plugin.data.service.js`

| Function | Purpose |
| --- | --- |
| `escapeCsvValue` | Escapes a value for CSV output. |
| `toCsv` | Converts rows into CSV text. |
| `getPluginDb` | Opens the `mintzy_plugin` database. |
| `fetchAllTradingLogs` | Reads all trading logs from plugin DB. |
| `fetchTradingLogs` | Reads logs for one plugin session. |
| `getTradingLogsDebugView` | Builds a debug view of log shape and cycles. |
| `getDateKeyFromTimestamp` | Converts a timestamp to an IST date key. |
| `getLivePnlMonitorKey` | Builds a unique live PnL monitor key. |
| `getLivePnlCollection` | Ensures and returns the live PnL history collection. |
| `toNumber` | Converts values to numbers with fallback. |
| `getSourceDateFromLivePnlData` | Finds the best date field from live PnL data. |
| `saveLivePnlSnapshot` | Saves one normalized live PnL snapshot. |
| `normalizeLivePnlSnapshot` | Normalizes raw live PnL snapshot values. |
| `buildMonthDateKeys` | Builds all date keys for a month. |
| `buildEmptyDailyFinalPnl` | Creates zero-value daily PnL rows for a month. |
| `resolveSymbolPnl` | Extracts PnL for one symbol/log row. |
| `normalizeSymbolKey` | Normalizes symbol names for PnL grouping. |
| `sumFinalPnlForLastCycle` | Sums final PnL for the latest cycle. |
| `computeLastCycleFinalPnlByDate` | Groups logs and computes latest-cycle final PnL by date. |
| `buildDailyFinalPnlFromMap` | Converts date/PnL map into daily rows. |
| `buildCurrentFromLogs` | Builds current PnL summary from logs. |
| `calculateDailyFinalPnl` | Calculates daily final PnL for a session. |
| `calculateDailyRealizedPnl` | Calculates daily realized PnL for a session. |
| `fetchTradingLogsBySessionIds` | Reads trading logs for multiple sessions. |
| `getTradingPnlSummary` | Builds monthly PnL summary for one session. |
| `getUserTradingPnlSummary` | Builds monthly PnL summary for all sessions of a user. |
| `syncStoppedPluginSessionToTradingSession` | Syncs stopped plugin session state back to gateway session. |
| `fetchSessionStatus` | Reads plugin session status and syncs stopped state. |
| `resetPluginSessionToAuthenticated` | Resets plugin DB session from live to authenticated for handoff retry. |
| `markPluginSessionAuthenticated` | Marks plugin DB session authenticated for special auto-auth flow. |
| `markPluginSessionTradingActive` | Marks plugin DB session trading active after live start. |
| `markPluginSessionStopped` | Marks plugin DB session stopped and syncs gateway state. |
| `debugStopPluginSession` | Debug helper to force plugin/gateway session stopped. |
| `getDashboardState` | Builds dashboard state from session/status/logs. |
| `generateLogsCSV` | Generates CSV text for trading logs. |
| `getAllSessions` | Reads all plugin DB sessions. |
| `restoreSession` | Restores session state from token via plugin. |
| `restorePluginSessionById` | Restores a plugin session by id through plugin API. |
| `restoreAuthenticatedSessionInPluginDb` | Marks a plugin DB session authenticated during restore. |
| `getFullSessionState` | Returns full gateway/plugin state for a session. |
| `saveFinalPnlSnapshot` | Saves final PnL into trading logs when stopping. |
| `fetchLivePnlFromPlugin` | Calls plugin live PnL endpoint. |
| `getPyramidPnl` | Calls plugin pyramid PnL endpoint. |
| `getLivePnl` | Gets current live PnL through plugin. |
| `stopLivePnlSnapshotMonitor` | Stops live PnL interval for a session. |
| `stopAllLivePnlSnapshotMonitors` | Stops all live PnL intervals. |
| `runLivePnlSnapshotTick` | One live PnL polling/saving tick. |
| `startLivePnlSnapshotMonitor` | Starts periodic live PnL snapshot saving. |
| `resumeLivePnlSnapshotMonitors` | Restarts live PnL monitors for active sessions after boot. |
| `getLivePnlHistory` | Reads saved live PnL history for a date. |

### `plugin.admin.service.js`

| Function | Purpose |
| --- | --- |
| `adminStopSession` | Calls plugin admin stop and marks gateway session stopped. |
| `forceStopAll` | Calls plugin force-stop-all and marks active gateway sessions stopped. |
| `flushSessions` | Deletes all gateway sessions for a user. |
| `deleteInvalidSessions` | Deletes malformed credential sessions. |
| `stopOldSessions` | Marks old sessions stopped. |
| `deleteTradingSessionByIdParam` | Deletes a gateway session by Mongo id for the user. |

### `rateLimiter.service.js`

| Function | Purpose |
| --- | --- |
| `rateLimiter.consume` | In-memory token bucket check allowing 100 requests per minute per key. |
