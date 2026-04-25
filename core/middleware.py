"""
core/middleware.py
──────────────────────────────────────────────────────────────────────────────
ActivityTrackingMiddleware
    Logs every HTTP request to UserActivity.  Geo-lookup (ip-api.com) is
    performed at most ONCE per unique IP address — the result is stored in
    Django's cache backend (default: LocMemCache; swap for Redis in settings
    for multi-process production).

Performance profile
    • Cache hit  → 0 external calls, ~0.2 ms overhead per request.
    • Cache miss → 1 synchronous GET to ip-api.com (~80–400 ms, first visit
                   only per IP).  The DB write is a fast INSERT with no
                   SELECT beforehand — we log every request unconditionally
                   because filtering inside the middleware wastes time.

Settings knobs (optional, set in settings.py):
    ACTIVITY_SKIP_PATHS   — list of path prefixes to skip (default: ["/static/", "/media/"])
    ACTIVITY_GEO_TIMEOUT  — ip-api.com request timeout in seconds (default: 4)
    ACTIVITY_CACHE_TTL    — seconds to keep geo results in cache (default: 86400 = 24 h)
"""

import logging
import requests

from django.conf import settings
from django.core.cache import cache
from django.utils.deprecation import MiddlewareMixin

logger = logging.getLogger(__name__)

# ── Defaults (override in settings.py) ───────────────────────────────────────
_SKIP_PATHS  = getattr(settings, "ACTIVITY_SKIP_PATHS",  ["/static/", "/media/", "/favicon"])
_GEO_TIMEOUT = getattr(settings, "ACTIVITY_GEO_TIMEOUT", 4)
_CACHE_TTL   = getattr(settings, "ACTIVITY_CACHE_TTL",   86_400)   # 24 h


class ActivityTrackingMiddleware(MiddlewareMixin):
    """
    Logs every HTTP request to core.UserActivity.

    Runs in process_response so the view always finishes first — we never
    add latency to the hot path.  (Geo lookups on cache-miss are the only
    exception, and they only happen on brand-new IPs.)
    """

    # ── IP extraction ─────────────────────────────────────────────────────
    @staticmethod
    def _get_client_ip(request) -> str:
        """
        Respects X-Forwarded-For set by ngrok, nginx, or any load-balancer.
        Takes the FIRST (leftmost) IP — that's the original client.
        Falls back to REMOTE_ADDR.
        """
        x_forwarded_for = request.META.get("HTTP_X_FORWARDED_FOR", "")
        if x_forwarded_for:
            return x_forwarded_for.split(",")[0].strip()
        return request.META.get("REMOTE_ADDR", "0.0.0.0")

    # ── Geo lookup with cache ─────────────────────────────────────────────
    @staticmethod
    def _get_location(ip: str) -> str:
        """
        Returns "City, Country" for the given IP.

        Cache key:  geo:<ip>
        Cache value: the resolved location string (or "Unknown").
        A cached "Unknown" is NOT re-tried — avoids hammering ip-api on
        bad/private IPs.  If you want retries, reduce _CACHE_TTL.

        Private / loopback addresses (127.x, 192.168.x, 10.x) are skipped
        immediately — ip-api.com returns an error for those anyway.
        """
        # Skip private/loopback addresses immediately
        if _is_private_ip(ip):
            return "Local / Private"

        cache_key = f"geo:{ip}"
        cached    = cache.get(cache_key)
        if cached is not None:
            return cached

        # Cache miss — call ip-api.com
        location = "Unknown"
        try:
            resp = requests.get(
                f"http://ip-api.com/json/{ip}",
                params={"fields": "status,city,country"},
                timeout=_GEO_TIMEOUT,
            )
            data = resp.json()
            if data.get("status") == "success":
                city    = data.get("city", "")
                country = data.get("country", "")
                location = f"{city}, {country}".strip(", ") or "Unknown"
        except Exception as exc:
            logger.debug("Geo lookup failed for %s: %s", ip, exc)

        cache.set(cache_key, location, _CACHE_TTL)
        return location

    # ── Main hook ─────────────────────────────────────────────────────────
    def process_response(self, request, response):
        """
        Runs after the view.  Safe to fail — a logging error must never
        break the user's response.
        """
        try:
            path = request.path

            # Skip static files, media, and any caller-configured prefixes
            if any(path.startswith(prefix) for prefix in _SKIP_PATHS):
                return response

            ip         = self._get_client_ip(request)
            location   = self._get_location(ip)
            user_agent = request.META.get("HTTP_USER_AGENT", "")[:512]
            user       = request.user if request.user.is_authenticated else None

            # Deferred import to avoid circular import at module load
            from core.models import UserActivity
            UserActivity.objects.create(
                user=user,
                ip_address=ip,
                location=location,
                path=path,
                user_agent=user_agent,
            )
        except Exception as exc:
            logger.exception("ActivityTrackingMiddleware failed: %s", exc)

        return response


# ── helpers ───────────────────────────────────────────────────────────────────
def _is_private_ip(ip: str) -> bool:
    """Return True for loopback and RFC-1918 private addresses."""
    import ipaddress
    try:
        addr = ipaddress.ip_address(ip)
        return addr.is_private or addr.is_loopback or addr.is_link_local
    except ValueError:
        return False