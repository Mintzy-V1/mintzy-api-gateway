import mongoose from "mongoose";
import "../../../models/tradingSession.js";
import { forwardToPlugin, resolvePluginTargetUrl } from "./plugin.proxy.service.js";
import logger from "../config/logger.js";
import * as httpCache from "../../../utils/httpCache.js";

const escapeCsvValue = (value) => {
    if (value === null || value === undefined) return "";
    const stringValue = typeof value === "object" ? JSON.stringify(value) : String(value);
    return /[",\n\r]/.test(stringValue)
        ? `"${stringValue.replace(/"/g, '""')}"`
        : stringValue;
};

const toCsv = (rows) => {
    if (!rows || rows.length === 0) return "";

    const fields = Object.keys(rows[0]);
    return [
        fields.join(","),
        ...rows.map((row) => fields.map((field) => escapeCsvValue(row[field])).join(","))
    ].join("\n");
};

/**
 * Access the mintzy_plugin database
 */
const getPluginDb = () => mongoose.connection.useDb("mintzy_plugin");

/**
 * Fetch all trading logs across all sessions for debugging
 */
const fetchAllTradingLogs = async () => {
    const db = getPluginDb();
    const collection = db.collection("trading_logs");
    
    // Limit to 5000 records to ensure the response size stays under ~1.5MB
    return await collection.find({}).sort({ timestamp: -1 }).limit(2000).toArray();
};




/**
 * Fetch trading logs from the specialized plugin DB
 */
const fetchTradingLogs = async (sessionId) => {
    return httpCache.run(`logs:${sessionId}`, 10000, () => fetchTradingLogsUncached(sessionId));
};


let tradingLogsIndexesReady = false;

const ensureTradingLogsIndexes = async () => {
    if (tradingLogsIndexesReady) return;
    const collection = getPluginDb().collection("trading_logs");
    await collection.createIndex({ session_id: 1, timestamp: 1 }, { background: true });
    tradingLogsIndexesReady = true;
};

const fetchTradingLogsUncached = async (sessionId) => {
    const collection = getPluginDb().collection("trading_logs");
    await ensureTradingLogsIndexes();

    return await collection
        .find({ session_id: sessionId })
        .project({ _id: 0 })
        .sort({ timestamp: 1 })
        .toArray();
};

/**
 * Debug view of trading_logs for a session (shape, cycles, sample rows).
 */
const getTradingLogsDebugView = async (sessionId, options = {}) => {
    const limit = Math.min(Math.max(Number(options.limit) || 10, 1), 100);
    const cycleFilter = options.cycle != null && options.cycle !== ''
        ? Number(options.cycle)
        : null;

    const logs = await fetchTradingLogs(sessionId);
    if (!logs.length) {
        return {
            session_id: sessionId,
            total_logs: 0,
            cycles: [],
            fields_present: [],
            final_pnl_stamped_count: 0,
            latest_by_cycle: {},
            portfolio_snapshots_by_cycle: {},
            sample: [],
            sample_note: 'No logs found'
        };
    }

    const fieldsPresent = new Set();
    for (const log of logs) {
        Object.keys(log).forEach((key) => fieldsPresent.add(key));
    }

    const cycleSet = new Set(logs.map((log) => Number(log.cycle ?? 0)));
    const cycles = [...cycleSet].sort((a, b) => a - b);

    const logsByCycle = new Map();
    for (const log of logs) {
        const cycle = Number(log.cycle ?? 0);
        if (!logsByCycle.has(cycle)) logsByCycle.set(cycle, []);
        logsByCycle.get(cycle).push(log);
    }

    const latestByCycle = {};
    const portfolioSnapshotsByCycle = {};

    for (const cycle of cycles) {
        const cycleLogs = logsByCycle.get(cycle) || [];
        const latest = cycleLogs[cycleLogs.length - 1];
        const symbols = [...new Set(cycleLogs.map((log) => log.symbol).filter(Boolean))];

        latestByCycle[cycle] = {
            timestamp: latest?.timestamp ?? null,
            log_count: cycleLogs.length,
            symbol_count: symbols.length,
            symbols
        };

        portfolioSnapshotsByCycle[cycle] = {
            timestamp: latest?.timestamp ?? null,
            cash_balance: latest?.cash_balance ?? latest?.portfolio_cash_balance ?? null,
            realized_pnl: latest?.realized_pnl ?? latest?.portfolio_realized_pnl ?? null,
            unrealized_pnl: latest?.unrealized_pnl ?? latest?.portfolio_unrealized_pnl ?? null,
            portfolio_pnl: latest?.portfolio_pnl ?? latest?.pnl ?? null,
            total_equity: latest?.total_equity ?? latest?.portfolio_total_equity ?? null,
            final_pnl: latest?.final_pnl ?? null
        };
    }

    let sampleSource = logs;
    if (Number.isFinite(cycleFilter)) {
        sampleSource = logs.filter((log) => Number(log.cycle ?? 0) === cycleFilter);
    }

    const sample = sampleSource.slice(-limit);

    return {
        session_id: sessionId,
        total_logs: logs.length,
        cycles,
        fields_present: [...fieldsPresent].sort(),
        final_pnl_stamped_count: logs.filter((log) => log.final_pnl != null).length,
        latest_by_cycle: latestByCycle,
        portfolio_snapshots_by_cycle: portfolioSnapshotsByCycle,
        sample,
        sample_note: Number.isFinite(cycleFilter)
            ? `Last ${sample.length} log(s) for cycle ${cycleFilter}`
            : `Last ${sample.length} log(s) across all cycles`
    };
};

const DATE_TIMEZONE = 'Asia/Kolkata';
const LIVE_PNL_SAVE_INTERVAL_MS = 1000;
const LIVE_PNL_REQUEST_STOP_HOUR_IST = parseInt(process.env.LIVE_PNL_REQUEST_STOP_HOUR_IST || "15", 10);
const LIVE_PNL_REQUEST_STOP_MINUTE_IST = parseInt(process.env.LIVE_PNL_REQUEST_STOP_MINUTE_IST || "5", 10);
const LIVE_PNL_SNAPSHOT_STATUSES = new Set(['simulation_active', 'trading_active']);

const getDateKeyFromTimestamp = (timestamp) => {
    const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleDateString('en-CA', { timeZone: DATE_TIMEZONE });
};

const getIstMinutesSinceMidnight = (date = new Date()) => {
    const formatter = new Intl.DateTimeFormat('en-GB', {
        timeZone: DATE_TIMEZONE,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
    });
    const parts = formatter.formatToParts(date);
    const lookup = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
    return (Number(lookup.hour) * 60) + Number(lookup.minute);
};

const getLivePnlRequestStopMinutesSinceMidnight = () =>
    (LIVE_PNL_REQUEST_STOP_HOUR_IST * 60) + LIVE_PNL_REQUEST_STOP_MINUTE_IST;

const isLivePnlRequestCutoffDue = (date = new Date()) =>
    getIstMinutesSinceMidnight(date) >= getLivePnlRequestStopMinutesSinceMidnight();

let livePnlIndexesReady = false;
const livePnlLastSavedAt = new Map();
const livePnlSnapshotMonitors = new Map();

const getLivePnlMonitorKey = (userId, sessionId) => `${userId?.toString() || 'unknown'}:${sessionId}`;

const getLivePnlCollection = async () => {
    const collection = getPluginDb().collection('live_pnl_snapshots');

    if (!livePnlIndexesReady) {
        await Promise.all([
            collection.createIndex(
                { session_id: 1, user_id: 1, source_key: 1 },
                { unique: true, background: true }
            ),
            collection.createIndex(
                { session_id: 1, user_id: 1, market_date: 1, sampled_at: 1 },
                { background: true }
            )
        ]);
        livePnlIndexesReady = true;
    }

    return collection;
};

const toNumber = (value, fallback = 0) => {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : fallback;
};

const getSourceDateFromLivePnlData = (data) => {
    const ts = Number(data?.ts);
    if (Number.isFinite(ts) && ts > 0) {
        return new Date(ts > 1e12 ? ts : ts * 1000);
    }
    return new Date();
};

const saveLivePnlSnapshot = async (userId, sessionId, pluginResponse, phase = 'live') => {
    try {
        const ready = pluginResponse?.ready ?? false;
        const data = pluginResponse?.data ?? null;

        if (!ready || !data) return null;

        const sampledAt = new Date();
        const throttleKey = `${userId?.toString() || 'unknown'}:${sessionId}`;
        const lastSavedAt = livePnlLastSavedAt.get(throttleKey) || 0;

        if (sampledAt.getTime() - lastSavedAt < LIVE_PNL_SAVE_INTERVAL_MS) {
            return null;
        }

        const sourceDate = getSourceDateFromLivePnlData(data);
        const marketDate = getDateKeyFromTimestamp(sourceDate) || getDateKeyFromTimestamp(sampledAt);
        const sourceBucket = Math.floor(sourceDate.getTime() / LIVE_PNL_SAVE_INTERVAL_MS) * LIVE_PNL_SAVE_INTERVAL_MS;
        const sourceKey = `${phase}:${sourceBucket}`;
        const userIdValue = userId?.toString();

        const doc = {
            session_id: sessionId,
            user_id: userIdValue,
            phase,
            market_date: marketDate,
            source_key: sourceKey,
            source_ts: data.ts ?? null,
            source_time: sourceDate,
            sampled_at: sampledAt,
            total_pnl: toNumber(data.total_pnl),
            realized_pnl: toNumber(data.realized_pnl),
            live_unrealized_pnl: toNumber(data.live_unrealized_pnl),
            symbols: data.symbols || {},
            raw_response: pluginResponse,
            updated_at: sampledAt
        };

        const collection = await getLivePnlCollection();
        await collection.updateOne(
            { session_id: sessionId, user_id: userIdValue, source_key: sourceKey },
            { $set: doc, $setOnInsert: { created_at: sampledAt } },
            { upsert: true }
        );

        livePnlLastSavedAt.set(throttleKey, sampledAt.getTime());

        return doc;
    } catch (err) {
        logger.warn('saveLivePnlSnapshot failed', { sessionId, error: err.message });
        return null;
    }
};

const normalizeLivePnlSnapshot = (snapshot) => {
    const rawData = snapshot?.raw_response?.data || {};
    return {
        sampled_at: snapshot.sampled_at,
        source_ts: snapshot.source_ts,
        market_date: snapshot.market_date,
        phase: snapshot.phase || rawData.phase || null,
        data: {
            realized_pnl: toNumber(snapshot.realized_pnl),
            live_unrealized_pnl: toNumber(snapshot.live_unrealized_pnl),
            total_pnl: toNumber(snapshot.total_pnl),
            symbols: snapshot.symbols || rawData.symbols || {},
            ts: snapshot.source_ts ?? rawData.ts ?? null
        }
    };
};

const buildMonthDateKeys = (year, month) => {
    const daysInMonth = new Date(year, month, 0).getDate();
    const monthKey = String(month).padStart(2, '0');
    const yearKey = String(year).padStart(4, '0');
    const keys = [];
    for (let day = 1; day <= daysInMonth; day += 1) {
        keys.push(`${yearKey}-${monthKey}-${String(day).padStart(2, '0')}`);
    }
    return keys;
};

const buildEmptyDailyFinalPnl = (year, month) =>
    buildMonthDateKeys(year, month).map((date) => ({
        date,
        final_pnl: 0,
        closing_final_pnl: 0,
        previous_closing_final_pnl: 0
    }));

/**
 * Resolve per-symbol PnL: prefer stamped final_pnl, else symbol/live pnl fields.
 */
const resolveSymbolPnl = (log) => {
    if (log?.final_pnl != null && !Number.isNaN(Number(log.final_pnl))) {
        return Number(log.final_pnl);
    }
    if (log?.symbol_pnl != null && !Number.isNaN(Number(log.symbol_pnl))) {
        return Number(log.symbol_pnl);
    }
    if (log?.pnl != null && !Number.isNaN(Number(log.pnl))) {
        return Number(log.pnl);
    }
    return null;
};

const normalizeSymbolKey = (symbol) => {
    if (typeof symbol !== 'string' || symbol.trim() === '') {
        return '_unknown';
    }
    return symbol.trim().toUpperCase();
};

/**
 * Sum PnL across every symbol in the last (max) cycle for a single day's logs.
 * Takes the latest log per symbol, then adds each symbol's pnl into the day total.
 */
const sumFinalPnlForLastCycle = (dayLogs) => {
    if (!Array.isArray(dayLogs) || dayLogs.length === 0) return 0;

    const maxCycle = Math.max(...dayLogs.map((log) => Number(log.cycle ?? 0)));
    const lastCycleLogs = dayLogs.filter((log) => Number(log.cycle ?? 0) === maxCycle);
    const latestLogBySymbol = new Map();

    for (const log of lastCycleLogs) {
        const symbolKey = normalizeSymbolKey(log.symbol);
        const existing = latestLogBySymbol.get(symbolKey);
        if (!existing || new Date(existing.timestamp) < new Date(log.timestamp)) {
            latestLogBySymbol.set(symbolKey, log);
        }
    }

    let total = 0;
    for (const log of latestLogBySymbol.values()) {
        const pnlValue = resolveSymbolPnl(log);
        if (pnlValue == null) continue;
        total += pnlValue;
    }

    return Number(total.toFixed(2));
};

/**
 * Map each calendar date (IST) to last-cycle summed PnL for that day (per session).
 */
const computeLastCycleFinalPnlByDate = (logs) => {
    const logsByDate = new Map();

    for (const log of logs) {
        const dateKey = getDateKeyFromTimestamp(log.timestamp);
        if (!dateKey) continue;
        if (!logsByDate.has(dateKey)) logsByDate.set(dateKey, []);
        logsByDate.get(dateKey).push(log);
    }

    const pnlByDate = new Map();
    for (const [dateKey, dayLogs] of logsByDate) {
        pnlByDate.set(dateKey, sumFinalPnlForLastCycle(dayLogs));
    }
    return pnlByDate;
};

const buildDailyFinalPnlFromMap = (pnlByDate, year, month) => {
    const monthDates = buildMonthDateKeys(year, month);
    const monthStartKey = monthDates[0];

    let priorClosing = 0;
    for (const dateKey of Array.from(pnlByDate.keys()).sort()) {
        if (dateKey < monthStartKey) {
            priorClosing += pnlByDate.get(dateKey) ?? 0;
        }
    }
    priorClosing = Number(priorClosing.toFixed(2));

    const daily = [];
    let previousClosing = priorClosing;

    for (const dateKey of monthDates) {
        const dayFinal = pnlByDate.get(dateKey) ?? 0;
        const closing = Number((previousClosing + dayFinal).toFixed(2));
        daily.push({
            date: dateKey,
            final_pnl: dayFinal,
            closing_final_pnl: closing,
            previous_closing_final_pnl: Number(previousClosing.toFixed(2))
        });
        previousClosing = closing;
    }

    const monthlyTotal = Number(daily.reduce((sum, entry) => sum + entry.final_pnl, 0).toFixed(2));
    return { daily, monthly_total: monthlyTotal };
};

const buildCurrentFromLogs = (logs, pnlByDate) => {
    if (!Array.isArray(logs) || logs.length === 0) return null;

    const sortedLogs = [...logs].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const latestLog = sortedLogs[sortedLogs.length - 1];
    const latestDateKey = getDateKeyFromTimestamp(latestLog.timestamp);
    const latestDayFinal = latestDateKey ? (pnlByDate.get(latestDateKey) ?? 0) : 0;

    return {
        timestamp: latestLog.timestamp,
        final_pnl: latestDayFinal,
        realized_pnl: Number(latestLog.realized_pnl ?? 0),
        unrealized_pnl: Number(latestLog.unrealized_pnl ?? 0),
        total_equity: Number(latestLog.total_equity ?? 0),
        cash_balance: Number(latestLog.cash_balance ?? 0)
    };
};

const calculateDailyFinalPnl = (logs, year, month) => {
    if (!Array.isArray(logs) || logs.length === 0) {
        return {
            current: null,
            daily: buildEmptyDailyFinalPnl(year, month),
            monthly_total: 0
        };
    }

    const pnlByDate = computeLastCycleFinalPnlByDate(logs);
    const { daily, monthly_total } = buildDailyFinalPnlFromMap(pnlByDate, year, month);
    const current = buildCurrentFromLogs(logs, pnlByDate);

    return { current, daily, monthly_total };
};

const calculateDailyRealizedPnl = (logs, year, month) => {
    if (!Array.isArray(logs)) {
        return {
            current: null,
            daily: [],
            monthly_total: 0
        };
    }

    const sortedLogs = [...logs].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const yearNum = Number(year);
    const monthNum = Number(month);

    const monthDates = buildMonthDateKeys(yearNum, monthNum);
    const monthStartKey = monthDates[0];
    const monthEndKey = monthDates[monthDates.length - 1];

    let priorClosingRealized = 0;
    const closingByDay = {};
    let latestLog = null;

    for (const log of sortedLogs) {
        const logDateKey = getDateKeyFromTimestamp(log.timestamp);
        if (!logDateKey) continue;

        const realizedValue = Number(log.realized_pnl ?? 0);
        if (logDateKey < monthStartKey) {
            priorClosingRealized = realizedValue;
        }

        if (logDateKey >= monthStartKey && logDateKey <= monthEndKey) {
            closingByDay[logDateKey] = realizedValue;
        }

        latestLog = log;
    }

    const daily = [];
    let previousClosing = priorClosingRealized;

    for (const dateKey of monthDates) {
        const closing = Object.prototype.hasOwnProperty.call(closingByDay, dateKey)
            ? closingByDay[dateKey]
            : previousClosing;
        const dailyRealized = Number((closing - previousClosing).toFixed(2));

        daily.push({
            date: dateKey,
            realized_pnl: dailyRealized,
            closing_realized_pnl: Number(closing.toFixed(2)),
            previous_closing_realized_pnl: Number(previousClosing.toFixed(2))
        });

        previousClosing = closing;
    }

    const monthlyTotal = Number(daily.reduce((sum, entry) => sum + entry.realized_pnl, 0).toFixed(2));
    const current = latestLog
        ? {
              timestamp: latestLog.timestamp,
              realized_pnl: Number(latestLog.realized_pnl ?? 0),
              unrealized_pnl: Number(latestLog.unrealized_pnl ?? 0),
              total_equity: Number(latestLog.total_equity ?? 0),
              cash_balance: Number(latestLog.cash_balance ?? 0)
          }
        : null;

    return {
        current,
        daily,
        monthly_total: monthlyTotal
    };
};

const fetchTradingLogsBySessionIds = async (sessionIds, endDate) => {
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) return [];

    const db = getPluginDb();
    const collection = db.collection('trading_logs');

    const filter = {
        session_id: { $in: sessionIds }
    };

    if (endDate) {
        filter.timestamp = { $lte: endDate };
    }

    return await collection
        .find(filter)
        // Only the fields the PnL computation reads — cuts the payload several
        // times over for users with many sessions.
        .project({
            _id: 0,
            session_id: 1,
            timestamp: 1,
            cycle: 1,
            symbol: 1,
            final_pnl: 1,
            symbol_pnl: 1,
            pnl: 1,
            realized_pnl: 1,
            unrealized_pnl: 1,
            total_equity: 1,
            cash_balance: 1,
            portfolio_cash_balance: 1,
            portfolio_realized_pnl: 1,
            portfolio_unrealized_pnl: 1,
            portfolio_pnl: 1,
            portfolio_total_equity: 1
        })
        .sort({ session_id: 1, timestamp: 1 })
        .toArray();
};

