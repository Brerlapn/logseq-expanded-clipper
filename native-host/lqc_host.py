#!/usr/bin/env python3
"""Native messaging host bridging Logseq Quick Capture to the logseq CLI.

Speaks the WebExtensions native messaging protocol on stdio (4-byte little-
endian length prefix + UTF-8 JSON) and relays requests to the `logseq` CLI.

Messages in:  {"id": <any>, "cmd": "version" | "cli", "args": [<str>, ...]}
Messages out: {"id": <any>, "ok": true, "result": <str>}
           or {"id": <any>, "ok": false, "error": <str>}
"""

import json
import os
import shutil
import struct
import subprocess
import sys

# Browser-to-host messages are capped at 4MB by Firefox; host-to-browser at 1MB.
MAX_REPLY_BYTES = 900_000
CLI_TIMEOUT_SECONDS = 60


def find_cli():
    env_path = os.environ.get("LOGSEQ_CLI_PATH")
    if env_path and os.access(env_path, os.X_OK):
        return env_path
    on_path = shutil.which("logseq")
    if on_path:
        return on_path
    local = os.path.expanduser("~/.local/bin/logseq")
    if os.access(local, os.X_OK):
        return local
    return None


def read_message():
    raw_length = sys.stdin.buffer.read(4)
    if len(raw_length) < 4:
        return None
    (length,) = struct.unpack("<I", raw_length)
    data = sys.stdin.buffer.read(length)
    if len(data) < length:
        return None
    return json.loads(data.decode("utf-8"))


def send_message(obj):
    data = json.dumps(obj).encode("utf-8")
    if len(data) > MAX_REPLY_BYTES:
        data = json.dumps(
            {"id": obj.get("id"), "ok": False, "error": "reply too large for native messaging"}
        ).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def run_cli(cli, args):
    result = subprocess.run(
        [cli, *args],
        capture_output=True,
        text=True,
        timeout=CLI_TIMEOUT_SECONDS,
    )
    if result.returncode != 0:
        message = (result.stderr or result.stdout or f"logseq exited {result.returncode}").strip()
        raise RuntimeError(message)
    return result.stdout


def handle(msg, cli):
    rid = msg.get("id")
    cmd = msg.get("cmd")

    if cli is None:
        return {"id": rid, "ok": False, "error": "logseq CLI not found on this machine"}

    if cmd == "version":
        try:
            return {"id": rid, "ok": True, "result": run_cli(cli, ["--version"]).strip()}
        except Exception as err:  # noqa: BLE001 - report anything to the extension
            return {"id": rid, "ok": False, "error": str(err)}

    if cmd == "cli":
        args = msg.get("args") or []
        if not isinstance(args, list) or not all(isinstance(a, str) for a in args):
            return {"id": rid, "ok": False, "error": "args must be a list of strings"}
        try:
            return {"id": rid, "ok": True, "result": run_cli(cli, args)}
        except subprocess.TimeoutExpired:
            return {"id": rid, "ok": False, "error": "logseq CLI timed out"}
        except Exception as err:  # noqa: BLE001
            return {"id": rid, "ok": False, "error": str(err)}

    return {"id": rid, "ok": False, "error": f"unknown cmd: {cmd!r}"}


def main():
    cli = find_cli()
    while True:
        try:
            msg = read_message()
        except (json.JSONDecodeError, ValueError):
            break
        if msg is None:
            break
        send_message(handle(msg, cli))


if __name__ == "__main__":
    main()
