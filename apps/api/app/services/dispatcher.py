"""P6 - Frontend Dispatcher.

A tiny in-process pub/sub that fans transcript + hint events out to all
subscribed Next.js dashboards listening on `/api/live-feed/{session_id}`.

This intentionally lives in-process (single FastAPI instance). When the API
is horizontally scaled, swap the `_subscribers` dict for Redis pub/sub or NATS
and keep the public API identical.
"""

from __future__ import annotations

import asyncio
import uuid
from collections import defaultdict
from typing import Any

import structlog

log = structlog.get_logger(__name__)


class FrontendDispatcher:
    def __init__(self) -> None:
        self._subscribers: dict[uuid.UUID, set[asyncio.Queue[dict[str, Any]]]] = defaultdict(set)
        self._lock = asyncio.Lock()

    async def subscribe(self, session_id: uuid.UUID) -> asyncio.Queue[dict[str, Any]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=256)
        async with self._lock:
            self._subscribers[session_id].add(queue)
        log.info("dispatcher_subscribed", session_id=str(session_id))
        return queue

    async def unsubscribe(
        self, session_id: uuid.UUID, queue: asyncio.Queue[dict[str, Any]]
    ) -> None:
        async with self._lock:
            self._subscribers[session_id].discard(queue)
            if not self._subscribers[session_id]:
                self._subscribers.pop(session_id, None)
        log.info("dispatcher_unsubscribed", session_id=str(session_id))

    async def broadcast(self, session_id: uuid.UUID, event: dict[str, Any]) -> None:
        async with self._lock:
            queues = list(self._subscribers.get(session_id, ()))
        for queue in queues:
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                log.warning("dispatcher_queue_full", session_id=str(session_id))


dispatcher = FrontendDispatcher()
