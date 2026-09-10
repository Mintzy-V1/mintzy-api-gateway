/**
 * Pre-open rehearsal for the 10:30 start -> 12:59 auto-stop -> 13:00 live switch.
 *
 * Exercises the real scheduler and simulation services against throwaway
 * TradingSession documents. It never calls a plugin VM and never places an order,
 * so it is safe to run against production Mongo.
 *
 *   node scripts/rehearse-handoff.mjs            # scenario checks only
 *   node scripts/rehearse-handoff.mjs --audit    # also audit today's real sessions
 *
 * Exits non-zero if any check fails.
 */

import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
import TradingSession from "../models/tradingSession.js";
import {
  fireDueScheduledStarts,
  istDateKey
} from "../services/scheduledStart.service.js";
import { recoverPendingLiveStartTimers } from "../modules/angle_one/services/plugin.simulation.service.js";

const REHEARSAL_TAG = "rehearsal-";
const results = [];

const check = (name, passed, detail = "") => {
  results.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const makeSession = async (overrides = {}) => {
  const sessionId = `${REHEARSAL_TAG}${Math.random().toString(36).slice(2, 10)}`;
  return TradingSession.create({
    user_id: new mongoose.Types.ObjectId(),
    python_session_id: sessionId,
    broker: "angle_one",
    status: "authenticated",
    vm_url: "http://127.0.0.1:9/rehearsal-never-called",
    ...overrides
  });
};

const cleanup = () =>
  TradingSession.deleteMany({ python_session_id: { $regex: `^${REHEARSAL_TAG}` } });

/**
 * The bug this guards: simulation_status values written during the handoff were
 * missing from the schema enum, so the next save() on a hydrated document threw
 * and the live start failed every time it was retried.
 */
const checkEnumAcceptsHandoffStates = async () => {
  const states = ["live_start_pending", "live_start_in_progress", "stop_failed_vm_unavailable"];

  for (const state of states) {
    const session = await makeSession();
    await TradingSession.updateOne({ _id: session._id }, { $set: { simulation_status: state } });

    const reloaded = await TradingSession.findById(session._id);
    reloaded.status = "trading_active";
    try {
      await reloaded.save();
      check(`enum accepts "${state}" on save()`, true);
    } catch (err) {
      check(`enum accepts "${state}" on save()`, false, `${err.name}: ${err.message}`);
    }
  }
};

/**
 * A schedule claimed by a process that then died stays "firing" forever, because
 * the due query only ever matched "pending". The 10:30 start silently never happens.
 */
const checkStuckFiringIsReclaimed = async () => {
  const session = await makeSession({
    // Deliberately not a configurable status: once the claim is reclaimed to
    // pending, the same tick must not go on to fire a real simulation start.
    status: "stopped",
    scheduled_start: {
      payload: { session_id: "unused" },
      start_at: new Date(Date.now() - 60_000),
      trade_date: istDateKey(),
      status: "firing",
      attempts: 0,
      created_at: new Date(),
      firing_at: new Date(Date.now() - 30 * 60_000)
    }
  });

  await fireDueScheduledStarts();

  const after = await TradingSession.findById(session._id).lean();
  const status = after?.scheduled_start?.status;
  // "pending" means reclaimed; it may also have been re-fired and failed, which is
  // still progress. Only "firing" means it is stuck.
  check(
    "abandoned 'firing' claim is reclaimed",
    status !== "firing",
    `status is now "${status}"`
  );
};

/**
 * A leftover pending schedule from an earlier day used to fire the instant the
 * gateway restarted, starting trading at an arbitrary time of day.
 */
const checkStaleScheduleIsCancelled = async () => {
  const session = await makeSession({
    status: "stopped",
    scheduled_start: {
      payload: { session_id: "unused" },
      start_at: new Date(Date.now() - 3 * 24 * 3600_000),
      trade_date: "2020-01-01",
      status: "pending",
      attempts: 0,
      created_at: new Date(Date.now() - 3 * 24 * 3600_000)
    }
  });

  await fireDueScheduledStarts();

  const after = await TradingSession.findById(session._id).lean();
  const status = after?.scheduled_start?.status;
  const error = after?.scheduled_start?.error || "";
  // The date guard runs before the status guard, so only it produces this message.
  check(
    "stale schedule from a previous day is cancelled by the date guard",
    status === "cancelled" && error.includes("stale schedule"),
    `status="${status}" error="${error}"`
  );
};

/**
 * A live start claimed then abandoned (gateway restart between 13:00:05 and the
 * live confirmation) can only be retried if something returns it to pending.
 */
const checkStaleLiveStartClaimIsReclaimed = async () => {
  const session = await makeSession({
    status: "simulation_active",
    simulation_trade_date: istDateKey(),
    simulation_status: "live_start_in_progress",
    live_start_claimed_at: new Date(Date.now() - 30 * 60_000)
    // simulation_output.stop is deliberately absent: once reclaimed to pending,
    // recovery skips sessions without a stop response rather than starting live.
  });

  await recoverPendingLiveStartTimers();

  const after = await TradingSession.findById(session._id).lean();
  check(
    "abandoned live-start claim returns to pending",
    after?.simulation_status !== "live_start_in_progress",
    `simulation_status is now "${after?.simulation_status}"`
  );
};

/**
 * Not a code path — a data check. resolvePluginTargetUrl falls back to the default
 * PLUGIN_BASE when vm_url is unset, so a missing value silently routes every
 * account to one VM and looks like success.
 */
const auditTodaysSessions = async () => {
  const today = istDateKey();
  const sessions = await TradingSession.find({
    python_session_id: { $not: { $regex: `^${REHEARSAL_TAG}` } },
    $or: [
      { simulation_trade_date: today },
      { "scheduled_start.trade_date": today },
      { status: { $in: ["authenticated", "simulation_active", "trading_active"] } }
    ]
  })
    .select("python_session_id user_id broker status vm_url simulation_status")
    .lean();

  console.log(`\n--- session audit (${sessions.length} candidates for ${today}) ---`);
  if (sessions.length === 0) {
    console.log("(no sessions yet — re-run once tomorrow's sessions are authenticated)");
    return;
  }

  const missingVm = sessions.filter((s) => !s.vm_url);
  for (const s of sessions) {
    console.log(
      `  ${s.python_session_id}  status=${s.status}  sim=${s.simulation_status || "-"}  vm_url=${s.vm_url || "*** MISSING ***"}`
    );
  }

  const vmCounts = new Map();
  for (const s of sessions) {
    if (s.vm_url) vmCounts.set(s.vm_url, (vmCounts.get(s.vm_url) || 0) + 1);
  }
  const shared = [...vmCounts.entries()].filter(([, n]) => n > 1);

  check("every session has vm_url set", missingVm.length === 0,
    missingVm.length ? `${missingVm.length} session(s) would fall back to the default VM` : "");
  check("no two accounts share a VM", shared.length === 0,
    shared.length ? shared.map(([url, n]) => `${url} x${n}`).join(", ") : "");
};

/**
 * Both fireDueScheduledStarts and recoverPendingLiveStartTimers operate on every
 * session, not just the rehearsal ones. Run this outside market hours so it cannot
 * interact with a real schedule or an in-flight live start.
 */
const assertOutsideMarketHours = () => {
  if (process.argv.includes("--force")) return;

  const hhmm = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(new Date());

  const minutes = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  if (minutes >= 9 * 60 && minutes <= 15 * 60 + 45) {
    console.error(
      `Refusing to run at ${hhmm} IST — this drives the real pollers and would act on live sessions.\n` +
      "Run it before 09:00 or after 15:45 IST, or pass --force if you accept that."
    );
    process.exit(2);
  }
};

const main = async () => {
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI is not set — run this from the gateway host with its env loaded.");
    process.exit(2);
  }

  assertOutsideMarketHours();

  await connectDB();
  await cleanup();

  try {
    await checkEnumAcceptsHandoffStates();
    await checkStuckFiringIsReclaimed();
    await checkStaleScheduleIsCancelled();
    await checkStaleLiveStartClaimIsReclaimed();

    if (process.argv.includes("--audit")) {
      await auditTodaysSessions();
    }
  } finally {
    await cleanup();
    await mongoose.disconnect();
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
};

main().catch(async (err) => {
  console.error("rehearsal aborted:", err);
  await cleanup().catch(() => {});
  await mongoose.disconnect().catch(() => {});
  process.exit(2);
});
