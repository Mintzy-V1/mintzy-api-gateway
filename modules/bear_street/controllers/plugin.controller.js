import catchAsync from "../utils/catchAsync.js";
import AppError from "../utils/AppError.js";
import logger from "../config/logger.js";
import TradingSession from "../../../models/tradingSession.js";
import SavedTradingConfiguration from "../../../models/savedTradingConfiguration.js";
import * as performanceService from "../../../services/performance.service.js";
import * as scheduledStartService from "../../../services/scheduledStart.service.js";
import * as proxyService from "../services/plugin.proxy.service.js";
import * as tradingService from "../services/plugin.trading.service.js";
import * as dataService from "../services/plugin.data.service.js";
import * as httpCache from "../../../utils/httpCache.js";
import * as adminService from "../services/plugin.admin.service.js";
import * as simulationService from "../services/plugin.simulation.service.js";

const MAX_SAVED_TRADING_CONFIGURATIONS = 5;

const getRequestUserId = (req) => {
    const userId = req.user?.userId;

    if (!userId) {
        throw new AppError("Authenticated user ID is required", 401);
    }

    return userId;
};

const getUserTradingSessions = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    const sessions = await httpCache.run(`sessions:${userId}`, 10000, () =>
        TradingSession.find({ user_id: userId }).sort({ created_at: -1 }).lean()
    );
    res.status(200).json({ success: true, sessions });
});

const getSavedTradingConfigurations = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    const configurations = await SavedTradingConfiguration
        .find({ user_id: userId })
        .sort({ updated_at: -1, created_at: -1 })
        .lean();

    res.status(200).json({
        success: true,
        max_saved_configurations: MAX_SAVED_TRADING_CONFIGURATIONS,
        count: configurations.length,
        configurations
    });
});

const getSavedTradingConfigurationById = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    const { configId } = req.params;

    const configuration = await SavedTradingConfiguration.findOne({
        _id: configId,
        user_id: userId
    }).lean();

    if (!configuration) {
        throw new AppError("Saved trading configuration not found", 404);
    }

    res.status(200).json({ success: true, configuration });
});

const createSavedTradingConfiguration = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    const currentCount = await SavedTradingConfiguration.countDocuments({ user_id: userId });

    if (currentCount >= MAX_SAVED_TRADING_CONFIGURATIONS) {
        throw new AppError(`You can save a maximum of ${MAX_SAVED_TRADING_CONFIGURATIONS} trading configurations`, 400);
    }

    const configuration = await SavedTradingConfiguration.create({
        user_id: userId,
        name: req.body.name,
        description: req.body.description,
        configuration: req.body.configuration
    });

    res.status(201).json({
        success: true,
        message: "Trading configuration saved successfully",
        configuration
    });
});

const updateSavedTradingConfiguration = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    const { configId } = req.params;
    const updates = {};

    if (Object.prototype.hasOwnProperty.call(req.body, "name")) {
        updates.name = req.body.name;
    }
    if (Object.prototype.hasOwnProperty.call(req.body, "description")) {
        updates.description = req.body.description;
    }
    if (Object.prototype.hasOwnProperty.call(req.body, "configuration")) {
        updates.configuration = req.body.configuration;
    }

    const configuration = await SavedTradingConfiguration.findOneAndUpdate(
        { _id: configId, user_id: userId },
        { $set: updates },
        { returnDocument: "after", runValidators: true }
    );

    if (!configuration) {
        throw new AppError("Saved trading configuration not found", 404);
    }

    res.status(200).json({
        success: true,
        message: "Trading configuration updated successfully",
        configuration
    });
});

const deleteSavedTradingConfiguration = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    const { configId } = req.params;

    const configuration = await SavedTradingConfiguration.findOneAndDelete({
        _id: configId,
        user_id: userId
    });

    if (!configuration) {
        throw new AppError("Saved trading configuration not found", 404);
    }

    res.status(200).json({
        success: true,
        message: "Trading configuration deleted successfully"
    });
});

const updateLeverageMultiplier = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    const configuration_id = req.body.configuration_id || req.body.configurationId || req.body.saved_configuration_id;
    const leverage_multiplier = req.body.leverage_multiplier ?? req.body.leverageMultiplier;

    const configuration = await SavedTradingConfiguration.findOneAndUpdate(
        { _id: configuration_id, user_id: userId },
        { $set: { leverage_multiplier } },
        { returnDocument: "after", runValidators: true }
    );

    if (!configuration) {
        throw new AppError("Saved trading configuration not found", 404);
    }

    res.status(200).json({
        success: true,
        message: "Leverage multiplier updated successfully",
        configuration
    });
});

