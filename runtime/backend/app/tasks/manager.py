"""进程内任务调度。

设计取舍（骨架阶段，够用且好替换）：

- 单进程、``asyncio`` 协程调度，用信号量限制并发数（``APP_TASK_MAX_CONCURRENCY``）
- 任务状态写进 ``task`` 表，进程重启后可查历史；启动时把上次未完成的任务标记为失败
- 取消用 ``asyncio.Task.cancel()``，handler 里 ``await ctx.sleep()`` / ``ctx.check_cancelled()``
  能及时响应，不要用阻塞调用

要换成 Celery / RQ / Arq 等外部队列时，只需替换 ``TaskManager`` 的实现，
对外的 ``submit / cancel / list`` 签名保持不变，路由层不用改。
"""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import select

from app.core.config import get_settings
from app.core.logging import get_logger
from app.db.base import utc_now
from app.db.models import TaskRecord
from app.db.session import session_scope

logger = get_logger("app.task")

ACTIVE_STATUSES = ("pending", "running")
FINAL_STATUSES = ("success", "failed", "canceled")


class TaskCancelled(Exception):
    """任务被取消时抛出，由调度器记录 canceled 状态。"""


TaskHandler = Callable[["TaskContext"], Awaitable[Any] | Any]


@dataclass
class TaskContext:
    """传给 handler 的上下文：上报进度、检查取消。"""

    id: str
    name: str
    payload: dict[str, Any]
    manager: "TaskManager" = field(repr=False)

    async def progress(self, value: float, message: str = "") -> None:
        value = max(0.0, min(1.0, float(value)))
        await self.manager._update_progress(self.id, value, message)

    def check_cancelled(self) -> None:
        if self.id in self.manager._cancelled:
            raise TaskCancelled(self.id)

    async def sleep(self, seconds: float) -> None:
        """可被取消打断的 sleep。"""
        try:
            await asyncio.sleep(seconds)
        except asyncio.CancelledError as error:
            raise TaskCancelled(self.id) from error
        self.check_cancelled()


def _row_to_dict(row: TaskRecord) -> dict[str, Any]:
    return {
        "id": row.id,
        "name": row.name,
        "status": row.status,
        "progress": round(row.progress or 0.0, 3),
        "message": row.message or "",
        "payload": row.payload or "",
        "result": row.result or "",
        "error": row.error or "",
        "traceId": row.trace_id or "",
        "createdAt": row.created_at.isoformat() if row.created_at else None,
        "updatedAt": row.updated_at.isoformat() if row.updated_at else None,
        "startedAt": row.started_at.isoformat() if row.started_at else None,
        "finishedAt": row.finished_at.isoformat() if row.finished_at else None,
    }