const getTradingPnlSummary = async (sessionId, year, month) => {
    return httpCache.run(`pnl:${sessionId}:${year}:${month}`, 15000, () => getTradingPnlSummaryUncached(sessionId, year, month));
};


const getTradingPnlSummaryUncached = async (sessionId, year, month) => {
    const logs = await fetchTradingLogs(sessionId);
    return calculateDailyFinalPnl(logs, year, month);
};

const getUserTradingPnlSummary = async (userId, year, month) => {
    return httpCache.run(`pnlAgg:${userId}:${year}:${month}`, 15000, () => getUserTradingPnlSummaryUncached(userId, year, month));
};


const getUserTradingPnlSummaryUncached = async (userId, year, month) => {
    const sessions = await mongoose.model('TradingSession')
        .find({ user_id: userId, python_session_id: { $exists: true, $ne: null } })
        .select('python_session_id')
        .lean();

    const sessionIds = sessions.map((session) => session.python_session_id).filter(Boolean);
    if (sessionIds.length === 0) {
        return {
            current: null,
            daily: buildEmptyDailyFinalPnl(year, month),
            monthly_total: 0
        };
    }

    const allLogs = await fetchTradingLogsBySessionIds(sessionIds);
    if (!Array.isArray(allLogs) || allLogs.length === 0) {
        return {
            current: null,
            daily: buildEmptyDailyFinalPnl(year, month),
            monthly_total: 0
        };
    }

    const aggregatedByDate = new Map();
    const logsBySession = new Map();

    for (const log of allLogs) {
        const sessionIdValue = log.session_id;
        if (!sessionIdValue) continue;
        if (!logsBySession.has(sessionIdValue)) logsBySession.set(sessionIdValue, []);
        logsBySession.get(sessionIdValue).push(log);
    }

    for (const sessionLogs of logsBySession.values()) {
        const sessionPnlByDate = computeLastCycleFinalPnlByDate(sessionLogs);
        for (const [dateKey, dayPnl] of sessionPnlByDate) {
            aggregatedByDate.set(dateKey, Number(((aggregatedByDate.get(dateKey) ?? 0) + dayPnl).toFixed(2)));
        }
    }

    const { daily, monthly_total } = buildDailyFinalPnlFromMap(aggregatedByDate, year, month);

    const latestBySession = new Map();
    for (const log of allLogs) {
        const sessionIdValue = log.session_id;
        if (!sessionIdValue) continue;
        const existing = latestBySession.get(sessionIdValue);
        if (!existing || new Date(existing.timestamp) < new Date(log.timestamp)) {
            latestBySession.set(sessionIdValue, log);
        }
    }

    let currentFinalPnl = 0;
    for (const [sessionIdValue, latestLog] of latestBySession) {
        const sessionLogs = logsBySession.get(sessionIdValue) || [];
        const sessionPnlByDate = computeLastCycleFinalPnlByDate(sessionLogs);
        const latestDateKey = getDateKeyFromTimestamp(latestLog.timestamp);
        currentFinalPnl += latestDateKey ? (sessionPnlByDate.get(latestDateKey) ?? 0) : 0;
    }

    const latestLog = Array.from(latestBySession.values()).reduce((latest, log) => {
        return !latest || new Date(latest.timestamp) < new Date(log.timestamp) ? log : latest;
    }, null);

    console.log('[aggregate PnL] total_equity per session (latest log each):');
    for (const [sessionIdValue, log] of latestBySession) {
        console.log(`  session=${sessionIdValue} total_equity=${log.total_equity ?? 0} timestamp=${log.timestamp}`);
    }
    if (latestLog) {
        console.log('[aggregate PnL] using single latest session snapshot (not summed):', {
            session_id: latestLog.session_id,
            total_equity: latestLog.total_equity ?? 0,
            cash_balance: latestLog.cash_balance ?? 0,
            timestamp: latestLog.timestamp
        });
    }

    // Account snapshots (equity, cash, etc.) reflect one broker account — use the
    // most recent session only. Summing across historical sessions double-counts.
    const current = latestLog
        ? {
              session_id: latestLog.session_id,
              timestamp: latestLog.timestamp,
              final_pnl: Number(currentFinalPnl.toFixed(2)),
              realized_pnl: Number(latestLog.realized_pnl ?? 0),
              unrealized_pnl: Number(latestLog.unrealized_pnl ?? 0),
              total_equity: Number(latestLog.total_equity ?? 0),
              cash_balance: Number(latestLog.cash_balance ?? 0)
          }
        : null;

    return { current, daily, monthly_total };
};