const getActiveSession = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    const session = await TradingSession.findOne({
        user_id: userId,
        status: { $in: ["credentials_received", "authenticated", "simulation_active", "trading_active"] }
    }).sort({ created_at: -1 });

    if (!session) {
        return res.status(200).json({ success: false, status: 404, message: "No active session found" });
    }

    res.status(200).json({ success: true, session });
});

const getSessionById = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    const { id } = req.params;
    const session = await TradingSession.findOne({ python_session_id: id, user_id: userId }).lean();
    if (!session) throw new AppError("Trading session not found", 404);
    res.status(200).json({ success: true, session });
});

const submitCredentials = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    const result = await tradingService.submitCredentials(userId, req.body);
    res.status(201).json({ success: true, ...result });
});

const submitTotp = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    const result = await tradingService.verifyTotp(userId, req.body);
    res.status(200).json({ success: true, ...result });
});

const startSimulation = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    httpCache.invalidateUser(userId);
    const scheduled = await scheduledStartService.maybeScheduleStart(userId, req.body);
    if (scheduled) {
        return res.status(200).json({ success: true, ...scheduled });
    }
    const result = await simulationService.startSimulation(userId, req.body);
    res.status(200).json({ success: true, ...result });
});

const getPerformanceStats = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    const stats = await performanceService.getPerformanceStats(userId);
    res.status(200).json({ success: true, stats });
});

const stopSimulation = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    const result = await simulationService.stopSimulation(userId, req.body);
    res.status(200).json({ success: true, ...result });
});

const getSimulationStatus = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    const { sessionId } = req.params;
    const result = await simulationService.getSimulationStatus(userId, sessionId);
    res.status(200).json({ success: true, ...result });
});

const getPyramidPnl = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    const { sessionId } = req.params;
    const result = await dataService.getPyramidPnl(sessionId, userId);
    res.status(200).json({ success: true, ...result });
});

const startTrading = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    httpCache.invalidateUser(userId);
    const result = await tradingService.startTrading(userId, req.body);
    res.status(200).json({ success: true, ...result });
});

const stopTradingBySessionId = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    httpCache.invalidateUser(userId);
    const { sessionId } = req.params;
    httpCache.invalidateSession(sessionId);
    const result = await tradingService.stopTrading(userId, sessionId);
    dataService.saveFinalPnlSnapshot(sessionId).catch((err) =>
        logger.warn("Final PnL snapshot failed on stop", { sessionId, error: err.message })
    );
    res.status(200).json({ success: true, ...result });
});

const stopTradingByBodyId = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    httpCache.invalidateUser(userId);
    const { session_id } = req.body;
    const result = await tradingService.stopTrading(userId, session_id);
    dataService.saveFinalPnlSnapshot(session_id).catch((err) =>
        logger.warn("Final PnL snapshot failed on stop", { sessionId: session_id, error: err.message })
    );
    res.status(200).json({ success: true, ...result });
});

const stopSession = catchAsync(async (req, res) => {
    const { sessionId } = req.params;
    httpCache.invalidateSession(sessionId);
    const session = await TradingSession.findOneAndUpdate(
        { python_session_id: sessionId, status: { $ne: "stopped" } },
        { $set: { status: "stopped", ended_at: new Date() } },
        { returnDocument: "after" }
    );
    if (!session) throw new AppError("Session not found or already stopped", 404);

    dataService.stopLivePnlSnapshotMonitor(sessionId, session.user_id);
    dataService.saveFinalPnlSnapshot(sessionId).catch((err) =>
        logger.warn("Final PnL snapshot failed on stop", { sessionId, error: err.message })
    );

    res.status(200).json({ success: true, message: "Session stopped successfully", session });
});

const abandonSession = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    httpCache.invalidateUser(userId);
    const { sessionId } = req.params;

    const ts = await TradingSession.findOne({ python_session_id: sessionId, user_id: userId });
    if (!ts) throw new AppError("Session not found", 404);
    if (ts.status === "trading_active") throw new AppError("Active trading session cannot be abandoned", 400);

    ts.status = "abandoned";
    ts.ended_at = new Date();
    await ts.save();
    dataService.stopLivePnlSnapshotMonitor(sessionId, ts.user_id);
    dataService.markPluginSessionAbandoned(sessionId).catch((err) =>
        logger.warn('Failed to mark plugin session abandoned', { sessionId, error: err.message })
    );
    scheduledStartService.clearScheduledStart(sessionId);

    res.status(200).json({ success: true, message: "Session abandoned" });
});

