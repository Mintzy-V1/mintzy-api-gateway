import crypto from "crypto";
import TradingSession from "../../../models/tradingSession.js";
import SavedTradingConfiguration from "../../../models/savedTradingConfiguration.js";
import {
    forwardToPlugin,
    PLUGIN_BASE,
    resolvePluginTargetUrl
} from "./plugin.proxy.service.js";
import * as dataService from "./plugin.data.service.js";
import { buildLiveTradingStartPayload } from "./plugin.payload.util.js";
import AppError from "../utils/AppError.js";
import logger from "../config/logger.js";

const SIMULATION_STOP_RETRY_DELAY_MS = parseInt(process.env.SIMULATION_STOP_RETRY_DELAY_MS || "2000", 10);
const LIVE_TRADING_ACTIVE_STATUSES = ["trading_active", "running", "started"];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isLivePluginStatus = (status) => LIVE_TRADING_ACTIVE_STATUSES.includes(status);

const isTransientStopSimulationFailure = (err) => {
    if (!err) return false;

    const statusCode = err.statusCode || err.response?.status;
    if (statusCode === 502 || statusCode === 503 || statusCode === 504) {
        return true;
    }

    const message = String(err.message || "").toLowerCase();
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

const invokeStopSimulationPlugin = async (userId, sessionId, targetBaseUrl, stopRequestTimeoutMs) => {
    const pluginRes = await forwardToPlugin(
        `/api/trading/stop-simulation/${sessionId}`,
        "post",
        {},
        { "X-Forwarded-User": userId.toString() },
        {},
        { targetBaseUrl, timeoutMs: stopRequestTimeoutMs, retries: 0 }
    );

    if (!pluginRes?.data || typeof pluginRes.data !== "object") {
        throw new AppError("Plugin stop-simulation returned empty or invalid response", 502);
    }

    return pluginRes;
};

const extractPluginErrorDetail = (err) => {
    const detail = err?.details?.detail ?? err?.details ?? err?.message;
    if (typeof detail === "string") return detail;
    if (detail && typeof detail === "object") {
        return JSON.stringify(detail);
    }
    return "";
};

const normalizeCredentialsPayload = (payload = {}) => ({
    userId: payload.userId,
    api_key: payload.api_key,
    client_code: payload.client_code,
    password: payload.password,
    second_auth: payload.second_auth,
    source: payload.source || "WEBAPI",
    base_url: payload.base_url,
    token: payload.token
});

const submitCredentials = async (jwtUserId, payload = {}) => {
    const credentials = normalizeCredentialsPayload(payload);
    const {
        userId,
        api_key,
        client_code,
        password,
        second_auth,
        source,
        base_url,
        token
    } = credentials;

    if (!userId || !api_key || !client_code || !password || !second_auth) {
        throw new AppError("userId, api_key, client_code, password, and second_auth are required", 400);
    }

    logger.info("Submitting Bear Street credentials", { userId: jwtUserId, client_code });

    const targetBaseUrl = PLUGIN_BASE;
    const pluginPayload = {
        broker_type: "bear_street",
        api_key,
        client_code,
        password,
        second_auth,
        source,
        base_url,
        token
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
        broker: "bear_street",
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

const verifyTotp = async (userId, payload = {}) => {
    const session_id = payload.session_id || payload.sessionId;
    const totp = payload.totp;

    if (!session_id || !totp) {
        throw new AppError("session_id and totp are required", 400);
    }

    logger.info("Verifying Bear Street TOTP", { userId, session_id });

    const ts = await TradingSession.findOne({ python_session_id: session_id, user_id: userId });
    const targetBaseUrl = resolvePluginTargetUrl(ts);

    const pluginRes = await forwardToPlugin(
        "/api/auth/totp",
        "post",
        { session_id, totp },
        { "X-Forwarded-User": userId.toString() },
        {},
        { targetBaseUrl }
    );

    if (ts) {
        ts.status = "authenticated";
        await ts.save();
    }

    return pluginRes.data || {};
};

const startTrading = async (userId, payload = {}) => {
    console.log("\n[SIM-HANDOFF-DEBUG] startTrading START", {
        userId: userId?.toString(),
        payload
    });

    const {
        session_id: rawSessionId,
        saved_configuration_id,
        configuration_name,
        ...runtimeOverrides
    } = payload;
    const session_id = rawSessionId || payload.sessionId;

    if (!session_id) {
        throw new AppError("session_id is required", 400);
    }

    logger.info("Starting Bear Street trading session", { userId, session_id });

    const ts = await TradingSession.findOne({
        python_session_id: session_id,
        user_id: userId
    });

    if (!ts) {
        throw new AppError("Trading session not found", 404);
    }

    const targetBaseUrl = resolvePluginTargetUrl(ts);
    let savedConfiguration = null;

    console.log("[SIM-HANDOFF-DEBUG] startTrading session lookup", {
        session_id,
        targetBaseUrl,
        gatewayStatus: ts?.status || null,
        saved_configuration_id: saved_configuration_id || ts?.saved_configuration_id?.toString() || null
    });

    const resolvedSavedConfigurationId =
        saved_configuration_id
        || ts.saved_configuration_id?.toString()
        || null;

    if (resolvedSavedConfigurationId) {
        savedConfiguration = await SavedTradingConfiguration.findOne({
            _id: resolvedSavedConfigurationId,
            user_id: userId
        }).lean();

        if (!savedConfiguration) {
            throw new AppError("Saved trading configuration not found", 404);
        }
    }

    const startPayload = savedConfiguration
        ? buildLiveTradingStartPayload(
            savedConfiguration.configuration || {},
            runtimeOverrides,
            session_id,
            {
                saved_configuration_id: resolvedSavedConfigurationId,
                leverage_multiplier: savedConfiguration.leverage_multiplier
            }
        )
        : {
            ...runtimeOverrides,
            session_id,
            leverage_multiplier: runtimeOverrides.leverage_multiplier
                ?? runtimeOverrides.leverageMultiplier
                ?? 1
        };

    if (!Array.isArray(startPayload.symbols) || startPayload.symbols.length === 0) {
        throw new AppError("Live trading configuration has no valid symbols", 400);
    }

    console.log("[SIM-HANDOFF-DEBUG] startTrading payload built", {
        session_id,
        strategy: startPayload.strategy,
        configuration_id: startPayload.configuration_id || null,
        symbolCount: startPayload.symbols.length,
        time_frame: startPayload.time_frame,
        candle: startPayload.candle,
        use_broker_cash: startPayload.use_broker_cash,
        leverage_multiplier: startPayload.leverage_multiplier ?? null
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
    console.log("[SIM-HANDOFF-DEBUG] startTrading pre-start plugin status", {
        session_id,
        pluginStatus,
        statusResponse: statusRes?.data || null
    });

    const allowedStatuses = ["authenticated", "trading_active", "running", "started", "credentials_received"];

    if (!allowedStatuses.includes(pluginStatus)) {
        console.log("[SIM-HANDOFF-DEBUG] startTrading ABORT - session not authenticated", {
            session_id,
            pluginStatus
        });
        throw new AppError(
            `Session not authenticated. Current status: ${pluginStatus || "unknown"}`,
            401
        );
    }

    let pluginRes = null;

    if (isLivePluginStatus(pluginStatus)) {
        console.log("[SIM-HANDOFF-DEBUG] startTrading SKIP - plugin already live", {
            session_id,
            pluginStatus
        });
        logger.info("Bear Street plugin already live; skipping duplicate start", {
            userId,
            session_id,
            pluginStatus
        });
        pluginRes = {
            status: 200,
            data: {
                success: true,
                message: "Trading already active on plugin",
                session_id,
                skipped: true,
                plugin_status: pluginStatus
            }
        };
    } else {
        console.log("[SIM-HANDOFF-DEBUG] startTrading calling POST /api/trading/start", {
            session_id,
            targetBaseUrl
        });

        try {
            pluginRes = await forwardToPlugin(
                "/api/trading/start",
                "post",
                startPayload,
                { "X-Forwarded-User": userId.toString() },
                {},
                { targetBaseUrl }
            );
        } catch (err) {
            const detail = extractPluginErrorDetail(err);

            if (detail.toLowerCase().includes("already running")) {
                console.log("[SIM-HANDOFF-DEBUG] startTrading already-running - polling for live confirmation", {
                    session_id,
                    detail
                });
                logger.info("Bear Street plugin reported already running; polling for live confirmation", {
                    userId,
                    session_id,
                    detail
                });

                for (let attempt = 1; attempt <= 5; attempt += 1) {
                    await sleep(1000 * attempt);

                    const retryStatusRes = await forwardToPlugin(
                        `/api/session/${session_id}/status`,
                        "get",
                        null,
                        { "X-Forwarded-User": userId.toString() },
                        {},
                        { timeoutMs: 8000, retries: 0, failOnError: false, targetBaseUrl }
                    );
                    const retryStatus = retryStatusRes?.data?.status || null;

                    if (isLivePluginStatus(retryStatus)) {
                        pluginRes = {
                            status: 200,
                            data: {
                                success: true,
                                message: "Trading already active on plugin (recovered from already-running)",
                                session_id,
                                skipped: true,
                                plugin_status: retryStatus
                            }
                        };
                        break;
                    }
                }
            }

            if (!pluginRes) {
                throw err;
            }
        }
    }

    console.log("[SIM-HANDOFF-DEBUG] startTrading plugin response", {
        session_id,
        status: pluginRes?.status,
        data: pluginRes?.data
    });

    ts.status = "trading_active";
    ts.broker = ts.broker || "bear_street";
    ts.saved_configuration_id = savedConfiguration?._id;
    ts.configuration_name = savedConfiguration?.name || configuration_name || null;
    ts.trading_configuration = startPayload;
    await ts.save();
    dataService.startLivePnlSnapshotMonitor(ts.user_id, ts.python_session_id);

    await dataService.markPluginSessionTradingActive(session_id, {
        strategy: startPayload.strategy,
        symbols: startPayload.symbols,
        time_frame: startPayload.time_frame,
        candle: startPayload.candle
    }).catch((err) => {
        logger.warn("Failed to mark plugin session trading_active", {
            sessionId: session_id,
            error: err.message
        });
    });

    console.log("[SIM-HANDOFF-DEBUG] startTrading END - gateway session marked trading_active", {
        session_id,
        strategy: startPayload.strategy
    });

    return pluginRes ? pluginRes.data : null;
};

const stopSimulationTrading = async (userId, sessionId) => {
    const endpointStartedMs = Date.now();
    console.log("\n[SIM-HANDOFF-DEBUG] stopSimulationTrading START", {
        userId: userId?.toString(),
        sessionId
    });
    console.log("[SIM-GW-TIMING] stopSimulationTrading ENTER", {
        userId: userId?.toString(),
        sessionId,
        pluginPath: `/api/trading/stop-simulation/${sessionId}`,
        body: "(empty - session_id is path param only; matches plugin TradingConfig-free endpoint)"
    });

    logger.info("Stopping Bear Street simulation worker", { userId, sessionId });

    const lookupStartedMs = Date.now();
    const ts = await TradingSession.findOne({ python_session_id: sessionId });
    const targetBaseUrl = resolvePluginTargetUrl(ts);

    console.log("[SIM-HANDOFF-DEBUG] stopSimulationTrading target", {
        sessionId,
        targetBaseUrl,
        gatewayStatus: ts?.status || null,
        vm_url: ts?.vm_url || null,
        stored_configuration_id: ts?.saved_configuration_id?.toString?.() || null,
        sessionLookupMs: Date.now() - lookupStartedMs
    });

    const stopRequestTimeoutMs = parseInt(process.env.SIMULATION_STOP_REQUEST_TIMEOUT || "120000", 10);
    const pluginCallStartedMs = Date.now();

    let pluginRes = null;
    let attempt = 1;

    try {
        pluginRes = await invokeStopSimulationPlugin(
            userId,
            sessionId,
            targetBaseUrl,
            stopRequestTimeoutMs
        );
    } catch (firstErr) {
        if (!isTransientStopSimulationFailure(firstErr)) {
            throw firstErr;
        }

        console.log("[SIM-HANDOFF-DEBUG] stopSimulationTrading transient failure - retrying once", {
            sessionId,
            attempt: 1,
            error: firstErr.message,
            statusCode: firstErr.statusCode || firstErr.response?.status || null,
            retryDelayMs: SIMULATION_STOP_RETRY_DELAY_MS
        });

        await sleep(SIMULATION_STOP_RETRY_DELAY_MS);
        attempt = 2;
        pluginRes = await invokeStopSimulationPlugin(
            userId,
            sessionId,
            targetBaseUrl,
            stopRequestTimeoutMs
        );
    }

    const pluginRoundTripMs = Date.now() - pluginCallStartedMs;

    console.log("[SIM-HANDOFF-DEBUG] stopSimulationTrading plugin response", {
        sessionId,
        attempt,
        status: pluginRes?.status,
        data: pluginRes?.data
    });
    console.log("[SIM-GW-TIMING] stopSimulationTrading plugin HTTP done", {
        sessionId,
        attempt,
        pluginRoundTripMs,
        pluginTimingMs: pluginRes?.data?.timing_ms ?? null,
        success: pluginRes?.data?.success,
        live_allowed: pluginRes?.data?.live_allowed,
        configuration_id: pluginRes?.data?.configuration_id ?? null,
        trading_status: pluginRes?.data?.trading_status ?? null,
        pyramid_reason: pluginRes?.data?.pyramid?.reason ?? null,
        totalElapsedMs: Date.now() - endpointStartedMs
    });

    return pluginRes.data;
};

const stopTrading = async (userId, sessionId) => {
    logger.info("Stopping Bear Street session", { userId, sessionId });

    const ts = await TradingSession.findOne({ python_session_id: sessionId });
    const targetBaseUrl = resolvePluginTargetUrl(ts);

    let pluginRes = null;
    try {
        pluginRes = await forwardToPlugin(
            `/api/trading/stop/${sessionId}`,
            "post",
            {},
            { "X-Forwarded-User": userId.toString() },
            {},
            { targetBaseUrl }
        );
    } catch (err) {
        logger.warn("Plugin stop request failed; marking session stopped locally", {
            sessionId,
            error: err.message
        });
    }

    if (ts) {
        ts.status = "stopped";
        ts.ended_at = new Date();
        await ts.save();
        dataService.stopLivePnlSnapshotMonitor(sessionId, ts.user_id);
    }

    await dataService.markPluginSessionStopped(sessionId).catch((err) =>
        logger.warn("Failed to sync plugin_sessions stopped status", { sessionId, error: err.message })
    );

    return pluginRes?.data || { success: true, session_id: sessionId, worker_stopped: false };
};

const stopTradingSymbol = async (userId, sessionId, symbol) => {
    logger.info("Exiting Bear Street symbol from session", { userId, sessionId, symbol });

    const ts = await TradingSession.findOne({ python_session_id: sessionId });
    const targetBaseUrl = resolvePluginTargetUrl(ts);

    const pluginRes = await forwardToPlugin(
        `/api/trading/${sessionId}/exit-symbol/${symbol}`,
        "post",
        {},
        { "X-Forwarded-User": userId.toString() },
        {},
        { targetBaseUrl }
    );

    return pluginRes.data || {};
};

export {
    submitCredentials,
    verifyTotp,
    startTrading,
    stopSimulationTrading,
    stopTrading,
    stopTradingSymbol
};

export default {
    submitCredentials,
    verifyTotp,
    startTrading,
    stopSimulationTrading,
    stopTrading,
    stopTradingSymbol
};
