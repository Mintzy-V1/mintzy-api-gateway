import crypto from "crypto";
import TradingSession from "../../../models/tradingSession.js";
import {
    forwardToPlugin,
    PLUGIN_BASE,
    resolvePluginTargetUrl
} from "./plugin.proxy.service.js";
import AppError from "../utils/AppError.js";
import logger from "../config/logger.js";

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

const startTrading = async (userId, payload = {}) => {
    const session_id = payload.session_id || payload.sessionId;

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

    const statusRes = await forwardToPlugin(
        `/api/session/${session_id}/status`,
        "get",
        null,
        { "X-Forwarded-User": userId.toString() },
        {},
        { timeoutMs: 8000, retries: 1, failOnError: false, targetBaseUrl }
    );

    const pluginStatus = statusRes?.data?.status;
    const allowedStatuses = ["authenticated", "trading_active", "running", "started"];

    if (!allowedStatuses.includes(pluginStatus)) {
        throw new AppError(
            `Session not authenticated. Current status: ${pluginStatus || "unknown"}`,
            401
        );
    }

    const pluginRes = await forwardToPlugin(
        "/api/trading/start",
        "post",
        payload,
        { "X-Forwarded-User": userId.toString() },
        {},
        { targetBaseUrl }
    );

    ts.status = "trading_active";
    ts.trading_configuration = payload;
    await ts.save();

    return pluginRes?.data || { success: true };
};

export {
    submitCredentials,
    startTrading
};

export default {
    submitCredentials,
    startTrading
};
