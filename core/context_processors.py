"""
core/context_processors.py
──────────────────────────────────────────────────────────────────────────────
Injects real-time online presence counters into every template context so you
can write {{ online_count }} and {{ online_users_count }} anywhere in your
templates without touching individual views.

Add to settings.py → TEMPLATES[0]['OPTIONS']['context_processors']:
    "core.context_processors.online_stats",

Redis keys read:
    presence:online_count   String  total WebSocket connections
    presence:online_users   Set     authenticated user IDs

Performance:
    We use a short local cache (30 s default, configurable via
    ONLINE_STATS_CACHE_TTL) so a page with 10 template includes doesn't
    make 10 Redis round-trips per request.
"""

import logging
import redis as redis_sync   # synchronous client — context processors are sync

from django.conf import settings
from django.core.cache import cache

logger = logging.getLogger(__name__)

_CACHE_TTL   = getattr(settings, "ONLINE_STATS_CACHE_TTL", 30)   # seconds
_CACHE_KEY   = "ctx:online_stats"

# Redis key mirrors from consumers.py (kept in sync manually)
_ONLINE_COUNT_KEY = "presence:online_count"
_ONLINE_USERS_KEY = "presence:online_users"


def online_stats(request):
    """
    Returns:
        online_count        int   total active WebSocket connections
        online_users_count  int   authenticated users currently connected
    """
    cached = cache.get(_CACHE_KEY)
    if cached is not None:
        return cached

    result = {"online_count": 0, "online_users_count": 0}

    try:
        r = redis_sync.from_url(
            getattr(settings, "REDIS_URL", "redis://127.0.0.1:6379"),
            decode_responses=True,
            socket_connect_timeout=1,
            socket_timeout=1,
        )
        with r.pipeline(transaction=False) as pipe:
            pipe.get(_ONLINE_COUNT_KEY)
            pipe.scard(_ONLINE_USERS_KEY)
            count_raw, users_count = pipe.execute()

        result["online_count"]       = max(0, int(count_raw or 0))
        result["online_users_count"] = int(users_count or 0)
        r.close()
    except Exception as exc:
        logger.debug("online_stats context processor: Redis unavailable — %s", exc)

    cache.set(_CACHE_KEY, result, _CACHE_TTL)
    return result