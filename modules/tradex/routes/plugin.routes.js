import express from "express";
import authMiddleware from "../middlewares/auth.js";
import pluginController from "../controllers/plugin.controller.js";
import marketHoursGuard from "../middlewares/marketHourGuard.js";
import validateRequest from "../middlewares/validateRequest.js";
import sanitizeRequest from "../middlewares/sanitizeRequest.js";
import pluginValidation from "../validations/plugin.validation.js";
import * as proxyService from "../services/plugin.proxy.service.js";

const router = express.Router();

// Helper to handle admin stop (preserving original naming if needed, but using controller)
router.delete("/trading/session/:sessionId",
  authMiddleware,
  validateRequest(pluginValidation.sessionIdParamSchema, 'params'),
  pluginController.deleteTradingSession
);

router.post('/admin/sessions/:sessionId/stop',
  // marketHoursGuard,
  authMiddleware,
  validateRequest(pluginValidation.sessionIdParamSchema, 'params'),
  pluginController.adminStopSession
);

router.post('/admin/force-stop-all',
  authMiddleware,
  pluginController.adminForceStopAll
);

router.delete("/sessions/flush",
  authMiddleware,
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
  authMiddleware,
  pluginController.getActiveSession
);

router.get('/saved-configurations',
  authMiddleware,
  pluginController.getSavedTradingConfigurations
);

router.get('/saved-configurations/:configId',
  authMiddleware,
  validateRequest(pluginValidation.savedConfigurationParamSchema, 'params'),
  pluginController.getSavedTradingConfigurationById
);

router.post('/saved-configurations',
  authMiddleware,
  sanitizeRequest,
  validateRequest(pluginValidation.savedConfigurationBodySchema),
  pluginController.createSavedTradingConfiguration
);

router.put('/saved-configurations/:configId',
  authMiddleware,
  sanitizeRequest,
  validateRequest(pluginValidation.savedConfigurationParamSchema, 'params'),
  validateRequest(pluginValidation.savedConfigurationUpdateSchema),
  pluginController.updateSavedTradingConfiguration
);

router.delete('/saved-configurations/:configId',
  authMiddleware,
  validateRequest(pluginValidation.savedConfigurationParamSchema, 'params'),
  pluginController.deleteSavedTradingConfiguration
);

router.get('/trading/live-pnl/:session_id',
  authMiddleware,
  validateRequest(pluginValidation.livePnlParamSchema, 'params'),
  pluginController.getLivePnl
);

router.get('/trading/live-pnl/:session_id/history',
  authMiddleware,
  validateRequest(pluginValidation.livePnlParamSchema, 'params'),
  validateRequest(pluginValidation.livePnlHistoryQuerySchema, 'query'),
  pluginController.getLivePnlHistory
);

router.post("/trading/:sessionId/abandon",
  authMiddleware,
  validateRequest(pluginValidation.sessionIdParamSchema, 'params'),
  pluginController.abandonSession
);

router.get('/trading/sessions/:id',
  authMiddleware,
  validateRequest(pluginValidation.idParamSchema, 'params'),
  pluginController.getSessionById
);

router.post('/credentials',
  authMiddleware,
  // marketHoursGuard,
  sanitizeRequest,
  validateRequest(pluginValidation.submitCredentialsSchema),
  pluginController.submitCredentials
);

router.post('/totp',
  authMiddleware,
  // marketHoursGuard,
  sanitizeRequest,
  validateRequest(pluginValidation.submitTotpSchema),
  pluginController.submitTotp
);

router.post('/start',
  authMiddleware,
  // marketHoursGuard,
  sanitizeRequest,
  validateRequest(pluginValidation.startTradingSchema),
  pluginController.startTrading
);

router.post('/stop/:sessionId',
  authMiddleware,
  // marketHoursGuard,
  validateRequest(pluginValidation.sessionIdParamSchema, 'params'),
  pluginController.stopTradingBySessionId
);

router.get('/health',
  pluginController.getHealth
);

router.get('/debug/routing',
  authMiddleware,
  pluginController.getPluginRoutingDebug
);

router.get('/session',
  authMiddleware,
  validateRequest(pluginValidation.sessionStateQuerySchema, 'query'),
  pluginController.getSessionState
);

/**
 * DEBUG: Test endpoint to verify forwarding to port 8000
 * No authentication required
 */
router.post('/debug/test-forward', async (req, res) => {
  try {
    console.log("🟡 [DEBUG /test-forward] Received request");
    const targetUrl = 'http://localhost:8000';
    console.log("🟡 [DEBUG /test-forward] Attempting to forward to:", targetUrl);
    
    const response = await proxyService.forwardToPlugin(
      '/api/health',
      'get',
      {},
      {},
      {},
      { targetBaseUrl: targetUrl }
    );
    
    console.log("🟢 [DEBUG /test-forward] Success! Response:", response.data);
    res.json({ success: true, message: 'Forwarding works!', data: response.data });
  } catch (error) {
    console.log("🔴 [DEBUG /test-forward] Error:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/sessions/invalid',
  pluginController.deleteInvalidSessions
);

router.post('/stop',
  authMiddleware,
  sanitizeRequest,
  validateRequest(pluginValidation.stopTradingByBodySchema),
  pluginController.stopTradingByBodyId
);

router.get('/tradingsessions',
  authMiddleware,
  pluginController.getUserTradingSessions
);

router.delete('/tradingsession/:id',
  authMiddleware,
  validateRequest(pluginValidation.mongoIdParamSchema, 'params'),
  pluginController.deleteTradingSessionByIdParam
);

router.get('/dashboard',
  authMiddleware,
  validateRequest(pluginValidation.dashboardQuerySchema, 'query'),
  pluginController.getDashboardData
);

router.get('/dashboard/pnl',
  authMiddleware,
  validateRequest(pluginValidation.pnlQuerySchema, 'query'),
  pluginController.getPnlSummary
);

router.get('/dashboard/pnl/aggregate',
  authMiddleware,
  validateRequest(pluginValidation.userPnlQuerySchema, 'query'),
  pluginController.getUserPnlSummary
);

router.get('/trading/sessions',
  authMiddleware,
  pluginController.getUserTradingSessions
);

router.get('/trading/:sessionId/final-tradebook',
  authMiddleware,
  validateRequest(pluginValidation.sessionIdParamSchema, 'params'),
  pluginController.downloadFinalTradebook
);

router.get('/fetch/all-sessions',
  pluginController.getAllSessions
);


router.get('/debug/all-logs',
  pluginController.getAllTradingLogs
);

router.get('/debug/trading-logs/:sessionId',
  validateRequest(pluginValidation.sessionIdParamSchema, 'params'),
  pluginController.debugTradingLogs
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
  authMiddleware,
  validateRequest(pluginValidation.exitSymbolParamSchema, 'params'),
  pluginController.stopSymbol
);



export default router;


