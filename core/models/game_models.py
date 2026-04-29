"""
core/models.py  — append these two models below the existing MatchSession,
UserActivity, and TrafficSnapshot models already in the file.

Do NOT replace the file — paste from the dashed line downward.
"""

# ─────────────────────────────────────────────────────────────────────────────
#  Game engine models
# ─────────────────────────────────────────────────────────────────────────────
import uuid
from django.db import models
from django.contrib.auth import get_user_model
from .match_session import MatchSession   # for the match_session_id FK in GameResult

User = get_user_model()   # already imported at top of your models.py — keep one copy


class GameType(models.Model):
    """
    Plugin descriptor for each mini-game.

    One row per game variant.  Seed via fixture or the admin:
        name="3mm"  display_name="Three Men's Morris"
        win_points=3  draw_points=1  loss_points=-1

    Adding a new game = adding a new row here + a new JS engine file.
    No code changes required in consumers.py or connect.html.
    """
    name         = models.CharField(max_length=32, unique=True,
                       help_text='Short code used in WS messages, e.g. "3mm".')
    display_name = models.CharField(max_length=64,
                       help_text='Human-readable label shown in the UI.')
    win_points   = models.IntegerField(default=3)
    draw_points  = models.IntegerField(default=1)
    loss_points  = models.IntegerField(default=-1)
    active       = models.BooleanField(default=True,
                       help_text="Deactivated game types are not offered to users.")

    class Meta:
        ordering = ["name"]
        verbose_name        = "Game type"
        verbose_name_plural = "Game types"

    def __str__(self):
        return f"{self.display_name} (W+{self.win_points} / D+{self.draw_points} / L{self.loss_points})"

    def points_for(self, is_win: bool, is_draw: bool) -> int:
        """Return the correct point value for the given outcome."""
        if is_win:   return self.win_points
        if is_draw:  return self.draw_points
        return self.loss_points   # loss


class GameResult(models.Model):
    """
    One row per player per game.  A single game therefore produces TWO rows
    (one for each participant) so per-user stat aggregation is a simple
    .filter(user=u).aggregate(total=Sum('points_earned')).

    Written by the consumer's _save_game_result() wrapper on:
      • "game_over" message received (normal completion)
      • disconnect() while game_session_id is set (forfeit → -1 for quitter)
    """
    # ── Identity ──────────────────────────────────────────────────────────
    # Mirrors MatchSession.session_id so results can be joined to video sessions.
    session = models.ForeignKey(
        MatchSession,
        on_delete=models.CASCADE,
        null=True,  # allow null for legacy records before this was added
        related_name="game_results",
    )
    match_session_id = models.UUIDField(
        db_index=True,
        help_text="UUID of the parent MatchSession (not a FK to avoid coupling).",
    )
    game_type = models.ForeignKey(
        GameType,
        on_delete=models.PROTECT,
        related_name="results",
    )

    # ── Participants ──────────────────────────────────────────────────────
    user     = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        related_name="game_results",
    )
    opponent = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        related_name="game_results_as_opponent",
    )

    # ── Outcome ───────────────────────────────────────────────────────────
    is_win    = models.BooleanField(default=False)
    is_draw   = models.BooleanField(default=False)
    is_loss   = models.BooleanField(default=False)
    is_forfeit = models.BooleanField(default=False,
                    help_text="True when the player disconnected mid-game.")
    points_earned = models.IntegerField(default=0,
                        help_text="Positive (win/draw) or negative (loss) delta applied to total score.")

    timestamp = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering            = ["-timestamp"]
        verbose_name        = "Game result"
        verbose_name_plural = "Game results"
        # Composite index: fast per-user leaderboard queries
        indexes = [
            models.Index(fields=["user", "game_type", "timestamp"],
                         name="gr_user_game_ts"),
        ]

    def __str__(self):
        outcome = "WIN" if self.is_win else ("DRAW" if self.is_draw else "LOSS")
        who = self.user.username if self.user else "?"
        return f"{who} — {outcome} ({self.points_earned:+d}pt) @ {self.timestamp:%Y-%m-%d %H:%M}"

    @classmethod
    def record_pair(cls, match_session_id, game_type,
                    winner, loser,
                    is_draw=False, winner_forfeit=False, loser_forfeit=False,
                    match_session=None):   # FIX-1: accept MatchSession instance
        """
        Convenience class method: write both rows atomically.
        Pass match_session=<MatchSession instance> to populate the FK column.
        """
        from django.db import transaction

        if is_draw:
            pts_a = game_type.draw_points
            pts_b = game_type.draw_points
            win_a = win_b = False
            draw_a = draw_b = True
            loss_a = loss_b = False
        elif winner_forfeit:
            pts_a = game_type.loss_points
            pts_b = game_type.win_points
            win_a = False; win_b = True
            draw_a = draw_b = False
            loss_a = True; loss_b = False
        else:
            pts_a = game_type.win_points
            pts_b = game_type.loss_points
            win_a = True; win_b = False
            draw_a = draw_b = False
            loss_a = False; loss_b = True

        with transaction.atomic():
            cls.objects.create(
                session=match_session,            # FIX-1
                match_session_id=match_session_id,
                game_type=game_type,
                user=winner,
                opponent=loser,
                is_win=win_a, is_draw=draw_a, is_loss=loss_a,
                is_forfeit=winner_forfeit,
                points_earned=pts_a,
            )
            cls.objects.create(
                session=match_session,            # FIX-1
                match_session_id=match_session_id,
                game_type=game_type,
                user=loser,
                opponent=winner,
                is_win=win_b, is_draw=draw_b, is_loss=loss_b,
                is_forfeit=loser_forfeit,
                points_earned=pts_b,
            )