const getDashboardData = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    let { session_id } = req.query;

    if (!session_id) {
        const ts = await TradingSession.findOne({ user_id: userId }).sort({ created_at: -1 }).lean();
        session_id = ts?.python_session_id;
    }

    if (!session_id) {
        return res.status(200).json({
            success: true,
            session_id: null,
            status: null,
            snapshot: null,
            logs: [],
            message: "No trading session found"
        });
    }

    const data = await dataService.getDashboardState(userId, session_id);
    res.status(200).json({ success: true, session_id, ...data });
});

const getPnlSummary = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    let { session_id, year, month } = req.query;

    if (!session_id) {
        const ts = await TradingSession.findOne({ user_id: userId }).sort({ created_at: -1 }).lean();
        session_id = ts?.python_session_id;
    }

    const now = new Date();
    const indiaNow = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const targetYear = Number(year ?? indiaNow.getFullYear());
    const targetMonth = Number(month ?? (indiaNow.getMonth() + 1));

    if (!Number.isInteger(targetYear) || targetYear < 2000 || targetYear > 2100) {
        throw new AppError("Invalid year provided", 400);
    }
    if (!Number.isInteger(targetMonth) || targetMonth < 1 || targetMonth > 12) {
        throw new AppError("Invalid month provided", 400);
    }

    if (!session_id) {
        const emptyPnl = await dataService.getTradingPnlSummary("__no_session__", targetYear, targetMonth);
        return res.status(200).json({
            success: true,
            session_id: null,
            year: targetYear,
            month: targetMonth,
            ...emptyPnl,
            message: "No trading session found"
        });
    }

    const pnlSummary = await dataService.getTradingPnlSummary(session_id, targetYear, targetMonth);
    res.status(200).json({
        success: true,
        session_id,
        year: targetYear,
        month: targetMonth,
        ...pnlSummary
    });
});

const getUserPnlSummary = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    const { year, month } = req.query;
    const now = new Date();
    const indiaNow = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const targetYear = Number(year ?? indiaNow.getFullYear());
    const targetMonth = Number(month ?? (indiaNow.getMonth() + 1));

    if (!Number.isInteger(targetYear) || targetYear < 2000 || targetYear > 2100) {
        throw new AppError("Invalid year provided", 400);
    }
    if (!Number.isInteger(targetMonth) || targetMonth < 1 || targetMonth > 12) {
        throw new AppError("Invalid month provided", 400);
    }

    const pnlSummary = await dataService.getUserTradingPnlSummary(userId, targetYear, targetMonth);
    res.status(200).json({
        success: true,
        year: targetYear,
        month: targetMonth,
        ...pnlSummary
    });
});

const getSessionState = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    const { token } = req.query;

    if (token) {
        const result = await dataService.restoreSession(userId, token);
        return res.status(200).json(result.data || result);
    }

    const ts = await TradingSession.findOne({ user_id: userId }).sort({ created_at: -1 }).lean();
    if (!ts || !ts.python_session_id) {
        return res.status(200).json({ success: false, message: "No active session" });
    }

    const state = await dataService.getFullSessionState(userId, ts.python_session_id);
    res.status(200).json({
        ...state,
        node_session_id: ts._id
    });
});

const getSessionStatus = catchAsync(async (req, res) => {
    const { sessionId } = req.params;
    const sessionData = await dataService.getSessionStatus(sessionId, req.user?.userId);

    if (!sessionData) {
        throw new AppError("Session not found", 404);
    }

    res.status(200).json(sessionData);
});

const getTradingSnapshot = catchAsync(async (req, res) => {
    const { sessionId } = req.params;
    const snapshot = await dataService.getTradingSnapshot(sessionId, req.user?.userId);
    res.status(200).json(snapshot);
});

const getLivePnl = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    const sessionId = req.params.sessionId || req.params.session_id;
    const pluginResponse = await dataService.getLivePnl(userId, sessionId);

    res.status(200).json({
        success: true,
        ready: pluginResponse?.ready ?? false,
        data: pluginResponse?.data ?? null,
        stopped: pluginResponse?.stopped ?? false,
        status: pluginResponse?.status ?? null,
        message: pluginResponse?.message,
        error: pluginResponse?.error
    });
});

const getLivePnlHistory = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    const sessionId = req.params.sessionId || req.params.session_id;
    const { date, step } = req.query;
    const history = await dataService.getLivePnlHistory(userId, sessionId, date, step);

    res.status(200).json({
        success: true,
        session_id: sessionId,
        ...history
    });
});

