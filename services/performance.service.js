import mongoose from "mongoose";
import TradingSession from "../models/tradingSession.js";
import PerformanceStat from "../models/performanceStat.js";

const IST = "Asia/Kolkata";
const STATS_DAILY_HOUR = parseInt(process.env.STATS_DAILY_HOUR_IST || "16", 10);
const STATS_DAILY_MINUTE = parseInt(process.env.STATS_DAILY_MINUTE_IST || "30", 10);

const getPluginDb = () => mongoose.connection.useDb("mintzy_plugin");

const istParts = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: IST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
};

const istDateKey = (date = new Date()) => {
  const { year, month, day } = istParts(date);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
};

const formatIstDayLabel = (dateKey) => {
  const [y, m, d] = dateKey.split("-").map(Number);
  if (!y || !m || !d) return dateKey;
  return new Date(Date.UTC(y, m - 1, d, 6, 30)).toLocaleDateString("en-IN", {
    timeZone: IST,
    day: "numeric",
    month: "short",
    year: "numeric"
  });
};

const formatIstMonthLabel = (year, month) =>
  new Date(Date.UTC(year, month - 1, 15, 6, 30)).toLocaleDateString("en-IN", {
    timeZone: IST,
    month: "short",
    year: "numeric"
  });

const last12Months = () => {
  const { year, month } = istParts();
  const out = [];
  let y = year;
  let m = month;
  for (let i = 0; i < 12; i++) {
    out.unshift({ year: y, month: m, key: `${y}-${String(m).padStart(2, "0")}`, label: formatIstMonthLabel(y, m) });
    m -= 1;
    if (m < 1) {
      m = 12;
      y -= 1;
    }
  }
  return out;
};

const isWaitAction = (raw) => {
  const key = String(raw || "").toLowerCase().replace(/[_()/[\],]+/g, " ").replace(/\s+/g, " ").trim();
  return /wait|no position|no momentum|^flat$/.test(key);
};

const num = (raw) => {
  if (raw == null || raw === "" || raw === "-" || raw === "—") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

const parseTradeTimeMs = (raw) => {
  if (raw == null || raw === "") return null;
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw.getTime();
  if (typeof raw === "number" && Number.isFinite(raw)) {
    if (raw <= 0) return null;
    return raw < 1e12 ? Math.round(raw * 1000) : Math.round(raw);
  }
  if (typeof raw === "object") {
    const o = raw;
    return parseTradeTimeMs(o.$date ?? o.$numberLong ?? o.$numberInt);
  }
  const s = String(raw).trim();
  if (!s) return null;
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) {
    const ms = Date.parse(s);
    return Number.isNaN(ms) ? null : ms;
  }
  const normalized = s.includes("T") ? s : s.replace(" ", "T");
  const ms = Date.parse(`${normalized}+05:30`);
  if (!Number.isNaN(ms)) return ms;
  const fallback = Date.parse(normalized);
  return Number.isNaN(fallback) ? null : fallback;
};

const asBool = (raw) => {
  if (typeof raw === "boolean") return raw;
  if (raw === "true" || raw === 1) return true;
  if (raw === "false" || raw === 0) return false;
  return null;
};

/**
 * Mirrors the frontend tradesFromPayload + computePerformanceStats:
 * last row per session|IST-day|symbol (P&L in logs is cumulative, not incremental).
 */
