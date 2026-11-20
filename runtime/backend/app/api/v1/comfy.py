"""ComfyUI 代理接口（沿用 Electron 主进程既有的路径与响应结构）。

任务执行沿用「内存任务表 + 后台线程」的模型：
ComfyUI 的 HTTP 轮询本身是阻塞的，这里不占用 FastAPI 的事件循环。
多进程 / 需要持久化时，把任务表换成数据库 + 外部队列即可，接口不变。
"""

from __future__ import annotations

import base64
import io
import os
import re
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Query
from fastapi.responses import Response

from app.core.errors import BadRequestError, NotFoundError, ServiceUnavailableError, UpstreamError
from app.core.logging import get_logger
from app.core.responses import ok, ok_list
from app.services.comfy import ComfyClient, ComfyError, comfy_client

router = APIRouter(prefix="/comfy", tags=["ComfyUI"])
logger = get_logger("app.comfy")

_LOCK = threading.Lock()
_JOBS: dict[str, dict[str, Any]] = {}

_PROGRESS_POLL_SECONDS = 1.5
_JOB_TIMEOUT_SECONDS = 30 * 60


def _public_job(job: dict[str, Any]) -> dict[str, Any]:
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


def _collect_outputs(entry: dict[str, Any]) -> list[dict[str, Any]]:
    outputs: list[dict[str, Any]] = []
    for node_output in (entry.get("outputs") or {}).values():
        # 角色拆分（JZL_SeeThrough）把图层放在 compositor_layers，名称在 compositor_bboxes
        labels = [
            str(box.get("name") or "")
            for box in (node_output.get("compositor_bboxes") or [])
            if isinstance(box, dict)
        ]
        for key in ("images", "gifs", "videos", "audio", "compositor_layers"):
            items = node_output.get(key) or []
            for index, item in enumerate(items):
                if not isinstance(item, dict):
                    continue
                name = item.get("filename")
                if not name:
                    continue
                lower = str(name).lower()
                output: dict[str, Any] = {
                    "filename": name,
                    "storage": str(item.get("type") or "output"),
                    "key": key,
                    "type": (
                        "video"
                        if lower.endswith((".webp", ".mp4", ".webm", ".gif", ".mov"))
                        else "audio"
                        if lower.endswith((".mp3", ".wav", ".flac", ".ogg", ".m4a", ".opus"))
                        else "file"
                        if lower.endswith((".psd", ".json", ".txt", ".zip"))
                        else "image"
                    ),
                    "subfolder": item.get("subfolder") or "",
                    "bytes": 0,
                }
                if key == "compositor_layers" and index < len(labels) and labels[index]:
                    output["label"] = labels[index]
                outputs.append(output)
    return outputs


def _job_run(job: dict[str, Any], graph: dict[str, Any]) -> None:
    client = ComfyClient()
    try:
        job["message"] = "正在提交到 ComfyUI…"
        prompt_id = client.submit(graph)
        job["promptId"] = prompt_id
        job["message"] = "已提交，等待执行…"
        deadline = time.time() + _JOB_TIMEOUT_SECONDS

        while time.time() < deadline:
            if job.get("canceled"):
                job.update(status="canceled", message="已取消", finishedAt=time.time())
                return

            entry = client.history(prompt_id)
            if entry:
                if (entry.get("status") or {}).get("status_str") == "error":
                    job.update(status="failed", message="ComfyUI 执行失败，请查看日志", finishedAt=time.time())
                    return
                outputs = _collect_outputs(entry)
                if outputs:
                    job.update(
                        status="success",
                        progress=1.0,
                        message=f"生成完成，共 {len(outputs)} 个结果",
                        outputs=outputs,
                        finishedAt=time.time(),
                    )
                    return

            elapsed = time.time() - job["startedAt"]
            job["progress"] = min(0.92, 0.12 + elapsed / 90.0)
            job["message"] = "正在生成…"
            time.sleep(_PROGRESS_POLL_SECONDS)

        job.update(status="failed", message="生成超时（30 分钟）", finishedAt=time.time())
    except Exception as error:  # noqa: BLE001 - 任务线程不能把异常抛给主循环
        import traceback

        job.update(status="failed", message=str(error), finishedAt=time.time())
        job.setdefault("logs", []).append(traceback.format_exc())
        logger.exception("ComfyUI 任务失败 id=%s", job.get("id"))