const getExitedSymbols = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    const sessionId = req.params.sessionId || req.params.session_id;
    const result = await dataService.getExitedSymbols(userId, sessionId);

    res.status(200).json(result);
});

const getTradingLogs = catchAsync(async (req, res) => {
    const { sessionId } = req.params;
    const logs = await dataService.getTradingLogs(sessionId);
    res.status(200).json(logs);
});

const downloadTradingLogs = catchAsync(async (req, res) => {
    const { sessionId } = req.params;
    const pluginRes = await dataService.downloadTradingLogs(sessionId);

    if (!pluginRes) {
        throw new AppError("No trading logs found", 404);
    }

    res.setHeader(
        "Content-Disposition",
        pluginRes.headers["content-disposition"] || `attachment; filename=${sessionId}.csv`
    );
    res.setHeader("Content-Type", pluginRes.headers["content-type"] || "text/csv");
    pluginRes.data.pipe(res);
});

const downloadFinalTradebook = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    const { sessionId } = req.params;
    const ts = await TradingSession.findOne({ python_session_id: sessionId });
    const targetBaseUrl = ts?.vm_url;

    const pluginRes = await proxyService.forwardToPlugin(
        `/api/trading/${sessionId}/final-tradebook`,
        "get",
        null,
        { "X-Forwarded-User": userId.toString() },
        {},
        { timeoutMs: 20000, responseType: "stream", targetBaseUrl }
    );

    if (!pluginRes) throw new AppError("Final tradebook not found", 404);

    res.setHeader("Content-Disposition", pluginRes.headers["content-disposition"] || `attachment; filename=final_tradebook_${sessionId}.csv`);
    res.setHeader("Content-Type", pluginRes.headers["content-type"] || "text/csv");
    pluginRes.data.pipe(res);
});

const getAdminTradingLogs = catchAsync(async (req, res) => {
    const result = await dataService.getAdminTradingLogs(req.query.limit);
    res.status(200).json(result);
});

const getAdminTradingLogsByUser = catchAsync(async (req, res) => {
    const { userId } = req.params;
    const result = await dataService.getAdminTradingLogsByUser(userId, req.query.limit);
    res.status(200).json(result);
});

const downloadAdminTradingLogsByUser = catchAsync(async (req, res) => {
    const { userId } = req.params;
    const pluginRes = await dataService.downloadAdminTradingLogsByUser(userId);

    if (!pluginRes) {
        throw new AppError("No trading logs found for user", 404);
    }

    res.setHeader(
        "Content-Disposition",
        pluginRes.headers["content-disposition"] || `attachment; filename=trading_logs_user_${userId}.zip`
    );
    res.setHeader("Content-Type", pluginRes.headers["content-type"] || "application/zip");
    pluginRes.data.pipe(res);
});

const adminStopSession = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    httpCache.invalidateUser(userId);
    const { sessionId } = req.params;
    httpCache.invalidateSession(sessionId);
    const result = await adminService.adminStopSession(userId, sessionId);
    dataService.saveFinalPnlSnapshot(sessionId).catch((err) =>
        logger.warn("Final PnL snapshot failed on force stop", { sessionId, error: err.message })
    );
    dataService.stopLivePnlSnapshotMonitor(sessionId);
    res.status(200).json(result);
});

const deleteAdminSession = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    const { sessionId } = req.params;
    const result = await adminService.deleteAdminSession(userId, sessionId);
    res.status(200).json(result);
});

const adminForceStopAll = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    const result = await adminService.forceStopAll(userId);
    dataService.stopAllLivePnlSnapshotMonitors();
    res.status(200).json(result);
});

const deleteInvalidSessions = catchAsync(async (req, res) => {
    const result = await adminService.deleteInvalidSessions();
    res.status(200).json({ success: true, deleted_count: result.deletedCount });
});

const flushSessions = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    const result = await adminService.flushSessions(userId);
    res.status(200).json({ success: true, deletedCount: result.deletedCount });
});

const stopOldSessions = catchAsync(async (req, res) => {
    const result = await adminService.stopOldSessions();
    res.status(200).json({
        success: true,
        message: "Old active sessions marked as stopped",
        modifiedCount: result.modifiedCount
    });
});

const deleteTradingSession = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    const { sessionId } = req.params;
    const session = await adminService.deleteTradingSessionByIdParam(userId, sessionId);
    if (!session) throw new AppError("Session not found or not authorized", 404);
    res.status(200).json({ success: true, message: "Trading session deleted successfully" });
});

