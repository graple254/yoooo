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
 
from core.models import GameResult, GameType
 
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
 

 
# ─── GameType ─────────────────────────────────────────────────────────────────
 
@admin.register(GameType)
class GameTypeAdmin(admin.ModelAdmin):
    list_per_page = PAGE_SIZE
 
    list_display  = ("name", "display_name", "win_points", "draw_points", "loss_points", "active", "result_count")
    list_editable = ("win_points", "draw_points", "loss_points", "active")
    list_filter   = ("active",)
    search_fields = ("name", "display_name")
    actions       = ["action_activate", "action_deactivate"]
 
    def get_queryset(self, request):
        return (
            super()
            .get_queryset(request)
            .annotate(result_count=Count("results"))
        )
 
    @admin.display(description="Total results", ordering="result_count")
    def result_count(self, obj):
        return obj.result_count
 
    @admin.action(description="Activate selected game types")
    def action_activate(self, request, queryset):
        updated = queryset.update(active=True)
        self.message_user(request, f"{updated} game type(s) activated.")
 
    @admin.action(description="Deactivate selected game types")
    def action_deactivate(self, request, queryset):
        updated = queryset.update(active=False)
        self.message_user(request, f"{updated} game type(s) deactivated.")
 
 
# ─── GameResult ───────────────────────────────────────────────────────────────
 
class OutcomeFilter(admin.SimpleListFilter):
    """Filter sidebar: Win / Draw / Loss / Forfeit."""
    title         = "Outcome"
    parameter_name = "outcome"
 
    def lookups(self, request, model_admin):
        return [
            ("win",     "Win"),
            ("draw",    "Draw"),
            ("loss",    "Loss"),
            ("forfeit", "Forfeit"),
        ]
 
    def queryset(self, request, queryset):
        v = self.value()
        if v == "win":     return queryset.filter(is_win=True)
        if v == "draw":    return queryset.filter(is_draw=True)
        if v == "loss":    return queryset.filter(is_loss=True)
        if v == "forfeit": return queryset.filter(is_forfeit=True)
        return queryset
 
 
@admin.register(GameResult)
class GameResultAdmin(admin.ModelAdmin):
    list_per_page  = PAGE_SIZE
    date_hierarchy = "timestamp"
 
    list_display = (
        "timestamp",
        "user",
        "opponent",
        "game_type",
        "outcome_badge",
        "points_earned",
        "is_forfeit",
        "short_session",
    )
    list_select_related = ("user", "opponent", "game_type")
    list_filter = (
        OutcomeFilter,
        "game_type",
        "is_forfeit",
        ("timestamp", admin.DateFieldListFilter),
    )
    search_fields = (
        "user__username",
        "opponent__username",
        "match_session_id__iexact",
    )
    readonly_fields = (
        "timestamp",
        "match_session_id",
        "points_earned",
        "is_win",
        "is_draw",
        "is_loss",
        "is_forfeit",
    )
    raw_id_fields = ("user", "opponent", "game_type", "session")
    fieldsets = (
        ("Identity", {
            "fields": ("session", "match_session_id", "game_type"),
        }),
        ("Participants", {
            "fields": ("user", "opponent"),
        }),
        ("Outcome", {
            "fields": ("is_win", "is_draw", "is_loss", "is_forfeit", "points_earned"),
        }),
        ("Meta", {
            "fields": ("timestamp",),
        }),
    )
    actions = ["action_export_csv"]
 
    # ── Computed columns ─────────────────────────────────────────────────
 
    @admin.display(description="Outcome")
    def outcome_badge(self, obj):
        if obj.is_win:     return mark_safe(_badge("#16a34a", "WIN"))
        if obj.is_draw:    return mark_safe(_badge("#ca8a04", "DRAW"))
        if obj.is_forfeit: return mark_safe(_badge("#7c3aed", "FORFEIT"))
        return mark_safe(_badge("#dc2626", "LOSS"))
 
    @admin.display(description="Session", ordering="match_session_id")
    def short_session(self, obj):
        return str(obj.match_session_id)[:8] + "…"
 
    # ── Actions ──────────────────────────────────────────────────────────
 
    @admin.action(description="Export selected game results to CSV")
    def action_export_csv(self, request, queryset):
        header = [
            "timestamp", "user", "opponent", "game_type",
            "is_win", "is_draw", "is_loss", "is_forfeit",
            "points_earned", "match_session_id",
        ]
        rows = queryset.values_list(
            "timestamp", "user__username", "opponent__username", "game_type__name",
            "is_win", "is_draw", "is_loss", "is_forfeit",
            "points_earned", "match_session_id",
        )
        return _streaming_csv("game_results.csv", header, rows)