const computePerformanceStats = (logs) => {
  const asOfDate = istDateKey();
  const empty = {
    maxProfitScript: null,
    maxLosingScript: null,
    maxProfitDay: null,
    maxLosingDay: null,
    avgWinRate: null,
    maxDrawdownPct: null,
    avgRiskReward: null,
    overallReturnPct: null,
    totalPnl: 0,
    startCapital: null,
    maxWinStreak: 0,
    maxLoseStreak: 0,
    months: last12Months().map((m) => ({ ...m, pnl: null })),
    tradingDays: 0,
    asOfDate
  };

  const usable = [];
  for (const item of logs) {
    const r = item || {};
    const symbol = String(r.Symbol ?? r.symbol ?? "").toUpperCase().trim();
    if (!symbol || symbol === "-") continue;
    const timeMs = parseTradeTimeMs(r.logged_at ?? r.loggedAt ?? r.timestamp ?? r.time ?? r.Timestamp ?? r.Time);
    if (timeMs == null) continue;
    const pnl = num(r["P&L"] ?? r.PnL ?? r.pnl ?? r.unrealized_pnl ?? r.realized_pnl);
    if (pnl == null) continue;
    const sim = asBool(r.simulation_logs ?? r.simulationLogs ?? r.is_simulation);
    if (sim === true) continue;
    const action = String(r.Action_Status ?? r.Action ?? r.action ?? r.action_status ?? r.status ?? "");
    const signal = String(r.Signal ?? r.signal ?? r.side ?? r.Side ?? "");
    usable.push({
      sessionId: r.session_id,
      symbol,
      pnl,
      capital: num(r.Total_Capital ?? r.TotalCapital ?? r.total_capital ?? r.capital ?? r.cash_balance ?? r.portfolio_cash_balance),
      timeMs,
      dateKey: istDateKey(new Date(timeMs)),
      wait: isWaitAction(action) || isWaitAction(signal)
    });
  }

  const filtered = usable.filter((t) => !t.wait && Number.isFinite(t.pnl) && t.symbol)
    .sort((a, b) => a.timeMs - b.timeMs);
  if (filtered.length === 0) return empty;

  const scriptDay = new Map();
  for (const t of filtered) {
    scriptDay.set(`${t.sessionId}|${t.dateKey}|${t.symbol}`, t);
  }
  const dayEnds = Array.from(scriptDay.values());

  const byScript = new Map();
  const byDay = new Map();
  for (const t of dayEnds) {
    byScript.set(t.symbol, (byScript.get(t.symbol) ?? 0) + t.pnl);
    byDay.set(t.dateKey, (byDay.get(t.dateKey) ?? 0) + t.pnl);
  }

  const scriptEntries = Array.from(byScript.entries());
  const dayEntries = Array.from(byDay.entries()).sort(([a], [b]) => a.localeCompare(b));
  const dailyValues = dayEntries.map(([, v]) => v);

  const bestScript = scriptEntries.reduce((best, cur) => (!best || cur[1] > best[1] ? cur : best), null);
  const worstScript = scriptEntries.reduce((best, cur) => (!best || cur[1] < best[1] ? cur : best), null);
  const bestDay = dayEntries.reduce((best, cur) => (!best || cur[1] > best[1] ? cur : best), null);
  const worstDay = dayEntries.reduce((best, cur) => (!best || cur[1] < best[1] ? cur : best), null);

  const wins = dailyValues.filter((v) => v > 0).length;
  const tradedDays = dailyValues.filter((v) => v !== 0).length;
  const avgWinRate = tradedDays > 0 ? (wins / tradedDays) * 100 : null;

  const positive = dailyValues.filter((v) => v > 0);
  const negative = dailyValues.filter((v) => v < 0).map((v) => Math.abs(v));
  const avgWin = positive.length ? positive.reduce((a, b) => a + b, 0) / positive.length : 0;
  const avgLoss = negative.length ? negative.reduce((a, b) => a + b, 0) / negative.length : 0;
  const avgRiskReward = avgLoss > 0 ? avgWin / avgLoss : null;

  const startCapital = filtered.find((t) => t.capital != null && t.capital > 0)?.capital ?? null;
  const totalPnl = dailyValues.reduce((a, b) => a + b, 0);
  const overallReturnPct = startCapital && startCapital > 0 ? (totalPnl / startCapital) * 100 : null;

  const base = startCapital && startCapital > 0 ? startCapital : 0;
  let peak = base;
  let equity = base;
  let maxDd = 0;
  for (const v of dailyValues) {
    equity += v;
    if (equity > peak) peak = equity;
    if (peak > 0) {
      const dd = ((peak - equity) / peak) * 100;
      if (dd > maxDd) maxDd = dd;
    }
  }

  let maxWin = 0;
  let maxLose = 0;
  let curWin = 0;
  let curLose = 0;
  for (const v of dailyValues) {
    if (v > 0) {
      curWin += 1;
      curLose = 0;
      if (curWin > maxWin) maxWin = curWin;
    } else if (v < 0) {
      curLose += 1;
      curWin = 0;
      if (curLose > maxLose) maxLose = curLose;
    } else {
      curWin = 0;
      curLose = 0;
    }
  }

  const monthPnl = new Map();
  const monthHasTrade = new Set();
  for (const [dateKey, pnl] of dayEntries) {
    const mk = dateKey.slice(0, 7);
    monthPnl.set(mk, (monthPnl.get(mk) ?? 0) + pnl);
    monthHasTrade.add(mk);
  }

  const months = last12Months().map((m) => ({
    ...m,
    pnl: monthHasTrade.has(m.key) ? (monthPnl.get(m.key) ?? 0) : null
  }));

  return {
    maxProfitScript: bestScript ? { label: bestScript[0], value: bestScript[1] } : null,
    maxLosingScript: worstScript ? { label: worstScript[0], value: worstScript[1] } : null,
    maxProfitDay: bestDay ? { label: formatIstDayLabel(bestDay[0]), value: bestDay[1] } : null,
    maxLosingDay: worstDay ? { label: formatIstDayLabel(worstDay[0]), value: worstDay[1] } : null,
    avgWinRate,
    maxDrawdownPct: dailyValues.length ? maxDd : null,
    avgRiskReward,
    overallReturnPct,
    totalPnl,
    startCapital,
    maxWinStreak: maxWin,
    maxLoseStreak: maxLose,
    months,
    tradingDays: dayEntries.length,
    asOfDate
  };
};

