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
    const userId = payload.userId;
    const access_key = payload.access_key || payload.accessKey;
    const access_secret = payload.access_secret || payload.accessSecret;
    const base_url = TRADEX_BASE_URL;
    const token = payload.token;

    return {
        userId,
        access_key,
        access_secret,
        base_url,
        token
    };
};

const submitCredentials = async (_jwtUserId, payload = {}) => {
    const credentials = normalizeCredentialsPayload(payload);
    const { userId, access_key, access_secret, base_url, token } = credentials;

    if (!userId || !access_key || !access_secret) {
        throw new AppError("userId, access_key, and access_secret are required", 400);
    }

    logger.info("Submitting TradeX credentials", { userId });

    // if (!checkMarketHours()) {
    //     throw new AppError("Market is closed. Access denied after 3:30 PM IST.", 400);
    // }

    const targetBaseUrl = getTargetBaseUrlByApiKey(access_key);
    const autoAuthOnCredentials = shouldAutoAuthenticateApiKey(access_key);
    const pluginPayload = {
        broker_type: "tradex",
        api_key: access_key,
        client_code: userId,
        password: access_secret,
        base_url,
        token
    };

    const pluginRes = await forwardToPlugin(
        "/api/auth/credentials",
        "post",
        pluginPayload,
        { "X-Forwarded-User": userId.toString() },
        {},
        { targetBaseUrl }
    );

    const pluginData = pluginRes.data || {};
    const pythonSessionId = pluginData.session_id;
    let initialPluginStatus = pluginData.status || "authenticated";

    if (pluginData.requires_totp === false) {
        initialPluginStatus = "authenticated";
        pluginData.status = "authenticated";
    }

    if (!pythonSessionId) {
        throw new AppError("Failed to create trading engine session", 502);
    }

    const fingerprint = crypto
        .createHash("sha256")
        .update(`${access_key}:${userId}`)
        .digest("hex");

    const ts = await TradingSession.create({
        user_id: userId,
        python_session_id: pythonSessionId,
        status: autoAuthOnCredentials && initialPluginStatus === "credentials_received"
            ? "authenticated"
            : initialPluginStatus,
        credentials_fingerprint: fingerprint,
        vm_url: targetBaseUrl,
        auto_auth_on_credentials: autoAuthOnCredentials
    });

    if (autoAuthOnCredentials && initialPluginStatus === "credentials_received") {
        await dataService.markPluginSessionAuthenticated(pythonSessionId, {
            reason: "special_access_key_credentials_received"
        });
        pluginData.status = "authenticated";
    }

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

    if (saved_configuration_id) {
        savedConfiguration = await SavedTradingConfiguration.findOne({
            _id: saved_configuration_id,
            user_id: userId
        }).lean();

        if (!savedConfiguration) {
            throw new AppError("Saved trading configuration not found", 404);
        }
    }

    const resolvedTradingConfiguration = savedConfiguration?.configuration || {};
    const startPayload = {
        ...resolvedTradingConfiguration,
        ...runtimeOverrides,
        session_id
    };

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

    const pluginRes = await forwardToPlugin(
        "/api/trading/start",
        "post",
        startPayload,
        { "X-Forwarded-User": userId.toString() },
        {},
        { targetBaseUrl }
    );

    if (ts) {
        ts.status = "trading_active";
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

const stopTrading = async (userId, sessionId) => {
    logger.info("Stopping TradeX session", { userId, sessionId });

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
    stopTrading,
    stopTradingSymbol
};

export default {
    submitCredentials,
    verifyTotp,
    startTrading,
    stopTrading,
    stopTradingSymbol
};
