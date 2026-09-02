import catchAsync from "../utils/catchAsync.js";
import AppError from "../utils/AppError.js";
import logger from "../config/logger.js";
import TradingSession from "../../../models/tradingSession.js";
import SavedTradingConfiguration from "../../../models/savedTradingConfiguration.js";

// Services
import * as proxyService from "../services/plugin.proxy.service.js";
import * as tradingService from "../services/plugin.trading.service.js";
import * as adminService from "../services/plugin.admin.service.js";
import * as dataService from "../services/plugin.data.service.js";
import * as simulationService from "../services/plugin.simulation.service.js";

const MAX_SAVED_TRADING_CONFIGURATIONS = 5;

const getRequestUserId = (req) => {
    const userId = req.user?.userId;

    if (!userId) {
        throw new AppError("Authenticated user ID is required", 401);
    }

    return userId;
};

/**
 * @desc Get all trading sessions for the logged-in user
 */
const getUserTradingSessions = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    const sessions = await TradingSession.find({ user_id: userId }).sort({ created_at: -1 }).lean();
    res.status(200).json({ success: true, sessions });
});

/**
 * @desc Get saved trading configurations for the logged-in user
 */
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

/**
 * @desc Get one saved trading configuration
 */
const getSavedTradingConfigurationById = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    const { configId } = req.params;

    const configuration = await SavedTradingConfiguration.findOne({
        _id: configId,
        user_id: userId
    }).lean();

    if (!configuration) {
        throw new AppError('Saved trading configuration not found', 404);
    }

    res.status(200).json({ success: true, configuration });
});

/**
 * @desc Save a pre-configured trading setup
 */
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
        message: 'Trading configuration saved successfully',
        configuration
    });
});

/**
 * @desc Update a saved trading configuration
 */
const updateSavedTradingConfiguration = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    const { configId } = req.params;

    const updates = {};

    if (Object.prototype.hasOwnProperty.call(req.body, 'name')) {
        updates.name = req.body.name;
    }

    if (Object.prototype.hasOwnProperty.call(req.body, 'description')) {
        updates.description = req.body.description;
    }

    if (Object.prototype.hasOwnProperty.call(req.body, 'configuration')) {
        updates.configuration = req.body.configuration;
    }

    const configuration = await SavedTradingConfiguration.findOneAndUpdate(
        { _id: configId, user_id: userId },
        { $set: updates },
        { new: true, runValidators: true }
    );

    if (!configuration) {
        throw new AppError('Saved trading configuration not found', 404);
    }

    res.status(200).json({
        success: true,
        message: 'Trading configuration updated successfully',
        configuration
    });
});

/**
 * @desc Delete a saved trading configuration
 */
const deleteSavedTradingConfiguration = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    const { configId } = req.params;

    const configuration = await SavedTradingConfiguration.findOneAndDelete({
        _id: configId,
        user_id: userId
    });

    if (!configuration) {
        throw new AppError('Saved trading configuration not found', 404);
    }

    res.status(200).json({
        success: true,
        message: 'Trading configuration deleted successfully'
    });
});

/**
 * @desc Set or update leverage_multiplier on a saved trading configuration
 */
const updateLeverageMultiplier = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    const configuration_id = req.body.configuration_id || req.body.configurationId || req.body.saved_configuration_id;
    const leverage_multiplier = req.body.leverage_multiplier ?? req.body.leverageMultiplier;

    console.log("[LEVERAGE-DEBUG] request", {
        jwtUserId: userId,
        jwtUserIdType: typeof userId,
        jwtUserIdString: userId?.toString?.(),
        configuration_id,
        configurationIdType: typeof configuration_id,
        leverage_multiplier,
        body: req.body
    });

    const byIdOnly = await SavedTradingConfiguration.findById(configuration_id).lean();
    console.log("[LEVERAGE-DEBUG] findById only", {
        found: Boolean(byIdOnly),
        stored_user_id: byIdOnly?.user_id ?? null,
        stored_user_id_type: byIdOnly?.user_id != null ? typeof byIdOnly.user_id : null,
        stored_user_id_constructor: byIdOnly?.user_id?.constructor?.name || null,
        stored_user_id_string: byIdOnly?.user_id?.toString?.() ?? null,
        jwt_equals_stored: byIdOnly?.user_id?.toString?.() === userId?.toString?.()
    });

    const query = { _id: configuration_id, user_id: userId };
    console.log("[LEVERAGE-DEBUG] findOneAndUpdate query", query);

    const configuration = await SavedTradingConfiguration.findOneAndUpdate(
        query,
        { $set: { leverage_multiplier } },
        { returnDocument: "after", runValidators: true }
    );

    console.log("[LEVERAGE-DEBUG] findOneAndUpdate result", {
        found: Boolean(configuration),
        configurationId: configuration?._id?.toString?.() || null,
        user_id: configuration?.user_id?.toString?.() || null,
        leverage_multiplier: configuration?.leverage_multiplier ?? null
    });

    if (!configuration) {
        throw new AppError('Saved trading configuration not found', 404);
    }

    res.status(200).json({
        success: true,
        message: 'Leverage multiplier updated successfully',
        configuration
    });
});

