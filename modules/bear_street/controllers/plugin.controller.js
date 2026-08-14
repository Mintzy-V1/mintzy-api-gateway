import catchAsync from "../utils/catchAsync.js";
import AppError from "../utils/AppError.js";
import * as tradingService from "../services/plugin.trading.service.js";
import * as dataService from "../services/plugin.data.service.js";
import * as adminService from "../services/plugin.admin.service.js";

const getRequestUserId = (req) => {
    const userId = req.user?.userId;

    if (!userId) {
        throw new AppError("Authenticated user ID is required", 401);
    }

    return userId;
};

const submitCredentials = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    const result = await tradingService.submitCredentials(userId, req.body);
    res.status(201).json({ success: true, ...result });
});

const startTrading = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    const result = await tradingService.startTrading(userId, req.body);
    res.status(200).json({ success: true, ...result });
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
    const { sessionId } = req.params;
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
    const { sessionId } = req.params;
    const result = await adminService.adminStopSession(userId, sessionId);
    res.status(200).json(result);
});

const deleteAdminSession = catchAsync(async (req, res) => {
    const userId = getRequestUserId(req);
    const { sessionId } = req.params;
    const result = await adminService.deleteAdminSession(userId, sessionId);
    res.status(200).json(result);
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
    submitCredentials,
    startTrading,
    getSessionStatus,
    getTradingSnapshot,
    getLivePnl,
    getTradingLogs,
    downloadTradingLogs,
    getAdminTradingLogs,
    getAdminTradingLogsByUser,
    downloadAdminTradingLogsByUser,
    adminStopSession,
    deleteAdminSession,
    getDebugSnapshot,
    insertFakeTrades
};
