from typing import Any, Dict, List, Tuple, Callable
from urllib.parse import unquote

from ytplayd_app.services import db_service


def handle_tables(db_fn: Callable[[], Any]) -> Tuple[int, Dict[str, Any]]:
    return 200, {"ok": True, "tables": db_service.list_tables(db_fn)}


def match_table_rows(path: str) -> str:
    if path.startswith("/api/db/table/") and path.endswith("/rows"):
        raw_name = path[len("/api/db/table/"):-len("/rows")]
        return unquote(raw_name).strip()
    return ""


def handle_table_rows(
    db_fn: Callable[[], Any],
    table: str,
    qs: Dict[str, List[str]],
) -> Tuple[int, Dict[str, Any]]:
    tables = db_service.list_tables(db_fn)
    if not table or table not in tables:
        return 404, {"ok": False, "error": "unknown table"}
    limit_raw = (qs.get("limit") or [None])[0]
    offset_raw = (qs.get("offset") or [None])[0]
    try:
        limit = int(limit_raw) if limit_raw is not None else 10
        offset = int(offset_raw) if offset_raw is not None else 0
    except ValueError:
        return 400, {"ok": False, "error": "invalid pagination"}
    limit = max(1, min(50, limit))
    offset = max(0, offset)
    payload = db_service.fetch_table_rows(db_fn, table, limit, offset)
    return 200, {"ok": True, **payload}
