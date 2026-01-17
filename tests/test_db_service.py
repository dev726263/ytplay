import os
import sys
import sqlite3
import tempfile
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SRC = os.path.join(ROOT, "src")
if SRC not in sys.path:
    sys.path.insert(0, SRC)

from ytplayd_app.services import db_service  # noqa: E402


class DbServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp_file = tempfile.NamedTemporaryFile(suffix=".sqlite3", delete=False)
        self.temp_path = self.temp_file.name
        self.temp_file.close()
        con = sqlite3.connect(self.temp_path)
        con.execute(
            "CREATE TABLE tracks (id INTEGER PRIMARY KEY, title TEXT, created_at INTEGER)"
        )
        con.execute("INSERT INTO tracks (title, created_at) VALUES (?, ?)", ("older", 10))
        con.execute("INSERT INTO tracks (title, created_at) VALUES (?, ?)", ("newer", 20))
        con.commit()
        con.close()

    def tearDown(self):
        if os.path.exists(self.temp_path):
            os.unlink(self.temp_path)

    def db_fn(self):
        return sqlite3.connect(self.temp_path)

    def test_list_tables(self):
        tables = db_service.list_tables(self.db_fn)
        self.assertIn("tracks", tables)

    def test_fetch_rows_orders_latest(self):
        data = db_service.fetch_table_rows(self.db_fn, "tracks", limit=1, offset=0)
        self.assertEqual(data["order_by"], "created_at DESC")
        self.assertEqual(data["rows"][0]["title"], "newer")
        self.assertEqual(data["columns"], ["id", "title", "created_at"])


if __name__ == "__main__":
    unittest.main()
