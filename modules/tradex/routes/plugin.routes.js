import express from "express";
import authMiddleware from "../middlewares/auth.js";
import pluginController from "../controllers/plugin.controller.js";
import marketHoursGuard from "../middlewares/marketHourGuard.js";
import validateRequest from "../middlewares/validateRequest.js";
import sanitizeRequest from "../middlewares/sanitizeRequest.js";
import pluginValidation from "../validations/plugin.validation.js";

const router = express.Router();

router.use(authMiddleware);

// Helper to handle admin stop (preserving original naming if needed, but using controller)
router.delete("/trading/session/:sessionId",
  validateRequest(pluginValidation.sessionIdParamSchema, 'params'),
  pluginController.deleteTradingSession
);

router.post('/admin/sessions/:sessionId/stop',
  // marketHoursGuard,
  validateRequest(pluginValidation.sessionIdParamSchema, 'params'),
  pluginController.adminStopSession
);

router.post('/admin/force-stop-all',
  pluginController.adminForceStopAll
);

router.delete("/sessions/flush",
  pluginController.flushSessions
);

router.post("/sessions/:sessionId/stop",
  validateRequest(pluginValidation.sessionIdParamSchema, 'params'),
  pluginController.stopSession
);

router.post("/sessions/stop-old",
  pluginController.stopOldSessions
);

router.get("/trading/active-session",
  pluginController.getActiveSession
);

router.get('/saved-configurations',
  pluginController.getSavedTradingConfigurations
);

router.get('/saved-configurations/:configId',
  validateRequest(pluginValidation.savedConfigurationParamSchema, 'params'),
  pluginController.getSavedTradingConfigurationById
);

router.post('/saved-configurations',
  sanitizeRequest,
  validateRequest(pluginValidation.savedConfigurationBodySchema),
  pluginController.createSavedTradingConfiguration
);

router.put('/saved-configurations/:configId',
  sanitizeRequest,
  validateRequest(pluginValidation.savedConfigurationParamSchema, 'params'),
  validateRequest(pluginValidation.savedConfigurationUpdateSchema),
  pluginController.updateSavedTradingConfiguration
);

router.delete('/saved-configurations/:configId',
  validateRequest(pluginValidation.savedConfigurationParamSchema, 'params'),
  pluginController.deleteSavedTradingConfiguration
);

router.get('/trading/live-pnl/:session_id',
  validateRequest(pluginValidation.livePnlParamSchema, 'params'),
  pluginController.getLivePnl
);

router.get('/trading/live-pnl/:session_id/history',
  validateRequest(pluginValidation.livePnlParamSchema, 'params'),
  validateRequest(pluginValidation.livePnlHistoryQuerySchema, 'query'),
  pluginController.getLivePnlHistory
);

router.post("/trading/:sessionId/abandon",
  validateRequest(pluginValidation.sessionIdParamSchema, 'params'),
  pluginController.abandonSession
);

router.get('/trading/sessions/:id',
  validateRequest(pluginValidation.idParamSchema, 'params'),
  pluginController.getSessionById
);

router.post('/credentials',
  // marketHoursGuard,
  sanitizeRequest,
  validateRequest(pluginValidation.submitCredentialsSchema),
  pluginController.submitCredentials
);

router.post('/totp',
  // marketHoursGuard,
  sanitizeRequest,
  validateRequest(pluginValidation.submitTotpSchema),
  pluginController.submitTotp
);

router.post('/start',
  // marketHoursGuard,
  sanitizeRequest,
  validateRequest(pluginValidation.startTradingSchema),
  pluginController.startTrading
);

router.post('/stop/:sessionId',
  // marketHoursGuard,
  validateRequest(pluginValidation.sessionIdParamSchema, 'params'),
  pluginController.stopTradingBySessionId
);

router.get('/health',
  pluginController.getHealth
);

router.get('/session',
  validateRequest(pluginValidation.sessionStateQuerySchema, 'query'),
  pluginController.getSessionState
);

router.delete('/sessions/invalid',
  pluginController.deleteInvalidSessions
);

router.post('/stop',
  sanitizeRequest,
  validateRequest(pluginValidation.stopTradingByBodySchema),
  pluginController.stopTradingByBodyId
);

router.get('/tradingsessions',
  pluginController.getUserTradingSessions
);

router.delete('/tradingsession/:id',
  validateRequest(pluginValidation.mongoIdParamSchema, 'params'),
  pluginController.deleteTradingSessionByIdParam
);

router.get('/dashboard',
  validateRequest(pluginValidation.dashboardQuerySchema, 'query'),
  pluginController.getDashboardData
);

router.get('/dashboard/pnl',
  validateRequest(pluginValidation.pnlQuerySchema, 'query'),
  pluginController.getPnlSummary
);

router.get('/dashboard/pnl/aggregate',
  validateRequest(pluginValidation.userPnlQuerySchema, 'query'),
  pluginController.getUserPnlSummary
);

router.get('/trading/sessions',
  pluginController.getUserTradingSessions
);

router.get('/trading/:sessionId/final-tradebook',
  validateRequest(pluginValidation.sessionIdParamSchema, 'params'),
  pluginController.downloadFinalTradebook
);

router.get('/fetch/all-sessions',
  pluginController.getAllSessions
);


router.get('/debug/all-logs',
  pluginController.getAllTradingLogs
);

router.get('/debug/final-pnl/:sessionId',
  pluginController.testFinalPnl
);

router.post('/debug/stop-plugin-session/:sessionId',
  pluginController.debugStopPluginSession
);



router.get('/sessions/:sessionId/trades',
  validateRequest(pluginValidation.sessionIdParamSchema, 'params'),
  pluginController.getTradingLogs
);



router.get("/sessions/:sessionId/status",
  validateRequest(pluginValidation.sessionIdParamSchema, 'params'),
  pluginController.getSessionStatus
);



router.get("/sessions/:sessionId/download",
  validateRequest(pluginValidation.sessionIdParamSchema, 'params'),
  pluginController.downloadTradingLogs
);



router.post("/:sessionId/exit-symbol/:symbol",
  validateRequest(pluginValidation.exitSymbolParamSchema, 'params'),
  pluginController.stopSymbol
);



export default router;

