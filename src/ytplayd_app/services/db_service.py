from typing import Any, Dict, List, Optional, Callable, Tuple


def list_tables(db_fn: Callable[[], Any]) -> List[str]:
    con = db_fn()
    rows = con.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;"
    ).fetchall()
    con.close()
    return [row[0] for row in rows]


def quote_ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def table_info(con: Any, table: str) -> Tuple[List[str], List[str]]:
    rows = con.execute(f"PRAGMA table_info({quote_ident(table)});").fetchall()
    columns = [row[1] for row in rows]
    pk_cols = [row[1] for row in rows if row[5]]
    return columns, pk_cols


def order_by(columns: List[str], pk_cols: List[str]) -> Tuple[str, str]:
    if "created_at" in columns:
        return "created_at DESC", f"{quote_ident('created_at')} DESC"
    if "updated_at" in columns:
        return "updated_at DESC", f"{quote_ident('updated_at')} DESC"
    if pk_cols:
        col = pk_cols[0]
        return f"{col} DESC", f"{quote_ident(col)} DESC"
    return "rowid DESC", "rowid DESC"


def serialize_value(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (bytes, bytearray, memoryview)):
        raw = bytes(value)
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError:
            return raw.hex()
    return value


def fetch_table_rows(
    db_fn: Callable[[], Any],
    table: str,
    limit: int,
    offset: int,
) -> Dict[str, Any]:
    con = db_fn()
    columns, pk_cols = table_info(con, table)
    order_label, order_sql = order_by(columns, pk_cols)
    total = con.execute(f"SELECT COUNT(*) FROM {quote_ident(table)};").fetchone()[0]
    rows_raw = con.execute(
        f"SELECT * FROM {quote_ident(table)} ORDER BY {order_sql} LIMIT ? OFFSET ?;",
        (limit, offset),
    ).fetchall()
    con.close()
    rows: List[Dict[str, Any]] = []
    for row in rows_raw:
        item = {col: serialize_value(val) for col, val in zip(columns, row)}
        rows.append(item)
    return {
        "table": table,
        "limit": limit,
        "offset": offset,
        "total": total,
        "rows": rows,
        "columns": columns,
        "order_by": order_label,
    }
