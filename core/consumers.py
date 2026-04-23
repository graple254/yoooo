import json
import uuid
import logging
from channels.generic.websocket import AsyncWebsocketConsumer
from channels.layers import get_channel_layer
from django.conf import settings
import redis.asyncio as aioredis

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Redis key helpers
# ---------------------------------------------------------------------------
WAITING_POOL_KEY = "matchmaking:waiting_pool"   # Redis Set
SESSION_KEY      = lambda sid: f"session:{sid}" # Redis Hash  – stores peer1/peer2 channel names


def get_redis():
    """Return an async Redis client from settings."""
    url = getattr(settings, "REDIS_URL", "redis://127.0.0.1:6380")
    return aioredis.from_url(url, decode_responses=True)


# ---------------------------------------------------------------------------
# Consumer
# ---------------------------------------------------------------------------
class MatchmakingConsumer(AsyncWebsocketConsumer):
    """
    Lifecycle
    ---------
    1. connect()    – add the user to the waiting pool; if a partner is already
                      waiting, pop them both and create a session.
    2. receive()    – route WebRTC signaling messages (offer / answer / ice) and
                      arbitrary shared payloads (game_move, sync, chat …) to the
                      partner inside the same session group.
    3. disconnect() – remove from the waiting pool (if still there) or notify the
                      partner and tear down the session.

    Redis data structures
    ---------------------
    • WAITING_POOL_KEY  : Set  – channel_name strings of waiting peers
    • session:<id>      : Hash – {peer1: <channel_name>, peer2: <channel_name>}

    Channel Layer groups
    --------------------
    Each matched pair shares a Channel Layer group named  session_<uuid>.
    All signaling / game messages are sent to this group so both peers receive them.
    """

    # ------------------------------------------------------------------ #
    #  Connection                                                          #
    # ------------------------------------------------------------------ #
    async def connect(self):
        await self.accept()

        self.session_id    = None   # set after matching
        self.session_group = None
        self.partner_channel = None

        redis = get_redis()
        try:
            matched = await self._try_match(redis)
            if matched:
                await self.send_json({"type": "matched", "session_id": self.session_id})
            else:
                await self.send_json({"type": "waiting"})
        finally:
            await redis.aclose()

    # ------------------------------------------------------------------ #
    #  Matchmaking logic                                                   #
    # ------------------------------------------------------------------ #
    async def _try_match(self, redis) -> bool:
        """
        Atomically pop one waiting peer and pair them with the current one.
        Returns True if a match was made, False if we were added to the pool.
        """
        # SPOP is atomic – safe for concurrent connections
        partner_channel = await redis.spop(WAITING_POOL_KEY)

        if partner_channel and partner_channel != self.channel_name:
            # --- We found a partner ---
            session_id    = str(uuid.uuid4())
            session_group = f"session_{session_id}"

            self.session_id      = session_id
            self.session_group   = session_group
            self.partner_channel = partner_channel

            # Persist the session so both peers (and disconnect) can look it up
            await redis.hset(
                SESSION_KEY(session_id),
                mapping={"peer1": partner_channel, "peer2": self.channel_name},
            )
            await redis.expire(SESSION_KEY(session_id), 3600)  # 1-hour TTL

            # Both peers join the channel layer group
            channel_layer = get_channel_layer()
            await self.channel_layer.group_add(session_group, self.channel_name)
            await channel_layer.group_add(session_group, partner_channel)

            # Tell the partner they are matched (they are still in connect() / waiting)
            await channel_layer.send(
                partner_channel,
                {
                    "type": "peer.matched",
                    "session_id": session_id,
                    "session_group": session_group,
                },
            )
            return True
        else:
            # --- No one waiting, join the pool ---
            await redis.sadd(WAITING_POOL_KEY, self.channel_name)
            return False

    # ------------------------------------------------------------------ #
    #  Channel-layer event: peer.matched (sent TO the waiting peer)       #
    # ------------------------------------------------------------------ #
    async def peer_matched(self, event):
        """Called on the *waiting* peer when the second peer connects and matches."""
        self.session_id    = event["session_id"]
        self.session_group = event["session_group"]

        await self.channel_layer.group_add(self.session_group, self.channel_name)
        await self.send_json({"type": "matched", "session_id": self.session_id})

    # ------------------------------------------------------------------ #
    #  Receive from WebSocket client                                       #
    # ------------------------------------------------------------------ #
    async def receive(self, text_data=None, bytes_data=None):
        if not text_data:
            return

        try:
            data = json.loads(text_data)
        except json.JSONDecodeError:
            await self.send_json({"type": "error", "message": "Invalid JSON"})
            return

        msg_type = data.get("type")

        if not self.session_group:
            await self.send_json({"type": "error", "message": "Not yet matched"})
            return

        # All recognised message types are forwarded to the session group.
        # The receiver on the other end will call the appropriate handler.
        allowed_types = {
            # WebRTC signaling
            "offer", "answer", "ice_candidate",
            # Application-level shared messages
            "game_move", "sync", "chat", "custom",
        }

        if msg_type not in allowed_types:
            await self.send_json({"type": "error", "message": f"Unknown type: {msg_type}"})
            return

        await self.channel_layer.group_send(
            self.session_group,
            {
                "type":   f"session.{msg_type.replace('_', '.')}",   # e.g. session.ice.candidate
                "sender": self.channel_name,
                "payload": data,
            },
        )

    # ------------------------------------------------------------------ #
    #  Channel-layer → WebSocket forwarding                               #
    #  One handler per allowed type; all do the same thing: forward to   #
    #  the WebSocket *unless* this peer is the sender.                    #
    # ------------------------------------------------------------------ #
    async def _forward(self, event):
        if event.get("sender") == self.channel_name:
            return  # don't echo back to sender
        await self.send_json(event["payload"])

    # Map channel-layer event types → handler
    async def session_offer(self, event):           await self._forward(event)
    async def session_answer(self, event):          await self._forward(event)
    async def session_ice_candidate(self, event):   await self._forward(event)
    async def session_game_move(self, event):       await self._forward(event)
    async def session_sync(self, event):            await self._forward(event)
    async def session_chat(self, event):            await self._forward(event)
    async def session_custom(self, event):          await self._forward(event)

    # ------------------------------------------------------------------ #
    #  Disconnect                                                          #
    # ------------------------------------------------------------------ #
    async def disconnect(self, close_code):
        redis = get_redis()
        try:
            # Case 1: user was still waiting – remove from pool
            await redis.srem(WAITING_POOL_KEY, self.channel_name)

            # Case 2: user was in a session – notify partner and clean up
            if self.session_id and self.session_group:
                await self.channel_layer.group_send(
                    self.session_group,
                    {
                        "type":    "session.peer_left",
                        "sender":  self.channel_name,
                        "payload": {"type": "peer_left"},
                    },
                )
                await self.channel_layer.group_discard(self.session_group, self.channel_name)
                await redis.delete(SESSION_KEY(self.session_id))
        except Exception as exc:
            logger.exception("Error during disconnect cleanup: %s", exc)
        finally:
            await redis.aclose()

    async def session_peer_left(self, event):
        """Partner disconnected – notify this client."""
        if event.get("sender") != self.channel_name:
            await self.send_json({"type": "peer_left"})
            # Clean up this peer's group membership too
            if self.session_group:
                await self.channel_layer.group_discard(self.session_group, self.channel_name)
            self.session_id    = None
            self.session_group = None

    # ------------------------------------------------------------------ #
    #  Helper                                                              #
    # ------------------------------------------------------------------ #
    async def send_json(self, content):
        await self.send(text_data=json.dumps(content))