from django.contrib import admin
from django.utils.html import format_html
from core.models import UserActivity, TrafficSnapshot
 
@admin.register(UserActivity)
class UserActivityAdmin(admin.ModelAdmin):
    list_display   = ("timestamp", "user_display", "ip_address", "location", "path", "short_ua")
    list_filter    = ("timestamp",)
    search_fields  = ("ip_address", "user__username", "path", "location")
    readonly_fields = (
        "user", "ip_address", "location", "path", "user_agent", "timestamp",
    )
    ordering       = ("-timestamp",)
    # Prevent admins accidentally editing log records
    def has_add_permission(self, request):    return False
    def has_change_permission(self, request, obj=None): return False
 
    @admin.display(description="User")
    def user_display(self, obj):
        if obj.user:
            return format_html(
                '<span style="font-weight:600">{}</span>', obj.user.username
            )
        return format_html('<span style="color:#aaa">{}</span>', 'anonymous')
 
    @admin.display(description="User-Agent")
    def short_ua(self, obj):
        return (obj.user_agent[:60] + "…") if len(obj.user_agent) > 60 else obj.user_agent
 
 
@admin.register(TrafficSnapshot)
class TrafficSnapshotAdmin(admin.ModelAdmin):
    list_display  = (
        "hour_bucket", "total_connections",
        "authenticated_users", "requests_in_hour", "captured_at",
    )
    list_filter   = ("hour_bucket",)
    readonly_fields = (
        "captured_at", "hour_bucket",
        "total_connections", "authenticated_users", "requests_in_hour",
    )
    ordering      = ("-hour_bucket",)
 
    def has_add_permission(self, request):    return False
    def has_change_permission(self, request, obj=None): return False