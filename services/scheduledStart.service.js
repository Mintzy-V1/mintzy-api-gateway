import TradingSession from "../models/tradingSession.js";
import { startSimulation as angleOneStartSimulation } from "../modules/angle_one/services/plugin.simulation.service.js";
import { startSimulation as tradexStartSimulation } from "../modules/tradex/services/plugin.simulation.service.js";
import { startSimulation as bearStreetStartSimulation } from "../modules/bear_street/services/plugin.simulation.service.js";

const IST = "Asia/Kolkata";
const START_HOUR = parseInt(process.env.SIMULATION_START_HOUR_IST || "10", 10);
const START_MINUTE = parseInt(process.env.SIMULATION_START_MINUTE_IST || "30", 10);
const POLL_INTERVAL_MS = parseInt(process.env.SCHEDULED_START_POLL_INTERVAL_MS || "30000", 10);
const MAX_ATTEMPTS = 3;
// A claim that has sat in "firing" longer than this belongs to a process that
// died mid-fire; nothing else ever moves it out of that state.
const FIRING_STUCK_MS = parseInt(process.env.SCHEDULED_START_FIRING_STUCK_MS || "300000", 10);

const CONFIGURABLE_STATUSES = ["authenticated"];

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

const isBeforeSimulationStart = (date = new Date()) => {
  const { year, month, day, hour, minute } = istParts(date);
  const nowIst = Date.parse(
    `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+05:30`
  );
  const startIst = Date.parse(
    `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(START_HOUR).padStart(2, "0")}:${String(START_MINUTE).padStart(2, "0")}:00+05:30`
  );
  return nowIst < startIst;
};

const startAtForToday = () => {
  const { year, month, day } = istParts();
  return new Date(
    Date.parse(
      `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(START_HOUR).padStart(2, "0")}:${String(START_MINUTE).padStart(2, "0")}:00+05:30`
    )
  );
};

const istDateKey = (date = new Date()) => {
  const { year, month, day } = istParts(date);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
};

// Schedules written before trade_date existed still need a day to compare against.
const scheduledTradeDate = (scheduled) =>
  scheduled?.trade_date || (scheduled?.start_at ? istDateKey(new Date(scheduled.start_at)) : null);

/**
 * If the session start request arrives before 10:30 AM IST, persist it on the
 * TradingSession doc so a background poller fires it at 10:30 — even if the
 * desktop app is closed. Returns the scheduled record or null when starting
 * immediately is allowed.
 */
const maybeScheduleStart = async (userId, payload) => {
  const session_id = payload.session_id || payload.sessionId;
  if (!session_id) return null;
  if (!isBeforeSimulationStart()) return null;

  const ts = await TradingSession.findOne({ python_session_id: session_id, user_id: userId });
  if (!ts) return null;
  if (ts.status !== "authenticated") return null;

  const startAt = startAtForToday();
  const scheduledStart = {
    payload,
    start_at: startAt,
    trade_date: istDateKey(startAt),
    status: "pending",
    attempts: 0,
    created_at: new Date()
  };

  await TradingSession.findOneAndUpdate(
    { _id: ts._id },
    { $set: { scheduled_start: scheduledStart } },
    { new: true }
  );

  console.log("[SCHEDULED-START] scheduled", { sessionId: session_id, startAt: startAt.toISOString() });
  return { scheduled: true, start_at: startAt };
};

const clearScheduledStart = async (sessionId) => {
  if (!sessionId) return;
  await TradingSession.updateMany(
    { python_session_id: sessionId },
    { $unset: { scheduled_start: "" } }
  );
};

const startBrokerTrading = async (ts, payload) => {
  const userId = ts.user_id;
  const broker = String(ts.broker || "").toLowerCase();
  if (broker === "tradex") return tradexStartSimulation(userId, payload);
  if (broker === "bear_street") return bearStreetStartSimulation(userId, payload);
  return angleOneStartSimulation(userId, payload);
};

/**
 * Return claims abandoned by a process that died between claiming and recording
 * the outcome. Without this they stay "firing" forever and the start never happens.
 */
