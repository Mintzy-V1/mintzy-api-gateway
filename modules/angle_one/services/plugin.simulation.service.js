import mongoose from "mongoose";
import TradingSession from "../../../models/tradingSession.js";
import SavedTradingConfiguration from "../../../models/savedTradingConfiguration.js";
import { startTrading, stopSimulationTrading } from "./plugin.trading.service.js";
import { forwardToPlugin, resolvePluginTargetUrl } from "./plugin.proxy.service.js";
import { buildSimulationStartPayload, normalizeSymbolKey, checkSimulationStartPayloadCompatibility, summarizeSimulationStartPayload } from "./plugin.payload.util.js";
import * as dataService from "./plugin.data.service.js";
import AppError from "../utils/AppError.js";
import logger from "../config/logger.js";

// const getPluginDb = () => mongoose.connection.useDb("mintzy_plugin");

const DATE_TIMEZONE = "Asia/Kolkata";

const SIMULATION_BASE_URL = (process.env.SIMULATION_BASE_URL || "http://18.205.165.28:8000").replace(/\/$/, "");
const SIMULATION_START_PATH = process.env.SIMULATION_START_PATH || "/api/trading/start-simulation";
const SIMULATION_JOB_STATUS_PATH = process.env.SIMULATION_JOB_STATUS_PATH || "/start-simulation/:jobId";
const SIMULATION_STOP_PATH = process.env.SIMULATION_STOP_PATH || "/stop";
const SIMULATION_STOP_METHOD = (process.env.SIMULATION_STOP_METHOD || "POST").toUpperCase();

const simGwElapsedMs = (startedAtMs) => Date.now() - startedAtMs;

const logSimGwTiming = (event, fields = {}) => {
    console.log(`[SIM-GW-TIMING] ${event}`, fields);
};
const SIMULATION_POLL_INTERVAL_MS = parseInt(process.env.SIMULATION_POLL_INTERVAL_MS || "60000", 10);
const SIMULATION_POLL_START_HOUR_IST = parseInt(process.env.SIMULATION_POLL_START_HOUR_IST || "12", 10);
const SIMULATION_POLL_START_MINUTE_IST = parseInt(process.env.SIMULATION_POLL_START_MINUTE_IST || "45", 10);
const SIMULATION_AUTO_STOP_HOUR_IST = parseInt(process.env.SIMULATION_AUTO_STOP_HOUR_IST || "12", 10);
const SIMULATION_AUTO_STOP_MINUTE_IST = parseInt(process.env.SIMULATION_AUTO_STOP_MINUTE_IST || "59", 10);
const SIMULATION_REQUEST_TIMEOUT = parseInt(process.env.SIMULATION_REQUEST_TIMEOUT || "60000", 10);

const ACTIVE_SIMULATION_STATUSES = ["pending", "running", "started"];
const CANCELLED_SIMULATION_STATUSES = ["cancelling", "cancelled"];
let pollerStarted = false;
let pollInProgress = false;
let lastAutoStopDateKey = null;

const isSimulationCancellationRequested = (session) =>
    Boolean(
        session
        && (
            session.simulation_cancel_requested
            || session.status === "stopped"
            || CANCELLED_SIMULATION_STATUSES.includes(session.simulation_status)
        )
    );

const buildSimulationCancelledResponse = (sessionId, session = null) => ({
    session_id: sessionId,
    configuration_id: session?.saved_configuration_id?.toString?.() || null,
    saved_configuration_id: session?.saved_configuration_id?.toString?.() || null,
    stop: null,
    live_trading: null,
    status: session?.status || "stopped",
    simulation_status: session?.simulation_status || "cancelled",
    cancelled: true,
    live_allowed: false,
    message: "Simulation was cancelled by user. Live trading will not start for this session."
});

const getStopSimulationFailureStatusCode = (err) => {
    const statusCode = Number(err?.statusCode || err?.response?.status || err?.details?.statusCode || err?.details?.status);
    return Number.isFinite(statusCode) ? statusCode : null;
};

const isStopSimulationVmUnavailableError = (err) => {
    const statusCode = getStopSimulationFailureStatusCode(err);
    if ([502, 503, 504].includes(statusCode)) return true;

    const message = String(err?.message || err?.cause?.message || "").toLowerCase();
    return (
        message.includes("timeout")
        || message.includes("timed out")
        || message.includes("fetch failed")
        || message.includes("network")
        || message.includes("econnrefused")
        || message.includes("econnreset")
        || message.includes("socket hang up")
    );
};

const failClosedStopSimulation = async (session, err) => {
    const stoppedAt = new Date();
    const sessionId = session.python_session_id;
    const statusCode = getStopSimulationFailureStatusCode(err);
    const details = err?.details || err?.response?.data || null;

    await TradingSession.findByIdAndUpdate(session._id, {
        $set: {
            status: "stopped",
            simulation_status: "stop_failed_vm_unavailable",
            simulation_cancel_requested: true,
            simulation_live_switch_triggered: false,
            simulation_completed_at: stoppedAt,
            ended_at: stoppedAt,
            simulation_output: {
                stop_error: {
                    message: err?.message || "Plugin VM unavailable during stop-simulation",
                    statusCode,
                    details
                },
                live_allowed: false,
                live_trading: null,
                fail_closed: true
            }
        }
    });

    dataService.stopLivePnlSnapshotMonitor(sessionId, session.user_id);
    await dataService.markPluginSessionStopped(sessionId, {
        stopped_at: stoppedAt,
        trading_status: "stopped",
        reason: "stop_simulation_vm_unavailable"
    }).catch((markErr) => {
        logger.warn("Failed to mark plugin session stopped after VM unavailable stop-simulation", {
            sessionId,
            error: markErr.message
        });
    });

    logger.error("Stop-simulation failed closed because plugin VM was unavailable", {
        sessionId,
        userId: session.user_id?.toString(),
        statusCode,
        error: err?.message
    });

    return {
        success: false,
        session_id: sessionId,
        configuration_id: session.saved_configuration_id?.toString?.() || null,
        saved_configuration_id: session.saved_configuration_id?.toString?.() || null,
        stop: null,
        live_trading: null,
        status: "stopped",
        simulation_status: "stop_failed_vm_unavailable",
        live_allowed: false,
        fail_closed: true,
        message: "Plugin VM was unavailable during stop-simulation. Gateway marked this session stopped and live trading will not start."
    };
};

const getIstDateParts = (date = new Date()) => {
    const formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: DATE_TIMEZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
    });
    const parts = formatter.formatToParts(date);
    const lookup = Object.fromEntries(parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));

    return {
        dateKey: `${lookup.year}-${lookup.month}-${lookup.day}`,
        hour: Number(lookup.hour),
        minute: Number(lookup.minute)
    };
};

