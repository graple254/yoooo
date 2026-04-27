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

"""
core/consumers.py — MatchmakingConsumer
All previous changes retained.  New additions for the game engine:

  GAME-1: Active game state attributes on the consumer instance.
  GAME-2: "game_start" message — relayed to partner, game state recorded.
  GAME-3: "game_over" message — server resolves winner, writes GameResult rows.
  GAME-4: Forfeit on disconnect — loser_forfeit=True for the disconnecting player.
  GAME-5: game_move relay — already handled by existing allowed_types relay.
  GAME-6: "game_quit" message — same outcome as mid-game disconnect for quitter.
  WATCHDOG-ACK: "watchdog_timeout" — client tells server ICE failed; server cleans session.

  GAME-7 (this update): game_type validation
    _handle_game_start no longer defaults to "3mm". It validates the supplied
    game_type against GameType.objects (active=True) and rejects unknown codes.
    session_game_start also stores the exact code the sender set — no default.

  ── Required GameType rows in the DB ────────────────────────────────────────
  Make sure these exist (name must match the code used by the client):

      GameType.objects.get_or_create(name="3mm", defaults={"label": "Three Men's Morris", "active": True})
      GameType.objects.get_or_create(name="ttt", defaults={"label": "Tic Tac Toe",        "active": True})

  Run via shell:  python manage.py shell  or add a data migration / fixture.
"""

import json
import uuid
import logging

from channels.generic.websocket import AsyncWebsocketConsumer
from channels.layers import get_channel_layer
from django.conf import settings
from django.contrib.auth import get_user_model
from django.utils import timezone
from asgiref.sync import sync_to_async
import redis.asyncio as aioredis

logger = logging.getLogger(__name__)
User = get_user_model()

WAITING_POOL_KEY = "matchmaking:waiting_pool"
SESSION_KEY      = lambda sid: f"session:{sid}"
ONLINE_COUNT_KEY = "presence:online_count"
ONLINE_USERS_KEY = "presence:online_users"


def get_redis():
    url = getattr(settings, "REDIS_URL", "redis://127.0.0.1:6379")
    return aioredis.from_url(url, decode_responses=True)


def _encode_pool_entry(channel_name: str, user_id: int) -> str:
    return f"{channel_name}:{user_id}"


def _decode_pool_entry(entry: str) -> tuple[str, int]:
    channel_name, user_id_str = entry.rsplit(":", 1)
    return channel_name, int(user_id_str)


@sync_to_async
def _get_user(user_id: int):
    try:
        return User.objects.get(pk=user_id)
    except User.DoesNotExist:
        return None


@sync_to_async
def _create_match_session(session_uuid, user_one, user_two):
    from core.models import MatchSession
    return MatchSession.objects.create(session_id=session_uuid, user_one=user_one, user_two=user_two)


@sync_to_async
def _close_match_session(session_uuid):
    from core.models import MatchSession
    try:
        record = MatchSession.objects.get(session_id=session_uuid)
    except MatchSession.DoesNotExist:
        return
    if record.end_time is not None:
        return
    now = timezone.now()
    record.end_time         = now
    record.duration_seconds = int((now - record.start_time).total_seconds())
    record.save(update_fields=["end_time", "duration_seconds"])


@sync_to_async
def _flag_report(session_uuid, reporter_user):
    from core.models import MatchSession
    try:
        record = MatchSession.objects.get(session_id=session_uuid)
    except MatchSession.DoesNotExist:
        return
    if record.reported:
        return
    record.reported    = True
    record.reported_by = reporter_user
    record.reported_at = timezone.now()
    record.save(update_fields=["reported", "reported_by", "reported_at"])


@sync_to_async
def _game_type_exists(game_type_code: str) -> bool:
    from core.models import GameType
    return GameType.objects.filter(name=game_type_code, active=True).exists()


