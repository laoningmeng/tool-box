"""引擎与会话管理。

- 惰性初始化：第一次用到时才建 engine（避免 import 期副作用，方便测试替换 URL）
- ``get_db`` 给 FastAPI 依赖注入用（请求级 Session）
- ``session_scope`` 给后台任务/脚本用（自动 commit / rollback）
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import Engine, create_engine, event
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import get_settings

_engine: Engine | None = None
_session_factory: sessionmaker[Session] | None = None


def init_engine(url: str | None = None, *, echo: bool = False) -> Engine:
    """创建（或重建）引擎与会话工厂。"""
    global _engine, _session_factory

    settings = get_settings()
    url = url or settings.resolved_db_url
    connect_args: dict[str, object] = {}
    if url.startswith("sqlite"):
        # SQLite 默认单线程限制，FastAPI 在线程池里用连接必须关掉
        connect_args["check_same_thread"] = False
        connect_args["timeout"] = 15

    engine = create_engine(url, echo=echo or settings.db_echo, future=True, connect_args=connect_args)

    if url.startswith("sqlite"):
        _enable_sqlite_pragmas(engine)

    _engine = engine
    _session_factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    return engine


def _enable_sqlite_pragmas(engine: Engine) -> None:
    @event.listens_for(engine, "connect")
    def _set_pragma(dbapi_connection, _record) -> None:  # noqa: ANN001
        cursor = dbapi_connection.cursor()
        try:
            cursor.execute("PRAGMA journal_mode=WAL")  # 读写并发更好，崩溃恢复更稳
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.execute("PRAGMA busy_timeout=15000")
        finally:
            cursor.close()


def get_engine() -> Engine:
    if _engine is None:
        return init_engine()
    return _engine


def get_session_factory() -> sessionmaker[Session]:
    if _session_factory is None:
        init_engine()
    assert _session_factory is not None
    return _session_factory


@contextmanager
def session_scope() -> Iterator[Session]:
    """事务边界：正常结束 commit，异常 rollback 后抛出。"""
    session = get_session_factory()()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def get_db() -> Iterator[Session]:
    """FastAPI 依赖：``db: Session = Depends(get_db)``。"""
    session = get_session_factory()()
    try:
        yield session
    finally:
        session.close()


def dispose_engine() -> None:
    global _engine, _session_factory
    if _engine is not None:
        _engine.dispose()
    _engine = None
    _session_factory = None
