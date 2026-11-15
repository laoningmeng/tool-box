"""任务接口出入参。"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class TaskCreate(BaseModel):
    name: str = Field(default="demo", description="已注册的任务名，见 /api/tasks/types")
    payload: dict[str, Any] = Field(default_factory=dict, description="任务参数，由 handler 自行解释")


class TaskOut(BaseModel):
    id: str
    name: str
    status: str = Field(description="pending / running / success / failed / canceled")
    progress: float = 0.0
    message: str = ""
    payload: str = ""
    result: str = ""
    error: str = ""
    traceId: str = ""
    createdAt: str | None = None
    updatedAt: str | None = None
    startedAt: str | None = None
    finishedAt: str | None = None
