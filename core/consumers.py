"""
core/consumers.py — MatchmakingConsumer
─────────────────────────────────────────────────────────────────────────────
Changes from the previous version:

  CHANGE 1 · Redis pool entries now store  "channel_name:user_id"
    Previously only channel_name was stored, so there was no way to know which
    Django User the waiting peer belonged to.  The consumer now encodes both
    pieces of information in a single string and decodes them wherever needed.

  CHANGE 2 · MatchSession DB record created on match
    When two peers are paired, a MatchSession row is inserted with both user
    FKs and the session UUID.  All DB calls go through sync_to_async wrappers
    so the async consumer never blocks.

  CHANGE 3 · MatchSession updated on disconnect
    The first disconnect for a given session_id writes end_time and
    duration_seconds.  A second disconnect (the surviving peer) hits an already-
    closed session and is handled gracefully.

  CHANGE 4 · report_peer message type
    A client can send {"type": "report_peer"} at any point during a matched
    session.  The consumer flags the MatchSession row (reported=True,
    reported_by, reported_at) without interrupting the session.

  CHANGE 5 · is_offerer flag in matched message
    The server now decides which peer should send the WebRTC offer.  peer2
    (the one who triggered the match) is the offerer; peer1 (who was waiting)
    is the answerer.  The client no longer needs a setTimeout race.
"""

import json
import uuid
import logging
from datetime import timezone as tz

from channels.generic.websocket import AsyncWebsocketConsumer
from channels.layers import get_channel_layer
from django.conf import settings
from django.contrib.auth import get_user_model
from django.utils import timezone
from asgiref.sync import sync_to_async
import redis.asyncio as aioredis

logger = logging.getLogger(__name__)
User = get_user_model()

# ─────────────────────────────────────────────────────────────────────────────
#  Redis key helpers
# ─────────────────────────────────────────────────────────────────────────────
WAITING_POOL_KEY = "matchmaking:waiting_pool"   # Redis Set
SESSION_KEY      = lambda sid: f"session:{sid}" # Redis Hash

# ── Presence keys ─────────────────────────────────────────────────────────────
ONLINE_COUNT_KEY = "presence:online_count"  # Redis String  – total WS connections
ONLINE_USERS_KEY = "presence:online_users"  # Redis Set     – authenticated user IDs


def get_redis():
    url = getattr(settings, "REDIS_URL", "redis://127.0.0.1:6379")
    return aioredis.from_url(url, decode_responses=True)


# ─────────────────────────────────────────────────────────────────────────────
#  Helpers: encode / decode pool entries
# ─────────────────────────────────────────────────────────────────────────────
def _encode_pool_entry(channel_name: str, user_id: int) -> str:
    """
    CHANGE 1: store both channel_name and user_id in the Redis Set.
    Format:  "<channel_name>:<user_id>"
    channel_name already contains colons (e.g. "specific.abc123!xyz") so we
    split from the RIGHT to isolate the user_id suffix.
    """
    return f"{channel_name}:{user_id}"


def _decode_pool_entry(entry: str) -> tuple[str, int]:
    """
    Returns (channel_name, user_id).  Splits on the LAST colon so the
    channel_name portion (which may itself contain colons) is preserved intact.
    """
    channel_name, user_id_str = entry.rsplit(":", 1)
    return channel_name, int(user_id_str)


# ─────────────────────────────────────────────────────────────────────────────
#  Async-safe DB helpers  (sync_to_async wrappers)
# ─────────────────────────────────────────────────────────────────────────────
@sync_to_async
def _get_user(user_id: int):
    try:
        return User.objects.get(pk=user_id)
    except User.DoesNotExist:
        return None


@sync_to_async
def _create_match_session(session_uuid, user_one, user_two):
    """CHANGE 2: create the DB record when a match is made."""
    from core.models import MatchSession
    return MatchSession.objects.create(
        session_id=session_uuid,
        user_one=user_one,
        user_two=user_two,
    )


@sync_to_async
def _close_match_session(session_uuid):
    """
    CHANGE 3: called by whichever peer disconnects first.
    Idempotent — a second call on an already-closed session is a no-op.
    """
    from core.models import MatchSession
    try:
        record = MatchSession.objects.get(session_id=session_uuid)
    except MatchSession.DoesNotExist:
        return

    if record.end_time is not None:
        return                  # already closed by the other peer

    now = timezone.now()
    delta = now - record.start_time
    record.end_time         = now
    record.duration_seconds = int(delta.total_seconds())
    record.save(update_fields=["end_time", "duration_seconds"])


@sync_to_async
def _flag_report(session_uuid, reporter_user):
    """CHANGE 4: mark the session as reported."""
    from core.models import MatchSession
    try:
        record = MatchSession.objects.get(session_id=session_uuid)
    except MatchSession.DoesNotExist:
        return

    if record.reported:
        return          # already reported — don't overwrite reporter

    record.reported    = True
    record.reported_by = reporter_user
    record.reported_at = timezone.now()
    record.save(update_fields=["reported", "reported_by", "reported_at"])


