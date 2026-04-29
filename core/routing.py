from django.urls import re_path
from core.presence_consumer import PresenceConsumer
from . import consumers

websocket_urlpatterns = [
    re_path(r"^ws/match/$", consumers.MatchmakingConsumer.as_asgi()),
    re_path(r"^ws/presence/$", PresenceConsumer.as_asgi()), 
]