import uuid
from django.db import models
from django.contrib.auth import get_user_model

User = get_user_model()


class MatchSession(models.Model):
    """
    Permanent audit record for every matched pair.

    Created  → when _try_match() pairs two peers.
    Updated  → when either peer disconnects (end_time + duration_seconds).
    Flagged  → when a peer sends report_peer (reported=True, reported_by set).
    """

    # ── Identity ──────────────────────────────────────────────────────────
    session_id = models.UUIDField(
        default=uuid.uuid4,
        unique=True,
        editable=False,
        db_index=True,
        help_text="Mirrors the Redis session UUID so the consumer can look it up cheaply.",
    )

    # ── Participants ──────────────────────────────────────────────────────
    user_one = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        related_name="sessions_as_user_one",
        help_text="The peer who was already waiting in the pool (peer1 / answerer).",
    )
    user_two = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        related_name="sessions_as_user_two",
        help_text="The peer who arrived and triggered the match (peer2 / offerer).",
    )

    # ── Timing ────────────────────────────────────────────────────────────
    start_time = models.DateTimeField(
        auto_now_add=True,
        help_text="Set automatically when the record is created.",
    )
    end_time = models.DateTimeField(
        null=True,
        blank=True,
        help_text="Set when the first peer disconnects.",
    )
    duration_seconds = models.PositiveIntegerField(
        null=True,
        blank=True,
        help_text="end_time − start_time in whole seconds. Null while session is live.",
    )

    # ── Moderation ────────────────────────────────────────────────────────
    reported = models.BooleanField(
        default=False,
        db_index=True,
        help_text="True when either peer sends report_peer during the session.",
    )
    reported_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="sessions_reported",
        help_text="The User who submitted the report.",
    )
    reported_at = models.DateTimeField(
        null=True,
        blank=True,
        help_text="Timestamp of the report.",
    )

    class Meta:
        ordering = ["-start_time"]
        verbose_name        = "Match session"
        verbose_name_plural = "Match sessions"

    def __str__(self):
        u1 = self.user_one.username if self.user_one else "?"
        u2 = self.user_two.username if self.user_two else "?"
        return f"Session {str(self.session_id)[:8]} — {u1} vs {u2}"