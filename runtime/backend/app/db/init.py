"""建表与启动自检。

骨架阶段用 ``create_all`` 直接建表；表结构开始演进后换成 Alembic：

    alembic init migrations
    alembic revision --autogenerate -m "init"
    alembic upgrade head
"""

from __future__ import annotations

from sqlalchemy import inspect

from app.core.logging import get_logger
from app.db.base import Base
from app.db.session import get_engine

logger = get_logger("app.db")


def init_db() -> None:
    """创建缺失的表（幂等）。新增模型后记得在这里 import，否则不会被发现。"""
    import app.db.models  # noqa: F401  确保模型注册到 Base.metadata

    engine = get_engine()
    Base.metadata.create_all(bind=engine)
    tables = ", ".join(sorted(inspect(engine).get_table_names())) or "(空)"
    logger.info("数据库就绪：%s | 表：%s", engine.url.render_as_string(hide_password=True), tables)
