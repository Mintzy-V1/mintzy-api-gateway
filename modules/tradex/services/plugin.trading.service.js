import crypto from "crypto";
import TradingSession from "../../../models/tradingSession.js";
import SavedTradingConfiguration from "../../../models/savedTradingConfiguration.js";
import {
    forwardToPlugin,
    getTargetBaseUrlByApiKey,
    resolvePluginTargetUrl,
    shouldAutoAuthenticateApiKey
} from "./plugin.proxy.service.js";
import * as dataService from "./plugin.data.service.js";
import AppError from "../utils/AppError.js";
import logger from "../config/logger.js";
import { buildLiveTradingStartPayload } from "./plugin.payload.util.js";

const LIVE_TRADING_ACTIVE_STATUSES = ["trading_active", "running", "started"];

// The plugin's live-start path blocks up to 90s inside prepare_for_live_start, so the
// default 60s proxy timeout would abandon a request the plugin is still servicing.
const TRADING_START_TIMEOUT_MS = parseInt(process.env.PLUGIN_TRADING_START_TIMEOUT_MS || "120000", 10);
const SIMULATION_STOP_POST_TIMEOUT_MS = parseInt(process.env.SIMULATION_STOP_POST_TIMEOUT_MS || "20000", 10);
const SIMULATION_STOP_POLL_INTERVAL_MS = parseInt(process.env.SIMULATION_STOP_POLL_INTERVAL_MS || "2000", 10);
const SIMULATION_STOP_POLL_TIMEOUT_MS = parseInt(process.env.SIMULATION_STOP_POLL_TIMEOUT_MS || "180000", 10);
const SIMULATION_STOP_STATUS_REQUEST_TIMEOUT_MS = parseInt(
    process.env.SIMULATION_STOP_STATUS_REQUEST_TIMEOUT_MS || "15000",
    10
);
const SIMULATION_STOP_RETRY_DELAY_MS = parseInt(process.env.SIMULATION_STOP_RETRY_DELAY_MS || "10000", 10);

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

const invokeStopSimulationStatus = async (userId, sessionId, targetBaseUrl) => {
    const pluginRes = await forwardToPlugin(
        `/api/trading/stop-simulation/${sessionId}/status`,
        "get",
        null,
        { "X-Forwarded-User": userId.toString() },
        {},
        { targetBaseUrl, timeoutMs: SIMULATION_STOP_STATUS_REQUEST_TIMEOUT_MS, retries: 0 }
    );

    if (!pluginRes?.data || typeof pluginRes.data !== "object") {
        throw new AppError("Plugin stop-simulation status returned empty or invalid response", 502);
    }

    return pluginRes.data;
};

const isStopSimulationJobStopping = (data) =>
    data?.status === "stopping"
    || (data?.accepted === true && data?.ready === false);

const isStopSimulationJobFailed = (data) =>
    data?.status === "failed" || (data?.ready === true && data?.success === false);

const isStopSimulationJobReady = (data) => {
    if (!data || typeof data !== "object") {
        return false;
    }

    if (data.ready === true && data.success !== false) {
        return true;
    }

    if (
        data.success === true
        && !data.accepted
        && data.status !== "stopping"
        && (
            data.live_allowed !== undefined
            || data.status === "authenticated"
            || data.status === "stopped"
        )
    ) {
        return true;
    }

    return false;
};