const syncStoppedPluginSessionToTradingSession = async (sessionId, pluginSession) => {
    const isStopped = pluginSession?.status === 'stopped' || pluginSession?.stopped === true;
    if (!isStopped) return null;

    const stoppedAt = pluginSession.ended_at || pluginSession.stopped_at || new Date();
    const tradingSession = await mongoose.model('TradingSession').findOneAndUpdate(
        { python_session_id: sessionId, status: { $ne: 'stopped' } },
        { $set: { status: 'stopped', ended_at: stoppedAt } },
        { new: true }
    );

    if (tradingSession) {
        stopLivePnlSnapshotMonitor(sessionId, tradingSession.user_id);
        logger.info('Synced stopped plugin session to TradingSession', {
            sessionId,
            tradingSessionId: tradingSession._id
        });
    }

    return tradingSession;
};

/**
 * Fetch session status from the specialized plugin DB
 */
const fetchSessionStatus = async (sessionId) => {
    return httpCache.run(`status:${sessionId}`, 5000, () => fetchSessionStatusUncached(sessionId));
};


const fetchSessionStatusUncached = async (sessionId) => {
    const db = getPluginDb();
    const collection = db.collection("plugin_sessions");

    const session = await collection.findOne(
        { session_id: sessionId },
        { projection: { _id: 0 } }
    );

    await syncStoppedPluginSessionToTradingSession(sessionId, session);

    return session;
};