const getTodayTradeDateIst = () => getIstDateParts().dateKey;

const isSimulationPollWindowOpen = (date = new Date()) => {
    const { hour, minute } = getIstDateParts(date);
    if (hour > SIMULATION_POLL_START_HOUR_IST) return true;
    if (hour === SIMULATION_POLL_START_HOUR_IST && minute >= SIMULATION_POLL_START_MINUTE_IST) return true;
    return false;
};

const getIstMinutesSinceMidnight = (date = new Date()) => {
    const { hour, minute } = getIstDateParts(date);
    return (hour * 60) + minute;
};

const getAutoStopMinutesSinceMidnight = () =>
    (SIMULATION_AUTO_STOP_HOUR_IST * 60) + SIMULATION_AUTO_STOP_MINUTE_IST;

const isSimulationAutoStopDue = (date = new Date()) =>
    getIstMinutesSinceMidnight(date) >= getAutoStopMinutesSinceMidnight();

const buildSimulationJobStatusPath = (jobId) =>
    SIMULATION_JOB_STATUS_PATH.replace(":jobId", encodeURIComponent(jobId));

const buildSimulationStopPath = (jobId) =>
    SIMULATION_STOP_PATH.includes(":jobId")
        ? SIMULATION_STOP_PATH.replace(":jobId", encodeURIComponent(jobId))
        : SIMULATION_STOP_PATH;

const parseResponseBody = async (response) => {
    const text = await response.text();
    if (!text) return null;

    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
};

const formatSimulationErrorDetail = (data) => {
    if (!data || typeof data !== "object") return null;

    if (typeof data.message === "string" && data.message.trim()) {
        return data.message;
    }

    const detail = data.detail ?? data.details;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) {
        return detail
            .map((entry) => entry?.msg || entry?.message || JSON.stringify(entry))
            .join("; ");
    }
    if (detail && typeof detail === "object") {
        return JSON.stringify(detail);
    }

    return null;
};

