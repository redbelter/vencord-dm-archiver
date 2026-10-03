#!/usr/bin/env python3
"""
guild_backfill.py — recover "servers you were ever in" from your OWN Discord
data package, ready for DmLedger's GuildLedger "Import backfill".

Discord deliberately forgets servers you leave. But the Activity/ telemetry
inside your data package (Settings -> Privacy & Safety -> Request all my Data)
records guild_id on hundreds of thousands of events — and often guild_name +
guild_size alongside them. This script mines that: per guild it collects the
first/last event date, how many "strong presence" events (you opened a channel,
sent a message, spoke in voice...) prove you were actually IN it, and any
guild_name the telemetry embedded. It also unions in the Servers/ folder
(servers you are currently in) so the ledger knows what's current vs gone.

Usage:
    python guild_backfill.py <unzipped-package-folder> [out.json]
    # out.json defaults to guild-ledger.json next to the package folder

Then: Settings -> Plugins -> DmLedger -> /guild-ledger -> paste the output
path -> Import backfill.

Read-only on the package. Writes exactly one JSON file. No network calls.
"""
import json
import os
import re
import sys
from collections import defaultdict

GUILD_ID_RE = re.compile(rb'"guild_id"\s*:\s*"?(\d{17,20})"?')
NAME_RE = re.compile(rb'"guild_name"\s*:\s*"((?:[^"\\]|\\.)*)"')
SIZE_RE = re.compile(rb'"guild_size"\s*:\s*"?(\d+)"?')
TS_RE = re.compile(rb'"(?:timestamp|_day_utc)"\s*:\s*"?([0-9]{4}-[0-9]{2}-[0-9]{2})')

# events that prove real presence (not just a tooltip hover)
STRONG = {
    "start_speaking", "start_listening", "send_message", "messages_sent",
    "message_sent", "ack_messages", "channel_opened", "thread_opened",
    "guild_viewed", "message_compose",
}


def scan_telemetry(pkg_root):
    seen = defaultdict(lambda: {"first": None, "last": None, "strong": 0, "n": 0})
    names = {}
    act = os.path.join(pkg_root, "Activity")
    if not os.path.isdir(act):
        sys.exit("no Activity/ folder in the package — nothing to mine")
    for sub in os.listdir(act):
        sub_dir = os.path.join(act, sub)
        if not os.path.isdir(sub_dir):
            continue
        for fn in os.listdir(sub_dir):
            if not fn.endswith(".json"):
                continue
            with open(os.path.join(sub_dir, fn), "rb") as f:
                for line in f:
                    m = GUILD_ID_RE.search(line)
                    if not m:
                        continue
                    gid = m.group(1).decode()
                    try:
                        ev = json.loads(line)
                    except Exception:
                        continue
                    ts = TS_RE.search(line)
                    day = ts.group(1).decode() if ts else None
                    s = seen[gid]
                    s["n"] += 1
                    if day:
                        if not s["first"] or day < s["first"]:
                            s["first"] = day
                        if not s["last"] or day > s["last"]:
                            s["last"] = day
                    et = str(ev.get("event_type") or ev.get("action") or "")
                    if et in STRONG:
                        s["strong"] += 1
                    nm = NAME_RE.search(line)
                    if nm and gid not in names:
                        try:
                            names[gid] = json.loads(b'"' + nm.group(1) + b'"')
                        except Exception:
                            pass
                    sz = SIZE_RE.search(line)
                    if sz and seen[gid].get("size") is None:
                        seen[gid]["size"] = int(sz.group(1))
    return seen, names


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    pkg = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(pkg, "guild-ledger.json")

    cur = {}
    servers = os.path.join(pkg, "Servers")
    if os.path.isdir(servers):
        for g in os.listdir(servers):
            gj = os.path.join(servers, g, "guild.json")
            if g.isdigit() and os.path.exists(gj):
                try:
                    with open(gj, encoding="utf-8") as f:
                        cur[g] = json.load(f).get("name")
                except Exception:
                    cur[g] = None

    seen, names = scan_telemetry(pkg)
    rows = []
    all_ids = set(seen) | set(cur)
    for gid in all_ids:
        s = seen.get(gid, {"first": None, "last": None, "strong": 0, "n": 0, "size": None})
        rows.append({
            "id": gid,
            "name": cur.get(gid) or names.get(gid),
            "firstSeen": s["first"],
            "lastSeen": s["last"],
            "strongEvents": s["strong"],
            "guildSize": s.get("size"),
            "status": "current" if gid in cur else "gone",
        })
    rows.sort(key=lambda r: (r["status"] != "current", r["firstSeen"] or "9999"))

    with open(out, "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=1)

    gone = sum(1 for r in rows if r["status"] == "gone")
    named = sum(1 for r in rows if r["name"])
    print(f"wrote {out}: {len(rows)} guilds ({len(cur)} current, {gone} gone; {named} named)")
    print("note: telemetry only covers what happened while events were being recorded —")
    print("this is a FLOOR on your history, not a census. Unnamed gone-guilds are real,")
    print("just no longer resolvable by Discord.")


if __name__ == "__main__":
    main()
