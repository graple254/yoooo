"""
auth/admin.py  (or wherever your CustomUser admin lives)

Adds an "Online" boolean column to the user changelist.
It reads presence:online_users from Redis — the same set maintained by
MatchmakingConsumer — so no extra tracking is needed.

The Redis lookup is synchronous and cheap (one SMEMBERS per page render).
Results are cached for ONLINE_CHECK_CACHE_TTL seconds (default 15) to avoid
hammering Redis when the changelist renders 50+ rows.
"""

import redis as redis_sync

from django.contrib import admin
from django.contrib.auth import get_user_model
from django.contrib.auth.admin import UserAdmin
from django.core.cache import cache
from django.conf import settings

from .models import UserTermsAndPolicy

CustomUser = get_user_model()

# ── Redis presence helpers ─────────────────────────────────────────────────────

_ONLINE_USERS_KEY       = "presence:online_users"
_ONLINE_CHECK_CACHE_TTL = getattr(settings, "ONLINE_CHECK_CACHE_TTL", 15)  # seconds


def _get_online_set() -> set:
    """
    Return the set of online user PKs (as strings) from Redis.
    Cached for _ONLINE_CHECK_CACHE_TTL seconds so a 50-row changelist
    does not make 50 Redis round-trips.
    """
    cache_key = "admin:online_user_pks"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    try:
        r = redis_sync.from_url(
            getattr(settings, "REDIS_URL", "redis://127.0.0.1:6380"),
            decode_responses=True,
            socket_connect_timeout=1,
            socket_timeout=1,
        )
        members = r.smembers(_ONLINE_USERS_KEY)
        r.close()
    except Exception:
        members = set()

    cache.set(cache_key, members, _ONLINE_CHECK_CACHE_TTL)
    return members


# ── CustomUser admin ───────────────────────────────────────────────────────────

@admin.register(CustomUser)
class CustomUserAdmin(UserAdmin):
    """
    Extends Django's built-in UserAdmin so all default fields, filters,
    and password-change tooling are preserved. The online indicator is
    appended as an extra column.
    """

    list_display = UserAdmin.list_display + ("is_online_now",)
    list_filter  = UserAdmin.list_filter  + ("is_active",)

    @admin.display(description="Online", boolean=True)
    def is_online_now(self, obj):
        return str(obj.pk) in _get_online_set()


# ── UserTermsAndPolicy admin (unchanged) ──────────────────────────────────────

@admin.register(UserTermsAndPolicy)
class UserTermsAndPolicyAdmin(admin.ModelAdmin):
    list_display = ("user", "terms_and_conditions_agreed", "age_confirmation",
                    "promotional_emails_agreed", "updated_at")
    list_filter  = ("terms_and_conditions_agreed", "age_confirmation",
                    "promotional_emails_agreed", "created_at")
    search_fields   = ("user__email", "user__username")
    readonly_fields = ("created_at", "updated_at")
    fieldsets = (
        ("User",       {"fields": ("user",)}),
        ("Agreements", {"fields": ("terms_and_conditions_agreed",
                                   "age_confirmation",
                                   "promotional_emails_agreed")}),
        ("Timestamps", {"fields": ("created_at", "updated_at"),
                        "classes": ("collapse",)}),
    )