import TradingSession from "../../../models/tradingSession.js";
import {
    forwardToPlugin,
    PLUGIN_BASE,
    resolvePluginTargetUrl
} from "./plugin.proxy.service.js";
import logger from "../config/logger.js";

const resolveTargetForSession = async (sessionId) => {
    if (!sessionId) {
        return PLUGIN_BASE;
    }

    const ts = await TradingSession.findOne({ python_session_id: sessionId }).lean();
    return resolvePluginTargetUrl(ts);
};

const buildHeaders = (userId) => (
    userId ? { "X-Forwarded-User": userId.toString() } : {}
);

const proxyGet = async (path, { sessionId, userId, params = {}, options = {} } = {}) => {
    const targetBaseUrl = sessionId
        ? await resolveTargetForSession(sessionId)
        : PLUGIN_BASE;

    return forwardToPlugin(
        path,
        "get",
        null,
        buildHeaders(userId),
        params,
        { targetBaseUrl, ...options }
    );
};

const getSessionStatus = async (sessionId, userId) => {
    logger.info("Fetching Bear Street session status", { sessionId });
    const pluginRes = await proxyGet(`/api/session/${sessionId}/status`, { sessionId, userId });
    return pluginRes?.data;
};

const getTradingSnapshot = async (sessionId, userId) => {
    logger.info("Fetching Bear Street trading snapshot", { sessionId });
    const pluginRes = await proxyGet(`/api/trading/snapshot/${sessionId}`, { sessionId, userId });
    return pluginRes?.data;
};

const getLivePnl = async (userId, sessionId) => {
    logger.info("Fetching Bear Street live PnL", { userId, sessionId });

    const ts = await TradingSession.findOne({
        python_session_id: sessionId,
        user_id: userId
    });

    if (!ts) {
        return { ready: false, stopped: true, status: "not_found", data: null };
    }

    if (ts.status === "stopped" || ts.status === "abandoned") {
        return { ready: false, stopped: true, status: ts.status, data: null };
    }

    const pluginRes = await proxyGet(`/api/trading/live-pnl/${sessionId}`, {
        sessionId,
        userId,
        options: { timeoutMs: 10000, retries: 1, failOnError: false }
    });

    return pluginRes?.data ?? pluginRes;
};

const getTradingLogs = async (sessionId) => {
    logger.info("Fetching Bear Street trading logs", { sessionId });
    const pluginRes = await proxyGet(`/api/sessions/${sessionId}/trades`, { sessionId });
    return pluginRes?.data;
};

const downloadTradingLogs = async (sessionId) => {
    logger.info("Downloading Bear Street trading logs", { sessionId });
    const targetBaseUrl = await resolveTargetForSession(sessionId);

    return forwardToPlugin(
        `/api/sessions/${sessionId}/download`,
        "get",
        null,
        {},
        {},
        { responseType: "stream", targetBaseUrl }
    );
};

const getAdminTradingLogs = async (limit) => {
    logger.info("Fetching Bear Street admin trading logs", { limit });
    const params = limit ? { limit: String(limit) } : {};

    const pluginRes = await proxyGet("/api/admin/trading-logs", { params });
    return pluginRes?.data;
};

const getAdminTradingLogsByUser = async (userId, limit) => {
    logger.info("Fetching Bear Street admin trading logs by user", { userId, limit });
    const params = limit ? { limit: String(limit) } : {};

    const pluginRes = await proxyGet(`/api/admin/trading-logs/user/${userId}`, { params });
    return pluginRes?.data;
};

const downloadAdminTradingLogsByUser = async (userId) => {
    logger.info("Downloading Bear Street admin trading logs by user", { userId });

    return forwardToPlugin(
        `/api/admin/trading-logs/user/${userId}/download`,
        "get",
        null,
        {},
        {},
        { responseType: "stream", targetBaseUrl: PLUGIN_BASE }
    );
};

const getDebugSnapshot = async () => {
    logger.info("Fetching Bear Street debug snapshot");
    const pluginRes = await proxyGet("/api/debug/snapshot");
    return pluginRes?.data;
};

const insertFakeTrades = async (sessionId) => {
    logger.info("Inserting Bear Street fake trades (debug)", { sessionId });
    const pluginRes = await proxyGet(`/api/debug/insert-fake-trades/${sessionId}`, { sessionId });
    return pluginRes?.data;
};

export {
    getSessionStatus,
    getTradingSnapshot,
    getLivePnl,
    getTradingLogs,
    downloadTradingLogs,
    getAdminTradingLogs,
    getAdminTradingLogsByUser,
    downloadAdminTradingLogsByUser,
    getDebugSnapshot,
    insertFakeTrades
};

export default {
    getSessionStatus,
    getTradingSnapshot,
    getLivePnl,
    getTradingLogs,
    downloadTradingLogs,
    getAdminTradingLogs,
    getAdminTradingLogsByUser,
    downloadAdminTradingLogsByUser,
    getDebugSnapshot,
    insertFakeTrades
};
