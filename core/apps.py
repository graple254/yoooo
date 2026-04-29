"""
core/apps.py
────────────────────────────────────────────────────────────────────────────
Flushes stale Redis presence state on every server startup so that counts
never carry over from a previous process that was killed without clean shutdown.
"""
 
from django.apps import AppConfig
 
 
class CoreConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "core"
 
    def ready(self):
        # Wipe presence counters so we start from zero.
        # This runs once when Daphne/Django boots — before any WebSocket
        # connections are accepted — so there is no race condition.
        from core.presence import flush_presence_state
        flush_presence_state()
 