const deleteTradingSessionByIdParam = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    httpCache.invalidateUser(userId);
    const { id } = req.params;
    const session = await adminService.deleteTradingSessionByIdParam(userId, id);
    if (!session) throw new AppError("Session not found", 404);
    res.status(200).json({ success: true, message: "Session deleted" });
});

const getAllSessions = catchAsync(async (req, res) => {
    const sessions = await dataService.getAllSessions();
    res.status(200).json(sessions);
});

const getAllTradingLogs = catchAsync(async (req, res) => {
    const logs = await dataService.fetchAllTradingLogs();
    res.status(200).json({ success: true, logs });
});

const debugTradingLogs = catchAsync(async (req, res) => {
    const { sessionId } = req.params;
    const { limit, cycle } = req.query;
    const debugView = await dataService.getTradingLogsDebugView(sessionId, { limit, cycle });

    if (debugView.total_logs === 0) {
        return res.status(404).json({
            success: false,
            message: "No trading logs found for this session",
            session_id: sessionId
        });
    }

    res.status(200).json({ success: true, ...debugView });
});

const testFinalPnl = catchAsync(async (req, res) => {
    const { sessionId } = req.params;
    const logs = await dataService.fetchTradingLogs(sessionId);
    const stamped = logs.filter((entry) => entry.final_pnl !== undefined);
    res.status(200).json({
        success: true,
        session_id: sessionId,
        total_logs: logs.length,
        stamped_count: stamped.length,
        stamped_logs: stamped
    });
});

const getHealth = catchAsync(async (req, res) => {
    const pluginRes = await proxyService.forwardToPlugin("/api/health", "get", null, {});
    res.status(200).json({
        success: true,
        pluginBase: proxyService.PLUGIN_BASE,
        reachable: true,
        pluginResponse: pluginRes.data
    });
});

const debugStopPluginSession = catchAsync(async (req, res) => {
    const { sessionId } = req.params;
    const result = await dataService.debugStopPluginSession(sessionId);

    if (!result.plugin_session_updated && !result.trading_session_updated) {
        throw new AppError("Session not found in plugin_sessions or trading sessions", 404);
    }

    dataService.saveFinalPnlSnapshot(sessionId).catch((err) =>
        logger.warn("Final PnL snapshot failed on debug stop", { sessionId, error: err.message })
    );

    res.status(200).json({
        success: true,
        message: "Debug stop applied",
        ...result
    });
});

const stopSymbol = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    const { sessionId, symbol } = req.params;
    const result = await tradingService.stopTradingSymbol(userId, sessionId, symbol);
    res.status(200).json({ success: true, ...result });
});

const getDebugSnapshot = catchAsync(async (req, res) => {
    const result = await dataService.getDebugSnapshot();
    res.status(200).json(result);
});

const insertFakeTrades = catchAsync(async (req, res) => {
    const { sessionId } = req.params;
    const result = await dataService.insertFakeTrades(sessionId);
    res.status(200).json(result);
});

export default {
    getUserTradingSessions,
    getSavedTradingConfigurations,
    getSavedTradingConfigurationById,
    createSavedTradingConfiguration,
    updateSavedTradingConfiguration,
    updateLeverageMultiplier,
    deleteSavedTradingConfiguration,
    getActiveSession,
    getSessionById,
    submitCredentials,
    submitTotp,
    startSimulation,
    stopSimulation,
    getSimulationStatus,
    getPyramidPnl,
    getPerformanceStats,
    startTrading,
    stopTradingBySessionId,
    stopTradingByBodyId,
    stopSession,
    abandonSession,
    getDashboardData,
    getPnlSummary,
    getUserPnlSummary,
    getSessionState,
    getSessionStatus,
    getTradingSnapshot,
    getLivePnl,
    getLivePnlHistory,
    getExitedSymbols,
    getTradingLogs,
    downloadTradingLogs,
    downloadFinalTradebook,
    getAdminTradingLogs,
    getAdminTradingLogsByUser,
    downloadAdminTradingLogsByUser,
    adminStopSession,
    deleteAdminSession,
    adminForceStopAll,
    deleteInvalidSessions,
    flushSessions,
    stopOldSessions,
    deleteTradingSession,
    deleteTradingSessionByIdParam,
    getAllSessions,
    getAllTradingLogs,
    debugTradingLogs,
    testFinalPnl,
    getHealth,
    debugStopPluginSession,
    stopSymbol,
    getDebugSnapshot,
    insertFakeTrades
};