const pollStopSimulationUntilReady = async (userId, sessionId, targetBaseUrl) => {
    const pollStartedMs = Date.now();
    let pollCount = 0;

    while (Date.now() - pollStartedMs < SIMULATION_STOP_POLL_TIMEOUT_MS) {
        pollCount += 1;
        const statusData = await invokeStopSimulationStatus(userId, sessionId, targetBaseUrl);

        console.log("[SIM-GW-TIMING] stopSimulationTrading poll tick", {
            sessionId,
            pollCount,
            status: statusData?.status,
            ready: statusData?.ready,
            live_allowed: statusData?.live_allowed,
            elapsedMs: Date.now() - pollStartedMs
        });

        if (isStopSimulationJobFailed(statusData)) {
            throw new AppError(
                statusData?.error || statusData?.message || "Simulation stop failed on plugin",
                502
            );
        }

        if (isStopSimulationJobReady(statusData)) {
            console.log("[SIM-GW-TIMING] stopSimulationTrading poll completed", {
                sessionId,
                pollCount,
                status: statusData?.status,
                ready: statusData?.ready,
                live_allowed: statusData?.live_allowed,
                elapsedMs: Date.now() - pollStartedMs
            });
            return statusData;
        }

        await sleep(SIMULATION_STOP_POLL_INTERVAL_MS);
    }

    throw new AppError(
        `Simulation stop did not complete within ${SIMULATION_STOP_POLL_TIMEOUT_MS}ms`,
        504
    );
};

const tryRecoverStopSimulationFromStatus = async (userId, sessionId, targetBaseUrl) => {
    try {
        const statusData = await invokeStopSimulationStatus(userId, sessionId, targetBaseUrl);

        if (isStopSimulationJobReady(statusData)) {
            console.log("[SIM-HANDOFF-DEBUG] stopSimulationTrading recovered via status poll", {
                sessionId,
                status: statusData?.status,
                ready: statusData?.ready
            });
            return statusData;
        }

        if (isStopSimulationJobStopping(statusData)) {
            console.log("[SIM-HANDOFF-DEBUG] stopSimulationTrading POST failed but job is stopping — polling", {
                sessionId,
                status: statusData?.status,
                phase: statusData?.phase
            });
            return pollStopSimulationUntilReady(userId, sessionId, targetBaseUrl);
        }
    } catch (pollErr) {
        console.log("[SIM-HANDOFF-DEBUG] stopSimulationTrading status recovery failed", {
            sessionId,
            error: pollErr.message
        });
    }

    return null;
};

const resolveStopSimulationResponse = async (userId, sessionId, targetBaseUrl, pluginRes) => {
    const data = pluginRes?.data;

    if (isStopSimulationJobReady(data) && !isStopSimulationJobStopping(data)) {
        return data;
    }

    if (pluginRes?.status === 202 || isStopSimulationJobStopping(data)) {
        console.log("[SIM-HANDOFF-DEBUG] stopSimulationTrading async accept — polling for completion", {
            sessionId,
            httpStatus: pluginRes?.status,
            pluginStatus: data?.status
        });
        return pollStopSimulationUntilReady(userId, sessionId, targetBaseUrl);
    }

    if (data?.success === true) {
        return data;
    }

    throw new AppError("Unexpected stop-simulation response from plugin", 502);
};

const extractPluginErrorDetail = (err) => {
    const detail = err?.details?.detail ?? err?.details ?? err?.message;
    if (typeof detail === "string") return detail;
    if (detail && typeof detail === "object") {
        return JSON.stringify(detail);
    }
    return "";
};

const AUTO_AUTH_PLUGIN_BASE_URL = process.env.PLUGIN_AUTO_AUTH_BASE_URL || "http://32.198.166.49:8000";
const TRADEX_BASE_URL = "https://tradex.markethubonline.com:30001/TradeXApi/v1";

const checkMarketHours = () => {
    const now = new Date();
    const istTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const hours = istTime.getHours();
    const minutes = istTime.getMinutes();

    return !(hours > 15 || (hours === 15 && minutes >= 30));
};

const normalizeCredentialsPayload = (payload = {}) => {
    console.log("\n--- normalizeCredentialsPayload INPUT ---");
    console.log("Raw payload:", payload);
    
    const userId = payload.userId;
    const access_key = payload.access_key || payload.accessKey;
    const access_secret = payload.access_secret || payload.accessSecret;
    const base_url = TRADEX_BASE_URL;
    const token = payload.token;

    const normalized = {
        userId,
        access_key,
        access_secret,
        base_url,
        token
    };
    
    console.log("Normalized credentials:", normalized);
    console.log("--- normalizeCredentialsPayload OUTPUT ---\n");
    
    return normalized;
};

