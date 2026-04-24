import os
import django
from django.core.asgi import get_asgi_application

# 1. Set the environment variable first
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'chichi.settings')

# 2. Initialize Django (crucial: must be done before importing routing/consumers)
django.setup()

# 3. NOW import your Channels components and routing
from channels.routing import ProtocolTypeRouter, URLRouter
from channels.auth import AuthMiddlewareStack
from core.routing import websocket_urlpatterns

# 4. Define the application
application = ProtocolTypeRouter(
    {
        "http": get_asgi_application(),
        "websocket": AuthMiddlewareStack(
            URLRouter(websocket_urlpatterns)
        ),
    }
)
