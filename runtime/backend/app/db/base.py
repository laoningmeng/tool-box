"""声明式基类与通用 Mixin。

所有模型继承 ``Base``；需要创建/更新时间就再混入 ``TimestampMixin``。
时间统一存 UTC 的 naive datetime，展示交给前端按本地时区格式化。
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import DateTime
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def utc_now() -> datetime:
    """当前 UTC 时间（naive，SQLite 友好）。"""
    return datetime.now(timezone.utc).replace(tzinfo=None)


class Base(DeclarativeBase):
    """所有 ORM 模型的基类。"""

    def to_dict(self) -> dict[str, object]:
        """轻量序列化：仅用于日志/调试，接口出参请用 Pydantic schema。"""
        return {column.name: getattr(self, column.name) for column in self.__table__.columns}


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, nullable=False, comment="创建时间（UTC）"
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now, nullable=False, comment="更新时间（UTC）"
    )