@router.get("/status", summary="ComfyUI 连接状态")
def comfy_status() -> dict[str, Any]:
    return ok(comfy_client().status())


@router.get("/jobs", summary="任务列表")
def list_jobs() -> dict[str, Any]:
    with _LOCK:
        items = [_public_job(job) for job in _JOBS.values()]
    items.sort(key=lambda row: row["startedAt"], reverse=True)
    return ok_list(items[:30])


@router.get("/jobs/{job_id}", summary="任务详情")
def get_job(job_id: str) -> dict[str, Any]:
    with _LOCK:
        job = _JOBS.get(job_id)
    if job is None:
        raise NotFoundError("任务不存在")
    return ok(_public_job(job))


@router.post("/run", summary="提交工作流")
def run_job(payload: dict[str, Any]) -> dict[str, Any]:
    graph = payload.get("graph") or {}
    if not graph:
        raise BadRequestError("缺少 workflow graph")

    status = comfy_client().status()
    if not status.get("connected"):
        raise ServiceUnavailableError(status.get("error") or "ComfyUI 未连接")

    job: dict[str, Any] = {
        "id": uuid.uuid4().hex[:12],
        "workflowId": str(payload.get("workflowId") or ""),
        "workflowName": str(payload.get("workflowName") or ""),
        "category": str(payload.get("category") or "t2i"),
        "status": "running",
        "progress": 0.05,
        "message": "准备提交…",
        "logs": [],
        "outputs": [],
        "startedAt": time.time(),
        "finishedAt": None,
    }
    with _LOCK:
        _JOBS[job["id"]] = job
    threading.Thread(target=_job_run, args=(job, graph), daemon=True, name=f"comfy:{job['id']}").start()
    logger.info("ComfyUI 任务已提交 id=%s workflow=%s", job["id"], job["workflowId"])
    return ok({"jobId": job["id"]})


@router.post("/jobs/{job_id}/cancel", summary="取消任务")
def cancel_job(job_id: str) -> dict[str, Any]:
    with _LOCK:
        job = _JOBS.get(job_id)
    if job is None:
        raise NotFoundError("任务不存在")
    job["canceled"] = True
    return ok({"id": job_id, "canceled": True})


@router.get("/output", summary="取回生成结果")
def get_output(
    filename: str = Query(..., description="ComfyUI 返回的文件名"),
    subfolder: str = Query(default=""),
    type: str = Query(default="output"),
) -> Response:
    import mimetypes

    try:
        data = comfy_client().view(filename, subfolder, type)
    except ComfyError as error:
        raise UpstreamError(str(error)) from error
    mime = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    return Response(content=data, media_type=mime)



@router.get("/history", summary="ComfyUI 历史输出（媒体库同步用）")
def comfy_history(max_items: int = Query(200, ge=1, le=1000)) -> dict[str, Any]:
    client = comfy_client()
    try:
        raw = client._request(f"/history?max_items={max_items}", timeout=30) or {}
    except ComfyError as error:
        raise UpstreamError(str(error)) from error
    items: list[dict[str, Any]] = []
    for prompt_id, entry in (raw or {}).items():
        if not isinstance(entry, dict):
            continue
        status = entry.get("status") or {}
        if status.get("status_str") == "error":
            continue
        outputs = _collect_outputs(entry)
        if not outputs:
            continue
        finished_at = None
        for message in status.get("messages") or []:
            if isinstance(message, (list, tuple)) and len(message) == 2 and message[0] == "execution_success":
                payload = message[1] or {}
                stamp = payload.get("timestamp")
                if isinstance(stamp, (int, float)):
                    finished_at = float(stamp)
        items.append({"promptId": prompt_id, "finishedAt": finished_at, "outputs": outputs})
    items.sort(key=lambda row: row.get("finishedAt") or 0, reverse=True)
    return ok_list(items)

_OUTPUT_DIR_CACHE: dict[str, str | None] = {}


