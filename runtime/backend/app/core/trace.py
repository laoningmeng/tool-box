"""全局日志链路追踪。

一个请求进来时由 ``TraceMiddleware`` 生成（或沿用客户端带来的）trace_id，
写进 ``ContextVar``，之后同一条调用链上的所有日志都会自动带上它，
错误响应体里的 ``traceId`` 也来自这里，方便前端报错时直接定位后端日志。
"""

from __future__ import annotations

import logging
import time
import uuid
from contextvars import ContextVar, Token

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response

TRACE_HEADER = "X-Trace-Id"
REQUEST_ID_HEADER = "X-Request-Id"

_trace_id: ContextVar[str] = ContextVar("trace_id", default="")

logger = logging.getLogger("app.trace")


def new_trace_id() -> str:
    return uuid.uuid4().hex[:16]


def get_trace_id() -> str:
    return _trace_id.get()


def set_trace_id(value: str) -> Token[str]:
    return _trace_id.set(value)


def reset_trace_id(token: Token[str]) -> None:
    _trace_id.reset(token)


class TraceMiddleware(BaseHTTPMiddleware):
    """给每个请求分配 trace_id，并记录「方法 / 路径 / 状态码 / 耗时」访问日志。"""

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        incoming = request.headers.get(REQUEST_ID_HEADER) or request.headers.get(TRACE_HEADER)
        trace_id = (incoming or new_trace_id())[:32]
        token = set_trace_id(trace_id)
        started = time.perf_counter()
        try:
            response = await call_next(request)
        except Exception:
            # 交给 app/core/errors.py 的兜底处理器，但日志要留痕
            elapsed = (time.perf_counter() - started) * 1000
            logger.exception(
                "%s %s 未捕获异常 耗时=%.1fms", request.method, request.url.path, elapsed
            )
            raise
        else:
            elapsed = (time.perf_counter() - started) * 1000
            response.headers[TRACE_HEADER] = trace_id
            response.headers["X-Response-Time-ms"] = f"{elapsed:.1f}"
            level = logging.WARNING if response.status_code >= 400 else logging.INFO
            logger.log(
                level,
                "%s %s -> %s 耗时=%.1fms",
                request.method,
                request.url.path,
                response.status_code,
                elapsed,
            )
            return response
        finally:
            reset_trace_id(token)