const resetPluginSessionToAuthenticated = async (sessionId, metadata = {}) => {
    httpCache.invalidateSession(sessionId);
    const authenticatedAt = new Date();
    const db = getPluginDb();
    const collection = db.collection("plugin_sessions");

    const result = await collection.findOneAndUpdate(
        { session_id: sessionId, status: "trading_active" },
        {
            $set: {
                status: "authenticated",
                updated_at: authenticatedAt,
                live_handoff_reset_reason: metadata.reason || "simulation_live_handoff"
            }
        },
        { returnDocument: "after" }
    );

    const session = result?.value || result;
    logger.info("Reset plugin session from trading_active to authenticated", {
        sessionId,
        updated: !!session,
        reason: metadata.reason || "simulation_live_handoff"
    });

    return session;
};

const markPluginSessionAuthenticated = async (sessionId, metadata = {}) => {
    httpCache.invalidateSession(sessionId);
    const authenticatedAt = new Date();
    const db = getPluginDb();
    const collection = db.collection("plugin_sessions");

    const result = await collection.findOneAndUpdate(
        {
            session_id: sessionId,
            status: { $nin: ["authenticated", "trading_active", "running", "started", "stopped"] }
        },
        {
            $set: {
                status: "authenticated",
                authenticated: true,
                authenticated_at: authenticatedAt,
                updated_at: authenticatedAt,
                auto_authenticated: true,
                auto_authenticated_reason: metadata.reason || "api_key_auto_auth"
            }
        },
        { returnDocument: "after" }
    );

    const session = result?.value || result;
    logger.info("Auto-authenticated plugin session", {
        sessionId,
        updated: !!session,
        reason: metadata.reason || "api_key_auto_auth"
    });

    return session;
};