const callSimulationService = async (method, path, body = null, headers = {}, baseUrl = SIMULATION_BASE_URL) => {
    const resolvedBaseUrl = (baseUrl || SIMULATION_BASE_URL || "").replace(/\/$/, "");
    if (!resolvedBaseUrl) {
        throw new AppError("Simulation service is not configured (SIMULATION_BASE_URL)", 503);
    }

    const url = `${resolvedBaseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const options = {
        method: method.toUpperCase(),
        headers: {
            "Content-Type": "application/json",
            ...headers
        },
        signal: AbortSignal.timeout(SIMULATION_REQUEST_TIMEOUT)
    };

    if (body != null && method.toLowerCase() !== "get") {
        options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);
    const data = await parseResponseBody(response);

    if (!response.ok) {
        const detail = formatSimulationErrorDetail(data);
        const message = detail || `Simulation service returned status ${response.status}`;
        throw new AppError(message, response.status >= 400 && response.status < 500 ? response.status : 502);
    }

    return data;
};

const callPluginForSimulation = async (path, method, body, userId, targetBaseUrl) => {
    const callStartedMs = Date.now();
    logSimGwTiming("callPluginForSimulation ENTER", {
        path,
        method,
        targetBaseUrl,
        payload: summarizeSimulationStartPayload(body),
        configuration_id: body?.configuration_id || null
    });

    try {
        const pluginCallStartedMs = Date.now();
        const pluginRes = await forwardToPlugin(
            path,
            method,
            body,
            { "X-Forwarded-User": userId.toString() },
            {},
            {
                targetBaseUrl,
                timeoutMs: SIMULATION_REQUEST_TIMEOUT
            }
        );
        const pluginRoundTripMs = simGwElapsedMs(pluginCallStartedMs);

        logSimGwTiming("callPluginForSimulation plugin HTTP done", {
            path,
            pluginRoundTripMs,
            pluginStatus: pluginRes?.status,
            pluginTimingMs: pluginRes?.data?.timing_ms ?? null,
            success: pluginRes?.data?.success,
            configuration_id: pluginRes?.data?.configuration_id ?? body?.configuration_id ?? null
        });

        logSimGwTiming("callPluginForSimulation EXIT", {
            path,
            totalElapsedMs: simGwElapsedMs(callStartedMs),
            pluginRoundTripMs
        });

        return pluginRes?.data;
    } catch (err) {
        const pluginResponse = err.details || err.response?.data;
        const detail = formatSimulationErrorDetail(pluginResponse);

        logSimGwTiming("callPluginForSimulation ERROR", {
            path,
            targetBaseUrl,
            totalElapsedMs: simGwElapsedMs(callStartedMs),
            status: err.statusCode,
            detail,
            pluginResponse
        });

        logger.error("Simulation plugin request failed", {
            path,
            targetBaseUrl,
            status: err.statusCode,
            detail,
            pluginResponse
        });

        const errWithDetails = new AppError(
            detail || err.message || "Simulation plugin request failed",
            err.statusCode || 502
        );
        errWithDetails.details = pluginResponse;
        throw errWithDetails;
    }
};

/*
 * Capital reallocation from plugin DB (disabled — handled by external simulation VM).
 *
 * const getLogUnrealizedPnl = (log) =>
 *     Number(log?.unrealized_pnl ?? log?.unrealised_pnl ?? log?.symbol_unrealized_pnl ?? 0);
 *
 * const fetchPluginSessionFreeCash = async (sessionId) => { ... };
 * const getLatestLogsBySymbol = (logs) => { ... };
 * const getProfitableSymbolKeys = (latestLogsBySymbol) => { ... };
 * const getConfigurationAlphas = (configuration = {}) => { ... };
 * const reallocateProfitableAlphas = (alphas, profitableSymbolKeys, freeCash) => { ... };
 * const buildLiveHandoffFromSessionData = async (session) => { ... };
 */

const extractSymbolsFromJobResult = (jobResult, existingSymbols = []) => {
    const tickersConfig =
        jobResult?.tickers_config
        || jobResult?.result?.tickers_config
        || [];

    if (!Array.isArray(tickersConfig) || tickersConfig.length === 0) {
        return [];
    }

    const stopLossBySymbol = new Map();
    for (const entry of existingSymbols) {
        const key = normalizeSymbolKey(entry?.symbol || entry?.ticker);
        if (key && entry?.stop_loss != null) {
            stopLossBySymbol.set(key, entry.stop_loss);
        }
    }

    return tickersConfig
        .map((entry) => {
            const symbol = normalizeSymbolKey(entry?.ticker || entry?.symbol);
            const capital = Number(entry?.capital);

            if (!symbol) return null;

            const mapped = {
                symbol,
                capital: Number.isFinite(capital) ? capital : 0
            };

            if (stopLossBySymbol.has(symbol)) {
                mapped.stop_loss = stopLossBySymbol.get(symbol);
            }

            return mapped;
        })
        .filter(Boolean);
};

const mapExternalSimulationStatus = (status) => {
    if (!status) return "running";
    const normalized = String(status).toLowerCase();
    if (normalized === "started") return "running";
    if (["pending", "running", "completed", "failed"].includes(normalized)) return normalized;
    return "running";
};

const startSimulation = async (userId, payload = {}) => {
    const endpointStartedMs = Date.now();
    logSimGwTiming("startSimulation ENTER", {
        userId: userId?.toString(),
        session_id: payload.session_id || payload.sessionId,
        saved_configuration_id: payload.saved_configuration_id || payload.savedConfigurationId
    });

    const session_id = payload.session_id || payload.sessionId;
    const saved_configuration_id = payload.saved_configuration_id || payload.savedConfigurationId;
    const trade_date = payload.trade_date || getTodayTradeDateIst();

    if (!session_id) {
        throw new AppError("session_id is required", 400);
    }

    if (!saved_configuration_id || !mongoose.Types.ObjectId.isValid(saved_configuration_id)) {
        throw new AppError("saved_configuration_id is required", 400);
    }

    const ts = await TradingSession.findOne({
        python_session_id: session_id,
        user_id: userId
    });

    if (!ts) {
        throw new AppError("Trading session not found", 404);
    }

    if (ts.status === "simulation_active" && ACTIVE_SIMULATION_STATUSES.includes(ts.simulation_status)) {
        throw new AppError("Simulation is already active for this session", 409);
    }

    if (ts.status === "trading_active") {
        throw new AppError("Live trading is already active for this session", 409);
    }

    const savedConfiguration = await SavedTradingConfiguration.findOne({
        _id: saved_configuration_id,
        user_id: userId
    }).lean();

    if (!savedConfiguration) {
        throw new AppError("Saved trading configuration not found", 404);
    }

    const {
        session_id: _ignoredSessionId,
        saved_configuration_id: _ignoredSavedConfigId,
        savedConfigurationId: _ignoredSavedConfigIdCamel,
        trade_date: _ignoredTradeDate,
        ...runtimeOverrides
    } = payload;

    const mergedConfiguration = {
        ...(savedConfiguration.configuration || {}),
        ...runtimeOverrides,
        session_id
    };

    const simStartPayload = buildSimulationStartPayload(
        savedConfiguration.configuration || {},
        runtimeOverrides,
        session_id,
        {
            saved_configuration_id,
            leverage_multiplier: savedConfiguration.leverage_multiplier
        }
    );

    const payloadCompatibility = checkSimulationStartPayloadCompatibility(simStartPayload);
    logSimGwTiming("startSimulation payload built + compatibility check", {
        session_id,
        saved_configuration_id,
        configuration_id: simStartPayload.configuration_id || null,
        leverage_multiplier: simStartPayload.leverage_multiplier ?? null,
        compatible: payloadCompatibility.compatible,
        issues: payloadCompatibility.issues,
        outbound_payload: payloadCompatibility.outbound_payload,
        plugin_expects: payloadCompatibility.plugin_expects,
        buildPhaseMs: simGwElapsedMs(endpointStartedMs)
    });

    if (!Array.isArray(simStartPayload.symbols) || simStartPayload.symbols.length === 0) {
        throw new AppError("Saved configuration must include at least one symbol with capital > 0", 400);
    }

    const targetBaseUrl = resolvePluginTargetUrl(ts) || SIMULATION_BASE_URL;
    const statusCheckStartedMs = Date.now();
    const statusRes = await forwardToPlugin(
        `/api/session/${session_id}/status`,
        "get",
        null,
        { "X-Forwarded-User": userId.toString() },
        {},
        { timeoutMs: 8000, retries: 1, failOnError: false, targetBaseUrl }
    );

    const pluginStatus = statusRes && (statusRes.data?.status || null);
    logSimGwTiming("startSimulation plugin session status check", {
        session_id,
        pluginStatus,
        targetBaseUrl,
        statusCheckMs: simGwElapsedMs(statusCheckStartedMs)
    });

    // Plugin /api/trading/start-simulation requires status === "authenticated" exactly.
    if (pluginStatus !== "authenticated") {
        throw new AppError(
            `Session not authenticated for simulation. Current status: ${pluginStatus || "[no-status]"}`,
            pluginStatus === "trading_active" || pluginStatus === "running" ? 409 : 401
        );
    }

    logger.info("Starting Angle One simulation", {
        userId,
        session_id,
        saved_configuration_id,
        trade_date,
        targetBaseUrl,
        symbolCount: simStartPayload.symbols.length,
        strategy: simStartPayload.strategy,
        leverage_multiplier: simStartPayload.leverage_multiplier ?? null,
        payload: {
            ...simStartPayload,
            symbols: simStartPayload.symbols.map((entry) => entry.symbol)
        }
    });

    const pluginCallStartedMs = Date.now();
    const simResponse = await callPluginForSimulation(
        SIMULATION_START_PATH,
        "post",
        simStartPayload,
        userId,
        targetBaseUrl
    );
    logSimGwTiming("startSimulation plugin start-simulation returned", {
        session_id,
        pluginCallMs: simGwElapsedMs(pluginCallStartedMs),
        pluginTimingMs: simResponse?.timing_ms ?? null,
        success: simResponse?.success,
        mode: simResponse?.mode,
        configuration_id: simResponse?.configuration_id ?? simStartPayload.configuration_id ?? null
    });

    if (!simResponse || simResponse.success === false) {
        const message = formatSimulationErrorDetail(simResponse) || "Simulation start rejected by plugin";
        throw new AppError(message, 502);
    }

    logger.info("Angle One simulation plugin response received", {
        session_id,
        mode: simResponse?.mode,
        strategy: simResponse?.strategy,
        job_id: simResponse?.job_id || simResponse?.session_id || session_id
    });

    const job_id = simResponse?.job_id || simResponse?.session_id || session_id;

    ts.status = "simulation_active";
    ts.broker = "angle_one";
    ts.simulation_job_id = job_id;
    ts.simulation_status = mapExternalSimulationStatus(simResponse?.status || "started");
    ts.simulation_started_at = new Date();
    ts.simulation_completed_at = undefined;
    ts.simulation_cancel_requested = false;
    ts.simulation_live_switch_triggered = false;
    ts.simulation_live_started_at = undefined;
    ts.simulation_trade_date = trade_date;
    ts.simulation_output = undefined;
    ts.saved_configuration_id = savedConfiguration._id;
    ts.configuration_name = savedConfiguration.name;
    ts.trading_configuration = mergedConfiguration;
    await ts.save();
    dataService.startLivePnlSnapshotMonitor(ts.user_id, ts.python_session_id);

    logSimGwTiming("startSimulation EXIT success", {
        session_id,
        job_id,
        configuration_id: simStartPayload.configuration_id || null,
        totalElapsedMs: simGwElapsedMs(endpointStartedMs),
        pluginTimingMs: simResponse?.timing_ms ?? null
    });

    return {
        job_id,
        session_id,
        simulation_status: ts.simulation_status,
        trade_date,
        message: simResponse?.message || "Simulation started. Live trading begins after morning simulation completes."
    };
};

const finalizeSimulationNoTradeDay = async (session, { stopResponse, jobResult } = {}) => {
    await TradingSession.findByIdAndUpdate(session._id, {
        $set: {
            status: "stopped",
            simulation_status: "completed",
            simulation_completed_at: new Date(),
            simulation_live_switch_triggered: false,
            ended_at: new Date(),
            simulation_output: {
                stop: stopResponse,
                no_trade_day: true,
                ...(jobResult ? { external_job: jobResult } : {})
            }
        }
    });

    logger.info("Simulation completed with no tradeable symbols — session stopped", {
        sessionId: session.python_session_id,
        savedConfigurationId: session.saved_configuration_id?.toString()
    });

    return {
        session_id: session.python_session_id,
        configuration_id: session.saved_configuration_id?.toString(),
        saved_configuration_id: session.saved_configuration_id?.toString(),
        symbols: [],
        alphas: [],
        stop: stopResponse,
        status: "stopped",
        live_allowed: false,
        message: "Today is no trade day"
    };
};

const finalizeNoProfitableSymbolsSession = async (session, stopResponse) => {
    await TradingSession.findByIdAndUpdate(session._id, {
        $set: {
            status: "stopped",
            simulation_status: "completed",
            simulation_completed_at: new Date(),
            simulation_live_switch_triggered: false,
            ended_at: new Date(),
            simulation_output: {
                stop: stopResponse,
                no_profitable_symbols: true,
                pyramid: stopResponse?.pyramid || null
            }
        }
    });

    logger.info("Simulation stopped with no profitable symbols — session closed", {
        sessionId: session.python_session_id,
        savedConfigurationId: session.saved_configuration_id?.toString(),
        pyramidReason: stopResponse?.pyramid?.reason || stopResponse?.stopped_reason || null
    });

    return {
        session_id: session.python_session_id,
        configuration_id: session.saved_configuration_id?.toString(),
        saved_configuration_id: session.saved_configuration_id?.toString(),
        symbols: [],
        alphas: [],
        stop: stopResponse,
        status: "stopped",
        live_allowed: false,
        message:
            stopResponse?.message
            || "No profitable symbols after simulation. Session stopped — create a new session for live trading."
    };
};

const applySimulationOutputAndStartLive = async (session, jobResult = null) => {
    const userId = session.user_id?.toString();
    const savedConfigurationId = session.saved_configuration_id;

    const latestSession = await TradingSession.findById(session._id).lean();
    if (isSimulationCancellationRequested(latestSession)) {
        return buildSimulationCancelledResponse(session.python_session_id, latestSession);
    }

    if (!savedConfigurationId) {
        throw new AppError("Session is missing saved_configuration_id for live handoff", 500);
    }

    const savedConfiguration = await SavedTradingConfiguration.findOne({
        _id: savedConfigurationId,
        user_id: session.user_id
    });

    if (!savedConfiguration) {
        throw new AppError("Saved trading configuration not found for live handoff", 404);
    }

    if (jobResult) {
        const existingSymbols =
            savedConfiguration.configuration?.symbols
            || savedConfiguration.configuration?.alphas
            || [];
        const updatedSymbols = extractSymbolsFromJobResult(jobResult, existingSymbols);

        savedConfiguration.configuration = {
            ...(savedConfiguration.configuration || {}),
            symbols: updatedSymbols,
            alphas: updatedSymbols.map((entry, index) => ({
                symbol: entry.symbol,
                capital: entry.capital,
                rank: index + 1,
                ...(entry.stop_loss != null ? { stop_loss: entry.stop_loss } : {})
            }))
        };
        await savedConfiguration.save();

        logger.info("Simulation handoff: updated saved configuration from external job result", {
            sessionId: session.python_session_id,
            savedConfigurationId: savedConfiguration._id.toString(),
            symbols: updatedSymbols.map((entry) => entry.symbol)
        });

        if (updatedSymbols.length === 0) {
            const stopResponse = await stopSimulationTrading(userId, session.python_session_id);

            if (stopResponse?.success === false) {
                throw new AppError(stopResponse?.message || "Failed to stop simulation session", 502);
            }

            return finalizeSimulationNoTradeDay(session, { stopResponse, jobResult });
        }
    }

    let handoffResult;

    try {
        handoffResult = await executeSimulationToLiveHandoff(userId, session);
    } catch (err) {
        const latestSession = await TradingSession.findById(session._id).lean();
        if (isSimulationCancellationRequested(latestSession)) {
            return buildSimulationCancelledResponse(session.python_session_id, latestSession);
        }

        if (isStopSimulationVmUnavailableError(err)) {
            return failClosedStopSimulation(session, err);
        }

        session.simulation_live_switch_triggered = false;
        session.simulation_status = "handoff_failed";
        await session.save().catch(() => {});
        throw err;
    }

    await finalizeSimulationHandoff(session, handoffResult, jobResult ? { external_job: jobResult } : {});

    logger.info("Simulation handoff complete; live trading started", {
        sessionId: session.python_session_id,
        jobId: session.simulation_job_id
    });

    return {
        session_id: session.python_session_id,
        configuration_id: savedConfiguration._id.toString(),
        saved_configuration_id: savedConfiguration._id.toString(),
        alphas: savedConfiguration.configuration?.alphas || [],
        symbols: savedConfiguration.configuration?.symbols || [],
        configuration: savedConfiguration.configuration,
        stop: handoffResult.stopResponse,
        live_trading: handoffResult.liveStartResult
    };
};

/*
const triggerLiveHandoffInBackground = (sessionId) => {
    setImmediate(() => {
        TradingSession.findById(sessionId)
            .then(async (session) => {
                if (!session) return;
                await applySimulationOutputAndStartLive(session, null);
            })
            .catch(async (err) => {
                logger.error("Background simulation live handoff failed", {
                    sessionId,
                    error: err.message
                });

                await TradingSession.findByIdAndUpdate(sessionId, {
                    $set: {
                        simulation_status: "failed",
                        simulation_completed_at: new Date(),
                        "simulation_output.handoff_error": err.message
                    }
                }).catch(() => {});
            });
    });
};
*/

const fetchSimulationJobStatus = async (jobId) =>
    callSimulationService("get", buildSimulationJobStatusPath(jobId));

const stopSimulationJob = async (jobId, userId) => {
    const path = buildSimulationStopPath(jobId);
    const body = { job_id: jobId, userId: userId.toString() };

    if (SIMULATION_STOP_METHOD === "GET") {
        return callSimulationService("get", path);
    }

    return callSimulationService(SIMULATION_STOP_METHOD, path, body);
};

const updateSavedConfigurationStrategyForLive = async (savedConfigurationId) => {
    const savedConfiguration = await SavedTradingConfiguration.findById(savedConfigurationId);

    if (!savedConfiguration) {
        throw new AppError("Saved trading configuration not found", 404);
    }

    const currentConfiguration = savedConfiguration.configuration || {};
    const previousStrategy = currentConfiguration.strategy;

    savedConfiguration.configuration = {
        ...currentConfiguration,
        strategy: "C"
    };
    savedConfiguration.markModified("configuration");
    await savedConfiguration.save();

    logger.info("Updated saved configuration strategy for live trading", {
        savedConfigurationId: savedConfigurationId.toString(),
        previousStrategy,
        nextStrategy: "C"
    });

    return savedConfiguration;
};

const LIVE_TRADING_STATUSES = ["trading_active", "running", "started"];

const fetchPluginSessionStatus = async (userId, session) => {
    const session_id = session.python_session_id;
    const targetBaseUrl = resolvePluginTargetUrl(session);
    const statusRes = await forwardToPlugin(
        `/api/session/${session_id}/status`,
        "get",
        null,
        { "X-Forwarded-User": userId.toString() },
        {},
        { timeoutMs: 8000, retries: 1, failOnError: false, targetBaseUrl }
    );

    return statusRes?.data?.status || null;
};

const isLiveTradingConfirmed = async (userId, session) => {
    const pluginStatus = await fetchPluginSessionStatus(userId, session);
    const gatewayLive = LIVE_TRADING_STATUSES.includes(session.status);
    const pluginLive = LIVE_TRADING_STATUSES.includes(pluginStatus);

    console.log("[SIM-HANDOFF-DEBUG] isLiveTradingConfirmed", {
        session_id: session.python_session_id,
        gatewayStatus: session.status,
        pluginStatus,
        gatewayLive,
        pluginLive,
        confirmed: gatewayLive && pluginLive
    });

    return gatewayLive && pluginLive;
};

const executeSimulationToLiveHandoff = async (userId, session) => {
    const session_id = session.python_session_id;
    const handoffStartedMs = Date.now();

    console.log("[SIM-HANDOFF-DEBUG] executeSimulationToLiveHandoff START", { session_id });
    logSimGwTiming("executeSimulationToLiveHandoff ENTER", {
        session_id,
        saved_configuration_id: session.saved_configuration_id?.toString()
    });

    const stopStartedMs = Date.now();
    const stopResponse = await stopSimulationTrading(userId, session_id);
    logSimGwTiming("executeSimulationToLiveHandoff stop-simulation phase", {
        session_id,
        stopPhaseMs: simGwElapsedMs(stopStartedMs),
        stopPluginTimingMs: stopResponse?.timing_ms ?? null,
        configuration_id: stopResponse?.configuration_id ?? session.saved_configuration_id?.toString()
    });

    if (stopResponse?.success === false) {
        throw new AppError(stopResponse?.message || "Failed to stop simulation session", 502);
    }

    if (stopResponse?.live_allowed === false) {
        logSimGwTiming("executeSimulationToLiveHandoff blocked — no profitable symbols", {
            session_id,
            pyramid_reason: stopResponse?.pyramid?.reason || stopResponse?.stopped_reason || null,
            plugin_status: stopResponse?.status || null
        });
        const noLiveResult = await finalizeNoProfitableSymbolsSession(session, stopResponse);
        return {
            stopResponse,
            liveStartResult: null,
            noLiveResult
        };
    }

    logSimGwTiming("executeSimulationToLiveHandoff trusting stop-simulation response", {
        session_id,
        trading_status: stopResponse?.trading_status ?? null,
        configuration_id: stopResponse?.configuration_id ?? session.saved_configuration_id?.toString(),
        pluginTimingMs: stopResponse?.timing_ms ?? null,
        note: "post-stop worker/auth polling disabled — plugin stop is blocking and authoritative"
    });

    const latestSessionBeforeLive = await TradingSession.findById(session._id).lean();
    if (isSimulationCancellationRequested(latestSessionBeforeLive)) {
        return {
            stopResponse,
            liveStartResult: null,
            noLiveResult: buildSimulationCancelledResponse(session_id, latestSessionBeforeLive)
        };
    }

    await prepareSessionForLiveTrading(userId, session);

    const symbolsForLive = Array.isArray(stopResponse?.pyramid?.symbols_for_live)
        ? stopResponse.pyramid.symbols_for_live.filter((entry) => entry?.symbol && Number(entry?.capital) > 0)
        : [];

    const liveStartPayload = {
        session_id,
        saved_configuration_id: session.saved_configuration_id.toString(),
        strategy: "C"
    };

    if (symbolsForLive.length > 0) {
        liveStartPayload.symbols = symbolsForLive;
    }

    const liveStartResult = await startTrading(userId, liveStartPayload);

    const refreshedSession = await TradingSession.findById(session._id);
    const liveConfirmed = await isLiveTradingConfirmed(userId, refreshedSession || session);

    if (!liveConfirmed) {
        const pluginStatus = await fetchPluginSessionStatus(userId, refreshedSession || session);
        throw new AppError(
            `Live trading did not start on plugin. Gateway status: ${refreshedSession?.status || session.status}, plugin status: ${pluginStatus || "unknown"}`,
            502
        );
    }

    console.log("[SIM-HANDOFF-DEBUG] executeSimulationToLiveHandoff END — live confirmed", { session_id });
    logSimGwTiming("executeSimulationToLiveHandoff EXIT success", {
        session_id,
        totalElapsedMs: simGwElapsedMs(handoffStartedMs),
        stopPluginTimingMs: stopResponse?.timing_ms ?? null
    });

    return { stopResponse, liveStartResult };
};

const finalizeSimulationHandoff = async (session, handoffResult, extraOutput = {}) => {
    const { stopResponse, liveStartResult } = handoffResult;

    return TradingSession.findByIdAndUpdate(
        session._id,
        {
            $set: {
                simulation_status: "completed",
                simulation_completed_at: new Date(),
                simulation_live_switch_triggered: true,
                simulation_live_started_at: new Date(),
                simulation_output: {
                    stop: stopResponse,
                    live_start: liveStartResult,
                    ...extraOutput
                }
            }
        },
        { returnDocument: "after" }
    ).lean();
};

const prepareSessionForLiveTrading = async (userId, session) => {
    const session_id = session.python_session_id;
    const targetBaseUrl = resolvePluginTargetUrl(session);

    console.log("\n[SIM-HANDOFF-DEBUG] prepareSessionForLiveTrading START", {
        userId: userId?.toString(),
        session_id,
        gatewayStatus: session.status,
        saved_configuration_id: session.saved_configuration_id?.toString(),
        targetBaseUrl
    });

    const statusRes = await forwardToPlugin(
        `/api/session/${session_id}/status`,
        "get",
        null,
        { "X-Forwarded-User": userId.toString() },
        {},
        { timeoutMs: 8000, retries: 1, failOnError: false, targetBaseUrl }
    );

    const pluginStatus = statusRes?.data?.status;
    const gatewayTradingActive = session.status === "trading_active";
    const pluginTradingActive = pluginStatus === "trading_active";

    console.log("[SIM-HANDOFF-DEBUG] prepareSessionForLiveTrading status check", {
        session_id,
        gatewayStatus: session.status,
        pluginStatus,
        gatewayTradingActive,
        pluginTradingActive
    });

    if (gatewayTradingActive || pluginTradingActive) {
        logger.info("Resetting trading_active session to authenticated before live start", {
            session_id,
            gatewayStatus: session.status,
            pluginStatus
        });

        if (gatewayTradingActive) {
            session.status = "authenticated";
            await session.save();
            console.log("[SIM-HANDOFF-DEBUG] gateway status reset to authenticated", { session_id });
        }

        if (pluginTradingActive) {
            await dataService.resetPluginSessionToAuthenticated(session_id, {
                reason: "simulation_live_handoff"
            });
            console.log("[SIM-HANDOFF-DEBUG] plugin DB status reset to authenticated", { session_id });
        }
    }

    const latestSessionBeforeStrategyUpdate = await TradingSession.findById(session._id).lean();
    if (isSimulationCancellationRequested(latestSessionBeforeStrategyUpdate)) {
        throw new AppError("Simulation was cancelled by user. Live trading will not start for this session.", 409);
    }

    await updateSavedConfigurationStrategyForLive(session.saved_configuration_id);

    console.log("[SIM-HANDOFF-DEBUG] prepareSessionForLiveTrading END", {
        session_id,
        strategyUpdatedTo: "C"
    });
};

const stopSimulation = async (userId, payload = {}) => {
    const endpointStartedMs = Date.now();
    console.log("\n[SIM-HANDOFF-DEBUG] ========== stopSimulation START ==========", {
        userId: userId?.toString(),
        payload,
        at: new Date().toISOString()
    });
    logSimGwTiming("stopSimulation ENTER", {
        userId: userId?.toString(),
        session_id: payload.session_id || payload.sessionId,
        note: "stop uses session_id in URL only — no configuration_id in request body (plugin reads it from session store)"
    });

    const session_id = payload.session_id || payload.sessionId;

    if (!session_id) {
        throw new AppError("session_id is required", 400);
    }

    let session = await TradingSession.findOne({
        python_session_id: session_id,
        user_id: userId
    });

    if (!session) {
        console.log("[SIM-HANDOFF-DEBUG] stopSimulation ABORT — session not found", { session_id, userId });
        throw new AppError("Trading session not found", 404);
    }

    if (isSimulationCancellationRequested(session)) {
        console.log("[SIM-HANDOFF-DEBUG] stopSimulation SKIP - simulation cancelled/stopped", {
            session_id,
            gatewayStatus: session.status,
            simulation_status: session.simulation_status
        });
        return buildSimulationCancelledResponse(session_id, session);
    }

    if (!session.saved_configuration_id) {
        console.log("[SIM-HANDOFF-DEBUG] stopSimulation ABORT — missing saved_configuration_id", { session_id });
        throw new AppError("saved_configuration_id is missing on this session", 400);
    }

    if (session.simulation_live_switch_triggered) {
        if (session.simulation_status === "handoff_in_progress") {
            throw new AppError("Simulation live handoff is already in progress", 409);
        }

        const liveConfirmed = await isLiveTradingConfirmed(userId, session);

        if (liveConfirmed) {
            console.log("[SIM-HANDOFF-DEBUG] stopSimulation ABORT — live trading already active", { session_id });
            throw new AppError("Simulation already switched to live trading", 409);
        }

        console.log("[SIM-HANDOFF-DEBUG] stopSimulation RETRY — flag set but live not confirmed, resetting flag", {
            session_id,
            gatewayStatus: session.status
        });
        session.simulation_live_switch_triggered = false;
        await session.save();
    }

    const handoffSession = await TradingSession.findOneAndUpdate(
        {
            _id: session._id,
            status: "simulation_active",
            simulation_cancel_requested: { $ne: true },
            simulation_live_switch_triggered: { $ne: true },
            simulation_status: { $nin: ["handoff_in_progress", ...CANCELLED_SIMULATION_STATUSES] }
        },
        {
            $set: {
                simulation_status: "handoff_in_progress",
                simulation_live_switch_triggered: true
            }
        },
        { returnDocument: "after" }
    );

    if (!handoffSession) {
        const latestSession = await TradingSession.findById(session._id).lean();

        if (isSimulationCancellationRequested(latestSession)) {
            console.log("[SIM-HANDOFF-DEBUG] stopSimulation SKIP after lock - simulation cancelled/stopped", {
                session_id,
                gatewayStatus: latestSession?.status,
                simulation_status: latestSession?.simulation_status
            });
            return buildSimulationCancelledResponse(session_id, latestSession);
        }

        throw new AppError("Simulation live handoff is already in progress or session is not active", 409);
    }

    session = handoffSession;

    console.log("[SIM-HANDOFF-DEBUG] stopSimulation session loaded", {
        session_id,
        gatewayStatus: session.status,
        simulation_status: session.simulation_status,
        saved_configuration_id: session.saved_configuration_id?.toString(),
        vm_url: session.vm_url || null
    });

    logger.info("Stopping simulation then starting live trading", { userId, session_id });

    let handoffResult;

    try {
        handoffResult = await executeSimulationToLiveHandoff(userId, session);
    } catch (err) {
        const latestSession = await TradingSession.findById(session._id).lean();
        if (isSimulationCancellationRequested(latestSession)) {
            return buildSimulationCancelledResponse(session_id, latestSession);
        }

        if (isStopSimulationVmUnavailableError(err)) {
            return failClosedStopSimulation(session, err);
        }

        session.simulation_live_switch_triggered = false;
        session.simulation_status = "handoff_failed";
        await session.save().catch(() => {});
        throw err;
    }

    if (handoffResult.noLiveResult) {
        const updatedSession = await TradingSession.findById(session._id).lean();
        console.log("[SIM-HANDOFF-DEBUG] ========== stopSimulation END (no live) ==========", {
            session_id,
            finalGatewayStatus: updatedSession?.status,
            message: handoffResult.noLiveResult.message
        });
        logSimGwTiming("stopSimulation EXIT no_profitable_symbols", {
            session_id,
            saved_configuration_id: session.saved_configuration_id?.toString(),
            stopPluginTimingMs: handoffResult?.stopResponse?.timing_ms ?? null,
            totalElapsedMs: simGwElapsedMs(endpointStartedMs)
        });

        return {
            session_id,
            configuration_id: session.saved_configuration_id.toString(),
            saved_configuration_id: session.saved_configuration_id.toString(),
            stop: handoffResult.stopResponse,
            live_trading: null,
            status: "stopped",
            live_allowed: false,
            message: handoffResult.noLiveResult.message
        };
    }

    const updatedSession = await finalizeSimulationHandoff(session, handoffResult);

    console.log("[SIM-HANDOFF-DEBUG] ========== stopSimulation END ==========", {
        session_id,
        finalGatewayStatus: updatedSession?.status,
        simulation_live_switch_triggered: updatedSession?.simulation_live_switch_triggered,
        liveStartResult: handoffResult.liveStartResult
    });
    logSimGwTiming("stopSimulation EXIT success", {
        session_id,
        saved_configuration_id: session.saved_configuration_id?.toString(),
        stopPluginTimingMs: handoffResult?.stopResponse?.timing_ms ?? null,
        totalElapsedMs: simGwElapsedMs(endpointStartedMs)
    });

    return {
        session_id,
        configuration_id: session.saved_configuration_id.toString(),
        saved_configuration_id: session.saved_configuration_id.toString(),
        stop: handoffResult.stopResponse,
        live_trading: handoffResult.liveStartResult,
        status: updatedSession?.status,
        live_allowed: true,
        message: "Simulation stopped. Live trading started."
    };
};

const processSimulationSession = async (session) => {
    if (!session?.simulation_job_id) {
        return;
    }

    if (isSimulationCancellationRequested(session)) {
        return;
    }

    if (session.simulation_live_switch_triggered) {
        const liveConfirmed = await isLiveTradingConfirmed(session.user_id?.toString(), session);

        if (liveConfirmed) {
            return;
        }

        console.log("[SIM-POLLER-DEBUG] processSimulationSession RETRY — flag set but live not confirmed", {
            sessionId: session.python_session_id
        });
        session.simulation_live_switch_triggered = false;
        await session.save();
    }

    const jobResult = await fetchSimulationJobStatus(session.simulation_job_id);
    const externalStatus = String(jobResult?.status || "").toLowerCase();

    if (externalStatus === "failed") {
        session.simulation_status = "failed";
        session.simulation_output = jobResult;
        session.simulation_completed_at = new Date();
        await session.save();
        logger.warn("Simulation job failed", {
            sessionId: session.python_session_id,
            jobId: session.simulation_job_id
        });
        return;
    }

    if (externalStatus !== "completed") {
        session.simulation_status = mapExternalSimulationStatus(externalStatus);
        await session.save();
        return;
    }

    const lockedSession = await TradingSession.findOneAndUpdate(
        {
            _id: session._id,
            status: "simulation_active",
            simulation_cancel_requested: { $ne: true },
            simulation_live_switch_triggered: { $ne: true },
            simulation_status: { $nin: CANCELLED_SIMULATION_STATUSES },
            simulation_job_id: session.simulation_job_id
        },
        { $set: { simulation_status: "handoff_in_progress" } },
        { returnDocument: "after" }
    );

    if (!lockedSession) {
        return;
    }

    try {
        await applySimulationOutputAndStartLive(lockedSession, jobResult);
    } catch (err) {
        lockedSession.simulation_status = "failed";
        lockedSession.simulation_live_switch_triggered = false;
        lockedSession.simulation_output = {
            ...(typeof jobResult === "object" ? jobResult : {}),
            handoff_error: err.message
        };
        lockedSession.simulation_completed_at = new Date();
        await lockedSession.save();

        logger.error("Simulation live handoff failed", {
            sessionId: lockedSession.python_session_id,
            jobId: lockedSession.simulation_job_id,
            error: err.message
        });
    }
};

const pollDueSimulationJobs = async () => {
    if (!SIMULATION_BASE_URL) return;
    if (!isSimulationPollWindowOpen()) return;
    if (pollInProgress) return;

    pollInProgress = true;

    console.log("[SIM-POLLER-DEBUG] pollDueSimulationJobs tick", {
        at: new Date().toISOString(),
        simulationBaseUrl: SIMULATION_BASE_URL
    });

    try {
        const sessions = await TradingSession.find({
            broker: "angle_one",
            status: "simulation_active",
            simulation_cancel_requested: { $ne: true },
            simulation_live_switch_triggered: { $ne: true },
            simulation_job_id: { $exists: true, $ne: null },
            simulation_status: { $in: ACTIVE_SIMULATION_STATUSES }
        }).sort({ simulation_started_at: 1 });

        console.log("[SIM-POLLER-DEBUG] pollDueSimulationJobs sessions found", {
            count: sessions.length,
            sessionIds: sessions.map((s) => s.python_session_id)
        });

        for (const session of sessions) {
            try {
                console.log("[SIM-POLLER-DEBUG] processing session", {
                    sessionId: session.python_session_id,
                    jobId: session.simulation_job_id,
                    simulation_status: session.simulation_status
                });
                await processSimulationSession(session);
            } catch (err) {
                console.log("[SIM-POLLER-DEBUG] processSimulationSession FAILED", {
                    sessionId: session.python_session_id,
                    error: err.message
                });
                logger.warn("Simulation poll failed for session", {
                    sessionId: session.python_session_id,
                    jobId: session.simulation_job_id,
                    error: err.message
                });
            }
        }
    } finally {
        pollInProgress = false;
    }
};

const autoStopDueSimulations = async () => {
    const today = getTodayTradeDateIst();
    const istNow = getIstDateParts();

    if (!isSimulationAutoStopDue()) {
        return;
    }

    if (lastAutoStopDateKey === today) {
        return;
    }

    const sessions = await TradingSession.find({
        broker: "angle_one",
        status: "simulation_active",
        simulation_cancel_requested: { $ne: true },
        simulation_status: { $nin: ["handoff_in_progress", ...CANCELLED_SIMULATION_STATUSES] },
        simulation_trade_date: today
    }).sort({ simulation_started_at: 1 });

    console.log("\n[SIM-POLLER-DEBUG] ========== autoStopDueSimulations TRIGGERED ==========", {
        at: new Date().toISOString(),
        istNow: `${istNow.hour}:${String(istNow.minute).padStart(2, "0")}`,
        tradeDate: today,
        stopAtIst: `${SIMULATION_AUTO_STOP_HOUR_IST}:${String(SIMULATION_AUTO_STOP_MINUTE_IST).padStart(2, "0")}`,
        sessionCount: sessions.length,
        sessionIds: sessions.map((s) => s.python_session_id)
    });

    if (sessions.length === 0) {
        logger.info("Simulation auto-stop: no active sessions for today", {
            tradeDate: today,
            stopAtIst: `${SIMULATION_AUTO_STOP_HOUR_IST}:${String(SIMULATION_AUTO_STOP_MINUTE_IST).padStart(2, "0")}`
        });
        return;
    }

    lastAutoStopDateKey = today;

    logger.info("Simulation auto-stop triggered", {
        tradeDate: today,
        sessionCount: sessions.length,
        stopAtIst: `${SIMULATION_AUTO_STOP_HOUR_IST}:${String(SIMULATION_AUTO_STOP_MINUTE_IST).padStart(2, "0")}`
    });

    for (const session of sessions) {
        try {
            console.log("[SIM-POLLER-DEBUG] autoStop calling stopSimulation", {
                sessionId: session.python_session_id,
                userId: session.user_id?.toString()
            });
            await stopSimulation(session.user_id, { session_id: session.python_session_id });
            console.log("[SIM-POLLER-DEBUG] autoStop stopSimulation SUCCESS", {
                sessionId: session.python_session_id
            });
            logger.info("Simulation auto-stop completed", {
                sessionId: session.python_session_id,
                userId: session.user_id?.toString()
            });
        } catch (err) {
            console.log("[SIM-POLLER-DEBUG] autoStop stopSimulation FAILED", {
                sessionId: session.python_session_id,
                error: err.message,
                stack: err.stack
            });
            logger.warn("Simulation auto-stop failed for session", {
                sessionId: session.python_session_id,
                userId: session.user_id?.toString(),
                error: err.message
            });
        }
    }
};

const getSimulationStatus = async (userId, sessionId) => {
    const session = await TradingSession.findOne({
        python_session_id: sessionId,
        user_id: userId
    }).lean();

    if (!session) {
        throw new AppError("Trading session not found", 404);
    }

    const response = {
        session_id: sessionId,
        status: session.status,
        simulation_job_id: session.simulation_job_id || null,
        simulation_status: session.simulation_status || null,
        simulation_trade_date: session.simulation_trade_date || null,
        simulation_started_at: session.simulation_started_at || null,
        simulation_completed_at: session.simulation_completed_at || null,
        simulation_live_switch_triggered: session.simulation_live_switch_triggered || false,
        simulation_live_started_at: session.simulation_live_started_at || null,
        saved_configuration_id: session.saved_configuration_id || null
    };

    if (session.simulation_job_id && SIMULATION_BASE_URL) {
        try {
            response.external_job = await fetchSimulationJobStatus(session.simulation_job_id);
        } catch (err) {
            response.external_job_error = err.message;
        }
    }

    return response;
};

const startSimulationJobPoller = () => {
    if (pollerStarted) return;
    pollerStarted = true;

    console.log("[SIM-POLLER-DEBUG] Angle One simulation poller STARTED", {
        at: new Date().toISOString(),
        pollIntervalMs: SIMULATION_POLL_INTERVAL_MS,
        pollStartAtIst: `${SIMULATION_POLL_START_HOUR_IST}:${String(SIMULATION_POLL_START_MINUTE_IST).padStart(2, "0")}`,
        autoStopAtIst: `${SIMULATION_AUTO_STOP_HOUR_IST}:${String(SIMULATION_AUTO_STOP_MINUTE_IST).padStart(2, "0")}`,
        autoStopFromEnv: {
            hour: process.env.SIMULATION_AUTO_STOP_HOUR_IST ?? "(default)",
            minute: process.env.SIMULATION_AUTO_STOP_MINUTE_IST ?? "(default)"
        },
        simulationBaseUrl: SIMULATION_BASE_URL
    });

    setInterval(() => {
        console.log("[SIM-POLLER-DEBUG] poller interval tick", { at: new Date().toISOString() });
        pollDueSimulationJobs().catch((err) => {
            console.log("[SIM-POLLER-DEBUG] pollDueSimulationJobs tick error", { error: err.message });
            logger.error("Simulation poller tick failed", { error: err.message });
        });
        autoStopDueSimulations().catch((err) => {
            console.log("[SIM-POLLER-DEBUG] autoStopDueSimulations tick error", { error: err.message });
            logger.error("Simulation auto-stop tick failed", { error: err.message });
        });
    }, SIMULATION_POLL_INTERVAL_MS);

    logger.info("Angle One simulation poller started", {
        pollIntervalMs: SIMULATION_POLL_INTERVAL_MS,
        pollStartIst: `${SIMULATION_POLL_START_HOUR_IST}:${String(SIMULATION_POLL_START_MINUTE_IST).padStart(2, "0")}`,
        simulationBaseUrl: SIMULATION_BASE_URL || "(not configured)"
    });
};

export {
    startSimulation,
    stopSimulation,
    extractSymbolsFromJobResult,
    applySimulationOutputAndStartLive,
    pollDueSimulationJobs,
    autoStopDueSimulations,
    getSimulationStatus,
    startSimulationJobPoller,
    getTodayTradeDateIst,
    isSimulationPollWindowOpen
};

export default {
    startSimulation,
    stopSimulation,
    extractSymbolsFromJobResult,
    applySimulationOutputAndStartLive,
    pollDueSimulationJobs,
    autoStopDueSimulations,
    getSimulationStatus,
    startSimulationJobPoller,
    getTodayTradeDateIst,
    isSimulationPollWindowOpen
};
