from allauth.account.signals import user_signed_up
from django.dispatch import receiver
from django.conf import settings
from django.template.loader import render_to_string
import logging

from .models import AdminEmailSendLog

logger = logging.getLogger(__name__)


@receiver(user_signed_up)
def handle_user_signed_up(request, user, **kwargs):
    """Send a welcome email when a user signs up for the first time.

    Uses the centralized email helper `core.email.send_welcome_email`.
    """
    try:
        # Import here to avoid import cycles at import-time
        from core.email import send_welcome_email

        response = send_welcome_email(user)

        subject = getattr(settings, 'WELCOME_SUBJECT', 'Welcome to Chichi')
        sender_email = getattr(
            settings,
            'WELCOME_SENDER_EMAIL',
            getattr(settings, 'DEFAULT_FROM_EMAIL', ''),
        )
        content = render_to_string('emails/welcome.html', {'user': user})

        AdminEmailSendLog.objects.create(
            created_by=None,
            sender_email=sender_email,
            subject=subject,
            content=content,
            recipient_scope=AdminEmailSendLog.SCOPE_SELECTED,
            intended_recipients=1,
            sent_count=1 if response.get('ok') else 0,
            failed_count=0 if response.get('ok') else 1,
            excluded_count=0,
            sent_recipients=[user.email] if response.get('ok') else [],
            failed_recipients=[user.email] if not response.get('ok') else [],
        )

        logger.info('Triggered welcome email for user %s', getattr(user, 'email', user))
    except Exception as exc:
        logger.exception('Error sending welcome email: %s', exc)
