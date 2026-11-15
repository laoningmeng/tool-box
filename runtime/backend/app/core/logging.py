"""日志管理：控制台 + 按大小轮转的文件日志，每条记录自动带 trace_id。

两种格式：
- ``text``（默认）给人看：``2026-01-01 12:00:00 INFO  app.api.tasks [trace=ab12cd34] ...``
- ``json`` 给采集器看：``{"ts": ..., "level": ..., "traceId": ...}``

切换：``APP_LOG_FORMAT=json``。
"""

from __future__ import annotations

import json
import logging
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path

from app.core.trace import get_trace_id

LOG_NAME = "backend.log"


class TraceIdFilter(logging.Filter):
    """把当前上下文的 trace_id 塞进 LogRecord，格式化串里就能直接用。"""

    def filter(self, record: logging.LogRecord) -> bool:
        record.trace_id = get_trace_id() or "-"
        return True


class TextFormatter(logging.Formatter):
    default_time_format = "%Y-%m-%d %H:%M:%S"

    def __init__(self) -> None:
        super().__init__(
            fmt="%(asctime)s %(levelname)-7s %(name)-22s [trace=%(trace_id)s] %(message)s",
            datefmt=self.default_time_format,
        )


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, object] = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S"),
            "level": record.levelname,
            "logger": record.name,
            "traceId": getattr(record, "trace_id", "-"),
            "message": record.getMessage(),
        }
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False)


def setup_logging(
    level: str = "INFO",
    log_dir: Path | None = None,
    fmt: str = "text",
    max_bytes: int = 5 * 1024 * 1024,
    backup_count: int = 3,
) -> Path | None:
    """初始化根 logger；返回日志文件路径（未落盘时为 None）。

    可重复调用（例如测试里重建 app），会先清空已有 handler 避免重复输出。
    """
    root = logging.getLogger()
    for handler in list(root.handlers):
        root.removeHandler(handler)
        handler.close()

    root.setLevel(str(level).upper())

    formatter: logging.Formatter = JsonFormatter() if fmt.lower() == "json" else TextFormatter()
    trace_filter = TraceIdFilter()

    console = logging.StreamHandler(stream=sys.stdout)
    console.setFormatter(formatter)
    console.addFilter(trace_filter)
    root.addHandler(console)

    # 第三方库的细节日志压到 WARNING，避免淹没自己的日志
    for noisy in ("uvicorn", "uvicorn.error", "uvicorn.access", "watchfiles", "multipart"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    if log_dir is None:
        return None

    log_dir = Path(log_dir)
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / LOG_NAME
    file_handler = RotatingFileHandler(
        log_file,
        maxBytes=max_bytes,
        backupCount=backup_count,
        encoding="utf-8",
        delay=True,
    )
    file_handler.setFormatter(formatter)
    file_handler.addFilter(trace_filter)
    root.addHandler(file_handler)
    return log_file


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)
