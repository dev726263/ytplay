import threading
import time
from typing import Any, Dict, Optional

_lock = threading.Lock()
_generation_seq = 0
_state: Dict[str, Any] = {
    "is_generating": False,
    "current_query": None,
    "started_at": None,
    "last_update": None,
    "last_error": None,
    "source": None,
    "phase": None,
    "active_id": None,
}


def start_generation(query: Optional[Dict[str, Any]], source: str, phase: Optional[str] = None) -> int:
    global _generation_seq
    now = int(time.time())
    with _lock:
        _generation_seq += 1
        gen_id = _generation_seq
        _state["is_generating"] = True
        _state["current_query"] = query
        _state["started_at"] = now
        _state["last_update"] = now
        _state["last_error"] = None
        _state["source"] = source
        _state["phase"] = phase
        _state["active_id"] = gen_id
        return gen_id


def update_generation(
    gen_id: int,
    query: Optional[Dict[str, Any]] = None,
    error: Optional[str] = None,
    phase: Optional[str] = None,
) -> None:
    now = int(time.time())
    with _lock:
        if _state.get("active_id") != gen_id:
            return
        if query is not None:
            _state["current_query"] = query
        if error is not None:
            _state["last_error"] = error
        if phase is not None:
            _state["phase"] = phase
        _state["last_update"] = now


def finish_generation(gen_id: int, error: Optional[str] = None) -> None:
    now = int(time.time())
    with _lock:
        if _state.get("active_id") != gen_id:
            return
        _state["is_generating"] = False
        _state["last_update"] = now
        _state["phase"] = None
        if error is not None:
            _state["last_error"] = error


def snapshot(queue_size: int, queue_target: int) -> Dict[str, Any]:
    with _lock:
        return {
            "ok": True,
            "queue_target": queue_target,
            "queue_size": queue_size,
            "is_generating": bool(_state.get("is_generating")),
            "current_query": _state.get("current_query"),
            "started_at": _state.get("started_at"),
            "last_update": _state.get("last_update"),
            "last_error": _state.get("last_error"),
            "source": _state.get("source"),
            "phase": _state.get("phase"),
        }
