import express from "express";
import authMiddleware from "../middlewares/auth.js";
import pluginController from "../controllers/plugin.controller.js";
import validateRequest from "../middlewares/validateRequest.js";
import sanitizeRequest from "../middlewares/sanitizeRequest.js";
import pluginValidation from "../validations/plugin.validation.js";

const router = express.Router();

router.delete("/trading/session/:sessionId",
    authMiddleware,
    validateRequest(pluginValidation.sessionIdParamSchema, "params"),
    pluginController.deleteTradingSession
);

router.post("/admin/sessions/:sessionId/stop",
    authMiddleware,
    validateRequest(pluginValidation.sessionIdParamSchema, "params"),
    pluginController.adminStopSession
);

router.delete("/admin/sessions/:sessionId",
    authMiddleware,
    validateRequest(pluginValidation.sessionIdParamSchema, "params"),
    pluginController.deleteAdminSession
);

router.post("/admin/force-stop-all",
    authMiddleware,
    pluginController.adminForceStopAll
);

router.delete("/sessions/flush",
    authMiddleware,
    pluginController.flushSessions
);

router.post("/sessions/:sessionId/stop",
    authMiddleware,
    validateRequest(pluginValidation.sessionIdParamSchema, "params"),
    pluginController.stopSession
);

router.post("/sessions/stop-old",
    authMiddleware,
    pluginController.stopOldSessions
);

router.get("/trading/active-session",
    authMiddleware,
    pluginController.getActiveSession
);

router.get("/saved-configurations",
    authMiddleware,
    pluginController.getSavedTradingConfigurations
);

router.get("/saved-configurations/:configId",
    authMiddleware,
    validateRequest(pluginValidation.savedConfigurationParamSchema, "params"),
    pluginController.getSavedTradingConfigurationById
);

router.post("/saved-configurations",
    authMiddleware,
    sanitizeRequest,
    validateRequest(pluginValidation.savedConfigurationBodySchema),
    pluginController.createSavedTradingConfiguration
);

router.put("/saved-configurations/:configId",
    authMiddleware,
    sanitizeRequest,
    validateRequest(pluginValidation.savedConfigurationParamSchema, "params"),
    validateRequest(pluginValidation.savedConfigurationUpdateSchema),
    pluginController.updateSavedTradingConfiguration
);

router.patch("/saved-configurations/leverage",
    authMiddleware,
    sanitizeRequest,
    validateRequest(pluginValidation.updateLeverageMultiplierSchema),
    pluginController.updateLeverageMultiplier
);

router.delete("/saved-configurations/:configId",
    authMiddleware,
    validateRequest(pluginValidation.savedConfigurationParamSchema, "params"),
    pluginController.deleteSavedTradingConfiguration
);

router.get("/trading/live-pnl/:sessionId/history",
    authMiddleware,
    validateRequest(pluginValidation.sessionIdParamSchema, "params"),
    validateRequest(pluginValidation.livePnlHistoryQuerySchema, "query"),
    pluginController.getLivePnlHistory
);

router.get("/trading/live-pnl/:sessionId",
    authMiddleware,
    validateRequest(pluginValidation.sessionIdParamSchema, "params"),
    pluginController.getLivePnl
);

router.get("/trading/exited-symbols/:sessionId",
    authMiddleware,
    validateRequest(pluginValidation.sessionIdParamSchema, "params"),
    pluginController.getExitedSymbols
);

router.post("/trading/:sessionId/abandon",
    authMiddleware,
    validateRequest(pluginValidation.sessionIdParamSchema, "params"),
    pluginController.abandonSession
);

router.get("/trading/sessions/:id",
    authMiddleware,
    validateRequest(pluginValidation.idParamSchema, "params"),
    pluginController.getSessionById
);

router.post("/credentials",
    authMiddleware,
    sanitizeRequest,
    validateRequest(pluginValidation.submitCredentialsSchema),
    pluginController.submitCredentials
);

router.post("/totp",
    authMiddleware,
    sanitizeRequest,
    validateRequest(pluginValidation.submitTotpSchema),
    pluginController.submitTotp
);

router.post("/start-simulation",
    authMiddleware,
    sanitizeRequest,
    validateRequest(pluginValidation.startSimulationSchema),
    pluginController.startSimulation
);

router.post("/stop-simulation",
    authMiddleware,
    sanitizeRequest,
    validateRequest(pluginValidation.stopSimulationSchema),
    pluginController.stopSimulation
);

router.get("/simulation/status/:sessionId",
    authMiddleware,
    validateRequest(pluginValidation.sessionIdParamSchema, "params"),
    pluginController.getSimulationStatus
);

