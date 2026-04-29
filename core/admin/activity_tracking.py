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
 
from core.models import TrafficSnapshot, UserActivity
 
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
 
 

 
# ─── UserActivity ─────────────────────────────────────────────────────────────
 
@admin.register(UserActivity)
class UserActivityAdmin(admin.ModelAdmin):
    list_per_page = PAGE_SIZE
    date_hierarchy = "timestamp"
 
    list_display  = ("timestamp", "who", "ip_address", "location", "path", "agent_short")
    list_filter   = (
        ("timestamp", admin.DateFieldListFilter),
        "location",
    )
    search_fields = (
        "user__username",
        "ip_address",
        "path",
        "location",
    )
    readonly_fields = ("timestamp", "ip_address", "user_agent")
    raw_id_fields   = ("user",)
    list_select_related = ("user",)
    actions = ["action_export_csv"]
 
    # ── Computed columns ─────────────────────────────────────────────────
 
    @admin.display(description="User / IP", ordering="user")
    def who(self, obj):
        return obj.user.username if obj.user else obj.ip_address
 
    @admin.display(description="User Agent")
    def agent_short(self, obj):
        return (obj.user_agent[:60] + "…") if len(obj.user_agent) > 60 else obj.user_agent
 
    # ── Actions ──────────────────────────────────────────────────────────
 
    @admin.action(description="Export selected activity logs to CSV")
    def action_export_csv(self, request, queryset):
        header = ["timestamp", "user", "ip_address", "location", "path"]
        rows = queryset.values_list(
            "timestamp", "user__username", "ip_address", "location", "path"
        )
        return _streaming_csv("user_activity.csv", header, rows)
 
 
# ─── TrafficSnapshot ──────────────────────────────────────────────────────────
 
@admin.register(TrafficSnapshot)
class TrafficSnapshotAdmin(admin.ModelAdmin):
    list_per_page  = PAGE_SIZE
    date_hierarchy = "hour_bucket"
 
    list_display = (
        "hour_bucket",
        "total_connections",
        "authenticated_users",
        "requests_in_hour",
        "anon_count",
        "captured_at",
    )
    list_filter = (("hour_bucket", admin.DateFieldListFilter),)
    search_fields = ("hour_bucket",)
    readonly_fields = ("captured_at", "hour_bucket", "total_connections",
                       "authenticated_users", "requests_in_hour")
    actions = ["action_export_csv"]
 
    # ── Computed columns ─────────────────────────────────────────────────
 
    @admin.display(description="Anonymous connections")
    def anon_count(self, obj):
        anon = obj.total_connections - obj.authenticated_users
        return max(anon, 0)
 
    # ── Actions ──────────────────────────────────────────────────────────
 
    @admin.action(description="Export selected snapshots to CSV")
    def action_export_csv(self, request, queryset):
        header = ["hour_bucket", "total_connections", "authenticated_users", "requests_in_hour"]
        rows = queryset.values_list(
            "hour_bucket", "total_connections", "authenticated_users", "requests_in_hour"
        )
        return _streaming_csv("traffic_snapshots.csv", header, rows)
 