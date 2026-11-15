"""ORM 模型。

骨架阶段只放一张通用任务表（``task``），给任务调度模块做状态持久化；
业务表请新建文件（如 ``app/db/models/order.py``）并在 ``app/db/init.py`` 里 import，
让 ``Base.metadata`` 能发现它。生产环境建议引入 Alembic 管理迁移。
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, Float, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin


class TaskRecord(Base, TimestampMixin):
    """进程内任务的状态存档（重启后仍可查历史，未完成的会被标记失败）。"""

    __tablename__ = "task"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(String(64), index=True)
    status: Mapped[str] = mapped_column(String(16), index=True, default="pending")
    progress: Mapped[float] = mapped_column(Float, default=0.0)
    message: Mapped[str] = mapped_column(String(500), default="")
    payload: Mapped[str] = mapped_column(Text, default="")
    result: Mapped[str] = mapped_column(Text, default="")
    error: Mapped[str] = mapped_column(Text, default="")
    trace_id: Mapped[str] = mapped_column(String(32), default="", index=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    def __repr__(self) -> str:  # pragma: no cover - 调试用
        return f"<TaskRecord {self.id} {self.name} {self.status}>"
