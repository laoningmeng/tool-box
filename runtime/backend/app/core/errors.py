"""异常体系与全局异常处理。

用法：业务代码里 ``raise NotFoundError("任务不存在")``，
交给这里统一转成 ``{"ok": false, ...}`` 信封，前端不必区分异常来源。

未捕获异常会带完整堆栈写进日志，但对外只返回通用文案（不泄露内部细节）。
"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy.exc import SQLAlchemyError
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.logging import get_logger
from app.core.responses import fail
from app.core.trace import get_trace_id

logger = get_logger("app.error")


class AppError(Exception):
    """业务异常基类：带 HTTP 状态码与稳定的错误码。"""

    status_code: int = 400
    code: str = "app_error"

    def __init__(
        self,
        message: str | None = None,
        *,
        status_code: int | None = None,
        code: str | None = None,
        details: Any = None,
    ) -> None:
        self.message = message or self.__class__.__doc__ or "请求处理失败"
        if status_code is not None:
            self.status_code = status_code
        if code is not None:
            self.code = code
        self.details = details
        super().__init__(self.message)


class BadRequestError(AppError):
    """请求参数不合法"""

    status_code = 400
    code = "bad_request"


class UnauthorizedError(AppError):
    """未授权"""

    status_code = 401
    code = "unauthorized"


class ForbiddenError(AppError):
    """无权限"""

    status_code = 403
    code = "forbidden"


class NotFoundError(AppError):
    """资源不存在"""

    status_code = 404
    code = "not_found"


class ConflictError(AppError):
    """资源状态冲突"""

    status_code = 409
    code = "conflict"


class UpstreamError(AppError):
    """上游服务异常"""

    status_code = 502
    code = "upstream_error"


class ServiceUnavailableError(AppError):
    """依赖的组件未就绪"""

    status_code = 503
    code = "service_unavailable"


def _payload(message: str, code: str, details: Any = None) -> dict[str, Any]:
    return fail(message, code=code, details=details, trace_id=get_trace_id() or None)


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _app_error(_request, exc: AppError) -> JSONResponse:
        log = logger.warning if exc.status_code < 500 else logger.error
        log("%s: %s", exc.code, exc.message)
        return JSONResponse(
            status_code=exc.status_code,
            content=_payload(exc.message, exc.code, exc.details),
        )

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_request, exc: RequestValidationError) -> JSONResponse:
        def field_of(error: dict[str, Any]) -> str:
            if str(error.get("type", "")).startswith("json_"):
                return "body"  # 整个请求体不是合法 JSON，定位到 body 即可
            parts = [str(part) for part in error.get("loc", ()) if part != "body"]
            return ".".join(parts) or "body"

        details = [
            {
                "field": field_of(error),
                "message": error.get("msg", ""),
                "type": error.get("type", ""),
            }
            for error in exc.errors()
        ]
        logger.warning("参数校验失败: %s", details)
        return JSONResponse(
            status_code=422,
            content=_payload("请求参数校验失败", "validation_error", details),
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_request, exc: StarletteHTTPException) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content=_payload(str(exc.detail or "请求失败"), f"http_{exc.status_code}"),
        )

    @app.exception_handler(SQLAlchemyError)
    async def _db_error(_request, exc: SQLAlchemyError) -> JSONResponse:
        logger.exception("数据库操作失败")
        return JSONResponse(
            status_code=500,
            content=_payload("数据库操作失败", "database_error"),
        )

    @app.exception_handler(Exception)
    async def _unhandled(_request, exc: Exception) -> JSONResponse:
        logger.exception("未捕获异常: %s", exc)
        return JSONResponse(
            status_code=500,
            content=_payload("服务器内部错误，请把 traceId 提供给开发者", "internal_error"),
        )