const markPluginSessionTradingActive = async (sessionId, metadata = {}) => {
    httpCache.invalidateSession(sessionId);
    const startedAt = new Date();
    const db = getPluginDb();
    const collection = db.collection("plugin_sessions");

    const result = await collection.findOneAndUpdate(
        { session_id: sessionId },
        {
            $set: {
                status: "trading_active",
                trading_status: metadata.trading_status || "running",
                trading_started_at: startedAt,
                updated_at: startedAt,
                ...(metadata.strategy ? { strategy: metadata.strategy } : {}),
                ...(metadata.symbols ? { symbols: metadata.symbols } : {}),
                ...(metadata.time_frame ? { time_frame: metadata.time_frame } : {}),
                ...(metadata.candle ? { candle: metadata.candle } : {}),
            }
        },
        { returnDocument: "after" }
    );

    return result?.value || result;
};

const markPluginSessionStopped = async (sessionId, metadata = {}) => {
    httpCache.invalidateSession(sessionId);
    const stoppedAt = metadata.stopped_at ? new Date(metadata.stopped_at) : new Date();
    const db = getPluginDb();
    const collection = db.collection("plugin_sessions");

    const result = await collection.findOneAndUpdate(
        { session_id: sessionId },
        {
            $set: {
                status: "stopped",
                trading_status: metadata.trading_status || "stopped",
                stopped: true,
                ended_at: stoppedAt,
                stopped_at: stoppedAt,
                updated_at: stoppedAt,
                worker_pid: null,
            }
        },
        { returnDocument: "after" }
    );

    await syncStoppedPluginSessionToTradingSession(sessionId, result?.value || result);
    return result?.value || result;
};

/**
 * Debug helper: mark a plugin DB session as stopped without touching the
 * trading engine. This is intentionally only for manual recovery/testing.
 */
const debugStopPluginSession = async (sessionId) => {
    httpCache.invalidateSession(sessionId);
    const stoppedAt = new Date();
    const db = getPluginDb();
    const collection = db.collection("plugin_sessions");

    const pluginSessionResult = await collection.findOneAndUpdate(
        { session_id: sessionId },
        {
            $set: {
                status: "stopped",
                stopped: true,
                ended_at: stoppedAt,
                stopped_at: stoppedAt,
                updated_at: stoppedAt
            }
        },
        { returnDocument: "after" }
    );
    const pluginSession = pluginSessionResult?.value || pluginSessionResult;

    const tradingSession = await mongoose.model('TradingSession').findOneAndUpdate(
        { python_session_id: sessionId },
        { $set: { status: "stopped", ended_at: stoppedAt } },
        { new: true }
    );

    stopLivePnlSnapshotMonitor(sessionId, tradingSession?.user_id);

    return {
        session_id: sessionId,
        plugin_session_updated: !!pluginSession,
        plugin_session: pluginSession,
        trading_session_updated: !!tradingSession,
        trading_session: tradingSession
    };
};

/**
 * Aggregate dashboard state (Status, Snapshot, Logs)
 */
const getDashboardState = async (userId, sessionId) => {
    return httpCache.run(`dash:${userId}:${sessionId}`, 5000, () => getDashboardStateUncached(userId, sessionId));
};


const getDashboardStateUncached = async (userId, sessionId) => {
    logger.info("Fetching dashboard state", { userId, sessionId });

    const ts = await mongoose.model('TradingSession').findOne({ python_session_id: sessionId });
    const targetBaseUrl = resolvePluginTargetUrl(ts);

    // 🕒 IST Market Hours Check for Snapshot
    const now = new Date();
    const istTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const isAfterMarketClose = istTime.getHours() > 15 || (istTime.getHours() === 15 && istTime.getMinutes() >= 30);

    const promises = [
        fetchSessionStatus(sessionId),
        isAfterMarketClose
            ? Promise.resolve(null)
            : forwardToPlugin(
                `/api/trading/snapshot/${sessionId}`,
                'get',
                null,
                { 'X-Forwarded-User': userId.toString() },
                {},
                { timeoutMs: 15000, retries: 2, failOnError: false, targetBaseUrl }
            ),
        fetchTradingLogs(sessionId)
    ];

    const [statusRes, snapshotRes, logs] = await Promise.allSettled(promises);

    const unwrap = (r) => (r && r.status === 'fulfilled' && r.value ? (r.value.data || r.value) : null);

    const state = {
        status: unwrap(statusRes),
        snapshot: unwrap(snapshotRes),
        logs: unwrap(logs) || []
    };

    // Optional: Inference logic for free_cash if status is missing
    if ((!state.status || Object.keys(state.status).length === 0) && state.snapshot) {
        const snap = state.snapshot;
        const inferredCash = snap?.cash_balance ?? snap?.free_cash ?? snap?.total_equity ?? snap?.totalCapital ?? null;
        if (inferredCash != null) {
            state.status = {
                status: 'unknown',
                free_cash: inferredCash,
                note: 'inferred_from_snapshot'
            };
        }
    }

    return state;
};

/**
 * Generate CSV from trading logs
 */
const generateLogsCSV = async (sessionId) => {
    const logs = await fetchTradingLogs(sessionId);
    if (!logs || logs.length === 0) return null;

    return toCsv(logs);
};

/**
 * Fetch all sessions from the specialized plugin DB
 */
const getAllSessions = async () => {
    logger.info("Fetching all sessions from plugin DB");
    const db = getPluginDb();
    const collection = db.collection("plugin_sessions");
    return await collection.find({}).sort({ timestamp: -1 }).toArray();
};

/**
 * Restore a session via token
 */
const restoreSession = async (userId, token) => {
    logger.info("Restoring session via token", { userId });
    // Without full python_session_id mapping to token easily, we fallback to user's latest session if possible, though token route might handle its own proxy locally.
    // For now we try to find active session for user to derive VM URL
    const ts = await mongoose.model('TradingSession').findOne({ user_id: userId }).sort({ created_at: -1 });
    const targetBaseUrl = resolvePluginTargetUrl(ts);

    return await forwardToPlugin(`/api/session/restore`, 'get', null, { 'X-Forwarded-User': userId.toString() }, { token }, { targetBaseUrl });
};

