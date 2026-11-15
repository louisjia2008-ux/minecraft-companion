"""Align same-host Companion receipts to an unmodified Recorder Minecraft Play."""

import argparse
from bisect import bisect_left, bisect_right
import json
from pathlib import Path


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def json_lines(path):
    with path.open(encoding="utf-8") as stream:
        for line in stream:
            yield json.loads(line)


def tally(inventory, watch):
    counts = dict.fromkeys(watch, 0)
    for slot in inventory:
        item = slot.get("itemId", "")
        for key in watch:
            # Vanilla logs include stems and hyphae, with stripped variants.
            if key == "#logs":
                matched = item.startswith("minecraft:") and item.endswith(("_log", "_stem", "_wood", "_hyphae"))
            else:
                matched = item == key
            if matched:
                counts[key] += slot.get("count", 0)
    return counts


def read_play(play, watch):
    meta = read_json(play / "metadata.json")
    connection = meta["connection"]
    identity = (meta["sessionId"], meta["player"]["uuid"], connection["id"])
    if "endServerTick" not in connection or connection.get("captureFailure"):
        raise ValueError("Recorder Play is incomplete")
    if not (play / "capture/replay.zip").is_file():
        raise ValueError("Recorder Play is missing its replay")
    samples, changes, replay_ticks = [], [], []
    previous = None
    for record in json_lines(play / "capture/events.jsonl"):
        if "playerState" not in record and "replayTimeline" not in record:
            continue
        stamp = record["identity"]
        if (stamp["sessionId"], stamp["playerUuid"], stamp["connectionId"]) != identity:
            raise ValueError("Capture event belongs to a different Play")
        tick = int(stamp["serverTick"])
        if "replayTimeline" in record:
            replay_ticks.append(tick)
            continue
        wall_ms = int(stamp["recordedAtUnixMs"])
        if samples and (tick < samples[-1][1] or wall_ms < samples[-1][0]):
            raise ValueError("Player state clock moved backwards")
        samples.append((wall_ms, tick))
        state = record["playerState"]
        observed = {
            "dimension": state["dimension"],
            "counts": tally(state.get("inventory", []), watch),
            "alive": state.get("alive", False),
        }
        if observed != previous:
            changes.append({
                "serverTick": tick, "recordedAtMs": wall_ms,
                "position": state.get("position"), **observed,
            })
            previous = observed
    if not samples:
        raise ValueError("Recorder Play has no authoritative player-state samples")
    if not replay_ticks or replay_ticks != sorted(replay_ticks):
        raise ValueError("Recorder Play has no ordered replay timeline")
    return meta, identity, samples, changes, replay_ticks


def read_frames(play, identity):
    renders = play / "renders"
    result_path = renders / "result.json"
    if not result_path.is_file():
        return [], None
    result = read_json(result_path)
    result_identity = (result["sessionId"], result["playerUuid"], result["connectionId"])
    if result["status"] != "RENDER_RESULT_STATUS_COMPLETE" or result_identity != identity:
        raise ValueError("Render is incomplete or belongs to a different Play")
    frames = []
    for row in json_lines(renders / "fpv_frames/frames.jsonl"):
        row_identity = (row["sessionId"], row["playerUuid"], row["connectionId"])
        if row_identity != identity or row["replayId"] != result["replay"]["replayId"]:
            raise ValueError("Frame belongs to a different replay")
        frames.append((int(row["serverTick"]), int(row.get("ordinal", 0))))
    if len(frames) != int(result["frameCount"]) or frames != sorted(frames):
        raise ValueError("Frame index count or order does not match the render result")
    return frames, result["framesPerSecond"]


