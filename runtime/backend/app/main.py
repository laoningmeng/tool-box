"""应用工厂。

``create_app()`` 里按固定顺序装配横切能力，顺序有讲究：

    日志 → 生命周期（建表 + 启动任务调度） → 中间件（链路追踪） → 路由 → 异常处理

异常处理器一定要最后注册：``Exception`` 处理器会被 Starlette 装到最外层，
这样它能兜住路由、中间件、依赖注入里抛出的所有异常。
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from collections.abc import AsyncIterator
from pathlib import Path

from fastapi import FastAPI

from app.api.v1.router import api_router
from app.core.config import get_settings
from app.core.errors import register_exception_handlers
from app.core.logging import get_logger, setup_logging
from app.core.trace import TraceMiddleware
from app.db import dispose_engine, init_db
from app.tasks import task_manager

DESCRIPTION = """
本地桌面应用的内置后端（FastAPI）。

- 所有接口均为本机回环访问，需带 `X-App-Token`
- 统一响应信封：`{ok, item|items, error, code, traceId}`
- 每个请求都有 trace_id，日志与错误响应都会带上它
"""


def create_app() -> FastAPI:
    settings = get_settings()
    settings.ensure_dirs()

    log_file: Path | None = setup_logging(
        level=settings.log_level,
        log_dir=settings.resolved_log_dir,
        fmt=settings.log_format,
        max_bytes=settings.log_max_bytes,
        backup_count=settings.log_backup_count,
    )
    logger = get_logger("app")

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        logger.info(
            "后端启动 version=%s data=%s db=%s",
            settings.app_version,
            settings.resolved_data_dir,
            settings.resolved_db_url,
        )
        if log_file:
            logger.info("日志文件：%s", log_file)
        init_db()
        await task_manager.start()
        try:
            yield
        finally:
            await task_manager.stop()
            dispose_engine()
            logger.info("后端已停止")

    app = FastAPI(
        title=settings.app_name,
        version=settings.app_version,
        description=DESCRIPTION,
        lifespan=lifespan,
        docs_url="/api/docs",
        redoc_url=None,
        openapi_url="/api/openapi.json",
    )

    app.add_middleware(TraceMiddleware)

    app.include_router(api_router)

    register_exception_handlers(app)

    return app


app = create_app  # 便于 `uvicorn app.main:app --factory`