const restorePluginSessionById = async (userId, sessionId, targetBaseUrl) => {
    logger.info("Restoring plugin session after simulation stop", { userId, sessionId });

    const pluginRes = await forwardToPlugin(
        `/api/debug/restore-session/${sessionId}`,
        "get",
        null,
        { "X-Forwarded-User": userId.toString() },
        {},
        { targetBaseUrl, timeoutMs: 30000, retries: 1 }
    );



    print("pluginRes" ,pluginRes)
    print("pluginRes data" ,pluginRes.data,pluginRes.data.data)


    return pluginRes?.data;
};

const restoreAuthenticatedSessionInPluginDb = async (sessionId, metadata = {}) => {
    const authenticatedAt = new Date();
    const db = getPluginDb();
    const collection = db.collection("plugin_sessions");

    const existing = await collection.findOne({ session_id: sessionId });

    if (!existing?.broker_session?.token && !existing?.broker_session?.feed_token) {
        return null;
    }

    const result = await collection.findOneAndUpdate(
        { session_id: sessionId },
        {
            $set: {
                status: "authenticated",
                authenticated: true,
                authenticated_at: existing.authenticated_at || authenticatedAt,
                updated_at: authenticatedAt,
                live_handoff_restore_reason: metadata.reason || "simulation_stop_db_restore"
            }
        },
        { returnDocument: "after" }
    );

    return result?.value || result;
};

/**
 * Get full session state (status, snapshot, trades)
 */
const getFullSessionState = async (userId, pythonSessionId) => {
    return httpCache.run(`full:${userId}:${pythonSessionId}`, 5000, () => getFullSessionStateUncached(userId, pythonSessionId));
};


const getFullSessionStateUncached = async (userId, pythonSessionId) => {
    logger.info("Fetching full session state", { userId, pythonSessionId });

    const ts = await mongoose.model('TradingSession').findOne({ python_session_id: pythonSessionId });
    const targetBaseUrl = resolvePluginTargetUrl(ts);

    const settled = await Promise.allSettled([
        forwardToPlugin(`/api/session/${pythonSessionId}/status`, 'get', null, { 'X-Forwarded-User': userId.toString() }, {}, { timeoutMs: 10000, retries: 2, failOnError: false, targetBaseUrl }),
        forwardToPlugin(`/api/trading/snapshot/${pythonSessionId}`, 'get', null, { 'X-Forwarded-User': userId.toString() }, {}, { timeoutMs: 15000, retries: 2, failOnError: false, targetBaseUrl }),
        forwardToPlugin(`/api/sessions/${pythonSessionId}/trades`, 'get', null, { 'X-Forwarded-User': userId.toString() }, {}, { timeoutMs: 15000, retries: 2, failOnError: false, targetBaseUrl }),
    ]);

    const unwrap = (r) => (r && r.status === 'fulfilled' && r.value ? (r.value.data || r.value) : null);

    const response = {
        success: true,
        python_session_id: pythonSessionId,
        status: unwrap(settled[0]),
        snapshot: unwrap(settled[1]),
        logs: unwrap(settled[2]) || [],
    };

    // Inference logic
    if ((!response.status || Object.keys(response.status).length === 0) && response.snapshot) {
        const snap = response.snapshot;
        const inferredCash = snap?.cash_balance ?? snap?.free_cash ?? snap?.total_equity ?? snap?.totalCapital ?? null;
        if (inferredCash != null) response.status = { status: 'unknown', free_cash: inferredCash, note: 'inferred_from_snapshot' };
    }

    return response;
};

/**
 * On session stop: fetch live PnL per symbol and stamp final_pnl onto
 * all existing trading_logs docs for that session + symbol.
 */
const saveFinalPnlSnapshot = async (sessionId) => {
    httpCache.invalidateSession(sessionId);
    try {
        const ts = await mongoose.model('TradingSession').findOne({ python_session_id: sessionId });
        const targetBaseUrl = resolvePluginTargetUrl(ts);
        const userId = ts?.user_id?.toString();

        const result = await forwardToPlugin(
            `/api/trading/live-pnl/${sessionId}`,
            'get',
            null,
            userId ? { 'X-Forwarded-User': userId } : {},
            {},
            { timeoutMs: 10000, retries: 1, failOnError: false, targetBaseUrl }
        );

        let symbols = result?.data?.data?.symbols ?? result?.data?.symbols;

        const collection = getPluginDb().collection('trading_logs');

        // A stopped session often no longer reports symbols from the plugin VM.
        // Fall back to the last trading-log row per symbol so we still capture
        // the final realized P&L.
        if (!symbols || Object.keys(symbols).length === 0) {
            const lastLogs = await collection
                .find({ session_id: sessionId })
                .sort({ _id: 1 })
                .toArray();
            symbols = {};
            for (const log of lastLogs) {
                const sym = String(log.symbol || '').toUpperCase();
                if (!sym || sym === '-') continue;
                symbols[sym] = {
                    realized_pnl: Number(log.symbol_realized_pnl ?? log.realized_pnl ?? 0) || 0,
                    live_unrealized_pnl: Number(log.symbol_unrealized_pnl ?? log.unrealized_pnl ?? 0) || 0
                };
            }
        }

        if (!symbols || Object.keys(symbols).length === 0) {
            logger.warn('saveFinalPnlSnapshot: no symbols to persist', { sessionId });
            return;
        }

        await Promise.all(
            Object.entries(symbols).map(async ([symbol, info]) => {
                const unrealized = info?.unrealized_pnl ?? info?.live_unrealized_pnl ?? 0;
                const realized   = info?.realized_pnl ?? 0;
                const final_pnl  = parseFloat((unrealized + realized).toFixed(2));

                const maxCycleDoc = await collection
                    .find({ session_id: sessionId, symbol })
                    .sort({ cycle: -1 })
                    .limit(1)
                    .toArray();

                const maxCycle = maxCycleDoc[0]?.cycle;
                const filter = { session_id: sessionId, symbol };
                if (maxCycle != null) {
                    filter.cycle = maxCycle;
                }

                return collection.updateMany(filter, { $set: { final_pnl } });
            })
        );

        await saveFinalLivePnlSnapshot(sessionId, userId, ts, symbols);

        logger.info('saveFinalPnlSnapshot: stamped final_pnl', { sessionId, symbols: Object.keys(symbols) });
    } catch (err) {
        logger.warn('saveFinalPnlSnapshot failed', { sessionId, error: err.message });
    }
};

/**
 * Persist a final live_pnl_snapshot on session close so the P&L chart / panel
 * end on the realized values instead of the last pre-close (unrealized)
 * snapshot — which is what caused the trade-log vs graph disparity.
 */