/**
 * @desc Get currently active or pending session
 */
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

/**
 * @desc Resolve session by python_session_id
 */
const getSessionById = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    const { id } = req.params; // python_session_id

    const session = await TradingSession.findOne({ python_session_id: id, user_id: userId }).lean();
    if (!session) throw new AppError('Trading session not found', 404);

    res.status(200).json({ success: true, session });
});

/**
 * @desc Submit broker credentials
 */
const submitCredentials = catchAsync(async (req, res) => {
    console.log("inside the submit credentials controllers")
    const userId = getRequestUserId(req);
    const result = await tradingService.submitCredentials(userId, req.body);
    res.status(201).json({ success: true, ...result });
});

/**
 * @desc Submit TOTP for authentication
 */
const submitTotp = catchAsync(async (req, res) => {
    console.log("inside the submittotp function inside plugincontroller")
    const userId = getRequestUserId(req);
    const result = await tradingService.verifyTotp(userId, req.body);
    res.status(200).json({ success: true, ...result });
});

/**
 * @desc Start morning simulation (Angel One hybrid flow)
 */
const startSimulation = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    const result = await simulationService.startSimulation(userId, req.body);
    res.status(200).json({ success: true, ...result });
});

/**
 * @desc Stop simulation, apply winning symbols, and start live trading
 */
const stopSimulation = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    const result = await simulationService.stopSimulation(userId, req.body);
    res.status(200).json({ success: true, ...result });
});

/**
 * @desc Get simulation status for a session
 */
const getSimulationStatus = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    const { sessionId } = req.params;
    const result = await simulationService.getSimulationStatus(userId, sessionId);
    res.status(200).json({ success: true, ...result });
});

const getPyramidPnl = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    const { sessionId } = req.params;
    const result = await dataService.getPyramidPnl(userId, sessionId);
    res.status(200).json({ success: true, ...result });
});

/**
 * @desc Start trading
 */
const startTrading = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    const result = await tradingService.startTrading(userId, req.body);
    res.status(200).json({ success: true, ...result });
});

/**
 * @desc Stop trading for a specific session (from UI params)
 */
const stopTradingBySessionId = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    const { sessionId } = req.params;
    const result = await tradingService.stopTrading(userId, sessionId);
    dataService.saveFinalPnlSnapshot(sessionId).catch(err =>
        logger.warn('Final PnL snapshot failed on stop', { sessionId, error: err.message })
    );
    res.status(200).json({ success: true, ...result });
});

/**
 * @desc Stop trading for a specific session (from UI body)
 */
const stopTradingByBodyId = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    const { session_id } = req.body;
    const result = await tradingService.stopTrading(userId, session_id);
    dataService.saveFinalPnlSnapshot(session_id).catch(err =>
        logger.warn('Final PnL snapshot failed on stop', { sessionId: session_id, error: err.message })
    );
    res.status(200).json({ success: true, ...result });
});

/**
 * @desc Stop a session locally (status update only)
 */
const stopSession = catchAsync(async (req, res) => {
    const { sessionId } = req.params;
    const session = await TradingSession.findOneAndUpdate(
        { python_session_id: sessionId, status: { $ne: "stopped" } },
        { $set: { status: "stopped", ended_at: new Date() } },
        { new: true }
    );
    if (!session) throw new AppError("Session not found or already stopped", 404);

    dataService.stopLivePnlSnapshotMonitor(sessionId, session.user_id);
    dataService.saveFinalPnlSnapshot(sessionId).catch(err =>
        logger.warn('Final PnL snapshot failed on stop', { sessionId, error: err.message })
    );

    res.status(200).json({ success: true, message: "Session stopped successfully", session });
});

