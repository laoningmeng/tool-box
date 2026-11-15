"""统一响应信封。

保持与 Electron 主进程既有解析逻辑兼容：

    成功：{"ok": true,  "item": {...}}        或 {"ok": true, "items": [...], "total": n}
    失败：{"ok": false, "error": "可读信息", "code": "...", "traceId": "..."}

新增接口直接复用这两个函数，不要在路由里手写字面量。
"""

from __future__ import annotations

from typing import Any


def ok(item: Any = None, **extra: Any) -> dict[str, Any]:
    return {"ok": True, "item": item, **extra}


def ok_list(items: list[Any], total: int | None = None, **extra: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {"ok": True, "items": items}
    payload["total"] = len(items) if total is None else total
    payload.update(extra)
    return payload


def fail(message: str, *, code: str = "error", details: Any = None, trace_id: str | None = None) -> dict[str, Any]:
    payload: dict[str, Any] = {"ok": False, "error": message, "code": code}
    if details is not None:
        payload["details"] = details
    if trace_id:
        payload["traceId"] = trace_id
    return payload