const submitCredentials = async (_jwtUserId, payload = {}) => {
    console.log("\n\n========================================");
    console.log("SERVICE: submitCredentials START");
    console.log("========================================");
    console.log("Parameter _jwtUserId:", _jwtUserId, "(type:", typeof _jwtUserId, ")");
    console.log("Parameter payload:", payload);
    
    const credentials = normalizeCredentialsPayload(payload);
    const { userId, access_key, access_secret, base_url, token } = credentials;

    console.log("\nAfter normalization:");
    console.log("  userId:", userId);
    console.log("  access_key:", access_key);
    console.log("  access_secret:", access_secret);
    console.log("  token:", token);

    if (!userId || !access_key || !access_secret) {
        console.log("\n❌ VALIDATION FAILED - Missing required fields");
        throw new AppError("userId, access_key, and access_secret are required", 400);
    }
    
    console.log("✅ Validation passed");
    logger.info("Submitting TradeX credentials", { userId });

    // if (!checkMarketHours()) {
    //     throw new AppError("Market is closed. Access denied after 3:30 PM IST.", 400);
    // }

    const targetBaseUrl = getTargetBaseUrlByApiKey(access_key);
    console.log("\ngetTargetBaseUrlByApiKey returned:", targetBaseUrl);
    
    const autoAuthOnCredentials = shouldAutoAuthenticateApiKey(access_key);
    console.log("shouldAutoAuthenticateApiKey returned:", autoAuthOnCredentials);
    
    const pluginPayload = {
        broker_type: "tradex",
        api_key: access_key,
        client_code: userId,
        password: access_secret,
        base_url,
        token
    };
    console.log("\nPluginPayload to send:", pluginPayload);

    console.log("\nCalling forwardToPlugin...");
    const pluginRes = await forwardToPlugin(
        "/api/auth/credentials",
        "post",
        pluginPayload,
        { "X-Forwarded-User": userId.toString() },
        {},
        { targetBaseUrl }
    );

    console.log("\nforwardToPlugin response:", pluginRes);
    
    const pluginData = pluginRes.data || {};
    console.log("pluginData extracted:", pluginData);
    
    const pythonSessionId = pluginData.session_id;
    console.log("pythonSessionId:", pythonSessionId, "(type:", typeof pythonSessionId, ")");
    
    let initialPluginStatus = pluginData.status || "authenticated";
    console.log("initialPluginStatus:", initialPluginStatus);

    if (pluginData.requires_totp === false) {
        initialPluginStatus = "authenticated";
        pluginData.status = "authenticated";
        console.log("Updated initialPluginStatus (no TOTP required):", initialPluginStatus);
    }

    if (!pythonSessionId) {
        console.log("\n❌ ERROR: pythonSessionId is missing");
        throw new AppError("Failed to create trading engine session", 502);
    }
    
    console.log("✅ pythonSessionId received successfully");

    const fingerprint = crypto
        .createHash("sha256")
        .update(`${access_key}:${userId}`)
        .digest("hex");
    console.log("\nGenerated fingerprint:", fingerprint);

    const sessionData = {
        user_id: userId,
        python_session_id: pythonSessionId,
        status: autoAuthOnCredentials && initialPluginStatus === "credentials_received"
            ? "authenticated"
            : initialPluginStatus,
        credentials_fingerprint: fingerprint,
        vm_url: targetBaseUrl,
        auto_auth_on_credentials: autoAuthOnCredentials
    };
    
    console.log("\n🔐 DATA BEING SAVED TO TRADINGSESSION:");
    console.log("  user_id:", sessionData.user_id, "(type:", typeof sessionData.user_id, ")");
    console.log("  python_session_id:", sessionData.python_session_id);
    console.log("  status:", sessionData.status);
    console.log("  credentials_fingerprint:", sessionData.credentials_fingerprint);
    console.log("  vm_url:", sessionData.vm_url);
    console.log("  auto_auth_on_credentials:", sessionData.auto_auth_on_credentials);
    
    console.log("\nAttempting TradingSession.create()...");
    const ts = await TradingSession.create({
        user_id: _jwtUserId,
        python_session_id: pythonSessionId,
        status: sessionData.status,
        credentials_fingerprint: fingerprint,
        vm_url: targetBaseUrl,
        auto_auth_on_credentials: autoAuthOnCredentials
    });

    console.log("✅ TradingSession created successfully:", ts._id);
    
    if (autoAuthOnCredentials && initialPluginStatus === "credentials_received") {
        console.log("\nMarking plugin session as authenticated...");
        await dataService.markPluginSessionAuthenticated(pythonSessionId, {
            reason: "special_access_key_credentials_received"
        });
        pluginData.status = "authenticated";
        console.log("✅ Plugin session marked authenticated");
    }

    const response = {
        ...pluginData,
        node_session_id: ts._id,
        ts
    };
    
    console.log("\nReturning response from SERVICE:");
    console.log(response);
    console.log("========================================");
    console.log("SERVICE: submitCredentials END");
    console.log("========================================\n\n");
    
    return response;
};