/**
 * @desc Abandon a session that hasn't started trading
 */
const abandonSession = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    const { sessionId } = req.params; // python_session_id

    const ts = await TradingSession.findOne({ python_session_id: sessionId, user_id: userId });
    if (!ts) throw new AppError("Session not found", 404);
    if (ts.status === "trading_active") throw new AppError("Active trading session cannot be abandoned", 400);

    ts.status = "abandoned";
    ts.ended_at = new Date();
    await ts.save();
    dataService.stopLivePnlSnapshotMonitor(sessionId, ts.user_id);

    res.status(200).json({ success: true, message: "Session abandoned" });
});

/**
 * @desc Fetch logs and status for the dashboard
 */
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
            message: 'No trading session found'
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
    const indiaNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const targetYear = Number(year ?? indiaNow.getFullYear());
    const targetMonth = Number(month ?? (indiaNow.getMonth() + 1));

    if (!Number.isInteger(targetYear) || targetYear < 2000 || targetYear > 2100) {
        throw new AppError('Invalid year provided', 400);
    }

    if (!Number.isInteger(targetMonth) || targetMonth < 1 || targetMonth > 12) {
        throw new AppError('Invalid month provided', 400);
    }

    if (!session_id) {
        const emptyPnl = await dataService.getTradingPnlSummary('__no_session__', targetYear, targetMonth);
        return res.status(200).json({
            success: true,
            session_id: null,
            year: targetYear,
            month: targetMonth,
            ...emptyPnl,
            message: 'No trading session found'
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
    const indiaNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const targetYear = Number(year ?? indiaNow.getFullYear());
    const targetMonth = Number(month ?? (indiaNow.getMonth() + 1));

    if (!Number.isInteger(targetYear) || targetYear < 2000 || targetYear > 2100) {
        throw new AppError('Invalid year provided', 400);
    }

    if (!Number.isInteger(targetMonth) || targetMonth < 1 || targetMonth > 12) {
        throw new AppError('Invalid month provided', 400);
    }

    const pnlSummary = await dataService.getUserTradingPnlSummary(userId, targetYear, targetMonth);

    res.status(200).json({
        success: true,
        year: targetYear,
        month: targetMonth,
        ...pnlSummary
    });
});

/**
 * @desc Get session state or restore via token
 */
const getSessionState = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    const { token } = req.query;

    if (token) {
        const result = await dataService.restoreSession(userId, token);
        return res.status(200).json(result.data || result);
    }

    const ts = await TradingSession.findOne({ user_id: userId }).sort({ created_at: -1 }).lean();
    if (!ts || !ts.python_session_id) {
        return res.status(200).json({ success: false, message: 'No active session' });
    }

    const state = await dataService.getFullSessionState(userId, ts.python_session_id);
    res.status(200).json({
        ...state,
        node_session_id: ts._id
    });
});

/**
 * @desc Get raw trading logs from plugin DB
 */
const getTradingLogs = catchAsync(async (req, res) => {
    const { sessionId } = req.params;
    const logs = await dataService.fetchTradingLogs(sessionId);
    res.status(200).json(logs);
});

/**
 * @desc Get session status from plugin DB
 */
const getSessionStatus = catchAsync(async (req, res) => {
    const { sessionId } = req.params;
    const sessionData = await dataService.fetchSessionStatus(sessionId);
    if (!sessionData) throw new AppError("Session not found", 404);
    res.status(200).json(sessionData);
});

/**
 * @desc Download logs as CSV
 */
const downloadTradingLogs = catchAsync(async (req, res) => {
    const { sessionId } = req.params;
    const csv = await dataService.generateLogsCSV(sessionId);
    if (!csv) throw new AppError("No trading logs found", 404);

    res.setHeader("Content-Disposition", `attachment; filename=${sessionId}.csv`);
    res.setHeader("Content-Type", "text/csv");
    res.status(200).send(csv);
});

/**
 * @desc Proxy stream for Final Tradebook
 */
