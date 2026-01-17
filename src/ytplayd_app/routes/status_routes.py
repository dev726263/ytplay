from typing import Any, Dict, Tuple

from ytplayd_app.services import status_service


def handle_status(queue_size: int, queue_target: int) -> Tuple[int, Dict[str, Any]]:
    return 200, status_service.snapshot(queue_size, queue_target)