@sync_to_async
def _save_game_result(match_session_id, game_type_code, winner_user, loser_user,
                      is_draw=False, winner_forfeit=False, loser_forfeit=False):
    from core.models import GameType, GameResult
    try:
        game_type = GameType.objects.get(name=game_type_code, active=True)
    except GameType.DoesNotExist:
        logger.warning("Unknown game_type_code=%r — GameResult not saved.", game_type_code)
        return
    GameResult.record_pair(
        match_session_id=match_session_id, game_type=game_type,
        winner=winner_user, loser=loser_user,
        is_draw=is_draw, winner_forfeit=winner_forfeit, loser_forfeit=loser_forfeit,
    )


class MatchmakingConsumer(AsyncWebsocketConsumer):

    async def connect(self):
        if not self.scope["user"].is_authenticated:
            await self.close()
            return
        await self.accept()

        self.user            = self.scope["user"]
        self.session_id      = None
        self.session_group   = None
        self.partner_channel = None
        self.partner_user    = None
        self.is_offerer      = False   # GAME-1

        # GAME-1: game state — None when no game is in progress
        self.game_session_id = None
        self.game_type_code  = None

        redis = get_redis()
        try:
            async with redis.pipeline(transaction=False) as pipe:
                pipe.incr(ONLINE_COUNT_KEY)
                pipe.sadd(ONLINE_USERS_KEY, str(self.user.pk))
                await pipe.execute()

            matched = await self._try_match(redis)
            if matched:
                await self.send_json({"type": "matched", "session_id": self.session_id, "is_offerer": True})
            else:
                await self.send_json({"type": "waiting"})
        finally:
            await redis.aclose()

    async def _try_match(self, redis) -> bool:
        my_entry    = _encode_pool_entry(self.channel_name, self.user.pk)
        raw_partner = await redis.spop(WAITING_POOL_KEY)

        if raw_partner and not raw_partner.startswith(self.channel_name + ":"):
            partner_channel, partner_user_id = _decode_pool_entry(raw_partner)
            session_id    = str(uuid.uuid4())
            session_group = f"session_{session_id}"

            self.session_id      = session_id
            self.session_group   = session_group
            self.partner_channel = partner_channel
            self.is_offerer      = True

            await redis.hset(SESSION_KEY(session_id), mapping={
                "peer1": raw_partner, "peer2": my_entry,
                "peer1_user_id": str(partner_user_id), "peer2_user_id": str(self.user.pk),
            })
            await redis.expire(SESSION_KEY(session_id), 3600)

            partner_user      = await _get_user(partner_user_id)
            self.partner_user = partner_user
            await _create_match_session(uuid.UUID(session_id), partner_user, self.user)

            channel_layer = get_channel_layer()
            await self.channel_layer.group_add(session_group, self.channel_name)
            await channel_layer.group_add(session_group, partner_channel)
            await channel_layer.send(partner_channel, {
                "type": "peer.matched", "session_id": session_id,
                "session_group": session_group, "is_offerer": False,
                "partner_user_id": self.user.pk,
            })
            return True
        else:
            if raw_partner:
                await redis.sadd(WAITING_POOL_KEY, raw_partner)
            await redis.sadd(WAITING_POOL_KEY, my_entry)
            return False

    async def peer_matched(self, event):
        self.session_id    = event["session_id"]
        self.session_group = event["session_group"]
        self.is_offerer    = False  # GAME-1: waiting peer = answerer

        partner_user_id = event.get("partner_user_id")
        if partner_user_id:
            self.partner_user = await _get_user(partner_user_id)

        await self.channel_layer.group_add(self.session_group, self.channel_name)
        await self.send_json({
            "type": "matched", "session_id": self.session_id,
            "is_offerer": event.get("is_offerer", False),
        })

    async def receive(self, text_data=None, bytes_data=None):
        if not text_data:
            return
        try:
            data = json.loads(text_data)
        except json.JSONDecodeError:
            await self.send_json({"type": "error", "message": "Invalid JSON"})
            return

        msg_type = data.get("type")

        if msg_type == "report_peer":
            await self._handle_report(); return
        if msg_type == "game_start":           # GAME-2
            await self._handle_game_start(data); return
        if msg_type == "game_over":            # GAME-3
            await self._handle_game_over(data); return
        if msg_type == "game_quit":            # GAME-6
            await self._handle_game_quit(); return
        if msg_type == "watchdog_timeout":     # WATCHDOG-ACK
            await self._handle_watchdog_timeout(); return

        if not self.session_group:
            await self.send_json({"type": "error", "message": "Not yet matched"}); return

        allowed_types = {"offer", "answer", "ice_candidate", "game_move", "sync", "chat", "custom"}
        if msg_type not in allowed_types:
            await self.send_json({"type": "error", "message": f"Unknown type: {msg_type}"}); return

        await self.channel_layer.group_send(self.session_group, {
            "type": f"session.{msg_type.replace('_', '.')}",
            "sender": self.channel_name, "payload": data,
        })

    # ── GAME-2 ────────────────────────────────────────────────────────────
    async def _handle_game_start(self, data):
        if not self.session_group: return
        game_type_code = data.get("game_type")
        if not game_type_code:
            await self.send_json({"type": "error", "message": "game_start requires game_type"}); return
        # Validate the game type exists and is active in the DB
        if not await _game_type_exists(game_type_code):
            await self.send_json({"type": "error", "message": f"Unknown game type: {game_type_code}"}); return
        self.game_session_id = self.session_id
        self.game_type_code  = game_type_code
        await self.channel_layer.group_send(self.session_group, {
            "type": "session.game_start", "sender": self.channel_name,
            "payload": {"type": "game_start", "game_type": self.game_type_code},
        })

    async def session_game_start(self, event):
        if event.get("sender") != self.channel_name:
            payload = event["payload"]
            self.game_session_id = self.session_id
            self.game_type_code  = payload.get("game_type")   # no default — must match what sender set
            await self.send_json(payload)

    # ── GAME-3 ────────────────────────────────────────────────────────────
    async def _handle_game_over(self, data):
        if not self.game_session_id or not self.game_type_code: return

        winner_role = data.get("winner")   # "offerer" | "answerer" | "draw"
        is_draw     = (winner_role == "draw")

        if is_draw:
            winner_user, loser_user = self.user, self.partner_user
        elif winner_role == "offerer":
            winner_user = self.user if self.is_offerer else self.partner_user
            loser_user  = self.partner_user if self.is_offerer else self.user
        else:  # "answerer"
            winner_user = self.user if not self.is_offerer else self.partner_user
            loser_user  = self.partner_user if not self.is_offerer else self.user

        try:
            await _save_game_result(
                uuid.UUID(self.game_session_id), self.game_type_code,
                winner_user, loser_user, is_draw=is_draw,
            )
        except Exception as exc:
            logger.exception("Error saving game result: %s", exc)

        if self.session_group:
            await self.channel_layer.group_send(self.session_group, {
                "type": "session.game_result", "sender": None,
                "payload": {
                    "type": "game_result", "winner": winner_role,
                    "is_draw": is_draw, "game_type": self.game_type_code,
                    "session_id": self.game_session_id,
                },
            })

        self.game_session_id = None
        self.game_type_code  = None

    async def session_game_result(self, event):
        await self.send_json(event["payload"])

    # ── GAME-6 ────────────────────────────────────────────────────────────
    async def _handle_game_quit(self):
        if not self.game_session_id or not self.game_type_code: return
        try:
            await _save_game_result(
                uuid.UUID(self.game_session_id), self.game_type_code,
                self.partner_user, self.user, loser_forfeit=True,
            )
        except Exception as exc:
            logger.exception("Error saving forfeit: %s", exc)

        if self.session_group:
            await self.channel_layer.group_send(self.session_group, {
                "type": "session.game_result", "sender": None,
                "payload": {
                    "type": "game_result",
                    "winner": "answerer" if self.is_offerer else "offerer",
                    "is_draw": False, "forfeit": True,
                    "game_type": self.game_type_code,
                },
            })
        self.game_session_id = None
        self.game_type_code  = None

    # ── WATCHDOG-ACK ─────────────────────────────────────────────────────
    async def _handle_watchdog_timeout(self):
        logger.info("Watchdog timeout: user=%s session=%s", getattr(self.user, "pk", "?"), self.session_id)
        self.game_session_id = None
        self.game_type_code  = None

        if self.session_id:
            redis = get_redis()
            try:
                await _close_match_session(uuid.UUID(self.session_id))
                if self.session_group:
                    await self.channel_layer.group_send(self.session_group, {
                        "type": "session.peer_left", "sender": self.channel_name,
                        "payload": {"type": "peer_left", "reason": "watchdog"},
                    })
                    await self.channel_layer.group_discard(self.session_group, self.channel_name)
                    await redis.delete(SESSION_KEY(self.session_id))
            finally:
                await redis.aclose()

        self.session_id    = None
        self.session_group = None
        await self.send_json({"type": "watchdog_ack"})

    # ── report ────────────────────────────────────────────────────────────
    async def _handle_report(self):
        if not self.session_id:
            await self.send_json({"type": "error", "message": "No active session to report"}); return
        try:
            await _flag_report(uuid.UUID(self.session_id), self.user)
            await self.send_json({"type": "report_ack", "session_id": self.session_id})
        except Exception as exc:
            logger.exception("Error flagging report: %s", exc)
            await self.send_json({"type": "error", "message": "Could not submit report"})

    # ── channel-layer forwarding ──────────────────────────────────────────
    async def _forward(self, event):
        if event.get("sender") == self.channel_name: return
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
            if hasattr(self, "user") and self.user.is_authenticated:
                async with redis.pipeline(transaction=False) as pipe:
                    pipe.eval(
                        "local v = redis.call('decr', KEYS[1]); "
                        "if v < 0 then redis.call('set', KEYS[1], 0) end; return v",
                        1, ONLINE_COUNT_KEY,
                    )
                    pipe.srem(ONLINE_USERS_KEY, str(self.user.pk))
                    await pipe.execute()
                my_entry = _encode_pool_entry(self.channel_name, self.user.pk)
                await redis.srem(WAITING_POOL_KEY, my_entry)

            # GAME-4: forfeit if mid-game
            if self.game_session_id and self.game_type_code and self.partner_user:
                try:
                    await _save_game_result(
                        uuid.UUID(self.game_session_id), self.game_type_code,
                        self.partner_user, self.user, loser_forfeit=True,
                    )
                except Exception as exc:
                    logger.exception("Error saving forfeit on disconnect: %s", exc)

            if self.session_id and self.session_group:
                try:
                    await _close_match_session(uuid.UUID(self.session_id))
                except Exception as exc:
                    logger.exception("Error closing match session: %s", exc)

                await self.channel_layer.group_send(self.session_group, {
                    "type": "session.peer_left", "sender": self.channel_name,
                    "payload": {"type": "peer_left"},
                })
                await self.channel_layer.group_discard(self.session_group, self.channel_name)
                await redis.delete(SESSION_KEY(self.session_id))

        except Exception as exc:
            logger.exception("Error during disconnect cleanup: %s", exc)
        finally:
            await redis.aclose()

    async def session_peer_left(self, event):
        if event.get("sender") != self.channel_name:
            await self.send_json({"type": "peer_left"})
            if self.session_group:
                await self.channel_layer.group_discard(self.session_group, self.channel_name)
            self.session_id      = None
            self.session_group   = None
            self.game_session_id = None  # GAME-4
            self.game_type_code  = None

    async def send_json(self, content):
        await self.send(text_data=json.dumps(content))