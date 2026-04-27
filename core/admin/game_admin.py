from django.contrib import admin
from core.models import GameType, GameResult


# ─────────────────────────────────────────────
# GameType Admin
# ─────────────────────────────────────────────
@admin.register(GameType)
class GameTypeAdmin(admin.ModelAdmin):
    list_display = (
        "name",
        "display_name",
        "win_points",
        "draw_points",
        "loss_points",
        "active",
    )
    list_filter = ("active",)
    search_fields = ("name", "display_name")
    ordering = ("name",)


# ─────────────────────────────────────────────
# GameResult Admin
# ─────────────────────────────────────────────
@admin.register(GameResult)
class GameResultAdmin(admin.ModelAdmin):
    list_display = (
        "id",
        "user",
        "opponent",
        "game_type",
        "points_earned",
        "is_win",
        "is_draw",
        "is_loss",
        "is_forfeit",
        "timestamp",
    )

    list_filter = (
        "game_type",
        "is_win",
        "is_draw",
        "is_loss",
        "is_forfeit",
        "timestamp",
    )

    search_fields = (
        "user__username",
        "opponent__username",
        "match_session_id",
    )

    readonly_fields = (
        "match_session_id",
        "timestamp",
    )

    ordering = ("-timestamp",)
