import os
import sys
import unittest
from unittest import mock

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SRC = os.path.join(ROOT, "src")
if SRC not in sys.path:
    sys.path.insert(0, SRC)

import ytplayd  # noqa: E402


class FakeCon:
    def __init__(self):
        self.executed = []

    def execute(self, sql, params=()):
        self.executed.append((sql, params))
        return self

    def commit(self):
        return None


class StubMPV:
    def __init__(self):
        self.loaded = []

    def load_and_play(self, urls):
        self.loaded.append(list(urls))


class HandlePlaySmokeTests(unittest.TestCase):
    def setUp(self):
        self.fake_con = FakeCon()
        self.stub_mpv = StubMPV()
        ytplayd.last_debug = {}
        ytplayd.last_queue = []
        ytplayd.last_seed = None
        ytplayd.last_seed_next = []
        ytplayd.last_prompt = None

        self.patchers = [
            mock.patch.object(ytplayd, "maybe_reload_ytmusic", new=lambda: None),
            mock.patch.object(ytplayd, "db", new=lambda: self.fake_con),
            mock.patch.object(ytplayd, "cache_get", new=lambda *args, **kwargs: None),
            mock.patch.object(ytplayd, "cache_put", new=lambda *args, **kwargs: None),
            mock.patch.object(
                ytplayd,
                "llm_curate",
                new=lambda prompt, extras: {
                    "search_queries": ["stub query"],
                    "avoid_terms": [],
                    "notes": "stub",
                    "source": "stub",
                },
            ),
            mock.patch.object(ytplayd, "fallback_queries", new=lambda *args, **kwargs: ["fallback"]),
            mock.patch.object(ytplayd, "mpv", new=self.stub_mpv),
        ]
        for patcher in self.patchers:
            patcher.start()
        self.addCleanup(self._cleanup_patches)

    def _cleanup_patches(self):
        for patcher in self.patchers:
            patcher.stop()

    def test_handle_play_uses_watch_urls_when_resolve_fails(self):
        tracks = [{"videoId": "vid1", "title": "Song 1", "artist": "Artist A"}]
        seed_info = {"videoId": "seed1", "title": "Seed Track", "artist": "Seed Artist"}
        seed_next = [{"videoId": "next1", "title": "Next", "artist": "Next Artist"}]
        with mock.patch.object(ytplayd, "pick_tracks", return_value=(tracks, seed_info, seed_next)):
            with mock.patch.object(ytplayd, "resolve_urls_parallel", return_value=([None], 0)):
                res = ytplayd.handle_play("prompt", {"max_tracks": 1, "ttl_hours": 1})

        self.assertTrue(res["ok"])
        self.assertEqual(self.stub_mpv.loaded[-1], [ytplayd.watch_url("vid1")])
        self.assertEqual(res["queue"][0]["videoId"], "vid1")
        self.assertEqual(res["queue"][0]["curation"], "fallback")
        self.assertTrue(ytplayd.last_debug.get("stream_fallback"))
        self.assertEqual(ytplayd.last_debug.get("stream_total"), 1)
        self.assertEqual(ytplayd.last_debug.get("stream_resolved"), 0)
        self.assertEqual(ytplayd.last_queue[0]["videoId"], "vid1")

    def test_handle_play_uses_resolved_stream_urls_when_available(self):
        tracks = [
            {"videoId": "vid1", "title": "Song 1", "artist": "Artist A"},
            {"videoId": "vid2", "title": "Song 2", "artist": "Artist B"},
        ]
        with mock.patch.object(ytplayd, "pick_tracks", return_value=(tracks, None, [])):
            with mock.patch.object(ytplayd, "resolve_urls_parallel", return_value=(["stream1", None], 1)):
                res = ytplayd.handle_play("prompt", {"max_tracks": 2, "ttl_hours": 1})

        self.assertTrue(res["ok"])
        self.assertEqual(self.stub_mpv.loaded[-1], ["stream1"])
        self.assertEqual(res["count"], 1)
        self.assertEqual(ytplayd.last_queue[0]["videoId"], "vid1")
        self.assertEqual(ytplayd.last_queue[0]["curation"], "fallback")
        self.assertFalse(ytplayd.last_debug.get("stream_fallback"))
        self.assertEqual(ytplayd.last_debug.get("stream_total"), 2)
        self.assertEqual(ytplayd.last_debug.get("stream_resolved"), 1)


if __name__ == "__main__":
    unittest.main()
