import logging
from django.conf import settings

logger = logging.getLogger(__name__)

try:
    from sib_api_v3_sdk import Configuration, ApiClient, TransactionalEmailsApi, SendSmtpEmail
    from sib_api_v3_sdk.rest import ApiException
except Exception:
    Configuration = ApiClient = TransactionalEmailsApi = SendSmtpEmail = None
    ApiException = Exception


def _get_brevo_api():
    api_key = getattr(settings, 'BREVO_API_KEY', None)
    if not api_key or Configuration is None:
        logger.warning('Brevo API key missing or SDK not installed')
        return None

    configuration = Configuration()
    configuration.api_key['api-key'] = api_key
    api_client = ApiClient(configuration)
    return TransactionalEmailsApi(api_client)


def send_transac_email(to_emails, subject, html_content, sender_email=None, sender_name=None):
    """Send a transactional email via Brevo (Sendinblue).

    - `to_emails` may be a single email or an iterable of emails.
    - `sender_email` should be one of configured sender addresses.
    """
    email_api = _get_brevo_api()
    if email_api is None:
        logger.error('Brevo email API not available, aborting send')
        return {
            'ok': False,
            'response': None,
            'error_code': 'client_not_configured',
            'error_message': 'Brevo API key missing or SDK not installed',
            'fatal': True,
        }

    if isinstance(to_emails, str):
        to_emails = [to_emails]

    sender_email = sender_email or getattr(settings, 'DEFAULT_FROM_EMAIL', None)
    sender_name = sender_name or getattr(settings, 'DEFAULT_FROM_NAME', '')

    send_email = SendSmtpEmail(
        to=[{"email": e} for e in to_emails],
        sender={"name": sender_name, "email": sender_email},
        subject=subject,
        html_content=html_content,
    )

    try:
        response = email_api.send_transac_email(send_email)
        logger.info('Email sent to %s; message_id=%s', to_emails, getattr(response, 'message_id', None))
        return {
            'ok': True,
            'response': response,
            'error_code': None,
            'error_message': None,
            'fatal': False,
        }
    except ApiException as e:
        status = getattr(e, 'status', None)
        body = str(getattr(e, 'body', '') or '')
        message = str(e)

        # Brevo IP authorization failures should stop batch sends immediately.
        is_ip_auth_error = (
            status == 401 and
            ('authorised_ips' in body or 'unrecognised IP address' in body or 'unauthorized' in body.lower())
        )

        if is_ip_auth_error:
            safe_message = 'Brevo rejected request: current server IP is not authorized in Brevo security settings.'
            logger.error('%s', safe_message)
            return {
                'ok': False,
                'response': None,
                'error_code': 'brevo_ip_not_authorized',
                'error_message': safe_message,
                'fatal': True,
            }

        logger.error('Brevo send error: %s', message)
        return {
            'ok': False,
            'response': None,
            'error_code': f'brevo_http_{status}' if status else 'brevo_error',
            'error_message': message,
            'fatal': False,
        }


def send_welcome_email(user):
    """Render and send the welcome email to a single user.

    This is transactional and should be sent at first signup.
    """
    from django.template.loader import render_to_string

    subject = getattr(settings, 'WELCOME_SUBJECT', 'Welcome to Chichi')
    html = render_to_string('emails/welcome.html', {'user': user})
    sender = getattr(settings, 'WELCOME_SENDER_EMAIL', getattr(settings, 'DEFAULT_FROM_EMAIL', None))
    sender_name = getattr(settings, 'WELCOME_SENDER_NAME', getattr(settings, 'DEFAULT_FROM_NAME', ''))

    return send_transac_email(user.email, subject, html, sender_email=sender, sender_name=sender_name)


def send_marketing_email(users, subject, html_content, sender_email=None, sender_name=None):
    """Send marketing/promotional emails to a list/queryset of users.

    This sends individual emails (one-to-one) to avoid exposing recipients.
    """
    # Accept queryset, list of users, or list of emails
    emails = []
    for u in users:
        if hasattr(u, 'email'):
            emails.append(u.email)
        else:
            emails.append(u)

    # dedupe
    emails = list(dict.fromkeys([e for e in emails if e]))

    results = []
    for e in emails:
        res = send_transac_email(e, subject, html_content, sender_email=sender_email, sender_name=sender_name)
        results.append((e, res))

        if res.get('fatal'):
            # Abort remaining sends on fatal transport/auth issues.
            break

    return results
