from django.apps import AppConfig


class AuthenticationConfig(AppConfig):
    name = 'authentication'
    def ready(self):
        # Import signal handlers to register them when the app is ready
        try:
            import authentication.signals  # noqa: F401
        except Exception:
            pass