const verifyTotp = async (userId, payload = {}) => {
    const session_id = payload.session_id || payload.sessionId;
    const totp = payload.totp;

    if (!session_id || !totp) {
        throw new AppError("session_id and totp are required", 400);
    }

    logger.info("Verifying TradeX TOTP", { userId, session_id });

    const ts = await TradingSession.findOne({ python_session_id: session_id });
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

    logger.info("Starting TradeX session", { userId, session_id });

    const ts = await TradingSession.findOne({ python_session_id: session_id });
    const targetBaseUrl = resolvePluginTargetUrl(ts);
    let savedConfiguration = null;

    if (ts?.simulation_cancel_requested || ["cancelling", "cancelled"].includes(ts?.simulation_status)) {
        throw new AppError("Simulation was cancelled by user. Live trading will not start for this session.", 409);
    }

    const resolvedSavedConfigurationId =
        saved_configuration_id
        || ts?.saved_configuration_id?.toString()
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

    const startPayload = buildLiveTradingStartPayload(
        savedConfiguration?.configuration || {},
        runtimeOverrides,
        session_id,
        {
            saved_configuration_id: resolvedSavedConfigurationId,
            leverage_multiplier: savedConfiguration?.leverage_multiplier
        }
    );

    if (!Array.isArray(startPayload.symbols) || startPayload.symbols.length === 0) {
        throw new AppError("Live trading configuration has no valid symbols", 400);
    }

    const statusRes = await forwardToPlugin(
        `/api/session/${session_id}/status`,
        "get",
        null,
        { "X-Forwarded-User": userId.toString() },
        {},
        { timeoutMs: 8000, retries: 1, failOnError: false, targetBaseUrl }
    );

    const pluginStatus = statusRes && (statusRes.data?.status || null);
    const isAuthenticated = pluginStatus && ["authenticated", "running", "started", "trading_active", "credentials_received"].includes(pluginStatus);

    if (!isAuthenticated) {
        throw new AppError(`Session not authenticated. Current status: ${pluginStatus || "[no-status]"}`, 401);
    }

    const shouldAutoAuthSession = ts?.auto_auth_on_credentials || targetBaseUrl === AUTO_AUTH_PLUGIN_BASE_URL;

    if (shouldAutoAuthSession && pluginStatus === "credentials_received") {
        await dataService.markPluginSessionAuthenticated(session_id, {
            reason: "special_access_key_before_start"
        });
    }

    let pluginRes = null;

    if (isLivePluginStatus(pluginStatus)) {
        pluginRes = {
            status: 200,
            data: {
                success: true,
                message: "Trading already active on plugin",
                session_id,
                skipped: true
            }
        };
    } else {
        try {
            pluginRes = await forwardToPlugin(
                "/api/trading/start",
                "post",
                startPayload,
                { "X-Forwarded-User": userId.toString() },
                {},
                // Starting is not idempotent: a proxy-level retry can spawn a second
                // live worker on the same session. Recovery is handled below instead.
                { targetBaseUrl, timeoutMs: TRADING_START_TIMEOUT_MS, retries: 0 }
            );
        } catch (err) {
            const detail = extractPluginErrorDetail(err);

            // Any failure here — "already running", a timeout, a dropped connection —
            // can still leave the plugin live, so confirm before treating it as failed.
            {
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

    if (ts) {
        ts.status = "trading_active";
        ts.broker = ts.broker || "tradex";
        ts.saved_configuration_id = savedConfiguration?._id;
        ts.configuration_name = savedConfiguration?.name || configuration_name || null;
        ts.trading_configuration = startPayload;
        await ts.save();
        dataService.startLivePnlSnapshotMonitor(ts.user_id, ts.python_session_id);
    }

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

    return pluginRes ? pluginRes.data : null;
};

const stopSimulationTrading = async (userId, sessionId, options = {}) => {
    const { onStopPollComplete } = options;
    const endpointStartedMs = Date.now();
    console.log("\n[SIM-HANDOFF-DEBUG] stopSimulationTrading START", {
        userId: userId?.toString(),
        sessionId
    });
    console.log("[SIM-GW-TIMING] stopSimulationTrading ENTER", {
        userId: userId?.toString(),
        sessionId,
        pluginPath: `/api/trading/stop-simulation/${sessionId}`,
        body: "(empty — session_id is path param only; matches plugin TradingConfig-free endpoint)"
    });

    logger.info("Stopping TradeX simulation worker", { userId, sessionId });

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

    const stopPostTimeoutMs = parseInt(
        process.env.SIMULATION_STOP_POST_TIMEOUT_MS || String(SIMULATION_STOP_POST_TIMEOUT_MS),
        10
    );
    const pluginCallStartedMs = Date.now();

    let pluginRes = null;
    let attempt = 1;
    let stopResponse = null;

    try {
        pluginRes = await invokeStopSimulationPlugin(
            userId,
            sessionId,
            targetBaseUrl,
            stopPostTimeoutMs
        );
        stopResponse = await resolveStopSimulationResponse(
            userId,
            sessionId,
            targetBaseUrl,
            pluginRes
        );
    } catch (firstErr) {
        const recovered = await tryRecoverStopSimulationFromStatus(userId, sessionId, targetBaseUrl);
        if (recovered) {
            stopResponse = recovered;
        } else if (!isTransientStopSimulationFailure(firstErr)) {
            throw firstErr;
        } else {
            console.log("[SIM-HANDOFF-DEBUG] stopSimulationTrading transient failure — poll then retry POST", {
                sessionId,
                attempt: 1,
                error: firstErr.message,
                statusCode: firstErr.statusCode || firstErr.response?.status || null,
                retryDelayMs: SIMULATION_STOP_RETRY_DELAY_MS
            });

            await sleep(SIMULATION_STOP_RETRY_DELAY_MS);
            attempt = 2;

            const recoveredAfterDelay = await tryRecoverStopSimulationFromStatus(
                userId,
                sessionId,
                targetBaseUrl
            );
            if (recoveredAfterDelay) {
                stopResponse = recoveredAfterDelay;
            } else {
                pluginRes = await invokeStopSimulationPlugin(
                    userId,
                    sessionId,
                    targetBaseUrl,
                    stopPostTimeoutMs
                );
                stopResponse = await resolveStopSimulationResponse(
                    userId,
                    sessionId,
                    targetBaseUrl,
                    pluginRes
                );
            }
        }
    }

    const pluginRoundTripMs = Date.now() - pluginCallStartedMs;

    console.log("[SIM-HANDOFF-DEBUG] stopSimulationTrading plugin response", {
        sessionId,
        attempt,
        httpStatus: pluginRes?.status ?? null,
        pluginStatus: stopResponse?.status,
        ready: stopResponse?.ready
    });
    console.log("[SIM-GW-TIMING] stopSimulationTrading plugin HTTP done", {
        sessionId,
        attempt,
        pluginRoundTripMs,
        pluginTimingMs: stopResponse?.timing_ms ?? pluginRes?.data?.timing_ms ?? null,
        success: stopResponse?.success,
        live_allowed: stopResponse?.live_allowed,
        configuration_id: stopResponse?.configuration_id ?? null,
        trading_status: stopResponse?.trading_status ?? null,
        pyramid_reason: stopResponse?.pyramid?.reason ?? null,
        totalElapsedMs: Date.now() - endpointStartedMs
    });

    if (typeof onStopPollComplete === "function") {
        await onStopPollComplete(stopResponse);
    }

    return stopResponse;
};

const stopTrading = async (userId, sessionId) => {
    logger.info("Stopping TradeX session", { userId, sessionId });

    const cancellationTime = new Date();
    let ts = await TradingSession.findOneAndUpdate(
        {
            python_session_id: sessionId,
            user_id: userId,
            status: "simulation_active",
            simulation_cancel_requested: { $ne: true }
        },
        {
            $set: {
                status: "stopped",
                simulation_status: "cancelled",
                simulation_cancel_requested: true,
                simulation_live_switch_triggered: false,
                simulation_completed_at: cancellationTime,
                ended_at: cancellationTime,
                "simulation_output.cancelled_by_user": true,
                "simulation_output.cancelled_at": cancellationTime,
                "simulation_output.cancel_source": "stop_endpoint"
            }
        },
        { returnDocument: "after" }
    );

    const wasSimulationCancelled = Boolean(ts);

    if (!ts) {
        ts = await TradingSession.findOne({ python_session_id: sessionId, user_id: userId });
    }

    const isSimulationCancellationResult =
        wasSimulationCancelled
        || Boolean(ts?.simulation_cancel_requested || ["cancelling", "cancelled"].includes(ts?.simulation_status));

    const targetBaseUrl = resolvePluginTargetUrl(ts);

    let pluginRes = null;
    let pluginStopError = null;
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
        pluginStopError = {
            message: err.message,
            statusCode: err.statusCode || err.response?.status || null
        };
        logger.warn("Plugin stop request failed; marking session stopped locally", {
            sessionId,
            error: err.message
        });
    }

    if (ts) {
        const stopPayload = pluginRes?.data || {
            success: true,
            session_id: sessionId,
            worker_stopped: false,
            plugin_stop_error: pluginStopError
        };

        if (isSimulationCancellationResult) {
            await TradingSession.findByIdAndUpdate(ts._id, {
                $set: {
                    "simulation_output.stop": stopPayload,
                    "simulation_output.live_allowed": false
                }
            });
        } else {
            ts.status = "stopped";
            ts.ended_at = new Date();
            await ts.save();
        }

        dataService.stopLivePnlSnapshotMonitor(sessionId, ts.user_id);
    }

    await dataService.markPluginSessionStopped(sessionId).catch((err) =>
        logger.warn("Failed to sync plugin_sessions stopped status", { sessionId, error: err.message })
    );

    if (isSimulationCancellationResult) {
        return {
            ...(pluginRes?.data || { success: true, session_id: sessionId, worker_stopped: false, plugin_stop_error: pluginStopError }),
            session_id: sessionId,
            status: "stopped",
            simulation_status: "cancelled",
            cancelled: true,
            live_allowed: false,
            message: "Simulation cancelled by user. Live trading will not start for this session."
        };
    }

    return pluginRes?.data || { success: true, session_id: sessionId, worker_stopped: false };
};

const stopTradingSymbol = async (userId, sessionId, symbol) => {
    logger.info("Exiting TradeX symbol from session", { userId, sessionId, symbol });

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