const fetchLogsForSessions = async (sessionIds) => {
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) return [];
  const collection = getPluginDb().collection("trading_logs");
  return collection
    .find({ session_id: { $in: sessionIds } })
    .project({
      _id: 0,
      session_id: 1,
      symbol: 1,
      timestamp: 1,
      time: 1,
      pnl: 1,
      "P&L": 1,
      PnL: 1,
      unrealized_pnl: 1,
      realized_pnl: 1,
      cash_balance: 1,
      portfolio_cash_balance: 1,
      capital: 1,
      total_capital: 1,
      Total_Capital: 1,
      action_status: 1,
      action: 1,
      status: 1,
      signal: 1,
      side: 1,
      simulation_logs: 1,
      is_simulation: 1
    })
    // _id tie-break: duplicate rows (same session/symbol/timestamp) resolve in
    // insertion order — matches what the old frontend saw via the API and picks
    // the last-written row for a cycle.
    .sort({ session_id: 1, timestamp: 1, _id: 1 })
    .toArray();
};

const computePerformanceStatsForUser = async (userId) => {
  const sessions = await TradingSession.find({ user_id: userId, python_session_id: { $exists: true, $ne: null } })
    .select("python_session_id broker")
    .lean();
  const sessionIds = sessions.map((s) => s.python_session_id).filter(Boolean);
  const logs = await fetchLogsForSessions(sessionIds);
  const stats = computePerformanceStats(logs);

  const doc = await PerformanceStat.findOneAndUpdate(
    { user_id: userId },
    {
      $set: {
        broker: sessions[0]?.broker ?? null,
        as_of_date: stats.asOfDate,
        stats,
        computed_at: new Date(),
        updated_at: new Date()
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return doc.stats;
};

const getPerformanceStats = async (userId) => {
  const existing = await PerformanceStat.findOne({ user_id: userId }).lean();
  if (existing?.stats) return existing.stats;
  return computePerformanceStatsForUser(userId);
};

const recomputeAllPerformanceStats = async () => {
  const userIds = await TradingSession.distinct("user_id", { python_session_id: { $exists: true, $ne: null } });
  let ok = 0;
  let failed = 0;
  for (const userId of userIds) {
    try {
      await computePerformanceStatsForUser(userId);
      ok += 1;
    } catch (err) {
      failed += 1;
      console.warn("[PERF-STATS] recompute failed", { userId: userId?.toString(), error: err.message });
    }
  }
  console.log("[PERF-STATS] daily recompute done", { users: userIds.length, ok, failed });
  return { users: userIds.length, ok, failed };
};

let statsSchedulerStarted = false;

const msUntilNextIstWallClock = (hour, minute) => {
  const { year, month, day, hour: hh, minute: mm } = istParts();
  const nowIst = Date.parse(
    `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+05:30`
  );
  const targetIst = Date.parse(
    `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+05:30`
  );
  const diff = targetIst - nowIst;
  return diff > 0 ? diff : diff + 24 * 60 * 60 * 1000;
};

const startDailyStatsScheduler = () => {
  if (statsSchedulerStarted) return;
  statsSchedulerStarted = true;

  const arm = () => {
    const delay = msUntilNextIstWallClock(STATS_DAILY_HOUR, STATS_DAILY_MINUTE);
    setTimeout(async () => {
      try {
        await recomputeAllPerformanceStats();
      } catch (err) {
        console.error("[PERF-STATS] daily recompute tick failed", { error: err.message });
      }
      arm();
    }, delay);
  };

  arm();
  console.log("[PERF-STATS] daily scheduler armed", {
    atIst: `${STATS_DAILY_HOUR}:${String(STATS_DAILY_MINUTE).padStart(2, "0")}`
  });
};

export {
  computePerformanceStats,
  computePerformanceStatsForUser,
  getPerformanceStats,
  recomputeAllPerformanceStats,
  startDailyStatsScheduler
};

export default {
  computePerformanceStats,
  computePerformanceStatsForUser,
  getPerformanceStats,
  recomputeAllPerformanceStats,
  startDailyStatsScheduler
};