class TaskManager:
    def __init__(self) -> None:
        self._handlers: dict[str, TaskHandler] = {}
        self._running: dict[str, asyncio.Task[None]] = {}
        self._cancelled: set[str] = set()
        self._semaphore: asyncio.Semaphore | None = None

    # ------------------------------------------------------------------ 生命周期

    async def start(self) -> None:
        settings = get_settings()
        self._semaphore = asyncio.Semaphore(max(1, settings.task_max_concurrency))
        recovered = await asyncio.to_thread(self._recover_stale)
        if recovered:
            logger.warning("清理上次未完成的任务 %s 个", recovered)
        logger.info("任务调度就绪：并发上限 %s，已注册任务 %s 个", settings.task_max_concurrency, len(self._handlers))

    async def stop(self) -> None:
        pending = [task for task in self._running.values() if not task.done()]
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        self._running.clear()
        logger.info("任务调度已停止")

    # ------------------------------------------------------------------ 注册

    def register(self, name: str) -> Callable[[TaskHandler], TaskHandler]:
        def decorator(handler: TaskHandler) -> TaskHandler:
            if name in self._handlers:
                raise RuntimeError(f"任务名重复注册：{name}")
            self._handlers[name] = handler
            return handler

        return decorator

    @property
    def handler_names(self) -> list[str]:
        return sorted(self._handlers)

    # ------------------------------------------------------------------ 提交 / 取消

    async def submit(self, name: str, payload: dict[str, Any] | None = None, *, trace_id: str = "") -> dict[str, Any]:
        if name not in self._handlers:
            raise KeyError(name)

        task_id = uuid.uuid4().hex[:12]
        payload = payload or {}
        row = await asyncio.to_thread(
            self._create_record, task_id, name, payload, trace_id
        )
        asyncio_task = asyncio.create_task(self._run(task_id, name, payload), name=f"task:{task_id}")
        self._running[task_id] = asyncio_task
        asyncio_task.add_done_callback(lambda _task: self._running.pop(task_id, None))
        logger.info("任务已提交 id=%s name=%s", task_id, name)
        return row

    async def cancel(self, task_id: str) -> bool:
        running = self._running.get(task_id)
        if running and not running.done():
            self._cancelled.add(task_id)
            running.cancel()
            return True
        # 还没轮到的任务：直接把状态改成取消
        return await asyncio.to_thread(self._cancel_pending, task_id)

    async def get(self, task_id: str) -> dict[str, Any] | None:
        return await asyncio.to_thread(self._fetch, task_id)

    async def list(self, limit: int = 20) -> list[dict[str, Any]]:
        return await asyncio.to_thread(self._fetch_list, limit)

    # ------------------------------------------------------------------ 执行

    async def _run(self, task_id: str, name: str, payload: dict[str, Any]) -> None:
        handler = self._handlers[name]
        ctx = TaskContext(id=task_id, name=name, payload=payload, manager=self)
        try:
            assert self._semaphore is not None, "TaskManager.start() 尚未执行"
            async with self._semaphore:
                await asyncio.to_thread(self._mark_running, task_id)
                logger.info("任务开始 id=%s name=%s", task_id, name)
                result = handler(ctx)
                if asyncio.iscoroutine(result) or isinstance(result, Awaitable):
                    result = await result
                await asyncio.to_thread(self._mark_success, task_id, result)
                logger.info("任务完成 id=%s name=%s", task_id, name)
        except (TaskCancelled, asyncio.CancelledError):
            await asyncio.to_thread(self._mark_canceled, task_id)
            logger.info("任务已取消 id=%s name=%s", task_id, name)
        except Exception as error:  # noqa: BLE001 - 任务失败要落库，不能让调度器挂掉
            await asyncio.to_thread(self._mark_failed, task_id, str(error))
            logger.exception("任务失败 id=%s name=%s", task_id, name)
        finally:
            self._cancelled.discard(task_id)

    # ------------------------------------------------------------------ 持久化（同步，跑在线程里）

    def _create_record(self, task_id: str, name: str, payload: dict[str, Any], trace_id: str) -> dict[str, Any]:
        with session_scope() as session:
            row = TaskRecord(
                id=task_id,
                name=name,
                status="pending",
                progress=0.0,
                message="已入队",
                payload=json.dumps(payload, ensure_ascii=False),
                trace_id=trace_id,
            )
            session.add(row)
            session.flush()
            return _row_to_dict(row)

    def _mark_running(self, task_id: str) -> None:
        with session_scope() as session:
            row = session.get(TaskRecord, task_id)
            if row is None:
                return
            row.status = "running"
            row.started_at = utc_now()
            row.message = "运行中"

    def _mark_success(self, task_id: str, result: Any) -> None:
        with session_scope() as session:
            row = session.get(TaskRecord, task_id)
            if row is None:
                return
            row.status = "success"
            row.progress = 1.0
            row.message = "已完成"
            row.result = json.dumps(result, ensure_ascii=False, default=str) if result is not None else ""
            row.finished_at = utc_now()

    def _mark_failed(self, task_id: str, error: str) -> None:
        with session_scope() as session:
            row = session.get(TaskRecord, task_id)
            if row is None:
                return
            row.status = "failed"
            row.message = "执行失败"
            row.error = error[:2000]
            row.finished_at = utc_now()

    def _mark_canceled(self, task_id: str) -> None:
        with session_scope() as session:
            row = session.get(TaskRecord, task_id)
            if row is None:
                return
            row.status = "canceled"
            row.message = "已取消"
            row.finished_at = utc_now()

    def _cancel_pending(self, task_id: str) -> bool:
        with session_scope() as session:
            row = session.get(TaskRecord, task_id)
            if row is None or row.status not in ACTIVE_STATUSES:
                return False
            row.status = "canceled"
            row.message = "已取消"
            row.finished_at = utc_now()
            return True

    async def _update_progress(self, task_id: str, value: float, message: str) -> None:
        def _write() -> None:
            with session_scope() as session:
                row = session.get(TaskRecord, task_id)
                if row is None:
                    return
                row.progress = value
                if message:
                    row.message = message

        await asyncio.to_thread(_write)

    def _fetch(self, task_id: str) -> dict[str, Any] | None:
        with session_scope() as session:
            row = session.get(TaskRecord, task_id)
            return _row_to_dict(row) if row else None

    def _fetch_list(self, limit: int) -> list[dict[str, Any]]:
        with session_scope() as session:
            rows = session.scalars(
                select(TaskRecord).order_by(TaskRecord.created_at.desc()).limit(max(1, min(limit, 200)))
            ).all()
            return [_row_to_dict(row) for row in rows]

    def _recover_stale(self) -> int:
        with session_scope() as session:
            rows = session.scalars(select(TaskRecord).where(TaskRecord.status.in_(ACTIVE_STATUSES))).all()
            for row in rows:
                row.status = "failed"
                row.message = "后端重启，任务中断"
                row.error = "backend restarted"
                row.finished_at = utc_now()
            return len(rows)


task_manager = TaskManager()
