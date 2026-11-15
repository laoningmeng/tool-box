"""通用出入参 schema。"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class ErrorBody(BaseModel):
    """错误响应体（用于 OpenAPI 文档展示）。"""

    ok: bool = Field(default=False, description="固定为 false")
    error: str = Field(description="可读错误信息")
    code: str = Field(description="稳定错误码，前端据此做分支")
    details: Any | None = Field(default=None, description="结构化细节，如字段校验错误")
    traceId: str | None = Field(default=None, description="对应的后端日志追踪 ID")
