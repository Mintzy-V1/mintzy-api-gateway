import TradingSession from "../../../models/tradingSession.js";
import { forwardToPlugin, resolvePluginTargetUrl } from "./plugin.proxy.service.js";
import logger from "../config/logger.js";

/**
 * Handle admin-level session stop
 */


const adminStopSession = async (userId, sessionId) => {
    logger.info("[Admin] Stopping session", { userId, sessionId });

    const ts_lookup = await TradingSession.findOne({ python_session_id: sessionId });
    const targetBaseUrl = resolvePluginTargetUrl(ts_lookup);

    const pluginRes = await forwardToPlugin(
        `/api/admin/sessions/${sessionId}/stop`,
        'post',
        {},
        { 'X-Forwarded-User': userId.toString() },
        {},
        { timeoutMs: 15000, targetBaseUrl }
    );

    

    const data = pluginRes?.data;
    if (!data || !data.success) {
        throw new Error('Failed to stop session in trading engine');
    }

    // Update local DB
    const ts = await TradingSession.findOneAndUpdate(
        { python_session_id: sessionId },
        { $set: { status: 'stopped', ended_at: new Date() } },
        { new: true }
    );

    return {
        success: true,
        session_id: sessionId,
        new_status: 'stopped',
        node_session_updated: !!ts
    };
};

/**
 * Force stop all sessions in the trading engine
 */
const ACTIVE_STATUSES = ['trading_active', 'running', 'started'];

const forceStopAll = async (userId) => {
    logger.warn("[Admin] Force-stopping ALL sessions", { userId });

    const ownSessions = await TradingSession.find({
        user_id: userId,
        status: { $in: ACTIVE_STATUSES }
    }).select('python_session_id vm_url').lean();

    // Each account runs on its own VM, so hitting only the default base would
    // leave every other account's workers trading.
    const targets = [...new Set(ownSessions.map((ts) => resolvePluginTargetUrl(ts)))];

    const results = [];
    for (const targetBaseUrl of targets) {
        try {
            const r = await forwardToPlugin(
                '/api/admin/force-stop-all',
                'post',
                null,
                { 'X-Forwarded-User': userId.toString() },
                {},
                { timeoutMs: 20000, targetBaseUrl }
            );
            results.push({ targetBaseUrl, success: true, data: r?.data });
        } catch (err) {
            logger.error("[Admin] Force-stop failed for VM", { userId, targetBaseUrl, error: err.message });
            results.push({ targetBaseUrl, success: false, error: err.message });
        }
    }

    // Only ever mark this user's sessions stopped — an unscoped update would tell
    // the gateway that every other account had stopped while it kept trading.
    const stoppedTargets = new Set(results.filter((r) => r.success).map((r) => r.targetBaseUrl));
    const stoppedIds = ownSessions
        .filter((ts) => stoppedTargets.has(resolvePluginTargetUrl(ts)))
        .map((ts) => ts.python_session_id);

    if (stoppedIds.length) {
        await TradingSession.updateMany(
            { user_id: userId, python_session_id: { $in: stoppedIds } },
            { $set: { status: 'stopped', ended_at: new Date() } }
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

/**
 * Flush all trading sessions for a user
 */
const flushSessions = async (userId) => {
    logger.info("[Admin] Flushing all sessions for user", { userId });
    const result = await TradingSession.deleteMany({ user_id: userId });
    return result;
};

/**
 * Delete invalid sessions (missing python_session_id)
 */
const deleteInvalidSessions = async () => {
    logger.info("[Admin] Cleaning up invalid sessions");
    const result = await TradingSession.deleteMany({
        status: "credentials_received",
        $or: [
            { python_session_id: { $exists: false } },
            { python_session_id: null },
            { python_session_id: "" }
        ]
    });
    return result;
};

/**
 * Mark old active sessions as stopped
 */
const stopOldSessions = async () => {
    logger.info("[Maintenance] Stopping old active sessions");

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const result = await TradingSession.updateMany(
        {
            created_at: { $lt: startOfToday },
            status: { $ne: "stopped" }
        },
        {
            $set: { status: "stopped", ended_at: new Date() }
        }
    );

    return result;
};

/**
 * Delete a trading session by ID (authorized for the user)
 */
const deleteTradingSessionByIdParam = async (userId, sessionId) => {
    logger.info("[Admin] Deleting session by ID", { userId, sessionId });
    const session = await TradingSession.findOneAndDelete({ _id: sessionId, user_id: userId });
    return session;
};

export {
    adminStopSession,
    forceStopAll,
    flushSessions,
    deleteInvalidSessions,
    stopOldSessions,
    deleteTradingSessionByIdParam
};

export default {
    adminStopSession,
    forceStopAll,
    flushSessions,
    deleteInvalidSessions,
    stopOldSessions,
    deleteTradingSessionByIdParam
};
