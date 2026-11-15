"""v1 路由汇总。

当前挂在前端既有的 ``/api`` 前缀下（Electron 主进程的路径是写死的）。
需要正式版本化时：把 ``prefix`` 改成 ``/api/v1``，并在主进程侧同步路径即可。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from app.api.v1 import comfy, system, tasks
from app.core.security import require_token

api_router = APIRouter(prefix="/api", dependencies=[Depends(require_token)])

api_router.include_router(system.router)
api_router.include_router(tasks.router)
api_router.include_router(comfy.router)
