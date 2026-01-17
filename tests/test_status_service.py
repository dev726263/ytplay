import os
import sys
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SRC = os.path.join(ROOT, "src")
if SRC not in sys.path:
    sys.path.insert(0, SRC)

from ytplayd_app.services import status_service  # noqa: E402


class StatusServiceTests(unittest.TestCase):
    def test_generation_lifecycle(self):
        gen_id = status_service.start_generation({"prompt": "test"}, "queue", phase="start")
        snapshot = status_service.snapshot(queue_size=3, queue_target=10)
        self.assertTrue(snapshot["is_generating"])
        self.assertEqual(snapshot["current_query"]["prompt"], "test")
        self.assertEqual(snapshot["queue_size"], 3)
        self.assertEqual(snapshot["queue_target"], 10)

        status_service.update_generation(gen_id, query={"prompt": "updated"}, phase="loop")
        snapshot = status_service.snapshot(queue_size=3, queue_target=10)
        self.assertEqual(snapshot["current_query"]["prompt"], "updated")
        self.assertEqual(snapshot["phase"], "loop")

        status_service.finish_generation(gen_id)
        snapshot = status_service.snapshot(queue_size=3, queue_target=10)
        self.assertFalse(snapshot["is_generating"])

    def test_stale_generation_update_is_ignored(self):
        first_id = status_service.start_generation({"prompt": "first"}, "queue")
        second_id = status_service.start_generation({"prompt": "second"}, "queue")

        status_service.update_generation(first_id, query={"prompt": "stale"})
        snapshot = status_service.snapshot(queue_size=1, queue_target=10)
        self.assertEqual(snapshot["current_query"]["prompt"], "second")

        status_service.finish_generation(second_id)


if __name__ == "__main__":
    unittest.main()
