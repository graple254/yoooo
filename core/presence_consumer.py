"""
core/presence_consumer.py  (updated)
─────────────────────────────────────────────────────────────────────────────
Now imports PRESENCE_GROUP and helpers from core.presence (single source of
truth) instead of defining its own constants.
"""

import json
import logging

from channels.generic.websocket import AsyncWebsocketConsumer

from core.presence import (
    ONLINE_COUNT_KEY,
    ONLINE_USERS_KEY,
    PRESENCE_GROUP,
    get_redis,
)

logger = logging.getLogger(__name__)


class PresenceConsumer(AsyncWebsocketConsumer):
    """
    Any page can open  wss://<host>/ws/presence/  to receive live counters.
    No authentication required — the data is public (just counts, no IDs).
    """

    async def connect(self):
        await self.channel_layer.group_add(PRESENCE_GROUP, self.channel_name)
        await self.accept()

        # Push current counts immediately so the widget doesn't wait for the
        # next user connect/disconnect event to show numbers.
        redis = get_redis()
        try:
            async with redis.pipeline(transaction=False) as pipe:
                pipe.get(ONLINE_COUNT_KEY)
                pipe.scard(ONLINE_USERS_KEY)
                count_raw, users_count = await pipe.execute()

            await self.send(text_data=json.dumps({
                "type":               "presence",
                "online_count":       max(0, int(count_raw or 0)),
                "online_users_count": int(users_count or 0),
            }))
        except Exception as exc:
            logger.debug("PresenceConsumer initial push: %s", exc)
        finally:
            await redis.aclose()

    async def disconnect(self, close_code):
        await self.channel_layer.group_discard(PRESENCE_GROUP, self.channel_name)

    async def presence_push(self, event):
        """Receive broadcast from channel layer → forward to WebSocket."""
        await self.send(text_data=json.dumps({
            "type":               "presence",
            "online_count":       event["online_count"],
            "online_users_count": event["online_users_count"],
        }))

    async def receive(self, text_data=None, bytes_data=None):
        pass   # read-only consumer — ignore anything the client sends