const reapStuckFiringClaims = async () => {
  const cutoff = new Date(Date.now() - FIRING_STUCK_MS);
  const stuck = await TradingSession.find({
    "scheduled_start.status": "firing",
    $or: [
      { "scheduled_start.firing_at": { $lte: cutoff } },
      { "scheduled_start.firing_at": { $exists: false } },
      { "scheduled_start.firing_at": null }
    ]
  })
    .select("_id python_session_id scheduled_start")
    .lean();

  for (const ts of stuck) {
    const attempts = (ts.scheduled_start?.attempts || 0) + 1;
    const status = attempts >= MAX_ATTEMPTS ? "failed" : "pending";
    await TradingSession.updateOne(
      { _id: ts._id, "scheduled_start.status": "firing" },
      {
        $set: {
          "scheduled_start.status": status,
          "scheduled_start.attempts": attempts,
          "scheduled_start.error": "reclaimed after fire was abandoned mid-flight"
        },
        $unset: { "scheduled_start.firing_at": "" }
      }
    );
    console.warn("[SCHEDULED-START] reclaimed stuck claim", {
      sessionId: ts.python_session_id,
      attempts,
      status
    });
  }
};

const fireDueScheduledStarts = async () => {
  await reapStuckFiringClaims();

  const today = istDateKey();
  const due = await TradingSession.find({
    "scheduled_start.status": "pending",
    "scheduled_start.start_at": { $lte: new Date() }
  })
    .select("_id user_id python_session_id broker status scheduled_start")
    .lean();

  for (const ts of due) {
    // A schedule left over from an earlier day would otherwise fire the moment
    // the gateway restarts, starting trading at an arbitrary time.
    const tradeDate = scheduledTradeDate(ts.scheduled_start);
    if (tradeDate !== today) {
      await TradingSession.updateOne(
        { _id: ts._id, "scheduled_start.status": "pending" },
        { $set: { "scheduled_start.status": "cancelled", "scheduled_start.error": `stale schedule for ${tradeDate || "unknown date"}` } }
      );
      console.warn("[SCHEDULED-START] cancelled stale schedule", {
        sessionId: ts.python_session_id,
        tradeDate,
        today
      });
      continue;
    }

    if (!CONFIGURABLE_STATUSES.includes(ts.status)) {
      await TradingSession.updateOne(
        { _id: ts._id, "scheduled_start.status": "pending" },
        { $set: { "scheduled_start.status": "cancelled", "scheduled_start.error": `session status ${ts.status} no longer configurable` } }
      );
      continue;
    }

    const claimed = await TradingSession.findOneAndUpdate(
      { _id: ts._id, "scheduled_start.status": "pending" },
      { $set: { "scheduled_start.status": "firing", "scheduled_start.firing_at": new Date() } },
      { new: true }
    );
    if (!claimed) continue;

    try {
      await startBrokerTrading(ts, ts.scheduled_start.payload);
      await TradingSession.updateOne(
        { _id: ts._id },
        {
          $set: {
            "scheduled_start.status": "fired",
            "scheduled_start.fired_at": new Date(),
            "scheduled_start.attempts": (claimed.scheduled_start.attempts || 0) + 1
          },
          $unset: { "scheduled_start.firing_at": "" }
        }
      );
      console.log("[SCHEDULED-START] fired", { sessionId: ts.python_session_id });
    } catch (err) {
      const attempts = (claimed.scheduled_start.attempts || 0) + 1;
      const status = attempts >= MAX_ATTEMPTS ? "failed" : "pending";
      await TradingSession.updateOne(
        { _id: ts._id },
        {
          $set: {
            "scheduled_start.status": status,
            "scheduled_start.attempts": attempts,
            "scheduled_start.error": err.message
          },
          $unset: { "scheduled_start.firing_at": "" }
        }
      );
      console.warn("[SCHEDULED-START] fire attempt failed", {
        sessionId: ts.python_session_id,
        attempts,
        status,
        error: err.message
      });
    }
  }
};

let pollerStarted = false;

const startScheduledStartPoller = () => {
  if (pollerStarted) return;
  pollerStarted = true;

  setInterval(() => {
    fireDueScheduledStarts().catch((err) => {
      console.error("[SCHEDULED-START] poller tick failed", { error: err.message });
    });
  }, POLL_INTERVAL_MS);

  fireDueScheduledStarts().catch((err) => {
    console.error("[SCHEDULED-START] initial tick failed", { error: err.message });
  });

  console.log("[SCHEDULED-START] poller started", { pollIntervalMs: POLL_INTERVAL_MS });
};

export {
  maybeScheduleStart,
  clearScheduledStart,
  fireDueScheduledStarts,
  reapStuckFiringClaims,
  startScheduledStartPoller,
  isBeforeSimulationStart,
  startAtForToday,
  istDateKey
};

export default {
  maybeScheduleStart,
  clearScheduledStart,
  fireDueScheduledStarts,
  reapStuckFiringClaims,
  startScheduledStartPoller,
  isBeforeSimulationStart,
  startAtForToday,
  istDateKey
};