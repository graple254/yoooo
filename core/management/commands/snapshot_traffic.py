"""
core/management/commands/snapshot_traffic.py
──────────────────────────────────────────────────────────────────────────────
Reads the current online counters from Redis and writes a TrafficSnapshot row
for the current calendar hour.  Idempotent — re-running during the same hour
updates the existing row rather than inserting a duplicate.

Schedule (pick one):
───────────────────
A) cron  (simplest, no Celery needed):
    0 * * * * /path/to/venv/bin/python /path/to/manage.py snapshot_traffic

B) Celery beat (settings.py):
    from celery.schedules import crontab
    CELERY_BEAT_SCHEDULE = {
        "snapshot-traffic": {
            "task":     "core.tasks.snapshot_traffic",
            "schedule": crontab(minute=0),   # top of every hour
        },
    }

Usage:
    python manage.py snapshot_traffic            # snapshot right now
    python manage.py snapshot_traffic --dry-run  # print values without saving
"""

import logging
from datetime import timedelta

import redis as redis_sync
from django.conf import settings
from django.core.management.base import BaseCommand
from django.utils import timezone

logger = logging.getLogger(__name__)

_ONLINE_COUNT_KEY = "presence:online_count"
_ONLINE_USERS_KEY = "presence:online_users"


class Command(BaseCommand):
    help = "Snapshot Redis online counters + request volume into TrafficSnapshot."

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Print values without writing to the database.",
        )

    def handle(self, *args, **options):
        # ── 1. Read from Redis ────────────────────────────────────────────
        total_connections   = 0
        authenticated_users = 0
        try:
            r = redis_sync.from_url(
                getattr(settings, "REDIS_URL", "redis://127.0.0.1:6379"),
                decode_responses=True,
                socket_connect_timeout=2,
                socket_timeout=2,
            )
            with r.pipeline(transaction=False) as pipe:
                pipe.get(_ONLINE_COUNT_KEY)
                pipe.scard(_ONLINE_USERS_KEY)
                count_raw, users_count = pipe.execute()

            total_connections   = max(0, int(count_raw or 0))
            authenticated_users = int(users_count or 0)
            r.close()
        except Exception as exc:
            self.stderr.write(f"Redis read failed: {exc}")
            logger.exception("snapshot_traffic: Redis error")

        # ── 2. Count requests in the current hour bucket ──────────────────
        now         = timezone.now()
        hour_bucket = now.replace(minute=0, second=0, microsecond=0)
        next_hour   = hour_bucket + timedelta(hours=1)

        from core.models import UserActivity, TrafficSnapshot

        requests_in_hour = UserActivity.objects.filter(
            timestamp__gte=hour_bucket,
            timestamp__lt=next_hour,
        ).count()

        # ── 3. Print / save ───────────────────────────────────────────────
        self.stdout.write(
            f"Hour:          {hour_bucket:%Y-%m-%d %H:00}\n"
            f"Connections:   {total_connections}\n"
            f"Auth users:    {authenticated_users}\n"
            f"Requests/hour: {requests_in_hour}\n"
        )

        if options["dry_run"]:
            self.stdout.write(self.style.WARNING("Dry run — nothing saved."))
            return

        obj, created = TrafficSnapshot.objects.update_or_create(
            hour_bucket=hour_bucket,
            defaults={
                "total_connections":   total_connections,
                "authenticated_users": authenticated_users,
                "requests_in_hour":    requests_in_hour,
            },
        )
        verb = "Created" if created else "Updated"
        self.stdout.write(self.style.SUCCESS(f"{verb} TrafficSnapshot for {hour_bucket:%Y-%m-%d %H:00}"))