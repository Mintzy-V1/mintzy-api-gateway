import TradingSession from "../models/tradingSession.js";
import { startSimulation as angleOneStartSimulation } from "../modules/angle_one/services/plugin.simulation.service.js";
import { startSimulation as tradexStartSimulation } from "../modules/tradex/services/plugin.simulation.service.js";
import { startSimulation as bearStreetStartSimulation } from "../modules/bear_street/services/plugin.simulation.service.js";

const IST = "Asia/Kolkata";
const START_HOUR = parseInt(process.env.SIMULATION_START_HOUR_IST || "10", 10);
const START_MINUTE = parseInt(process.env.SIMULATION_START_MINUTE_IST || "30", 10);
const POLL_INTERVAL_MS = parseInt(process.env.SCHEDULED_START_POLL_INTERVAL_MS || "30000", 10);
const MAX_ATTEMPTS = 3;

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

const fireDueScheduledStarts = async () => {
  const due = await TradingSession.find({
    "scheduled_start.status": "pending",
    "scheduled_start.start_at": { $lte: new Date() }
  })
    .select("_id user_id python_session_id broker status scheduled_start")
    .lean();

  for (const ts of due) {
    if (!CONFIGURABLE_STATUSES.includes(ts.status)) {
      await TradingSession.updateOne(
        { _id: ts._id, "scheduled_start.status": "pending" },
        { $set: { "scheduled_start.status": "cancelled", "scheduled_start.error": `session status ${ts.status} no longer configurable` } }
      );
      continue;
    }

    const claimed = await TradingSession.findOneAndUpdate(
      { _id: ts._id, "scheduled_start.status": "pending" },
      { $set: { "scheduled_start.status": "firing" } },
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
          }
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
          }
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
  startScheduledStartPoller,
  isBeforeSimulationStart,
  startAtForToday
};

export default {
  maybeScheduleStart,
  clearScheduledStart,
  fireDueScheduledStarts,
  startScheduledStartPoller,
  isBeforeSimulationStart,
  startAtForToday
};