const saveFinalLivePnlSnapshot = async (sessionId, userId, ts, symbols) => {
    try {
        const snapCollection = getPluginDb().collection('live_pnl_snapshots');
        const existing = await snapCollection.findOne(
            { session_id: sessionId },
            { sort: { source_time: -1 }, projection: { market_date: 1 } }
        );
        const marketDate = existing?.market_date
            || getDateKeyFromTimestamp(ts?.ended_at || ts?.created_at || new Date());
        if (!marketDate) return;

        const snapSymbols = {};
        let total = 0;
        for (const [sym, info] of Object.entries(symbols)) {
            const realized = Number(info?.realized_pnl ?? 0) || 0;
            const unrealized = Number(info?.unrealized_pnl ?? info?.live_unrealized_pnl ?? 0) || 0;
            const sum = parseFloat((realized + unrealized).toFixed(2));
            total += sum;
            snapSymbols[sym] = {
                realized_pnl: realized,
                unrealized_pnl: unrealized,
                total_pnl: sum,
                qty: info?.qty ?? null,
                side: info?.side ?? info?.signal ?? null,
                position_status: 'CLOSED',
                exit_reason: null
            };
        }

        const now = new Date();
        const doc = {
            session_id: sessionId,
            user_id: userId,
            phase: 'live',
            market_date: marketDate,
            source_key: 'final',
            source_ts: now.getTime() / 1000,
            source_time: now,
            sampled_at: now,
            total_pnl: parseFloat(total.toFixed(2)),
            realized_pnl: parseFloat(Object.values(snapSymbols).reduce((a, s) => a + s.realized_pnl, 0).toFixed(2)),
            live_unrealized_pnl: parseFloat(Object.values(snapSymbols).reduce((a, s) => a + s.unrealized_pnl, 0).toFixed(2)),
            symbols: snapSymbols,
            updated_at: now
        };

        await snapCollection.updateOne(
            { session_id: sessionId, user_id: userId, source_key: 'final' },
            { $set: doc, $setOnInsert: { created_at: now } },
            { upsert: true }
        );

        logger.info('saveFinalLivePnlSnapshot: wrote final snapshot', { sessionId, marketDate, symbols: Object.keys(snapSymbols) });
    } catch (err) {
        logger.warn('saveFinalLivePnlSnapshot failed', { sessionId, error: err.message });
    }
};

/**
 * Fetch live P&L from the plugin server for a given session
 */
const fetchLivePnlFromPlugin = async (userId, sessionId, targetBaseUrl) => {
    const result = await forwardToPlugin(
        `/api/trading/live-pnl/${sessionId}`,
        'get',
        null,
        userId ? { 'X-Forwarded-User': userId.toString() } : {},
        {},
        { timeoutMs: 10000, retries: 1, failOnError: false, targetBaseUrl }
    );

    return result?.data ?? result;
};

const getPyramidPnl = async (userId, sessionId) => {
    return httpCache.run(`pyramid:${userId}:${sessionId}`, 15000, () => getPyramidPnlUncached(userId, sessionId));
};


const getPyramidPnlUncached = async (userId, sessionId) => {
    logger.info("Fetching pyramid PnL snapshot", { userId, sessionId });
    const ts = await mongoose.model("TradingSession").findOne({
        python_session_id: sessionId,
        user_id: userId
    });
    const targetBaseUrl = resolvePluginTargetUrl(ts);
    const pluginRes = await forwardToPlugin(
        `/api/trading/pyramid-pnl/${sessionId}`,
        "get",
        null,
        userId ? { "X-Forwarded-User": userId.toString() } : {},
        {},
        { targetBaseUrl }
    );
    return pluginRes?.data;
};

const getLivePnl = async (userId, sessionId) => {
    logger.info("Fetching live PnL", { userId, sessionId });

    const ts = await mongoose.model('TradingSession').findOne({ python_session_id: sessionId, user_id: userId });

    if (!ts) {
        return { ready: false, stopped: true, status: 'not_found', data: null };
    }

    if (ts.status === 'stopped' || ts.status === 'abandoned') {
        stopLivePnlSnapshotMonitor(sessionId, ts.user_id);
        return { ready: false, stopped: true, status: ts.status, data: null };
    }

    const targetBaseUrl = resolvePluginTargetUrl(ts);
    const pluginResponse = await fetchLivePnlFromPlugin(userId, sessionId, targetBaseUrl);

    return pluginResponse;
};

const getExitedSymbols = async (userId, sessionId) => {
    return httpCache.run(`exited:${userId}:${sessionId}`, 15000, () => getExitedSymbolsUncached(userId, sessionId));
};


const getExitedSymbolsUncached = async (userId, sessionId) => {
    logger.info("Fetching exited symbols", { userId, sessionId });

    const ts = await mongoose.model('TradingSession').findOne({
        python_session_id: sessionId,
        user_id: userId
    });
    const targetBaseUrl = resolvePluginTargetUrl(ts);
    const pluginRes = await forwardToPlugin(
        `/api/trading/exited-symbols/${sessionId}`,
        'get',
        null,
        userId ? { 'X-Forwarded-User': userId.toString() } : {},
        {},
        { targetBaseUrl }
    );

    return pluginRes?.data;
};

const stopLivePnlSnapshotMonitor = (sessionId, userId) => {
    const keys = userId
        ? [getLivePnlMonitorKey(userId, sessionId)]
        : Array.from(livePnlSnapshotMonitors.keys()).filter((key) => key.endsWith(`:${sessionId}`));

    for (const key of keys) {
        const monitor = livePnlSnapshotMonitors.get(key);
        if (!monitor) continue;
        clearInterval(monitor.timer);
        livePnlSnapshotMonitors.delete(key);
        livePnlLastSavedAt.delete(key);
        logger.info('Stopped live PnL snapshot monitor', { sessionId, userId: monitor.userId });
    }
};

const stopAllLivePnlSnapshotMonitors = () => {
    for (const key of livePnlSnapshotMonitors.keys()) {
        const monitor = livePnlSnapshotMonitors.get(key);
        if (monitor?.timer) clearInterval(monitor.timer);
    }
    livePnlSnapshotMonitors.clear();
    livePnlLastSavedAt.clear();
    logger.info('Stopped all live PnL snapshot monitors');
};

const runLivePnlSnapshotTick = async (key) => {
    const monitor = livePnlSnapshotMonitors.get(key);
    if (!monitor || monitor.running) return;

    if (isLivePnlRequestCutoffDue()) {
        stopLivePnlSnapshotMonitor(monitor.sessionId, monitor.userId);
        logger.info('Stopped live PnL snapshot monitor after IST cutoff', {
            sessionId: monitor.sessionId,
            userId: monitor.userId?.toString(),
            stopAtIst: `${LIVE_PNL_REQUEST_STOP_HOUR_IST}:${String(LIVE_PNL_REQUEST_STOP_MINUTE_IST).padStart(2, '0')}`
        });
        return;
    }

    monitor.running = true;

    try {
        const ts = await mongoose.model('TradingSession').findOne({
            python_session_id: monitor.sessionId,
            user_id: monitor.userId
        });

        if (!ts || !LIVE_PNL_SNAPSHOT_STATUSES.has(ts.status)) {
            stopLivePnlSnapshotMonitor(monitor.sessionId, monitor.userId);
            return;
        }

        const phase = ts.status === 'simulation_active' ? 'simulation' : 'live';
        const pluginResponse = await fetchLivePnlFromPlugin(monitor.userId, monitor.sessionId, resolvePluginTargetUrl(ts));
        await saveLivePnlSnapshot(monitor.userId, monitor.sessionId, pluginResponse, phase);
    } catch (err) {
        logger.warn('Live PnL snapshot monitor tick failed', {
            sessionId: monitor.sessionId,
            userId: monitor.userId?.toString(),
            error: err.message
        });
    } finally {
        const latestMonitor = livePnlSnapshotMonitors.get(key);
        if (latestMonitor) latestMonitor.running = false;
    }
};

