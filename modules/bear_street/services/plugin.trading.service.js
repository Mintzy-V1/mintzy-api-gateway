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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

    const statusRes = await forwardToPlugin(
        `/api/session/${session_id}/status`,
        "get",
        null,
        { "X-Forwarded-User": userId.toString() },
        {},
        { timeoutMs: 8000, retries: 1, failOnError: false, targetBaseUrl }
    );

    const pluginStatus = statusRes?.data?.status;
    const allowedStatuses = ["authenticated", "trading_active", "running", "started", "credentials_received"];

    if (!allowedStatuses.includes(pluginStatus)) {
        throw new AppError(
            `Session not authenticated. Current status: ${pluginStatus || "unknown"}`,
            401
        );
    }

    const pluginRes = await forwardToPlugin(
        "/api/trading/start",
        "post",
        startPayload,
        { "X-Forwarded-User": userId.toString() },
        {},
        { targetBaseUrl }
    );

    ts.status = "trading_active";
    ts.broker = ts.broker || "bear_street";
    ts.saved_configuration_id = savedConfiguration?._id;
    ts.configuration_name = savedConfiguration?.name || configuration_name || null;
    ts.trading_configuration = startPayload;
    await ts.save();
    dataService.startLivePnlSnapshotMonitor(ts.user_id, ts.python_session_id);

    return pluginRes?.data || { success: true };
};

const stopSimulationTrading = async (userId, sessionId) => {
    logger.info("Stopping Bear Street simulation worker", { userId, sessionId });

    const ts = await TradingSession.findOne({ python_session_id: sessionId });
    const targetBaseUrl = resolvePluginTargetUrl(ts);
    const stopRequestTimeoutMs = parseInt(process.env.SIMULATION_STOP_REQUEST_TIMEOUT || "120000", 10);

    let pluginRes = null;

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

        await sleep(SIMULATION_STOP_RETRY_DELAY_MS);
        pluginRes = await invokeStopSimulationPlugin(
            userId,
            sessionId,
            targetBaseUrl,
            stopRequestTimeoutMs
        );
    }

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
