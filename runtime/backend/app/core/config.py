"""应用配置。

来源优先级：命令行参数（server.py 写进环境变量） > 环境变量 > 默认值。
所有环境变量统一带 ``APP_`` 前缀，例如 ``APP_PORT`` / ``APP_DB_URL``。
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_ROOT = Path(__file__).resolve().parent.parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="APP_", env_file=".env", extra="ignore")

    # ---- 基础 ----
    app_name: str = "本地后端"
    app_version: str = "0.0.0"
    host: str = "127.0.0.1"
    port: int = 0
    # 每次启动由主进程随机生成，所有 /api 请求都要带 X-App-Token
    token: str = ""
    data_dir: Path = BACKEND_ROOT / "data"

    # ---- 外部服务 ----
    comfy_url: str = "http://127.0.0.1:8188"

    # ---- 日志 ----
    log_level: str = "INFO"
    log_format: str = "text"  # text | json
    log_dir: str = ""  # 空 = <data_dir>/logs
    log_max_bytes: int = 5 * 1024 * 1024
    log_backup_count: int = 3

    # ---- 数据库 ----
    db_url: str = ""  # 空 = sqlite:///<data_dir>/app.db
    db_echo: bool = False

    # ---- 任务 ----
    task_max_concurrency: int = 2
    task_retention_days: int = 7

    # ---------------------------------------------------------------- 派生值

    @property
    def resolved_data_dir(self) -> Path:
        return Path(self.data_dir).expanduser().resolve()

    @property
    def resolved_log_dir(self) -> Path:
        return Path(self.log_dir).expanduser().resolve() if self.log_dir else self.resolved_data_dir / "logs"

    @property
    def resolved_db_url(self) -> str:
        if self.db_url:
            return self.db_url
        db_file = self.resolved_data_dir / "app.db"
        return f"sqlite:///{db_file.as_posix()}"

    def ensure_dirs(self) -> None:
        self.resolved_data_dir.mkdir(parents=True, exist_ok=True)
        self.resolved_log_dir.mkdir(parents=True, exist_ok=True)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """进程内单例；测试里可 ``get_settings.cache_clear()`` 后重建。"""
    return Settings()
