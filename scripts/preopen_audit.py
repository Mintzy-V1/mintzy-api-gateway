"""
Pre-open audit for the 10:30 start -> 12:59 auto-stop -> 13:00 live switch.

This inspects the real database and VMs rather than synthetic fixtures. It answers
"is anything already in a state that will break tomorrow", which is a different
question from "do the code fixes work" — the latter needs scripts/rehearse-handoff.mjs
run on the gateway host, because the enum and reaper behaviour is Node-side.

    python scripts/preopen_audit.py            # read-only
    python scripts/preopen_audit.py --fix      # also remediate stuck/stale records
    python scripts/preopen_audit.py --no-http  # skip VM reachability probes

Exits 0 if every check passes, 1 if any fails, 2 on a setup error.
"""

import argparse
import os
import re
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:
    import requests
except ImportError:
    requests = None

from dotenv import load_dotenv
from pymongo import MongoClient

IST = timezone(timedelta(hours=5, minutes=30))

def load_schema_enum():
    """Read the enum straight out of the schema so this can't drift from it.

    Anything in the database outside this set will raise a ValidationError the next
    time the document is loaded and saved, because Mongoose validates hydrated paths.
    """
    schema = Path(__file__).resolve().parent.parent / "models" / "tradingSession.js"
    text = schema.read_text(encoding="utf-8")
    block = re.search(r"simulation_status:\s*\{.*?enum:\s*\[(.*?)\]", text, re.S)
    if not block:
        print(f"Could not parse the simulation_status enum from {schema}", file=sys.stderr)
        sys.exit(2)
    pairs = re.findall(r"'([^']+)'|\"([^\"]+)\"", block.group(1))
    return {single or double for single, double in pairs}

ACTIVE_STATUSES = ["authenticated", "simulation_active", "trading_active", "running", "started"]

results = []


def check(name, passed, detail=""):
    results.append(passed)
    mark = "PASS" if passed else "FAIL"
    print(f"{mark}  {name}" + (f"\n      {detail}" if detail else ""))


def info(msg):
    print(f"      {msg}")


def today_ist():
    return datetime.now(IST).strftime("%Y-%m-%d")


def day_key(value):
    """Trade-date string for a datetime, however Mongo handed it back."""
    if isinstance(value, str):
        return value[:10]
    if isinstance(value, datetime):
        aware = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return aware.astimezone(IST).strftime("%Y-%m-%d")
    return None


def resolve_mongo_uri():
    here = Path(__file__).resolve().parent.parent
    load_dotenv(here / ".env")
    uri = os.environ.get("MONGO_URI")
    if not uri:
        print("MONGO_URI is not set and was not found in the gateway .env", file=sys.stderr)
        sys.exit(2)
    return uri


CANDIDATE_COLLECTIONS = ("tradingsessions", "tradingSessions", "trading_sessions")


def find_sessions_collection(client, db):
    """The connection string often omits a database, so fall back to searching."""
    if db is not None:
        names = db.list_collection_names()
        for candidate in CANDIDATE_COLLECTIONS:
            if candidate in names:
                return db[candidate]

    for db_name in client.list_database_names():
        if db_name in ("admin", "local", "config"):
            continue
        names = client[db_name].list_collection_names()
        for candidate in CANDIDATE_COLLECTIONS:
            if candidate in names:
                return client[db_name][candidate]

    print("Could not find the TradingSession collection in any database.", file=sys.stderr)
    sys.exit(2)


