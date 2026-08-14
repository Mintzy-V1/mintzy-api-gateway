import express from "express";
import authMiddleware from "../middlewares/auth.js";
import pluginController from "../controllers/plugin.controller.js";
import validateRequest from "../middlewares/validateRequest.js";
import sanitizeRequest from "../middlewares/sanitizeRequest.js";
import pluginValidation from "../validations/plugin.validation.js";

const router = express.Router();

router.post(
    "/credentials",
    authMiddleware,
    sanitizeRequest,
    validateRequest(pluginValidation.submitCredentialsSchema),
    pluginController.submitCredentials
);

router.post(
    "/start",
    authMiddleware,
    sanitizeRequest,
    validateRequest(pluginValidation.startTradingSchema),
    pluginController.startTrading
);

router.get(
    "/session/:sessionId/status",
    validateRequest(pluginValidation.sessionIdParamSchema, "params"),
    pluginController.getSessionStatus
);

router.get(
    "/trading/snapshot/:sessionId",
    validateRequest(pluginValidation.sessionIdParamSchema, "params"),
    pluginController.getTradingSnapshot
);

router.get(
    "/trading/live-pnl/:sessionId",
    authMiddleware,
    validateRequest(pluginValidation.sessionIdParamSchema, "params"),
    pluginController.getLivePnl
);

router.get(
    "/sessions/:sessionId/trades",
    validateRequest(pluginValidation.sessionIdParamSchema, "params"),
    pluginController.getTradingLogs
);

router.get(
    "/sessions/:sessionId/download",
    validateRequest(pluginValidation.sessionIdParamSchema, "params"),
    pluginController.downloadTradingLogs
);

router.get(
    "/admin/trading-logs",
    authMiddleware,
    validateRequest(pluginValidation.tradingLogsQuerySchema, "query"),
    pluginController.getAdminTradingLogs
);

router.get(
    "/admin/trading-logs/user/:userId",
    authMiddleware,
    validateRequest(pluginValidation.userIdParamSchema, "params"),
    validateRequest(pluginValidation.tradingLogsQuerySchema, "query"),
    pluginController.getAdminTradingLogsByUser
);

router.get(
    "/admin/trading-logs/user/:userId/download",
    authMiddleware,
    validateRequest(pluginValidation.userIdParamSchema, "params"),
    pluginController.downloadAdminTradingLogsByUser
);

router.post(
    "/admin/sessions/:sessionId/stop",
    authMiddleware,
    validateRequest(pluginValidation.sessionIdParamSchema, "params"),
    pluginController.adminStopSession
);

router.delete(
    "/admin/sessions/:sessionId",
    authMiddleware,
    validateRequest(pluginValidation.sessionIdParamSchema, "params"),
    pluginController.deleteAdminSession
);

// Debug endpoints — development only
router.get("/debug/snapshot", pluginController.getDebugSnapshot);

router.get(
    "/debug/insert-fake-trades/:sessionId",
    validateRequest(pluginValidation.sessionIdParamSchema, "params"),
    pluginController.insertFakeTrades
);

export default router;
