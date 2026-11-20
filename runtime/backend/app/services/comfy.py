"""ComfyUI 适配层。

只用标准库 urllib，避免为一次代理再引入 HTTP 客户端依赖；
所有失败都包成 ``ComfyError``，由路由层转成 502 + 可读文案。
"""

from __future__ import annotations

import json
import mimetypes
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any

from app.core.config import get_settings


class ComfyError(RuntimeError):
    """ComfyUI 不可达 / 返回异常。"""


class ComfyClient:
    def __init__(self, base_url: str | None = None) -> None:
        settings = get_settings()
        self.base_url = (base_url or settings.comfy_url or "http://127.0.0.1:8188").rstrip("/")

    # ------------------------------------------------------------------ 基础请求

    def _request(
        self,
        path: str,
        method: str = "GET",
        body: Any = None,
        timeout: int = 30,
        query: str = "",
    ) -> Any:
        url = f"{self.base_url}{path}{query}"
        data = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {"Content-Type": "application/json"} if data else {}
        request = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                payload = response.read()
                content_type = response.headers.get("Content-Type") or ""
                if "application/json" in content_type:
                    return json.loads(payload.decode("utf-8")) if payload else {}
                return payload
        except urllib.error.URLError as error:
            reason = str(error.reason).rstrip("。.")
            raise ComfyError(
                f"无法连接 ComfyUI（{self.base_url}）：{reason}。请先启动 ComfyUI"
            ) from error

    # ------------------------------------------------------------------ 业务能力

    def status(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "connected": False,
            "url": self.base_url,
            "version": "",
            "device": "",
            "vram": "",
            "queueRunning": 0,
            "queuePending": 0,
            "error": "",
        }
        try:
            stats = self._request("/system_stats", timeout=6) or {}
            devices = stats.get("devices") or []
            first = devices[0] if devices else {}
            total = first.get("vram_total") or 0
            result.update(
                {
                    "connected": True,
                    "version": str((stats.get("system") or {}).get("comfyui_version") or ""),
                    "device": str(first.get("name") or ""),
                    "vram": f"{round(total / 1024 / 1024 / 1024, 1)} GB" if total else "",
                }
            )
            queue = self._request("/queue", timeout=6) or {}
            result["queueRunning"] = len(queue.get("queue_running") or [])
            result["queuePending"] = len(queue.get("queue_pending") or [])
        except ComfyError as error:
            result["error"] = str(error)
        return result

    def submit(self, graph: dict[str, Any]) -> str:
        response = self._request(
            "/prompt",
            method="POST",
            body={"prompt": graph, "client_id": uuid.uuid4().hex},
            timeout=60,
        )
        prompt_id = (response or {}).get("prompt_id")
        if not prompt_id:
            raise ComfyError(f"ComfyUI 未返回 prompt_id：{str(response)[:200]}")
        return str(prompt_id)

    def history(self, prompt_id: str) -> dict[str, Any]:
        data = self._request(f"/history/{prompt_id}", timeout=20)
        return (data or {}).get(prompt_id) or {}

    def view(self, filename: str, subfolder: str = "", type_: str = "output") -> bytes:
        query = (
            f"?filename={urllib.parse.quote(filename)}"
            f"&subfolder={urllib.parse.quote(subfolder)}&type={urllib.parse.quote(type_)}"
        )
        payload = self._request("/view", timeout=120, query=query)
        return payload if isinstance(payload, bytes) else b""

    def upload_bytes(self, data: bytes, filename: str) -> str:
        """把内存里的图片字节上传到 ComfyUI 的 input 目录（返回服务器文件名）。"""
        name = Path(filename).name or "image.png"
        boundary = f"----app{uuid.uuid4().hex}"
        mime = mimetypes.guess_type(name)[0] or "image/png"
        body = b"".join(
            [
                f"--{boundary}\r\n".encode(),
                f'Content-Disposition: form-data; name="image"; filename="{name}"\r\n'.encode(),
                f"Content-Type: {mime}\r\n\r\n".encode(),
                data,
                f"\r\n--{boundary}\r\n".encode(),
                b'Content-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n',
                f"--{boundary}--\r\n".encode(),
            ]
        )
        request = urllib.request.Request(
            f"{self.base_url}/upload/image",
            data=body,
            method="POST",
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        )
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.URLError as error:
            raise ComfyError(f"上传图片失败：{error}") from error
        return str(payload.get("name") or name)

    def upload_image(self, file_path: str) -> str:
        path = Path(file_path)
        if not path.is_file():
            raise ComfyError(f"图片不存在：{file_path}")
        return self.upload_bytes(path.read_bytes(), path.name)


def comfy_client() -> ComfyClient:
    return ComfyClient()