# ─────────────────────────────────────────────────────────────────────────────
#  Consumer
# ─────────────────────────────────────────────────────────────────────────────
class MatchmakingConsumer(AsyncWebsocketConsumer):
    """
    Redis data structures
    ─────────────────────
    WAITING_POOL_KEY  : Set  – encoded entries  "channel_name:user_id"
    session:<id>      : Hash – {peer1: <encoded>, peer2: <encoded>,
                                peer1_user_id: <int>, peer2_user_id: <int>}

    Channel Layer groups
    ────────────────────
    Each pair shares a group named  session_<uuid>.
    """

    # ── connect ──────────────────────────────────────────────────────────
    async def connect(self):
        # Require authenticated user
        if not self.scope["user"].is_authenticated:
            await self.close()
            return

        await self.accept()

        self.user            = self.scope["user"]
        self.session_id      = None
        self.session_group   = None
        self.partner_channel = None
        self.partner_user    = None

        redis = get_redis()
        try:
            # ── Task 1: presence tracking ─────────────────────────────────
            # INCR is atomic — safe for concurrent connections.
            # Pipeline sends both commands in one round-trip.
            async with redis.pipeline(transaction=False) as pipe:
                pipe.incr(ONLINE_COUNT_KEY)
                pipe.sadd(ONLINE_USERS_KEY, str(self.user.pk))
                await pipe.execute()

            matched = await self._try_match(redis)
            if matched:
                await self.send_json({
                    "type":       "matched",
                    "session_id": self.session_id,
                    "is_offerer": True,     # CHANGE 5: peer2 = offerer
                })
            else:
                await self.send_json({"type": "waiting"})
        finally:
            await redis.aclose()

    # ── matchmaking ──────────────────────────────────────────────────────
    async def _try_match(self, redis) -> bool:
        """
        CHANGE 1: pool entries are now  "channel_name:user_id".
        SPOP pops one entry atomically; we decode it to get the partner's
        channel_name and user_id, then build the session.
        """
        my_entry    = _encode_pool_entry(self.channel_name, self.user.pk)
        raw_partner = await redis.spop(WAITING_POOL_KEY)

        if raw_partner and not raw_partner.startswith(self.channel_name + ":"):
            # ── found a partner ──────────────────────────────────────────
            partner_channel, partner_user_id = _decode_pool_entry(raw_partner)

            session_id    = str(uuid.uuid4())
            session_group = f"session_{session_id}"

            self.session_id      = session_id
            self.session_group   = session_group
            self.partner_channel = partner_channel

            # Persist session metadata in Redis
            await redis.hset(
                SESSION_KEY(session_id),
                mapping={
                    "peer1":         raw_partner,           # waiting peer (answerer)
                    "peer2":         my_entry,              # arriving peer (offerer)
                    "peer1_user_id": str(partner_user_id),
                    "peer2_user_id": str(self.user.pk),
                },
            )
            await redis.expire(SESSION_KEY(session_id), 3600)

            # CHANGE 2: create DB record
            partner_user      = await _get_user(partner_user_id)
            self.partner_user = partner_user
            await _create_match_session(
                session_uuid=uuid.UUID(session_id),
                user_one=partner_user,      # peer1 = user_one (was waiting)
                user_two=self.user,         # peer2 = user_two (arrived)
            )

            # Join channel layer group — both peers
            channel_layer = get_channel_layer()
            await self.channel_layer.group_add(session_group, self.channel_name)
            await channel_layer.group_add(session_group, partner_channel)

            # Notify the waiting peer (peer1 / answerer)
            await channel_layer.send(
                partner_channel,
                {
                    "type":           "peer.matched",
                    "session_id":     session_id,
                    "session_group":  session_group,
                    "is_offerer":     False,    # CHANGE 5: peer1 = answerer
                    "partner_user_id": self.user.pk,
                },
            )
            return True

        else:
            # ── no partner — join the pool ───────────────────────────────
            if raw_partner:
                # We popped our own entry (edge case on reconnect) — put it back
                await redis.sadd(WAITING_POOL_KEY, raw_partner)
            await redis.sadd(WAITING_POOL_KEY, my_entry)
            return False

    # ── peer.matched  (channel-layer event → waiting peer) ───────────────
    async def peer_matched(self, event):
        """
        Received by peer1 (the one who was waiting).
        CHANGE 5: forward is_offerer=False so the client knows to wait for the
        offer rather than creating one.
        """
        self.session_id      = event["session_id"]
        self.session_group   = event["session_group"]

        # Look up partner user for any future use (reporting, etc.)
        partner_user_id  = event.get("partner_user_id")
        if partner_user_id:
            self.partner_user = await _get_user(partner_user_id)

        await self.channel_layer.group_add(self.session_group, self.channel_name)
        await self.send_json({
            "type":       "matched",
            "session_id": self.session_id,
            "is_offerer": event.get("is_offerer", False),   # CHANGE 5
        })

    # ── receive ──────────────────────────────────────────────────────────
    async def receive(self, text_data=None, bytes_data=None):
        if not text_data:
            return

        try:
            data = json.loads(text_data)
        except json.JSONDecodeError:
            await self.send_json({"type": "error", "message": "Invalid JSON"})
            return

        msg_type = data.get("type")

        # CHANGE 4: report_peer is handled locally — never relayed
        if msg_type == "report_peer":
            await self._handle_report()
            return

        if not self.session_group:
            await self.send_json({"type": "error", "message": "Not yet matched"})
            return

        allowed_types = {
            "offer", "answer", "ice_candidate",
            "game_move", "sync", "chat", "custom",
        }

        if msg_type not in allowed_types:
            await self.send_json({"type": "error", "message": f"Unknown type: {msg_type}"})
            return

        await self.channel_layer.group_send(
            self.session_group,
            {
                "type":    f"session.{msg_type.replace('_', '.')}",
                "sender":  self.channel_name,
                "payload": data,
            },
        )

    # ── report handler ────────────────────────────────────────────────────
    async def _handle_report(self):
        """CHANGE 4: flag the DB session record and ack the reporter."""
        if not self.session_id:
            await self.send_json({"type": "error", "message": "No active session to report"})
            return

        try:
            await _flag_report(
                session_uuid=uuid.UUID(self.session_id),
                reporter_user=self.user,
            )
            await self.send_json({"type": "report_ack", "session_id": self.session_id})
            logger.info(
                "Session %s reported by user %s", self.session_id, self.user.pk
            )
        except Exception as exc:
            logger.exception("Error flagging report: %s", exc)
            await self.send_json({"type": "error", "message": "Could not submit report"})

    # ── channel-layer forwarding ──────────────────────────────────────────
    async def _forward(self, event):
        if event.get("sender") == self.channel_name:
            return
        await self.send_json(event["payload"])

    async def session_offer(self, event):          await self._forward(event)
    async def session_answer(self, event):         await self._forward(event)
    async def session_ice_candidate(self, event):  await self._forward(event)
    async def session_game_move(self, event):      await self._forward(event)
    async def session_sync(self, event):           await self._forward(event)
    async def session_chat(self, event):           await self._forward(event)
    async def session_custom(self, event):         await self._forward(event)

    # ── disconnect ───────────────────────────────────────────────────────
    async def disconnect(self, close_code):
        redis = get_redis()
        try:
            # ── Task 1: presence cleanup ──────────────────────────────────
            # DECR can go negative if the server restarts mid-session;
            # we clamp to 0 with a Lua script to keep the counter honest.
            if hasattr(self, "user") and self.user.is_authenticated:
                async with redis.pipeline(transaction=False) as pipe:
                    # Decrement but floor at 0
                    pipe.eval(
                        "local v = redis.call('decr', KEYS[1]); "
                        "if v < 0 then redis.call('set', KEYS[1], 0) end; "
                        "return v",
                        1, ONLINE_COUNT_KEY,
                    )
                    pipe.srem(ONLINE_USERS_KEY, str(self.user.pk))
                    await pipe.execute()

            # Remove from pool if still waiting (encoded entry)
            if hasattr(self, "user") and self.user.is_authenticated:
                my_entry = _encode_pool_entry(self.channel_name, self.user.pk)
                await redis.srem(WAITING_POOL_KEY, my_entry)

            if self.session_id and self.session_group:
                # CHANGE 3: close the DB record
                try:
                    await _close_match_session(uuid.UUID(self.session_id))
                except Exception as exc:
                    logger.exception("Error closing match session in DB: %s", exc)

                # Notify partner
                await self.channel_layer.group_send(
                    self.session_group,
                    {
                        "type":    "session.peer_left",
                        "sender":  self.channel_name,
                        "payload": {"type": "peer_left"},
                    },
                )
                await self.channel_layer.group_discard(
                    self.session_group, self.channel_name
                )
                await redis.delete(SESSION_KEY(self.session_id))

        except Exception as exc:
            logger.exception("Error during disconnect cleanup: %s", exc)
        finally:
            await redis.aclose()

    async def session_peer_left(self, event):
        if event.get("sender") != self.channel_name:
            await self.send_json({"type": "peer_left"})
            if self.session_group:
                await self.channel_layer.group_discard(
                    self.session_group, self.channel_name
                )
            self.session_id    = None
            self.session_group = None

    # ── helper ───────────────────────────────────────────────────────────
    async def send_json(self, content):
        await self.send(text_data=json.dumps(content))