def align(meta, samples, changes, replay_ticks, frames, fps, events):
    wall = [ms for ms, _tick in samples]
    frame_ticks = [tick for tick, _ordinal in frames]

    def video_at(tick):
        if not frame_ticks or not frame_ticks[0] <= tick <= frame_ticks[-1]:
            return None
        i = bisect_right(frame_ticks, tick) - 1
        # Keep the anchor tick. A frame may be held through multiple server ticks.
        frame_tick, ordinal = frames[i]
        return {"frameServerTick": frame_tick, "ordinal": ordinal, "videoSeconds": (ordinal - frames[0][1]) / fps}

    def bracket(ms):
        left, right = bisect_right(wall, ms) - 1, bisect_left(wall, ms)
        if left < 0 or right >= len(wall):
            return {"quality": "outside_capture"}
        left, right = sorted((left, right))
        start_ms, start_tick = samples[left]
        end_ms, end_tick = samples[right]
        return {
            "quality": "same_host_receipt_bracket" if end_ms - start_ms <= 500 else "wide_receipt_bracket",
            "firstServerTick": start_tick, "lastServerTick": end_tick, "sampleGapMs": end_ms - start_ms,
            "firstVideoAnchor": video_at(start_tick), "lastVideoAnchor": video_at(end_tick),
        }

    return {
        "schemaVersion": 1,
        "play": {"server": meta["server"], "player": meta["player"], "connection": meta["connection"]},
        "alignment": "Companion receipt wall time bracketed by same-host Recorder player-state samples. "
                     "A receipt bracket is not the server tick when the game action occurred.",
        "playerStateSamples": len(samples),
        "replayMarkers": {"count": len(replay_ticks), "firstServerTick": replay_ticks[0], "lastServerTick": replay_ticks[-1]},
        "renderedFrames": len(frames),
        "hostEvents": [
            {**event, "receiptBracket": bracket(event["observedAtMs"])}
            for event in sorted(events, key=lambda entry: entry["observedAtMs"])
        ],
        "authoritativeStateChanges": [
            {**change, "videoAnchor": video_at(change["serverTick"])} for change in changes
        ],
    }


def read_host_events(args, meta):
    player = meta["player"]["name"]
    if args.desktop:
        log = read_json(args.desktop)
        if log["bot"] != player or log["clock"] != "unix_epoch_ms":
            raise ValueError("Desktop timeline player or clock does not match the Play")
        play = log["recorderPlay"]
        if play["playerUuid"] != meta["player"]["uuid"] or play["connectionId"] != meta["connection"]["id"]:
            raise ValueError("Desktop timeline belongs to a different Play")
        return [
            *({"kind": "task", **event} for event in log["taskEvents"]),
            *({"kind": "ui", **event} for event in log["uiEvents"]),
            *({"kind": "inventory_check", "observedAtMs": event["queryCompletedAtMs"], **event}
              for event in log["inventoryChecks"]),
        ]
    if args.scenario_player != player:
        raise ValueError("--scenario-player must match the Recorder Play")
    return [
        {"kind": record["type"], "observedAtMs": record["t"],
         **{key: value for key, value in record.items() if key not in {"type", "t"}}}
        for record in json_lines(args.scenario)
        if record["type"].startswith(("quartz_", "portal_"))
        or record["type"] in {"goal_set", "goal_done", "goal_failed", "bridge_returned", "result"}
    ]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--play", type=Path, required=True)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--desktop", type=Path)
    source.add_argument("--scenario", type=Path)
    parser.add_argument("--scenario-player", help="Name of the bot that ran the scenario")
    parser.add_argument("--watch", action="append", help="Namespaced item ID or #logs. Can repeat.")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    watch = args.watch or (["#logs"] if args.desktop else ["minecraft:quartz"])
    meta, identity, samples, changes, replay_ticks = read_play(args.play, watch)
    frames, fps = read_frames(args.play, identity)
    events = read_host_events(args, meta)
    report = align(meta, samples, changes, replay_ticks, frames, fps, events)
    with args.output.open("x", encoding="utf-8") as stream:
        json.dump(report, stream, indent=2)
        stream.write("\n")


if __name__ == "__main__":
    main()