const downloadFinalTradebook = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    const { sessionId } = req.params;

    const ts = await TradingSession.findOne({ python_session_id: sessionId });
    const targetBaseUrl = ts?.vm_url;

    const pluginRes = await proxyService.forwardToPlugin(
        `/api/trading/${sessionId}/final-tradebook`,
        'get',
        null,
        { 'X-Forwarded-User': userId.toString() },
        {},
        { timeoutMs: 20000, responseType: 'stream', targetBaseUrl }
    );

    if (!pluginRes) throw new AppError("Final tradebook not found", 404);

    res.setHeader('Content-Disposition', pluginRes.headers['content-disposition'] || `attachment; filename=final_tradebook_${sessionId}.csv`);
    res.setHeader('Content-Type', pluginRes.headers['content-type'] || 'text/csv');
    pluginRes.data.pipe(res);
});

/**
 * @desc Admin stop session
 */
const adminStopSession = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    const { sessionId } = req.params;
    const result = await adminService.adminStopSession(userId, sessionId);

    dataService.saveFinalPnlSnapshot(sessionId).catch(err =>
        logger.warn('Final PnL snapshot failed on force stop', { sessionId, error: err.message })
    );
    dataService.stopLivePnlSnapshotMonitor(sessionId);

    res.status(200).json(result);
});

/**
 * @desc Admin force stop all
 */
const adminForceStopAll = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    const result = await adminService.forceStopAll(userId);
    dataService.stopAllLivePnlSnapshotMonitors();
    res.status(200).json(result);
});

/**
 * @desc Clean up invalid sessions
 */
const deleteInvalidSessions = catchAsync(async (req, res) => {
    const result = await adminService.deleteInvalidSessions();
    res.status(200).json({ success: true, deleted_count: result.deletedCount });
});

/**
 * @desc Flush user sessions
 */
const flushSessions = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    const result = await adminService.flushSessions(userId);
    res.status(200).json({ success: true, deletedCount: result.deletedCount });
});

/**
 * @desc Stop old sessions (maintenance)
 */
const stopOldSessions = catchAsync(async (req, res) => {
    const result = await adminService.stopOldSessions();
    res.status(200).json({ success: true, message: "Old active sessions marked as stopped", modifiedCount: result.modifiedCount });
});

/**
 * @desc Delete session by _id (authorized)
 */
const deleteTradingSession = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    const { sessionId } = req.params;
    const session = await adminService.deleteTradingSessionByIdParam(userId, sessionId);
    if (!session) throw new AppError("Session not found or not authorized", 404);
    res.status(200).json({ success: true, message: "Trading session deleted successfully" });
});

/**
 * @desc Delete session by id param (duplicate naming)
 */
const deleteTradingSessionByIdParam = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    const { id } = req.params;
    const session = await adminService.deleteTradingSessionByIdParam(userId, id);
    if (!session) throw new AppError("Session not found", 404);
    res.status(200).json({ success: true, message: "Session deleted" });
});

/**
 * @desc Get all sessions from plugin DB
 */
const getAllSessions = catchAsync(async (req, res) => {
    const sessions = await dataService.getAllSessions();
    res.status(200).json(sessions);
});

/**
 * @desc Get all trading logs from plugin DB (Debugging Route)
 */
const getAllTradingLogs = catchAsync(async (req, res) => {
    const sessionId = "session_20260413041316_b42ef9f3";
    const csv = await dataService.generateLogsCSV(sessionId);
    
    if (!csv) {
       return res.status(404).json({ success: false, message: `No trading logs found for ${sessionId}` });
    }

    res.setHeader("Content-Disposition", `attachment; filename=${sessionId}.csv`);
    res.setHeader("Content-Type", "text/csv");
    res.status(200).send(csv);
});

/**
 * @desc [DEBUG] Inspect trading_logs shape, cycles, and sample rows
 */
const debugTradingLogs = catchAsync(async (req, res) => {
    const { sessionId } = req.params;
    const { limit, cycle } = req.query;

    const debugView = await dataService.getTradingLogsDebugView(sessionId, { limit, cycle });

    if (debugView.total_logs === 0) {
        return res.status(404).json({
            success: false,
            message: 'No trading logs found for this session',
            session_id: sessionId
        });
    }

    res.status(200).json({ success: true, ...debugView });
});

/**
 * @desc [TEST] Check if final_pnl was stamped on trading_logs for a session
 */
const testFinalPnl = catchAsync(async (req, res) => {
    const { sessionId } = req.params;
    const logs = await dataService.fetchTradingLogs(sessionId);
    const stamped = logs.filter(l => l.final_pnl !== undefined);
    res.status(200).json({
        success: true,
        session_id: sessionId,
        total_logs: logs.length,
        stamped_count: stamped.length,
        stamped_logs: stamped
    });
});