def _detect_output_dir() -> str | None:
    """尽量找到 ComfyUI 的输出目录：环境变量 → 进程命令行 → 常见路径。"""
    if "dir" in _OUTPUT_DIR_CACHE:
        return _OUTPUT_DIR_CACHE["dir"]
    candidates: list[str] = []
    env_dir = os.environ.get("COMFY_OUTPUT_DIR", "").strip()
    if env_dir:
        candidates.append(env_dir)
    try:
        import subprocess  # noqa: PLC0415 - 只在本机探测时用

        result = subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-Command",
                "(Get-CimInstance Win32_Process -Filter \"Name like 'python%'\" | "
                "Select-Object -ExpandProperty CommandLine) -join [Environment]::NewLine",
            ],
            capture_output=True,
            text=True,
            timeout=8,
            check=False,
        )
        for line in (result.stdout or "").splitlines():
            match = re.search(r"--output-directory\s+\"?([^\"\s]+)", line)
            if match:
                candidates.append(match.group(1))
    except Exception:  # noqa: BLE001 - 探测失败就走常见路径
        pass
    if os.name == "nt":
        candidates += [
            os.path.expanduser("~\\ComfyUI\\output"),
            "D:\\workspace\\comfyui_output",
            "D:\\ComfyUI\\output",
            "C:\\ComfyUI\\output",
        ]
    for candidate in candidates:
        try:
            if candidate and os.path.isdir(candidate):
                _OUTPUT_DIR_CACHE["dir"] = candidate
                return candidate
        except OSError:
            continue
    _OUTPUT_DIR_CACHE["dir"] = None
    return None


_PSD_CACHE: dict[tuple[str, float, int], dict[str, Any]] = {}


def _resolve_output_path(filename: str, subfolder: str) -> "Path | None":
    """把 output 目录里的相对路径解析成绝对路径（防目录穿越）。"""
    base = _detect_output_dir()
    if not base or not filename:
        return None
    root_dir = Path(base).resolve()
    target = (root_dir / subfolder / filename).resolve() if subfolder else (root_dir / filename).resolve()
    try:
        target.relative_to(root_dir)
    except ValueError:
        return None
    return target if target.is_file() else None


def _psd_module():
    try:
        from psd_tools import PSDImage  # noqa: PLC0415 - 依赖可选，按需导入
    except ImportError as error:
        raise ServiceUnavailableError("缺少 psd-tools 依赖，请运行 npm run setup:backend 或 pip install psd-tools") from error
    return PSDImage


