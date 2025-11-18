from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse
import uvicorn
import litellm
import logging
import json
from typing import Any, AsyncIterator

logging.basicConfig(level=logging.INFO)
app = FastAPI(title="LiteLLM Server", version="0.1.0")


def _event_name(e: Any) -> str | None:
    # Attempt to infer event name from common attributes
    for attr in ("type", "event", "event_type"):
        if hasattr(e, attr):
            value = getattr(e, attr)
            if isinstance(value, str):
                return value
    return None


def _event_payload(e: Any) -> str:
    # Pydantic v2
    if hasattr(e, "model_dump_json"):
        try:
            return e.model_dump_json()
        except Exception:
            pass
    # Pydantic v1
    if hasattr(e, "json"):
        try:
            return e.json()
        except Exception:
            pass
    if isinstance(e, (dict, list)):
        return json.dumps(e, ensure_ascii=False)
    if isinstance(e, bytes):
        return e.decode("utf-8", errors="replace")
    return str(e)


async def _responses_sse_stream(gen: AsyncIterator[Any]) -> AsyncIterator[bytes]:
    async for e in gen:
        name = _event_name(e)
        data = _event_payload(e)
        if name:
            yield f"event: {name}\n".encode("utf-8")
        yield f"data: {data}\n\n".encode("utf-8")


@app.get("/")
async def root():
    """Root endpoint"""
    return {"message": "LiteLLM FastAPI Server is running!"}


@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {"status": "healthy", "service": "litellm"}


@app.post("/v1/messages")
async def anthropic_messages(request: Request):
    """Chat completions endpoint that passes through to LiteLLM"""
    request_data = await request.json()
    if "stream" in request_data and request_data["stream"]:
        response = await litellm.anthropic.messages.acreate(**request_data)
        return StreamingResponse(response)
    return await litellm.anthropic.messages.acreate(**request_data)


@app.post("/responses")
async def responses(request: Request):
    """Responses endpoint that passes through to LiteLLM"""
    request_data = await request.json()
    if (
        "model_reasoning_effort" not in request_data
        or "model_reasoning_effort" == "none"
    ):
        request_data["model_reasoning_effort"] = "high"

    if request_data.get("stream"):
        gen = await litellm.aresponses(**request_data)
        return StreamingResponse(
            _responses_sse_stream(gen),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            },
        )
    return await litellm.aresponses(**request_data)


@app.post("/chat/completions")
async def chat_completions(request: Request):
    """Chat completions endpoint that passes through to LiteLLM"""
    request_data = await request.json()
    if "stream" in request_data and request_data["stream"]:
        response = await litellm.acompletion(**request_data)
        return StreamingResponse(response)
    return await litellm.acompletion(**request_data)


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000)