/**
 * @desc Get engine health
 */
const getHealth = catchAsync(async (req, res) => {
    const pluginRes = await proxyService.forwardToPlugin('/api/health', 'get', null, {});
    res.status(200).json({
        success: true,
        pluginBase: proxyService.PLUGIN_BASE,
        reachable: true,
        pluginResponse: pluginRes.data
    });
});


/**
 * @desc Get live P&L for a trading session
 */
const getLivePnl = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    const { session_id } = req.params;

    const pluginResponse = await dataService.getLivePnl(userId, session_id);

    const ready = pluginResponse?.ready ?? false;
    const data  = pluginResponse?.data  ?? null;
    const stopped = pluginResponse?.stopped ?? false;
    const status = pluginResponse?.status ?? null;

    res.status(200).json({ success: true, ready, data, stopped, status });
});

/**
 * @desc Get saved live P&L history for a trading session
 */
const getLivePnlHistory = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    const { session_id } = req.params;
    const { date } = req.query;

    const history = await dataService.getLivePnlHistory(userId, session_id, date);

    res.status(200).json({
        success: true,
        session_id,
        ...history
    });
});

/**
 * @desc Get exited symbols for a trading session
 */
const getExitedSymbols = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    const sessionId = req.params.sessionId || req.params.session_id;
    const result = await dataService.getExitedSymbols(userId, sessionId);

    res.status(200).json(result);
});

/**
 * @desc [DEBUG] Mark a plugin DB session as stopped without auth/validation
 */
const debugStopPluginSession = catchAsync(async (req, res) => {
    const { sessionId } = req.params;
    const result = await dataService.debugStopPluginSession(sessionId);

    if (!result.plugin_session_updated && !result.trading_session_updated) {
        throw new AppError("Session not found in plugin_sessions or trading sessions", 404);
    }

    dataService.saveFinalPnlSnapshot(sessionId).catch(err =>
        logger.warn('Final PnL snapshot failed on debug stop', { sessionId, error: err.message })
    );

    res.status(200).json({
        success: true,
        message: "Debug stop applied",
        ...result
    });
});

const stopSymbol = catchAsync(async(req , res)=>{
    console.log("inside the stopsymbol controller")
    const userId = getRequestUserId(req);
    const {sessionId , symbol} = req.params;
    console.log("calling the tradingservice for stoping the symbol")
    const result = await tradingService.stopTradingSymbol(userId , sessionId , symbol);

    console.log("response from tradingservice.stopsymbolsession" , result)
    res.status(200).json({ success: true, ...result });
})



/// finally we have solve and refactored it successfully 

export {
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
    startTrading,
    stopTradingBySessionId,
    stopTradingByBodyId,
    stopSession,
    abandonSession,
    getDashboardData,
    getPnlSummary,
    getUserPnlSummary,
    getSessionState,
    getTradingLogs,
    getSessionStatus,
    downloadTradingLogs,
    downloadFinalTradebook,
    adminStopSession,
    adminForceStopAll,
    deleteInvalidSessions,
    flushSessions,
    stopOldSessions,
    deleteTradingSession,
    deleteTradingSessionByIdParam,
    getAllSessions,
    getAllTradingLogs,
    getHealth,
    stopSymbol,
    getLivePnl,
    getLivePnlHistory,
    getExitedSymbols,
    testFinalPnl,
    debugTradingLogs,
    debugStopPluginSession
};

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
    startTrading,
    stopTradingBySessionId,
    stopTradingByBodyId,
    stopSession,
    abandonSession,
    getDashboardData,
    getPnlSummary,
    getUserPnlSummary,
    getSessionState,
    getTradingLogs,
    getSessionStatus,
    downloadTradingLogs,
    downloadFinalTradebook,
    adminStopSession,
    adminForceStopAll,
    deleteInvalidSessions,
    flushSessions,
    stopOldSessions,
    deleteTradingSession,
    deleteTradingSessionByIdParam,
    getAllSessions,
    getAllTradingLogs,
    getHealth,
    stopSymbol,
    getLivePnl,
    getLivePnlHistory,
    getExitedSymbols,
    testFinalPnl,
    debugTradingLogs,
    debugStopPluginSession
};
