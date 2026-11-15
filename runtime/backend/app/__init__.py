"""后端应用包。

分层约定（依赖方向单向向下，禁止反向 import）：

    api/        路由层：只做参数校验 + 调用 service/task，不写 SQL
    services/   外部系统适配（ComfyUI 等）
    tasks/      进程内任务调度（异步、可持久化状态）
    db/         SQLAlchemy 引擎 / 会话 / 模型
    schemas/    Pydantic 出入参
    core/       配置、日志、链路追踪、异常、鉴权等横切能力
"""

__version__ = "1.0.0"
