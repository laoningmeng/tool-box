"""内置 Python 后端（标准库实现，无第三方依赖）。

职责：
- 提供健康检查 / 状态
- 作为 ComfyUI 的代理：状态、提交任务、轮询历史、取回输出、上传图片
- 任务进度通过内存任务表暴露给 Electron 轮询

启动参数：
  --port 随机端口
  --token 每次启动生成的访问令牌（请求头 X-App-Token）
  --data-dir 可写数据目录
  --comfy-url ComfyUI 地址
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import queue
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional


# --------------------------------------------------------------------------- #
# 配置与全局
# --------------------------------------------------------------------------- #


@dataclass
class Config:
    port: int
    token: str
    data_dir: Path
    comfy_url: str
    app_version: str = "0.0.0"
    started_at: float = field(default_factory=time.time)


CFG: Optional[Config] = None
COMFY_JOBS: Dict[str, Dict[str, Any]] = {}
LOCK = threading.Lock()


def human_size(size: int) -> str:
    value = float(size)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            return f"{value:.1f} {unit}"
        value /= 1024
    return f"{value:.1f} GB"


# --------------------------------------------------------------------------- #
# ComfyUI 客户端
# --------------------------------------------------------------------------- #


class ComfyError(RuntimeError):
    pass


class ComfyClient:
    def __init__(self, base_url: str) -> None:
        self.base_url = (base_url or "http://127.0.0.1:8188").rstrip("/")

    def _request(
        self, path: str, method: str = "GET", body: Any = None, timeout: int = 30, query: str = ""
    ) -> Any:
        url = f"{self.base_url}{path}{query}"
        data = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {"Content-Type": "application/json"} if data else {}
        request = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                payload = response.read()
                if "application/json" in (response.headers.get("Content-Type") or ""):
                    return json.loads(payload.decode("utf-8")) if payload else {}
                return payload
        except urllib.error.URLError as error:
            raise ComfyError(
                f"无法连接 ComfyUI（{self.base_url}）：{error.reason}。请先启动 ComfyUI"
            ) from error

    def status(self) -> Dict[str, Any]:
        result = {
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
            stats = self._request("/system_stats", timeout=6)
            devices = (stats or {}).get("devices") or []
            first = devices[0] if devices else {}
            total = first.get("vram_total") or 0
            result.update(
                {
                    "connected": True,
                    "version": str(((stats or {}).get("system") or {}).get("comfyui_version") or ""),
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

    def submit(self, graph: Dict[str, Any]) -> str:
        response = self._request(
            "/prompt", method="POST", body={"prompt": graph, "client_id": uuid.uuid4().hex}, timeout=60
        )
        prompt_id = (response or {}).get("prompt_id")
        if not prompt_id:
            raise ComfyError(f"ComfyUI 未返回 prompt_id：{str(response)[:200]}")
        return str(prompt_id)

    def history(self, prompt_id: str) -> Dict[str, Any]:
        data = self._request(f"/history/{prompt_id}", timeout=20)
        return (data or {}).get(prompt_id) or {}

    def view(self, filename: str, subfolder: str = "", type_: str = "output") -> bytes:
        query = (
            f"?filename={urllib.parse.quote(filename)}"
            f"&subfolder={urllib.parse.quote(subfolder)}&type={urllib.parse.quote(type_)}"
        )
        payload = self._request("/view", timeout=120, query=query)
        return payload if isinstance(payload, bytes) else b""

    def upload_image(self, file_path: str) -> str:
        path = Path(file_path)
        if not path.is_file():
            raise ComfyError(f"图片不存在：{file_path}")
        boundary = f"----app{uuid.uuid4().hex}"
        mime = mimetypes.guess_type(path.name)[0] or "image/png"
        body = b"".join(
            [
                f"--{boundary}\r\n".encode(),
                f'Content-Disposition: form-data; name="image"; filename="{path.name}"\r\n'.encode(),
                f"Content-Type: {mime}\r\n\r\n".encode(),
                path.read_bytes(),
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
        return str(payload.get("name") or path.name)


def comfy_client() -> ComfyClient:
    return ComfyClient(CFG.comfy_url if CFG else "http://127.0.0.1:8188")


# --------------------------------------------------------------------------- #
# 任务
# --------------------------------------------------------------------------- #


def public_job(job: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": job["id"],
        "workflowId": job["workflowId"],
        "workflowName": job.get("workflowName", ""),
        "category": job.get("category", "t2i"),
        "status": job["status"],
        "progress": round(job.get("progress", 0.0), 3),
        "message": job.get("message", ""),
        "logs": job.get("logs", [])[-80:],
        "outputs": job.get("outputs", []),
        "startedAt": job["startedAt"],
        "finishedAt": job.get("finishedAt"),
        "elapsed": round((job.get("finishedAt") or time.time()) - job["startedAt"], 1),
    }


def job_run(job: Dict[str, Any], graph: Dict[str, Any]) -> None:
    client = comfy_client()
    try:
        job["message"] = "正在提交到 ComfyUI…"
        prompt_id = client.submit(graph)
        job["promptId"] = prompt_id
        job["message"] = "已提交，等待执行…"
        deadline = time.time() + 1800
        while time.time() < deadline:
            if job.get("canceled"):
                job["status"] = "canceled"
                job["message"] = "已取消"
                job["finishedAt"] = time.time()
                return
            entry = client.history(prompt_id)
            if entry:
                status_str = (entry.get("status") or {}).get("status_str")
                if status_str == "error":
                    job["status"] = "failed"
                    job["message"] = "ComfyUI 执行失败，请查看日志"
                    job["finishedAt"] = time.time()
                    return
                outputs: List[Dict[str, Any]] = []
                for node_output in (entry.get("outputs") or {}).values():
                    for key in ("images", "gifs", "videos"):
                        for item in node_output.get(key) or []:
                            name = item.get("filename")
                            if not name:
                                continue
                            outputs.append(
                                {
                                    "filename": name,
                                    "type": "video" if str(name).lower().endswith((".webp", ".mp4", ".webm", ".gif")) else "image",
                                    "subfolder": item.get("subfolder") or "",
                                    "bytes": 0,
                                }
                            )
                if outputs:
                    job["outputs"] = outputs
                    job["status"] = "success"
                    job["progress"] = 1.0
                    job["message"] = f"生成完成，共 {len(outputs)} 个结果"
                    job["finishedAt"] = time.time()
                    return
            elapsed = time.time() - job["startedAt"]
            job["progress"] = min(0.92, 0.12 + elapsed / 90.0)
            job["message"] = "正在生成…"
            time.sleep(1.5)
        job["status"] = "failed"
        job["message"] = "生成超时（30 分钟）"
        job["finishedAt"] = time.time()
    except Exception as error:  # noqa: BLE001
        job["status"] = "failed"
        job["message"] = str(error)
        job["logs"].append(traceback.format_exc())
        job["finishedAt"] = time.time()


# --------------------------------------------------------------------------- #
# HTTP 服务
# --------------------------------------------------------------------------- #


class Handler(BaseHTTPRequestHandler):
    server_version = "AppBackend/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        sys.stderr.write("[backend] " + (fmt % args) + "\n")

    # ------------------------------------------------------------------ 工具函数

    def _send(self, payload: Dict[str, Any], status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status: int, message: str) -> None:
        self._send({"ok": False, "error": message}, status)

    def _authorized(self) -> bool:
        return bool(CFG) and self.headers.get("X-App-Token") == CFG.token

    def _body(self) -> Dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception:  # noqa: BLE001
            return {}

    # ------------------------------------------------------------------ GET

    def do_GET(self) -> None:  # noqa: N802
        if not self._authorized():
            return self._error(401, "未授权")
        if CFG is None:
            return self._error(503, "后端未初始化")

        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        try:
            if path == "/api/health":
                return self._send({"ok": True, "item": {"ready": True}})
            if path == "/api/status":
                return self._send(
                    {
                        "ok": True,
                        "item": {
                            "version": sys.version.split()[0],
                            "appVersion": CFG.app_version,
                            "uptime": round(time.time() - CFG.started_at, 1),
                            "comfyUrl": CFG.comfy_url,
                        },
                    }
                )
            if path == "/api/comfy/status":
                return self._send({"ok": True, "item": comfy_client().status()})
            if path == "/api/comfy/jobs":
                with LOCK:
                    items = [public_job(job) for job in COMFY_JOBS.values()]
                items.sort(key=lambda row: row["startedAt"], reverse=True)
                return self._send({"ok": True, "items": items[:30]})
            if path.startswith("/api/comfy/jobs/"):
                job_id = path[len("/api/comfy/jobs/") :].strip("/")
                with LOCK:
                    job = COMFY_JOBS.get(job_id)
                if not job:
                    return self._error(404, "任务不存在")
                return self._send({"ok": True, "item": public_job(job)})
            if path == "/api/comfy/output":
                query = urllib.parse.parse_qs(parsed.query)
                filename = query.get("filename", [""])[0]
                subfolder = query.get("subfolder", [""])[0]
                if not filename:
                    return self._error(400, "缺少 filename")
                data = comfy_client().view(filename, subfolder)
                mime = mimetypes.guess_type(filename)[0] or "application/octet-stream"
                self.send_response(200)
                self.send_header("Content-Type", mime)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return None
            return self._error(404, "未知接口")
        except ComfyError as error:
            return self._error(502, str(error))
        except Exception as error:  # noqa: BLE001
            return self._error(500, str(error))

    # ------------------------------------------------------------------ POST

    def do_POST(self) -> None:  # noqa: N802
        if not self._authorized():
            return self._error(401, "未授权")
        if CFG is None:
            return self._error(503, "后端未初始化")

        path = urllib.parse.urlparse(self.path).path
        body = self._body()
        try:
            if path == "/api/comfy/run":
                graph = body.get("graph") or {}
                if not graph:
                    return self._error(400, "缺少 workflow graph")
                status = comfy_client().status()
                if not status.get("connected"):
                    return self._error(503, status.get("error") or "ComfyUI 未连接")
                job = {
                    "id": uuid.uuid4().hex[:12],
                    "workflowId": str(body.get("workflowId") or ""),
                    "workflowName": str(body.get("workflowName") or ""),
                    "category": str(body.get("category") or "t2i"),
                    "status": "running",
                    "progress": 0.05,
                    "message": "准备提交…",
                    "logs": [],
                    "outputs": [],
                    "startedAt": time.time(),
                    "finishedAt": None,
                }
                with LOCK:
                    COMFY_JOBS[job["id"]] = job
                threading.Thread(target=job_run, args=(job, graph), daemon=True).start()
                return self._send({"ok": True, "item": {"jobId": job["id"]}})
            if path.startswith("/api/comfy/jobs/") and path.endswith("/cancel"):
                job_id = path[len("/api/comfy/jobs/") : -len("/cancel")].strip("/")
                with LOCK:
                    job = COMFY_JOBS.get(job_id)
                if not job:
                    return self._error(404, "任务不存在")
                job["canceled"] = True
                return self._send({"ok": True})
            if path == "/api/comfy/upload":
                file_path = str(body.get("path") or "")
                if not file_path or not os.path.isfile(file_path):
                    return self._error(400, "图片文件不存在")
                name = comfy_client().upload_image(file_path)
                return self._send({"ok": True, "item": {"name": name}})
            return self._error(404, "未知接口")
        except ComfyError as error:
            return self._error(502, str(error))
        except Exception as error:  # noqa: BLE001
            return self._error(500, str(error))


def main() -> None:
    global CFG
    parser = argparse.ArgumentParser(description="应用本地后端")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--token", required=True)
    parser.add_argument("--data-dir", default="")
    parser.add_argument("--comfy-url", default="http://127.0.0.1:8188")
    parser.add_argument("--app-version", default="0.0.0")
    args = parser.parse_args()

    data_dir = Path(args.data_dir).resolve() if args.data_dir else Path(__file__).resolve().parent.parent / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    CFG = Config(
        port=args.port,
        token=args.token,
        data_dir=data_dir,
        comfy_url=args.comfy_url.rstrip("/"),
        app_version=args.app_version,
    )

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"[backend] listening on 127.0.0.1:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
