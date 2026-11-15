# 内置后端（FastAPI）

Electron 主进程用项目内置的 `runtime/python` 拉起本目录，只监听 `127.0.0.1`，
每次启动随机端口 + 随机 `X-App-Token`，只对本机回环开放。

## 启动

由应用自动拉起（无需手动）。手动调试：

```bash
runtime\python\python.exe runtime\backend\server.py --port 8911 --token dev --data-dir .tmp\backend-data
# 文档：http://127.0.0.1:8911/api/docs  （请求仍需带 X-App-Token 才能命中 /api/*）
```

依赖（装在内置运行时里，不影响宿主机）：`npm run setup:backend`

## 目录

```
app/
  main.py              应用工厂：日志 → 生命周期 → 中间件 → 路由 → 异常
  core/
    config.py          APP_* 环境变量配置（命令行参数由 server.py 写入环境变量）
    logging.py         控制台 + 轮转文件日志，text/json 两种格式，自动带 trace_id
    trace.py           trace_id 上下文 + 请求中间件（响应头 X-Trace-Id / X-Response-Time-ms）
    errors.py          AppError 体系 + 全局异常处理器（含校验错误、数据库错误、兜底）
    responses.py       统一信封 ok() / ok_list() / fail()
    security.py        X-App-Token 恒定时间校验
  db/
    base.py            Declarative Base + TimestampMixin（UTC 时间）
    session.py         引擎/会话、SQLite PRAGMA(WAL)、get_db 依赖、session_scope
    models.py          骨架表：task（任务状态存档）
    init.py            建表（后续可换 Alembic）
  tasks/
    manager.py         进程内异步任务调度：并发上限、进度、取消、状态落库、重启恢复
    builtin.py         内置示例任务 demo / sleep（不含业务）
  services/
    comfy.py           ComfyUI 适配（标准库 urllib）
  api/v1/
    router.py          /api 汇总（含鉴权依赖）
    system.py          /api/health、/api/status
    tasks.py           /api/tasks 提交 / 列表 / 详情 / 取消
    comfy.py           /api/comfy/*（沿用 Electron 既有路径）
  schemas/             Pydantic 出入参
```

## 统一响应

```json
{ "ok": true,  "item": { } }
{ "ok": true,  "items": [], "total": 0 }
{ "ok": false, "error": "可读信息", "code": "bad_request", "details": {}, "traceId": "..." }
```

前端（Electron 主进程）只认 `ok` / `error`，`code` 与 `traceId` 供排查用：
拿 `traceId` 去 `<userData>/data/logs/backend.log` 里搜，就能看到这条请求的完整链路。

## 日志

- 位置：`<userData>/data/logs/backend.log`，超过 5MB 轮转，保留 3 份
- 形状：`时间 级别 模块 [trace=xxx] 消息`
- 切 JSON 给采集器：`APP_LOG_FORMAT=json`
- 后台任务的日志会沿用「提交它的那次请求」的 trace_id，前后能串起来

## 加一个任务

```python
# app/tasks/handlers.py
from app.tasks.manager import TaskContext, task_manager

@task_manager.register("report")
async def build_report(ctx: TaskContext) -> dict:
    await ctx.progress(0.3, "取数中")
    await ctx.sleep(1)          # 可被取消打断
    ctx.check_cancelled()        # 主动检查取消
    return {"ok": True}
```

然后在 `app/tasks/__init__.py` 里 import 一次即可注册。

## 加一张表 / 一个接口

1. `app/db/models/xxx.py` 定义模型（继承 `Base`，需要时间戳就混入 `TimestampMixin`）
2. 在 `app/db/init.py` 里 `import app.db.models.xxx`，让 `create_all` 能发现
3. `app/schemas/xxx.py` 写 Pydantic 出入参
4. `app/api/v1/xxx.py` 写路由（`db: Session = Depends(get_db)`），在 `router.py` 里 include
5. 出错直接 `raise NotFoundError("...")`，异常处理器会统一转成信封

## 已知边界（骨架阶段）

- 迁移用 `create_all`，表结构开始演进时接 Alembic
- 任务队列是单进程内存调度，多进程/分布式要换外部队列（接口不用改）
- ComfyUI 任务仍是内存任务表 + 后台线程，未落库
