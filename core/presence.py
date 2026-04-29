"""
presence.py  —  core/presence.py
─────────────────────────────────────────────────────────────────────────────
Centralised presence helpers used by MatchmakingConsumer and PresenceConsumer.

WHAT "ONLINE" MEANS IN THIS APP
────────────────────────────────
A user is counted as online when they have at least one open WebSocket
connection to /ws/match/.  Visiting other pages without opening the socket
does NOT count.  Anonymous visitors are counted in online_count but not in
online_users_count.

MULTI-TAB / MULTI-DEVICE CORRECTNESS
──────────────────────────────────────
Problem: a user with 3 tabs open should count as 1 authenticated user.
But the first tab to close must NOT remove them from the set — only the
last tab closing should.

Solution: we keep a per-user reference counter alongside the set:

    presence:online_count           ← total WS connections (all users)
    presence:online_users           ← set of authenticated user PKs
    presence:user_conns:<pk>        ← integer ref-count per user

on_connect(user_pk):
    INCR presence:online_count
    INCR presence:user_conns:<pk>   → if result == 1: SADD presence:online_users <pk>

on_disconnect(user_pk):
    DECR-safe presence:online_count
    DECR presence:user_conns:<pk>   → if result <= 0: SREM presence:online_users <pk>
                                                       DEL  presence:user_conns:<pk>

STALE STATE (server crash / restart)
──────────────────────────────────────
On a hard restart disconnect() never runs, so counts drift.
Call flush_presence_state() once at startup (e.g. from AppConfig.ready()).
It resets all three key families to zero/empty.

ANONYMOUS USERS
────────────────
Pass user_pk=None for unauthenticated connections.  They increment
online_count but are not added to the set.
"""

import logging

import redis.asyncio as aioredis
from django.conf import settings

logger = logging.getLogger(__name__)

# ── Redis key definitions (single source of truth) ────────────────────────────
ONLINE_COUNT_KEY  = "presence:online_count"
ONLINE_USERS_KEY  = "presence:online_users"
USER_CONNS_KEY    = lambda pk: f"presence:user_conns:{pk}"   # noqa: E731

PRESENCE_GROUP    = "presence.broadcast"   # channel-layer group name


def get_redis():
    url = getattr(settings, "REDIS_URL", "redis://127.0.0.1:6379")
    return aioredis.from_url(url, decode_responses=True)


# ── Connect / disconnect ──────────────────────────────────────────────────────

async def presence_connect(redis, user_pk=None):
    """
    Call after a WebSocket is accepted.

    Args:
        redis:    open aioredis client
        user_pk:  authenticated user's PK, or None for anonymous
    """
    # Always increment the total connection counter
    await redis.incr(ONLINE_COUNT_KEY)

    if user_pk is not None:
        ref_count = await redis.incr(USER_CONNS_KEY(user_pk))
        if ref_count == 1:
            # First connection for this user — add to the online set
            await redis.sadd(ONLINE_USERS_KEY, str(user_pk))


async def presence_disconnect(redis, user_pk=None):
    """
    Call at the start of WebSocket disconnect cleanup.

    Args:
        redis:    open aioredis client
        user_pk:  authenticated user's PK, or None for anonymous
    """
    # Decrement total connections, floor at 0
    await redis.eval(
        "local v = redis.call('decr', KEYS[1]); "
        "if v < 0 then redis.call('set', KEYS[1], '0') end; return v",
        1, ONLINE_COUNT_KEY,
    )

    if user_pk is not None:
        ref_key   = USER_CONNS_KEY(user_pk)
        ref_count = await redis.decr(ref_key)
        if ref_count <= 0:
            # Last tab/device closed — remove from the online set
            await redis.srem(ONLINE_USERS_KEY, str(user_pk))
            await redis.delete(ref_key)


# ── Broadcast helper ──────────────────────────────────────────────────────────

async def broadcast_presence(redis=None):
    """
    Read current counters and fan-out to every PresenceConsumer.
    Pass an already-open redis client to avoid creating a new connection.
    """
    from channels.layers import get_channel_layer

    close_after = redis is None
    if redis is None:
        redis = get_redis()

    try:
        count_raw, users_count = await redis.mget(ONLINE_COUNT_KEY, "presence:__dummy__")
        # mget doesn't support SCARD, so use a pipeline
        async with redis.pipeline(transaction=False) as pipe:
            pipe.get(ONLINE_COUNT_KEY)
            pipe.scard(ONLINE_USERS_KEY)
            count_raw, users_count = await pipe.execute()

        payload = {
            "type":               "presence.push",
            "online_count":       max(0, int(count_raw or 0)),
            "online_users_count": int(users_count or 0),
        }
        await get_channel_layer().group_send(PRESENCE_GROUP, payload)

    except Exception as exc:
        logger.debug("broadcast_presence error: %s", exc)
    finally:
        if close_after:
            await redis.aclose()


# ── Startup flush (call from AppConfig.ready via sync_to_async or mgmt cmd) ───

def flush_presence_state():
    """
    Synchronous — call once at application startup to wipe stale presence data
    left over from a previous server process that was killed without clean shutdown.

    Usage in core/apps.py:
        class CoreConfig(AppConfig):
            def ready(self):
                from core.presence import flush_presence_state
                flush_presence_state()
    """
    import redis as redis_sync

    url = getattr(settings, "REDIS_URL", "redis://127.0.0.1:6379")
    try:
        r = redis_sync.from_url(url, decode_responses=True)
        # Delete the counters and the online users set
        r.delete(ONLINE_COUNT_KEY, ONLINE_USERS_KEY)
        # Delete all per-user ref-count keys
        pattern = "presence:user_conns:*"
        cursor   = 0
        while True:
            cursor, keys = r.scan(cursor, match=pattern, count=200)
            if keys:
                r.delete(*keys)
            if cursor == 0:
                break
        r.close()
        logger.info("Presence state flushed on startup.")
    except Exception as exc:
        logger.warning("Could not flush presence state: %s", exc)