def _layer_thumbnail(layer: Any, size: int) -> tuple[str | None, float]:
    """返回（缩略图 dataURL, 非透明像素占比）。"""
    image = layer.topil()
    if image is None:
        return (None, 0.0)
    image = image.convert("RGBA")
    alpha = image.getchannel("A")
    # 估算覆盖率：直方图里 alpha>0 的像素比例
    histogram = alpha.histogram()
    total = max(1, sum(histogram))
    opaque = total - histogram[0]
    coverage = round(opaque / total, 5)
    preview = image.copy()
    preview.thumbnail((size, size))
    buffer = io.BytesIO()
    preview.save(buffer, format="PNG")
    return ("data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode(), coverage)


@router.get("/psd-layers", summary="解析 PSD 的图层清单 + 缩略图")
def psd_layers(filename: str, subfolder: str = "", thumb: int = 160) -> dict[str, Any]:
    path = _resolve_output_path(filename, subfolder)
    if path is None:
        raise NotFoundError("PSD 文件不存在")
    PSDImage = _psd_module()
    size = max(48, min(int(thumb or 160), 512))
    key = (str(path), path.stat().st_mtime, size)
    cached = _PSD_CACHE.get(key)
    if cached:
        return ok(cached)
    try:
        psd = PSDImage.open(str(path))
    except Exception as error:  # noqa: BLE001 - 损坏文件按解析失败处理
        raise UpstreamError(f"解析 PSD 失败：{error}") from error
    layers: list[dict[str, Any]] = []
    for index, layer in enumerate(psd.descendants()):
        entry: dict[str, Any] = {
            "index": index,
            "name": str(layer.name or f"图层 {index + 1}"),
            "kind": str(layer.kind),
            "visible": bool(layer.visible),
            "left": int(layer.left),
            "top": int(layer.top),
            "width": int(layer.width),
            "height": int(layer.height),
            "thumb": None,
            "coverage": 0.0,
        }
        try:
            thumb, coverage = _layer_thumbnail(layer, size)
            entry["thumb"] = thumb
            entry["coverage"] = coverage
        except Exception:  # noqa: BLE001 - 单层渲染失败不影响其它层
            entry["thumb"] = None
        layers.append(entry)
    result = {"width": int(psd.width), "height": int(psd.height), "layers": layers}
    _PSD_CACHE[key] = result
    if len(_PSD_CACHE) > 20:
        for stale in list(_PSD_CACHE)[: len(_PSD_CACHE) - 20]:
            _PSD_CACHE.pop(stale, None)
    return ok(result)


@router.get("/psd-layer-image", summary="PSD 单个图层的完整图片")
def psd_layer_image(filename: str, subfolder: str = "", index: int = 0, max_size: int = 2048) -> dict[str, Any]:
    path = _resolve_output_path(filename, subfolder)
    if path is None:
        raise NotFoundError("PSD 文件不存在")
    PSDImage = _psd_module()
    try:
        psd = PSDImage.open(str(path))
        layers = list(psd.descendants())
    except Exception as error:  # noqa: BLE001
        raise UpstreamError(f"解析 PSD 失败：{error}") from error
    if index < 0 or index >= len(layers):
        raise BadRequestError("图层序号超出范围")
    layer = layers[index]
    image = layer.topil()
    if image is None:
        raise UpstreamError("这个图层没有可渲染的像素")
    image = image.convert("RGBA")
    limit = max(256, min(int(max_size or 2048), 4096))
    if max(image.size) > limit:
        image.thumbnail((limit, limit))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return ok(
        {
            "name": str(layer.name or f"图层 {index + 1}"),
            "width": image.width,
            "height": image.height,
            "dataUrl": "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode(),
        }
    )


@router.get("/output-files", summary="列出 ComfyUI 输出目录里的文件（角色拆分产出的 PSD 等）")
def output_files(ext: str = "psd", since: float | None = None, limit: int = 30) -> dict[str, Any]:
    directory = _detect_output_dir()
    if not directory:
        return ok({"dir": "", "files": [], "reason": "没找到 ComfyUI 输出目录"})
    suffix = "." + ext.lstrip(".").lower()
    files: list[dict[str, Any]] = []
    try:
        entries = list(os.scandir(directory))
    except OSError as error:
        return ok({"dir": directory, "files": [], "reason": str(error)})
    # 角色拆分的 PSD 落在子目录（如 «图像分层»），这里向下扫两层
    scanned: list[tuple[str, str]] = []
    for item in entries:
        try:
            if item.is_file():
                scanned.append(("", item.name))
                continue
            if not item.is_dir():
                continue
            for child in os.scandir(item.path):
                if child.is_file():
                    scanned.append((item.name, child.name))
        except OSError:
            continue
    for subfolder, name in scanned:
        if not name.lower().endswith(suffix):
            continue
        full = os.path.join(directory, subfolder, name) if subfolder else os.path.join(directory, name)
        try:
            stat = os.stat(full)
        except OSError:
            continue
        if since and stat.st_mtime < since - 5:
            continue
        files.append(
            {
                "filename": name,
                "subfolder": subfolder,
                "bytes": stat.st_size,
                "mtime": stat.st_mtime,
            }
        )
    files.sort(key=lambda row: row["mtime"], reverse=True)
    return ok({"dir": directory, "files": files[: max(1, min(limit, 100))]})


@router.post("/upload-output", summary="把输出目录里的文件复制到 input（从媒体库选参考图）")
def upload_output(payload: dict[str, Any]) -> dict[str, Any]:
    filename = str(payload.get("filename") or "").strip()
    subfolder = str(payload.get("subfolder") or "").strip()
    if not filename:
        raise BadRequestError("缺少文件名")
    try:
        data = comfy_client().view(filename, subfolder, "output")
    except ComfyError as error:
        raise UpstreamError(str(error)) from error
    if not data:
        raise UpstreamError("读取输出文件失败")
    try:
        name = comfy_client().upload_bytes(data, filename)
    except ComfyError as error:
        raise UpstreamError(str(error)) from error
    return ok({"name": name})
@router.post("/upload", summary="上传参考图")
def upload_image(payload: dict[str, Any]) -> dict[str, Any]:
    import os

    file_path = str(payload.get("path") or "")
    if not file_path or not os.path.isfile(file_path):
        raise BadRequestError("图片文件不存在")
    try:
        name = comfy_client().upload_image(file_path)
    except ComfyError as error:
        raise UpstreamError(str(error)) from error
    return ok({"name": name})
