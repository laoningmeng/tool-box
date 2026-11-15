"""任务接口：提交 / 查询 / 取消。

约定：提交是「异步受理」，返回 202 语义的 taskId，调用方轮询 ``GET /api/tasks/{id}`` 拿进度。
"""

from __future__ import annotations

from fastapi import APIRouter, Query

from app.core.errors import BadRequestError, NotFoundError
from app.core.responses import ok, ok_list
from app.core.trace import get_trace_id
from app.schemas.task import TaskCreate
from app.tasks import task_manager

router = APIRouter(prefix="/tasks", tags=["任务"])


@router.get("/types", summary="可用的任务类型")
def task_types() -> dict[str, object]:
    return ok(task_manager.handler_names)


@router.post("", summary="提交任务")
async def create_task(payload: TaskCreate) -> dict[str, object]:
    try:
        row = await task_manager.submit(payload.name, payload.payload, trace_id=get_trace_id())
    except KeyError as error:
        raise BadRequestError(
            f"未知任务类型：{payload.name}",
            details={"available": task_manager.handler_names},
        ) from error
    return ok(row)


@router.get("", summary="任务列表")
async def list_tasks(limit: int = Query(default=20, ge=1, le=200)) -> dict[str, object]:
    rows = await task_manager.list(limit)
    return ok_list(rows)


@router.get("/{task_id}", summary="任务详情")
async def get_task(task_id: str) -> dict[str, object]:
    row = await task_manager.get(task_id)
    if row is None:
        raise NotFoundError("任务不存在")
    return ok(row)


@router.post("/{task_id}/cancel", summary="取消任务")
async def cancel_task(task_id: str) -> dict[str, object]:
    canceled = await task_manager.cancel(task_id)
    if not canceled:
        raise NotFoundError("任务不存在或已结束")
    return ok({"id": task_id, "canceled": True})
