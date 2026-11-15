"""内置任务示例。

这里不放业务逻辑，只演示 handler 该怎么写：
- 进度上报：``await ctx.progress(0.4, "处理中")``
- 响应取消：``await ctx.sleep(...)`` 会在任务被取消时抛 ``TaskCancelled``
- 返回值会被 JSON 序列化后写进 ``task.result``

接入真实业务时新建 ``app/tasks/handlers.py``，用 ``@task_manager.register("名字")`` 注册即可。
"""

from __future__ import annotations

import asyncio
from typing import Any

from app.core.logging import get_logger
from app.tasks.manager import TaskContext, task_manager

logger = get_logger("app.task.builtin")


@task_manager.register("demo")
async def demo_task(ctx: TaskContext) -> dict[str, Any]:
    """演示任务：按 steps 分段上报进度，可被取消。"""
    steps = int(ctx.payload.get("steps", 5) or 5)
    interval = float(ctx.payload.get("interval", 0.4) or 0.4)
    steps = max(1, min(steps, 50))

    for index in range(steps):
        ctx.check_cancelled()
        await ctx.progress((index + 1) / steps, f"处理中 {index + 1}/{steps}")
        await asyncio.sleep(interval)

    return {"steps": steps, "message": "演示任务完成"}


@task_manager.register("sleep")
async def sleep_task(ctx: TaskContext) -> dict[str, Any]:
    """占位任务：睡指定秒数，用于验证调度与取消。"""
    seconds = float(ctx.payload.get("seconds", 3) or 3)
    await ctx.sleep(min(max(seconds, 0.1), 300))
    await ctx.progress(1.0, "已完成")
    return {"seconds": seconds}
