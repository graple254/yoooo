import uuid
from django.db import models
from django.contrib.auth import get_user_model

User = get_user_model()



# ─────────────────────────────────────────────────────────────────────────────
#  Task 2: Activity & Location Tracking
# ─────────────────────────────────────────────────────────────────────────────
 
class UserActivity(models.Model):
    """
    One row per HTTP request — logged by ActivityTrackingMiddleware.
 
    Performance notes:
    • ip_address + timestamp are indexed so the admin can filter efficiently.
    • location is filled in lazily by the middleware (GeoIP result cached in
      Django's cache backend so ip-api.com is only hit once per unique IP).
    • user is nullable so anonymous visitors are still captured.
    """
 
    user = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="activity_logs",
        help_text="Null for unauthenticated visitors.",
    )
    ip_address = models.GenericIPAddressField(
        db_index=True,
        help_text="Client IP — X-Forwarded-For header respected for proxies/ngrok.",
    )
    location = models.CharField(
        max_length=120,
        default="Unknown",
        help_text="City, Country — resolved once per unique IP via ip-api.com.",
    )
    path = models.CharField(
        max_length=512,
        help_text="URL path of the request, e.g. /connect/.",
    )
    user_agent = models.TextField(
        blank=True,
        help_text="Raw HTTP User-Agent header.",
    )
    timestamp = models.DateTimeField(
        auto_now_add=True,
        db_index=True,
    )
 
    class Meta:
        ordering            = ["-timestamp"]
        verbose_name        = "User activity"
        verbose_name_plural = "User activity logs"
        indexes = [
            models.Index(fields=["ip_address", "timestamp"]),
            models.Index(fields=["user", "timestamp"]),
        ]
 
    def __str__(self):
        who = self.user.username if self.user else self.ip_address
        return f"{who} → {self.path} at {self.timestamp:%Y-%m-%d %H:%M}"
 
 
class TrafficSnapshot(models.Model):
    """
    Hourly snapshot of online presence counters.
 
    Written by the `snapshot_traffic` management command (schedule with cron
    or Celery beat every 60 minutes).  Used for analytics — "during this hour
    there was a surge of N users".
 
    Redis sources:
      online_count  → total WebSocket connections (ONLINE_COUNT_KEY)
      online_users  → authenticated user count     (SCARD ONLINE_USERS_KEY)
    """
 
    captured_at = models.DateTimeField(
        auto_now_add=True,
        db_index=True,
        help_text="When this snapshot was taken.",
    )
    # Floored to the hour so each hour has exactly one canonical row
    hour_bucket = models.DateTimeField(
        db_index=True,
        unique=True,
        help_text="The calendar hour this snapshot represents (minute/second = 0).",
    )
    total_connections = models.PositiveIntegerField(
        default=0,
        help_text="Value of ONLINE_COUNT_KEY at snapshot time.",
    )
    authenticated_users = models.PositiveIntegerField(
        default=0,
        help_text="SCARD of ONLINE_USERS_KEY at snapshot time.",
    )
    requests_in_hour = models.PositiveIntegerField(
        default=0,
        help_text="UserActivity rows whose timestamp falls in this hour bucket.",
    )
 
    class Meta:
        ordering            = ["-hour_bucket"]
        verbose_name        = "Traffic snapshot"
        verbose_name_plural = "Traffic snapshots"
 
    def __str__(self):
        return (
            f"{self.hour_bucket:%Y-%m-%d %H:00} — "
            f"{self.total_connections} connections, "
            f"{self.authenticated_users} users"
        )