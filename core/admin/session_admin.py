from django.contrib import admin
from django.utils.html import format_html
from core.models import MatchSession


@admin.register(MatchSession)
class MatchSessionAdmin(admin.ModelAdmin):
    list_display  = (
        "short_id", "user_one", "user_two",
        "start_time", "duration_seconds",
        "reported_badge", "reported_by",
    )
    list_filter   = ("reported", "start_time")
    search_fields = (
        "session_id", "user_one__username", "user_two__username",
        "reported_by__username",
    )
    readonly_fields = (
        "session_id", "start_time", "end_time",
        "duration_seconds", "reported_at",
    )
    ordering = ("-start_time",)

    @admin.display(description="Session ID")
    def short_id(self, obj):
        return str(obj.session_id)[:8] + "…"

# core/admin.py

    @admin.display(description="Reported", boolean=False)
    def reported_badge(self, obj):
        if obj.reported:
            # Pass the content as an argument to format_html
            return format_html('<span style="color:red;font-weight:bold">{}</span>', '⚑ YES')
        return format_html('<span style="color:gray">{}</span>', '—')