router.get("/trading/pyramid-pnl/:sessionId",
    authMiddleware,
    validateRequest(pluginValidation.sessionIdParamSchema, "params"),
    pluginController.getPyramidPnl
);

router.post("/start",
    authMiddleware,
    sanitizeRequest,
    validateRequest(pluginValidation.startTradingSchema),
    pluginController.startTrading
);

router.post("/stop/:sessionId",
    authMiddleware,
    validateRequest(pluginValidation.sessionIdParamSchema, "params"),
    pluginController.stopTradingBySessionId
);

router.get("/health",
    pluginController.getHealth
);

router.get("/session",
    authMiddleware,
    validateRequest(pluginValidation.sessionStateQuerySchema, "query"),
    pluginController.getSessionState
);

router.get("/session/:sessionId/status",
    validateRequest(pluginValidation.sessionIdParamSchema, "params"),
    pluginController.getSessionStatus
);

router.get("/sessions/:sessionId/status",
    validateRequest(pluginValidation.sessionIdParamSchema, "params"),
    pluginController.getSessionStatus
);

router.delete("/sessions/invalid",
    authMiddleware,
    pluginController.deleteInvalidSessions
);

router.post("/stop",
    authMiddleware,
    sanitizeRequest,
    validateRequest(pluginValidation.stopTradingByBodySchema),
    pluginController.stopTradingByBodyId
);

router.get("/tradingsessions",
    authMiddleware,
    pluginController.getUserTradingSessions
);

router.delete("/tradingsession/:id",
    authMiddleware,
    validateRequest(pluginValidation.mongoIdParamSchema, "params"),
    pluginController.deleteTradingSessionByIdParam
);

router.get("/dashboard",
    authMiddleware,
    validateRequest(pluginValidation.dashboardQuerySchema, "query"),
    pluginController.getDashboardData
);

router.get("/dashboard/pnl",
    authMiddleware,
    validateRequest(pluginValidation.pnlQuerySchema, "query"),
    pluginController.getPnlSummary
);

router.get("/dashboard/pnl/aggregate",
    authMiddleware,
    validateRequest(pluginValidation.userPnlQuerySchema, "query"),
    pluginController.getUserPnlSummary
);

router.get("/dashboard/performance-stats",
    authMiddleware,
    pluginController.getPerformanceStats
);

router.get("/trading/sessions",
    authMiddleware,
    pluginController.getUserTradingSessions
);

router.get("/trading/:sessionId/final-tradebook",
    authMiddleware,
    validateRequest(pluginValidation.sessionIdParamSchema, "params"),
    pluginController.downloadFinalTradebook
);

router.get("/trading/snapshot/:sessionId",
    validateRequest(pluginValidation.sessionIdParamSchema, "params"),
    pluginController.getTradingSnapshot
);

router.get("/fetch/all-sessions",
    pluginController.getAllSessions
);

router.get("/admin/trading-logs",
    authMiddleware,
    validateRequest(pluginValidation.tradingLogsQuerySchema, "query"),
    pluginController.getAdminTradingLogs
);

router.get("/admin/trading-logs/user/:userId",
    authMiddleware,
    validateRequest(pluginValidation.userIdParamSchema, "params"),
    validateRequest(pluginValidation.tradingLogsQuerySchema, "query"),
    pluginController.getAdminTradingLogsByUser
);

router.get("/admin/trading-logs/user/:userId/download",
    authMiddleware,
    validateRequest(pluginValidation.userIdParamSchema, "params"),
    pluginController.downloadAdminTradingLogsByUser
);

router.get("/debug/all-logs",
    pluginController.getAllTradingLogs
);

router.get("/debug/trading-logs/:sessionId",
    validateRequest(pluginValidation.sessionIdParamSchema, "params"),
    pluginController.debugTradingLogs
);

router.get("/debug/final-pnl/:sessionId",
    pluginController.testFinalPnl
);

router.post("/debug/stop-plugin-session/:sessionId",
    pluginController.debugStopPluginSession
);

router.get("/debug/snapshot", pluginController.getDebugSnapshot);

router.get("/debug/insert-fake-trades/:sessionId",
    validateRequest(pluginValidation.sessionIdParamSchema, "params"),
    pluginController.insertFakeTrades
);

router.get("/sessions/:sessionId/trades",
    validateRequest(pluginValidation.sessionIdParamSchema, "params"),
    pluginController.getTradingLogs
);

router.get("/sessions/:sessionId/download",
    validateRequest(pluginValidation.sessionIdParamSchema, "params"),
    pluginController.downloadTradingLogs
);

router.post("/:sessionId/exit-symbol/:symbol",
    authMiddleware,
    validateRequest(pluginValidation.exitSymbolParamSchema, "params"),
    pluginController.stopSymbol
);

export default router;
