import TradingSession from "../../../models/tradingSession.js";
import { forwardToPlugin, resolvePluginTargetUrl } from "./plugin.proxy.service.js";
import logger from "../config/logger.js";
import AppError from "../utils/AppError.js";

const adminStopSession = async (userId, sessionId) => {
    logger.info("[Firstock Admin] Stopping session", { userId, sessionId });

    const ts = await TradingSession.findOne({ python_session_id: sessionId });
    const targetBaseUrl = resolvePluginTargetUrl(ts);

    const pluginRes = await forwardToPlugin(
        `/api/admin/sessions/${sessionId}/stop`,
        "post",
        {},
        { "X-Forwarded-User": userId.toString() },
        {},
        { timeoutMs: 15000, targetBaseUrl }
    );

    const data = pluginRes?.data;
    if (!data || !data.success) {
        throw new AppError("Failed to stop session in trading engine", 502);
    }

    const updatedSession = await TradingSession.findOneAndUpdate(
        { python_session_id: sessionId },
        { $set: { status: "stopped", ended_at: new Date() } },
        { new: true }
    );

    return {
        success: true,
        session_id: sessionId,
        new_status: "stopped",
        node_session_updated: !!updatedSession
    };
};

const deleteAdminSession = async (userId, sessionId) => {
    logger.info("[Firstock Admin] Deleting session", { userId, sessionId });

    const ts = await TradingSession.findOne({ python_session_id: sessionId });
    const targetBaseUrl = resolvePluginTargetUrl(ts);

    const pluginRes = await forwardToPlugin(
        `/api/admin/sessions/${sessionId}`,
        "delete",
        null,
        { "X-Forwarded-User": userId.toString() },
        {},
        { timeoutMs: 15000, targetBaseUrl }
    );

    const data = pluginRes?.data;
    if (!data || !data.success) {
        throw new AppError("Failed to delete session in trading engine", 502);
    }

    await TradingSession.findOneAndUpdate(
        { python_session_id: sessionId },
        { $set: { status: "stopped", ended_at: new Date() } }
    );

    return data;
};

const ACTIVE_STATUSES = ["trading_active", "running", "started"];

const forceStopAll = async (userId) => {
    logger.warn("[Firstock Admin] Force-stopping ALL sessions", { userId });

    const ownSessions = await TradingSession.find({
        user_id: userId,
        status: { $in: ACTIVE_STATUSES }
    }).select("python_session_id vm_url").lean();

    const targets = [...new Set(ownSessions.map((ts) => resolvePluginTargetUrl(ts)))];

    const results = [];
    for (const targetBaseUrl of targets) {
        try {
            const r = await forwardToPlugin(
                "/api/admin/force-stop-all",
                "post",
                null,
                { "X-Forwarded-User": userId.toString() },
                {},
                { timeoutMs: 20000, targetBaseUrl }
            );
            results.push({ targetBaseUrl, success: true, data: r?.data });
        } catch (err) {
            logger.error("[Firstock Admin] Force-stop failed for VM", {
                userId,
                targetBaseUrl,
                error: err.message
            });
            results.push({ targetBaseUrl, success: false, error: err.message });
        }
    }

    const stoppedTargets = new Set(results.filter((r) => r.success).map((r) => r.targetBaseUrl));
    const stoppedIds = ownSessions
        .filter((ts) => stoppedTargets.has(resolvePluginTargetUrl(ts)))
        .map((ts) => ts.python_session_id);

    if (stoppedIds.length) {
        await TradingSession.updateMany(
            { user_id: userId, python_session_id: { $in: stoppedIds } },
            { $set: { status: "stopped", ended_at: new Date() } }
        );
    }

    const failed = results.filter((r) => !r.success);
    return {
        success: failed.length === 0,
        vms_targeted: targets.length,
        sessions_stopped: stoppedIds.length,
        failures: failed,
        results
    };
};

const flushSessions = async (userId) => {
    logger.info("[Firstock Admin] Flushing all sessions for user", { userId });
    return TradingSession.deleteMany({ user_id: userId });
};

const deleteInvalidSessions = async () => {
    logger.info("[Firstock Admin] Cleaning up invalid sessions");
    return TradingSession.deleteMany({
        status: "credentials_received",
        $or: [
            { python_session_id: { $exists: false } },
            { python_session_id: null },
            { python_session_id: "" }
        ]
    });
};

const stopOldSessions = async () => {
    logger.info("[Firstock Maintenance] Stopping old active sessions");

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    return TradingSession.updateMany(
        {
            created_at: { $lt: startOfToday },
            status: { $ne: "stopped" }
        },
        {
            $set: { status: "stopped", ended_at: new Date() }
        }
    );
};

const deleteTradingSessionByIdParam = async (userId, sessionId) => {
    logger.info("[Firstock Admin] Deleting session by ID", { userId, sessionId });
    return TradingSession.findOneAndDelete({ _id: sessionId, user_id: userId });
};

export {
    adminStopSession,
    deleteAdminSession,
    forceStopAll,
    flushSessions,
    deleteInvalidSessions,
    stopOldSessions,
    deleteTradingSessionByIdParam
};

export default {
    adminStopSession,
    deleteAdminSession,
    forceStopAll,
    flushSessions,
    deleteInvalidSessions,
    stopOldSessions,
    deleteTradingSessionByIdParam
};
