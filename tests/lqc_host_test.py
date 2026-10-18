#!/usr/bin/env python3
"""Drive native-host/lqc_host.py over stdio with a fake `logseq` CLI.

Run: python3 -I tests/lqc_host_test.py
Covers R17a: only the subcommands the transport uses reach the CLI.
"""

import json
import os
import struct
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
HOST = os.path.join(HERE, "..", "native-host", "lqc_host.py")

# Every invocation appends its argv (as JSON) to the file named in LQC_FAKE_LOG.
FAKE_CLI = """#!/usr/bin/env python3
import json, os, sys
with open(os.environ["LQC_FAKE_LOG"], "a", encoding="utf-8") as fh:
    fh.write(json.dumps(sys.argv[1:]) + "\\n")
if sys.argv[1:] == ["--version"]:
    print("fake-logseq 0.0.1")
else:
    print(json.dumps({"status": "ok", "data": {"argv": sys.argv[1:]}}))
"""

REJECT_HINT = "install.sh"


def frame(obj):
    data = json.dumps(obj).encode("utf-8")
    return struct.pack("<I", len(data)) + data


def unframe(buf):
    out = []
    while buf:
        (n,) = struct.unpack("<I", buf[:4])
        out.append(json.loads(buf[4:4 + n].decode("utf-8")))
        buf = buf[4 + n:]
    return out


class HostTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cli = os.path.join(self.tmp.name, "logseq")
        with open(self.cli, "w", encoding="utf-8") as fh:
            fh.write(FAKE_CLI)
        os.chmod(self.cli, 0o755)
        self.log = os.path.join(self.tmp.name, "calls.jsonl")
        self.env = dict(os.environ, LOGSEQ_CLI_PATH=self.cli, LQC_FAKE_LOG=self.log)

    def tearDown(self):
        self.tmp.cleanup()

    def calls(self):
        if not os.path.exists(self.log):
            return []
        with open(self.log, encoding="utf-8") as fh:
            return [json.loads(line) for line in fh if line.strip()]

    def send(self, *messages):
        proc = subprocess.run(
            [sys.executable, "-I", HOST],
            input=b"".join(frame(m) for m in messages),
            capture_output=True,
            env=self.env,
            timeout=30,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr.decode("utf-8", "replace"))
        return unframe(proc.stdout)

    def test_version_cmd_still_works(self):
        [reply] = self.send({"id": 1, "cmd": "version"})
        self.assertTrue(reply["ok"], reply)
        self.assertEqual(reply["result"], "fake-logseq 0.0.1")
        self.assertEqual(self.calls(), [["--version"]])

    def test_each_allowed_verb_pair_reaches_cli(self):
        allowed = [
            ["graph", "list"],
            ["list", "tag", "--graph", "G", "--limit", "2000"],
            ["upsert", "tag", "--graph", "G", "--name", "music-recs"],
            ["upsert", "block", "--graph", "G", "--target-page", "P", "--content", "C"],
            ["query", "--graph", "G", "--query", "[:find ?x]"],
        ]
        msgs = [{"id": i, "cmd": "cli", "args": a} for i, a in enumerate(allowed)]
        replies = self.send(*msgs)
        self.assertEqual(len(replies), len(allowed))
        for reply, args in zip(replies, allowed):
            self.assertTrue(reply["ok"], reply)
            self.assertEqual(json.loads(reply["result"])["data"]["argv"], args)
        self.assertEqual(self.calls(), allowed)

    def test_disallowed_verbs_rejected_and_not_spawned(self):
        bad = [["graph", "remove", "x"], ["rm", "-rf"], ["version"], [], ["graph"]]
        replies = self.send(*[{"id": i, "cmd": "cli", "args": a} for i, a in enumerate(bad)])
        self.assertEqual(len(replies), len(bad))
        for reply in replies:
            self.assertFalse(reply["ok"], reply)
            self.assertIn(REJECT_HINT, reply["error"])
            self.assertIn("newer", reply["error"])
        self.assertEqual(self.calls(), [], "fake CLI must record no invocation")

    def test_upsert_block_full_argv_round_trips(self):
        args = [
            "upsert", "block", "--graph", "my graph", "--target-page", "Clips",
            "--content", "[Title with spaces](https://example.com/a?b=1&c=2)",
            "--update-tags", '["music-recs" "Web Clip"]',
            "-o", "json",
        ]
        [reply] = self.send({"id": "x", "cmd": "cli", "args": args})
        self.assertTrue(reply["ok"], reply)
        self.assertEqual(json.loads(reply["result"])["data"]["argv"], args)
        self.assertEqual(self.calls(), [args])


if __name__ == "__main__":
    unittest.main()
