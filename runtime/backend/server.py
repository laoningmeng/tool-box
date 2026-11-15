"""内置 Python 后端入口（FastAPI + uvicorn）。

由 Electron 主进程以子进程方式拉起：

    python.exe server.py --port <随机端口> --token <随机令牌> --data-dir <可写目录>
                        --comfy-url <ComfyUI 地址> --app-version <应用版本>

命令行参数会被写成 ``APP_*`` 环境变量，再由 ``app/core/config.py`` 统一读取；
这样既保留了命令行启动方式，也让后端内部只有一份配置来源。

只监听 127.0.0.1，所有 /api 请求必须带 X-App-Token。
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="应用本地后端（FastAPI）")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--token", required=True)
    parser.add_argument("--data-dir", default="")
    parser.add_argument("--comfy-url", default="http://127.0.0.1:8188")
    parser.add_argument("--app-version", default="0.0.0")
    return parser.parse_args()


def check_dependencies() -> None:
    """缺依赖时给出可执行提示，而不是抛一屏 traceback。"""
    missing: list[str] = []
    for module, package in (
        ("fastapi", "fastapi"),
        ("uvicorn", "uvicorn"),
        ("sqlalchemy", "sqlalchemy"),
        ("pydantic_settings", "pydantic-settings"),
    ):
        try:
            __import__(module)
        except ModuleNotFoundError:
            missing.append(package)
    if missing:
        print(
            "[backend] 缺少依赖：" + ", ".join(missing) + "；请先执行 `npm run setup:backend`",
            file=sys.stderr,
            flush=True,
        )
        raise SystemExit(2)


def main() -> None:
    args = parse_args()

    data_dir = Path(args.data_dir).resolve() if args.data_dir else BACKEND_DIR.parent / "data"
    data_dir.mkdir(parents=True, exist_ok=True)

    os.environ["APP_PORT"] = str(args.port)
    os.environ["APP_TOKEN"] = args.token
    os.environ["APP_DATA_DIR"] = str(data_dir)
    os.environ["APP_COMFY_URL"] = args.comfy_url.rstrip("/")
    os.environ["APP_APP_VERSION"] = args.app_version
    os.environ.setdefault("PYTHONUNBUFFERED", "1")

    check_dependencies()

    # backend 目录加入 sys.path，保证 `import app.*` 在本文件被任意路径启动时都能工作
    if str(BACKEND_DIR) not in sys.path:
        sys.path.insert(0, str(BACKEND_DIR))

    import uvicorn

    from app.core.config import get_settings
    from app.core.logging import get_logger
    from app.main import create_app

    settings = get_settings()
    application = create_app()
    logger = get_logger("app")
    logger.info("监听 127.0.0.1:%s（uvicorn，单进程）", args.port)
    print(f"[backend] listening on 127.0.0.1:{args.port}", flush=True)

    uvicorn.run(
        application,
        host="127.0.0.1",
        port=args.port,
        log_config=None,  # 用 app/core/logging.py 的配置，避免 uvicorn 覆盖
        access_log=False,  # 访问日志由 TraceMiddleware 统一输出（带 trace_id 与耗时）
        timeout_graceful_shutdown=3,
    )


if __name__ == "__main__":
    main()
