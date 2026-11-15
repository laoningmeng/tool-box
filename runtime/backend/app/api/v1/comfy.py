"""ComfyUI 代理接口（沿用 Electron 主进程既有的路径与响应结构）。

任务执行沿用「内存任务表 + 后台线程」的模型：
ComfyUI 的 HTTP 轮询本身是阻塞的，这里不占用 FastAPI 的事件循环。
多进程 / 需要持久化时，把任务表换成数据库 + 外部队列即可，接口不变。
"""

from __future__ import annotations

import threading
import time
import uuid
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
        for key in ("images", "gifs", "videos"):
            for item in node_output.get(key) or []:
                name = item.get("filename")
                if not name:
                    continue
                lower = str(name).lower()
                outputs.append(
                    {
                        "filename": name,
                        "type": "video" if lower.endswith((".webp", ".mp4", ".webm", ".gif")) else "image",
                        "subfolder": item.get("subfolder") or "",
                        "bytes": 0,
                    }
                )
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
