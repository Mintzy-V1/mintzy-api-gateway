import TradingSession from "../../../models/tradingSession.js";
import { forwardToPlugin, resolvePluginTargetUrl } from "./plugin.proxy.service.js";
import logger from "../config/logger.js";
import AppError from "../utils/AppError.js";

const adminStopSession = async (userId, sessionId) => {
    logger.info("[BearStreet Admin] Stopping session", { userId, sessionId });

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
    logger.info("[BearStreet Admin] Deleting session", { userId, sessionId });

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

export {
    adminStopSession,
    deleteAdminSession
};

export default {
    adminStopSession,
    deleteAdminSession
};
