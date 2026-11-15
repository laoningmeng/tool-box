"""任务模块导出。

import 本包即完成内置任务注册（``app/tasks/builtin.py``）。
"""

from app.tasks.manager import TaskCancelled, TaskContext, TaskManager, task_manager

# 触发内置任务注册（demo / sleep），业务任务可在别处 import 时再注册
from app.tasks import builtin  # noqa: E402,F401

__all__ = ["TaskManager", "TaskContext", "TaskCancelled", "task_manager"]