const startLivePnlSnapshotMonitor = (userId, sessionId) => {
    if (!userId || !sessionId) return false;

    if (isLivePnlRequestCutoffDue()) {
        logger.info('Skipped live PnL snapshot monitor start after IST cutoff', {
            sessionId,
            userId: userId.toString(),
            stopAtIst: `${LIVE_PNL_REQUEST_STOP_HOUR_IST}:${String(LIVE_PNL_REQUEST_STOP_MINUTE_IST).padStart(2, '0')}`
        });
        return false;
    }

    const key = getLivePnlMonitorKey(userId, sessionId);
    if (livePnlSnapshotMonitors.has(key)) return true;

    const monitor = {
        userId,
        sessionId,
        running: false,
        timer: setInterval(() => {
            runLivePnlSnapshotTick(key);
        }, LIVE_PNL_SAVE_INTERVAL_MS)
    };

    livePnlSnapshotMonitors.set(key, monitor);
    runLivePnlSnapshotTick(key);

    logger.info('Started live PnL snapshot monitor', { userId: userId.toString(), sessionId });
    return true;
};

const resumeLivePnlSnapshotMonitors = async () => {
    const sessions = await mongoose.model('TradingSession')
        .find({ status: { $in: ['simulation_active', 'trading_active'] }, python_session_id: { $exists: true, $ne: null } })
        .select('user_id python_session_id')
        .lean();

    sessions.forEach((session) => {
        startLivePnlSnapshotMonitor(session.user_id, session.python_session_id);
    });

    logger.info('Resumed live PnL snapshot monitors', { count: sessions.length });
    return sessions.length;
};

const SNAPSHOT_DECIMATE_TARGET = 480;


const getLivePnlHistory = async (userId, sessionId, marketDate, stepSeconds) => {
    return httpCache.run(`hist:${userId}:${sessionId}:${marketDate || ""}:${stepSeconds || ""}`, 15000, () => getLivePnlHistoryUncached(userId, sessionId, marketDate, stepSeconds));
};


const getLivePnlHistoryUncached = async (userId, sessionId, marketDate, stepSeconds) => {
    logger.info("Fetching saved live PnL history", { userId, sessionId, marketDate, stepSeconds });

    const userIdValue = userId?.toString();
    const collection = await getLivePnlCollection();

    let targetMarketDate = marketDate;
    if (!targetMarketDate) {
        const latest = await collection.findOne(
            { session_id: sessionId, user_id: userIdValue },
            { sort: { sampled_at: -1 }, projection: { market_date: 1 } }
        );
        targetMarketDate = latest?.market_date;
    }

    if (!targetMarketDate) {
        return {
            market_date: null,
            snapshots: []
        };
    }

    const baseFilter = { session_id: sessionId, user_id: userIdValue, market_date: targetMarketDate };

    // Decimate inside Mongo so only the downsampled points cross the wire —
    // fetching every stored snapshot (6k+/day) is slow over remote connections.
    let step = Math.floor(Number(stepSeconds) || 0);
    if (step < 1 || step > 3600) {
        const [first, last] = await Promise.all([
            collection.findOne(baseFilter, { sort: { source_time: 1 }, projection: { source_time: 1 } }),
            collection.findOne(baseFilter, { sort: { source_time: -1 }, projection: { source_time: 1 } })
        ]);
        const rangeSeconds = Math.max(
            Math.floor(((last?.source_time?.getTime?.() ?? 0) - (first?.source_time?.getTime?.() ?? 0)) / 1000),
            1
        );
        step = Math.max(1, Math.ceil(rangeSeconds / SNAPSHOT_DECIMATE_TARGET));
    }

    const snapshots = await collection
        .aggregate([
            { $match: baseFilter },
            { $sort: { source_time: 1 } },
            {
                $group: {
                    _id: { $floor: { $divide: [{ $toLong: "$source_time" }, 1000 * step] } },
                    doc: { $last: "$$ROOT" }
                }
            },
            { $replaceRoot: { newRoot: "$doc" } },
            { $sort: { source_time: 1 } }
        ])
        .toArray();

    return {
        market_date: targetMarketDate,
        snapshots: snapshots.map(normalizeLivePnlSnapshot)
    };
};

export {
    fetchTradingLogs,
    getTradingLogsDebugView,
    fetchSessionStatus,
    markPluginSessionAuthenticated,
    resetPluginSessionToAuthenticated,
    markPluginSessionTradingActive,
    markPluginSessionStopped,
    debugStopPluginSession,
    getDashboardState,
    getTradingPnlSummary,
    getUserTradingPnlSummary,
    generateLogsCSV,
    getAllSessions,
    restoreSession,
    restorePluginSessionById,
    restoreAuthenticatedSessionInPluginDb,
    getFullSessionState,
    fetchAllTradingLogs,
    getPyramidPnl,
    getLivePnl,
    getLivePnlHistory,
    getExitedSymbols,
    saveFinalPnlSnapshot,
    startLivePnlSnapshotMonitor,
    stopLivePnlSnapshotMonitor,
    stopAllLivePnlSnapshotMonitors,
    resumeLivePnlSnapshotMonitors
};

export default {
    fetchTradingLogs,
    getTradingLogsDebugView,
    fetchSessionStatus,
    markPluginSessionAuthenticated,
    resetPluginSessionToAuthenticated,
    markPluginSessionTradingActive,
    markPluginSessionStopped,
    debugStopPluginSession,
    getDashboardState,
    getTradingPnlSummary,
    getUserTradingPnlSummary,
    generateLogsCSV,
    getAllSessions,
    restoreSession,
    restorePluginSessionById,
    restoreAuthenticatedSessionInPluginDb,
    getFullSessionState,
    fetchAllTradingLogs,
    getPyramidPnl,
    getLivePnl,
    getLivePnlHistory,
    getExitedSymbols,
    saveFinalPnlSnapshot,
    startLivePnlSnapshotMonitor,
    stopLivePnlSnapshotMonitor,
    stopAllLivePnlSnapshotMonitors,
    resumeLivePnlSnapshotMonitors
};
