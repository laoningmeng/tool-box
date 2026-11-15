"""访问鉴权。

进程监听 127.0.0.1，且每次启动由主进程生成随机 token：
所有 ``/api/*`` 请求必须带 ``X-App-Token``，用恒定时间比较避免时序侧信道。
"""

from __future__ import annotations

import secrets

from fastapi import Header

from app.core.config import get_settings
from app.core.errors import UnauthorizedError
from app.core.logging import get_logger

logger = get_logger("app.security")

TOKEN_HEADER = "X-App-Token"


async def require_token(x_app_token: str | None = Header(default=None, alias=TOKEN_HEADER)) -> None:
    settings = get_settings()
    if not settings.token:  # 本机调试未配置 token 时放行
        return
    if not x_app_token or not secrets.compare_digest(x_app_token, settings.token):
        logger.warning("鉴权失败，拒绝访问")
        raise UnauthorizedError("未授权：X-App-Token 缺失或不匹配")
