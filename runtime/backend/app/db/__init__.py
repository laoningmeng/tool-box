"""数据库层：SQLAlchemy 2.0 引擎 / 会话 / 模型。

默认落地 SQLite（``<data_dir>/app.db``），换库只需改 ``APP_DB_URL``，
例如 ``postgresql+psycopg://user:pass@127.0.0.1:5432/app``。
"""

from app.db.base import Base, TimestampMixin, utc_now
from app.db.init import init_db
from app.db.session import dispose_engine, get_db, init_engine, session_scope

__all__ = [
    "Base",
    "TimestampMixin",
    "utc_now",
    "init_db",
    "init_engine",
    "get_db",
    "session_scope",
    "dispose_engine",
]