def audit_vm_urls(sessions, since_days):
    """resolvePluginTargetUrl silently falls back to the default PLUGIN_BASE when
    vm_url is unset, so a missing value routes an account to the wrong VM and still
    looks like success."""
    print("\n== VM routing ==")
    query = {"status": {"$in": ACTIVE_STATUSES}}
    if since_days is not None:
        # Long-abandoned sessions are never going to trade; including them turns
        # every run into a failure and hides the ones that matter tomorrow.
        cutoff = datetime.now(timezone.utc) - timedelta(days=since_days)
        query["created_at"] = {"$gte": cutoff}
        info(f"considering sessions created in the last {since_days} day(s); --all to include everything")

    candidates = list(sessions.find(
        query,
        {"python_session_id": 1, "user_id": 1, "status": 1, "vm_url": 1, "simulation_status": 1},
    ))

    if not candidates:
        info("No recent sessions in an active state yet — re-run once tomorrow's sessions authenticate.")
        return []

    for s in candidates:
        info(f"{s.get('python_session_id')}  status={s.get('status')}  "
             f"sim={s.get('simulation_status') or '-'}  vm_url={s.get('vm_url') or '*** MISSING ***'}")

    missing = [s for s in candidates if not s.get("vm_url")]
    check("every active session has vm_url set", not missing,
          f"{len(missing)} session(s) would fall back to the default VM" if missing else "")

    by_url = defaultdict(set)
    for s in candidates:
        if s.get("vm_url"):
            by_url[s["vm_url"]].add(str(s.get("user_id")))
    shared = {u: users for u, users in by_url.items() if len(users) > 1}
    check("no VM is shared by two accounts", not shared,
          "; ".join(f"{u} used by {len(users)} users" for u, users in shared.items()) if shared else "")

    return candidates


def audit_enum_values(sessions):
    """Values outside the schema enum make the next .save() throw, which is what
    broke the live start."""
    print("\n== simulation_status values ==")
    valid = load_schema_enum()
    distinct = [v for v in sessions.distinct("simulation_status") if v is not None]
    bad = sorted(set(distinct) - valid)
    for v in sorted(distinct):
        info(f"{v}{'   <-- NOT IN SCHEMA ENUM' if v in bad else ''}")
    check("no simulation_status value falls outside the schema enum", not bad,
          f"add to the enum in models/tradingSession.js: {bad}" if bad else "")


def audit_scheduled_starts(sessions, today, fix):
    """A claim stuck at "firing" or a schedule left over from a previous day are the
    two ways the 10:30 start goes wrong."""
    print("\n== scheduled starts ==")
    docs = list(sessions.find(
        {"scheduled_start": {"$exists": True}},
        {"python_session_id": 1, "status": 1, "scheduled_start": 1},
    ))

    stuck, stale = [], []
    for d in docs:
        sched = d.get("scheduled_start") or {}
        status = sched.get("status")
        sched_day = sched.get("trade_date") or day_key(sched.get("start_at"))
        info(f"{d.get('python_session_id')}  status={status}  trade_date={sched_day}  "
             f"start_at={sched.get('start_at')}  attempts={sched.get('attempts', 0)}")
        if status == "firing":
            stuck.append(d)
        elif status == "pending" and sched_day and sched_day != today:
            stale.append(d)

    check("no scheduled start is stuck at 'firing'", not stuck,
          f"{len(stuck)} claim(s) would never fire" if stuck else "")
    check("no pending schedule is left over from a previous day", not stale,
          f"{len(stale)} would fire on the next gateway restart" if stale else "")

    if fix:
        for d in stuck:
            sessions.update_one(
                {"_id": d["_id"], "scheduled_start.status": "firing"},
                {"$set": {"scheduled_start.status": "pending",
                          "scheduled_start.error": "reset by preopen_audit"},
                 "$unset": {"scheduled_start.firing_at": ""}},
            )
            info(f"FIXED reset to pending: {d.get('python_session_id')}")
        for d in stale:
            sessions.update_one(
                {"_id": d["_id"], "scheduled_start.status": "pending"},
                {"$set": {"scheduled_start.status": "cancelled",
                          "scheduled_start.error": "stale schedule cancelled by preopen_audit"}},
            )
            info(f"FIXED cancelled stale schedule: {d.get('python_session_id')}")


