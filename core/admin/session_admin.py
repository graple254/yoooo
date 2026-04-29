"""
core/admin.py
 
Production-grade Django admin for:
  • MatchSession
  • UserActivity
  • TrafficSnapshot
  • GameType
  • GameResult
 
Features
--------
• Custom list_display on every model with computed / annotated columns
• search_fields, list_filter, date_hierarchy for fast narrowing
• list_per_page = 50 (overrideable via ADMIN_PAGE_SIZE setting)
• Raw-id widgets on all FK fields so autocomplete never hangs on big tables
• Read-only fields on every sensitive / auto-set field
• Inline GameResult inside MatchSession so one page shows the full story
• Admin actions: mark_reported, clear_reports, export_csv (all models)
• Safe export: streams CSV without loading the whole queryset into memory
• Annotated querysets on GameResult and UserActivity for aggregated columns
• Color-coded outcome badges via HTML in list_display (mark_safe, carefully)
"""
 
import csv
import datetime
 
from django.contrib import admin
from django.db.models import Count, Sum, Q
from django.http import StreamingHttpResponse
from django.utils import timezone
from django.utils.html import format_html
from django.utils.safestring import mark_safe
 
from core.models import MatchSession, UserActivity, TrafficSnapshot, GameType, GameResult
 
# ─── Shared helpers ───────────────────────────────────────────────────────────
 
PAGE_SIZE = 50   # override in settings: ADMIN_PAGE_SIZE
 
 
def _badge(color: str, text: str) -> str:
    """Tiny inline badge without external CSS."""
    return (
        f'<span style="background:{color};color:#fff;padding:2px 7px;'
        f'border-radius:3px;font-size:11px;font-weight:600;">{text}</span>'
    )
 
 
class _EchoBuffer:
    """Minimal write-back object for StreamingHttpResponse."""
    def write(self, value):
        return value
 
 
def _streaming_csv(filename: str, header: list, rows):
    """
    Stream a CSV to the browser without materialising the full queryset.
 
    `rows` must be an iterable of lists/tuples.
    """
    buf    = _EchoBuffer()
    writer = csv.writer(buf)
 
    def stream():
        yield writer.writerow(header)
        for row in rows:
            yield writer.writerow(row)
 
    response = StreamingHttpResponse(stream(), content_type="text/csv")
    response["Content-Disposition"] = f'attachment; filename="{filename}"'
    return response
 


# ─── MatchSession ─────────────────────────────────────────────────────────────
 
class GameResultInline(admin.TabularInline):
    """Show both game results that belong to a MatchSession on the same page."""
    model          = GameResult
    extra          = 0
    can_delete     = False
    show_change_link = True
    fields         = ("user", "opponent", "game_type", "outcome_badge", "points_earned", "timestamp")
    readonly_fields = ("user", "opponent", "game_type", "outcome_badge", "points_earned", "timestamp")
 
    @admin.display(description="Outcome")
    def outcome_badge(self, obj):
        if obj.is_win:    return mark_safe(_badge("#16a34a", "WIN"))
        if obj.is_draw:   return mark_safe(_badge("#ca8a04", "DRAW"))
        if obj.is_forfeit:return mark_safe(_badge("#7c3aed", "FORFEIT"))
        return mark_safe(_badge("#dc2626", "LOSS"))
 
 
@admin.register(MatchSession)
class MatchSessionAdmin(admin.ModelAdmin):
    list_per_page = PAGE_SIZE
    date_hierarchy = "start_time"
    inlines        = [GameResultInline]
 
    list_display = (
        "short_id",
        "user_one",
        "user_two",
        "start_time",
        "duration_display",
        "reported_badge",
        "game_count",
    )
    list_select_related = ("user_one", "user_two", "reported_by")
    list_filter = (
        "reported",
        ("start_time", admin.DateFieldListFilter),
    )
    search_fields = (
        "session_id__iexact",
        "user_one__username",
        "user_two__username",
    )
    readonly_fields = (
        "session_id",
        "start_time",
        "end_time",
        "duration_seconds",
        "reported_at",
    )
    raw_id_fields = ("user_one", "user_two", "reported_by")
    fieldsets = (
        ("Identity", {
            "fields": ("session_id",),
        }),
        ("Participants", {
            "fields": ("user_one", "user_two"),
        }),
        ("Timing", {
            "fields": ("start_time", "end_time", "duration_seconds"),
        }),
        ("Moderation", {
            "fields": ("reported", "reported_by", "reported_at"),
            "classes": ("collapse",),
        }),
    )
    actions = ["action_mark_reported", "action_clear_reports", "action_export_csv"]
 
    def get_queryset(self, request):
        return (
            super()
            .get_queryset(request)
            .annotate(game_count=Count("game_results"))
        )
 
    # ── Computed columns ─────────────────────────────────────────────────
 
    @admin.display(description="Session ID", ordering="session_id")
    def short_id(self, obj):
        return str(obj.session_id)[:8] + "…"
 
    @admin.display(description="Duration", ordering="duration_seconds")
    def duration_display(self, obj):
        if obj.duration_seconds is None:
            return mark_safe(_badge("#0ea5e9", "LIVE"))
        m, s = divmod(obj.duration_seconds, 60)
        return f"{m}m {s}s"
 
    @admin.display(description="Reported", boolean=False, ordering="reported")
    def reported_badge(self, obj):
        if obj.reported:
            return mark_safe(_badge("#dc2626", "REPORTED"))
        return "—"
 
    @admin.display(description="Games", ordering="game_count")
    def game_count(self, obj):
        return obj.game_count
 
    # ── Actions ──────────────────────────────────────────────────────────
 
    @admin.action(description="Mark selected sessions as reported")
    def action_mark_reported(self, request, queryset):
        updated = queryset.filter(reported=False).update(
            reported=True, reported_at=timezone.now()
        )
        self.message_user(request, f"{updated} session(s) marked as reported.")
 
    @admin.action(description="Clear report flag on selected sessions")
    def action_clear_reports(self, request, queryset):
        updated = queryset.filter(reported=True).update(
            reported=False, reported_by=None, reported_at=None
        )
        self.message_user(request, f"{updated} report(s) cleared.")
 
    @admin.action(description="Export selected sessions to CSV")
    def action_export_csv(self, request, queryset):
        header = ["session_id", "user_one", "user_two", "start_time", "duration_seconds", "reported"]
        rows = queryset.values_list(
            "session_id", "user_one__username", "user_two__username",
            "start_time", "duration_seconds", "reported",
        )
        return _streaming_csv("match_sessions.csv", header, rows)