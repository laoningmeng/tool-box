"""系统接口：健康检查 / 运行状态。

``/api/health`` 是 Electron 主进程判定「后端就绪」的唯一依据，保持极轻。
``/api/status`` 的 ``item.version`` 会被渲染层显示成 Python 版本，勿随意改名。
"""

from __future__ import annotations

import platform
import time

from fastapi import APIRouter

from app.core.config import get_settings
from app.core.responses import ok
from app.tasks import task_manager

router = APIRouter(tags=["系统"])

_STARTED_AT = time.time()


@router.get("/health", summary="健康检查")
def health() -> dict[str, object]:
    return ok({"ready": True})


@router.get("/status", summary="运行状态")
def status() -> dict[str, object]:
    settings = get_settings()
    return ok(
        {
            "version": platform.python_version(),
            "appVersion": settings.app_version,
            "uptime": round(time.time() - _STARTED_AT, 1),
            "comfyUrl": settings.comfy_url,
            "db": settings.resolved_db_url.split("://", 1)[0],
            "logDir": str(settings.resolved_log_dir),
            "taskTypes": task_manager.handler_names,
            "framework": "fastapi",
        }
    )