def audit_live_start_claims(sessions, today, fix):
    """A live start claimed then abandoned can only be retried once something
    returns it to pending."""
    print("\n== live-start claims ==")
    docs = list(sessions.find(
        {"simulation_status": {"$in": ["live_start_pending", "live_start_in_progress"]}},
        {"python_session_id": 1, "simulation_status": 1, "simulation_trade_date": 1,
         "live_start_claimed_at": 1},
    ))

    if not docs:
        info("none outstanding")

    abandoned = []
    for d in docs:
        claimed = d.get("live_start_claimed_at")
        age = "unknown"
        if isinstance(claimed, datetime):
            claimed_aware = claimed if claimed.tzinfo else claimed.replace(tzinfo=timezone.utc)
            age = f"{(datetime.now(timezone.utc) - claimed_aware).total_seconds() / 60:.1f} min"
        info(f"{d.get('python_session_id')}  {d.get('simulation_status')}  "
             f"trade_date={d.get('simulation_trade_date')}  claimed={age} ago")
        if d.get("simulation_status") == "live_start_in_progress" and d.get("simulation_trade_date") != today:
            abandoned.append(d)

    check("no live-start claim is stranded from a previous day", not abandoned,
          f"{len(abandoned)} session(s) stuck mid-handoff" if abandoned else "")

    if fix:
        # A claim from a previous day can never legitimately resume, so close it out
        # rather than returning it to pending the way the same-day reaper does.
        for d in abandoned:
            sessions.update_one(
                {"_id": d["_id"], "simulation_status": "live_start_in_progress"},
                {"$set": {"simulation_status": "handoff_failed",
                          "simulation_output.live_start_last_error":
                              "stranded claim closed by preopen_audit"},
                 "$unset": {"live_start_claimed_at": ""}},
            )
            info(f"FIXED closed stranded claim: {d.get('python_session_id')}")


def audit_plugin_auth(client, candidates):
    """The gateway gates the live start on the plugin's own session status, so a
    session that lost its auth during simulation never switches."""
    print("\n== plugin-side session auth ==")
    plugin_sessions = client["mintzy_plugin"]["plugin_sessions"]
    ids = [s.get("python_session_id") for s in candidates if s.get("python_session_id")]
    if not ids:
        info("no sessions to cross-check")
        return

    docs = {d.get("session_id"): d for d in plugin_sessions.find(
        {"session_id": {"$in": ids}},
        {"session_id": 1, "status": 1, "trading_status": 1, "authenticated_at": 1},
    )}

    unauthenticated = []
    for sid in ids:
        d = docs.get(sid)
        if not d:
            info(f"{sid}  *** no plugin_sessions document ***")
            unauthenticated.append(sid)
            continue
        info(f"{sid}  status={d.get('status')}  trading={d.get('trading_status')}  "
             f"authenticated_at={d.get('authenticated_at')}")
        if d.get("status") == "stopped" or not d.get("authenticated_at"):
            unauthenticated.append(sid)

    check("every gateway session has an authenticated plugin session",
          not unauthenticated,
          f"not usable for a live start: {unauthenticated}" if unauthenticated else "")


def audit_vm_reachability(candidates):
    print("\n== VM reachability ==")
    if requests is None:
        info("requests not installed — skipped")
        return

    urls = sorted({s["vm_url"] for s in candidates if s.get("vm_url")})
    if not urls:
        info("no vm_url values to probe")
        return

    unreachable = []
    for url in urls:
        target = url.rstrip("/") + "/health"
        try:
            r = requests.get(target, timeout=8)
            info(f"{target} -> HTTP {r.status_code}")
            if r.status_code >= 500:
                unreachable.append(url)
        except Exception as e:
            info(f"{target} -> {type(e).__name__}: {e}")
            unreachable.append(url)

    check("every VM answers a health probe", not unreachable,
          f"unreachable: {unreachable}" if unreachable else "")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--fix", action="store_true",
                        help="remediate stuck claims and stale schedules")
    parser.add_argument("--no-http", action="store_true", help="skip VM probes")
    parser.add_argument("--since-days", type=int, default=2,
                        help="only consider sessions created this recently (default 2)")
    parser.add_argument("--all", action="store_true",
                        help="consider sessions of any age, including long-abandoned ones")
    args = parser.parse_args()

    uri = resolve_mongo_uri()
    client = MongoClient(uri, serverSelectionTimeoutMS=15000)
    client.admin.command("ping")

    try:
        db = client.get_default_database()
    except Exception:
        db = None

    sessions = find_sessions_collection(client, db)
    today = today_ist()
    print(f"Trade date (IST): {today}   "
          f"database: {sessions.database.name}.{sessions.name}   "
          f"mode: {'FIX' if args.fix else 'read-only'}")

    candidates = audit_vm_urls(sessions, None if args.all else args.since_days)
    audit_enum_values(sessions)
    audit_scheduled_starts(sessions, today, args.fix)
    audit_live_start_claims(sessions, today, args.fix)
    audit_plugin_auth(client, candidates)
    if not args.no_http:
        audit_vm_reachability(candidates)

    failed = results.count(False)
    print(f"\n{len(results) - failed}/{len(results)} checks passed")
    client.close()
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
