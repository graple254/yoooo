"""
auth/admin.py  (or wherever your CustomUser admin lives)

Adds an "Online" boolean column to the user changelist.
It reads presence:online_users from Redis — the same set maintained by
MatchmakingConsumer — so no extra tracking is needed.

The Redis lookup is synchronous and cheap (one SMEMBERS per page render).
Results are cached for ONLINE_CHECK_CACHE_TTL seconds (default 15) to avoid
hammering Redis when the changelist renders 50+ rows.
"""

import redis as redis_sync

from django.contrib import admin
from django.contrib.auth import get_user_model
from django.contrib.auth.admin import UserAdmin
from django.core.cache import cache
from django.conf import settings
from django import forms
from django.urls import path
from django.shortcuts import render, redirect
from django.contrib import messages
from django.urls import reverse

from .models import UserTermsAndPolicy, AdminEmailSendLog

CustomUser = get_user_model()

# ── Redis presence helpers ─────────────────────────────────────────────────────

_ONLINE_USERS_KEY       = "presence:online_users"
_ONLINE_CHECK_CACHE_TTL = getattr(settings, "ONLINE_CHECK_CACHE_TTL", 15)  # seconds


def _get_online_set() -> set:
    """
    Return the set of online user PKs (as strings) from Redis.
    Cached for _ONLINE_CHECK_CACHE_TTL seconds so a 50-row changelist
    does not make 50 Redis round-trips.
    """
    cache_key = "admin:online_user_pks"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    try:
        r = redis_sync.from_url(
            getattr(settings, "REDIS_URL", "redis://127.0.0.1:6380"),
            decode_responses=True,
            socket_connect_timeout=1,
            socket_timeout=1,
        )
        members = r.smembers(_ONLINE_USERS_KEY)
        r.close()
    except Exception:
        members = set()

    cache.set(cache_key, members, _ONLINE_CHECK_CACHE_TTL)
    return members


# ── CustomUser admin ───────────────────────────────────────────────────────────

@admin.register(CustomUser)
class CustomUserAdmin(UserAdmin):
    """
    Extends Django's built-in UserAdmin so all default fields, filters,
    and password-change tooling are preserved. The online indicator is
    appended as an extra column.
    """

    list_display = UserAdmin.list_display + ("is_online_now",)
    list_filter  = UserAdmin.list_filter  + ("is_active",)

    @admin.display(description="Online", boolean=True)
    def is_online_now(self, obj):
        return str(obj.pk) in _get_online_set()

    # Admin action to initiate marketing send
    actions = ['admin_send_marketing_action']

    def get_urls(self):
        urls = super().get_urls()
        custom_urls = [
            path('send-marketing/', self.admin_site.admin_view(self.send_marketing_view), name='authentication_customuser_send_marketing'),
        ]
        return custom_urls + urls

    def admin_send_marketing_action(self, request, queryset):
        """Admin action: redirect to the send marketing form with selected user ids."""
        ids = ",".join(str(x.pk) for x in queryset)
        url = reverse('admin:authentication_customuser_send_marketing') + f'?ids={ids}'
        return redirect(url)

    admin_send_marketing_action.short_description = 'Send marketing email to selected users'

    def send_marketing_view(self, request):
        """Custom admin view to compose and send marketing emails.

        - Supports sending to selected users (only those opted-in will receive)
        - Supports sending to all opted-in users
        """
        class MarketingEmailForm(forms.Form):
            subject = forms.CharField(max_length=200)
            content = forms.CharField(widget=forms.Textarea(attrs={'rows': 12}))
            sender_email = forms.ChoiceField(choices=[(s, s) for s in getattr(settings, 'ALLOWED_SENDER_EMAILS', [getattr(settings, 'DEFAULT_FROM_EMAIL')])])
            recipient_scope = forms.ChoiceField(choices=(('selected', 'Selected users (only opted-in will receive)'), ('opted_in_all', 'All users who opted-in to promotional emails')))
            user_ids = forms.CharField(widget=forms.HiddenInput(), required=False)

        if request.method == 'POST':
            form = MarketingEmailForm(request.POST)
            if form.is_valid():
                subject = form.cleaned_data['subject']
                content = form.cleaned_data['content']
                sender_email = form.cleaned_data['sender_email']
                scope = form.cleaned_data['recipient_scope']
                ids_raw = form.cleaned_data.get('user_ids') or ''
                ids = [int(i) for i in ids_raw.split(',') if i.strip()] if ids_raw else []

                # Determine recipients respecting promotional opt-in
                if scope == 'selected' and ids:
                    users = CustomUser.objects.filter(pk__in=ids)
                    opted_in_users = CustomUser.objects.filter(
                        pk__in=users.values_list('pk', flat=True),
                        terms_and_policy__promotional_emails_agreed=True,
                    )
                    excluded_count = users.count() - opted_in_users.count()
                else:
                    opted_in_users = CustomUser.objects.filter(terms_and_policy__promotional_emails_agreed=True)
                    excluded_count = 0

                if opted_in_users.count() == 0:
                    messages.error(request, 'No recipients found who have opted-in to promotional emails.')
                    return redirect(reverse('admin:authentication_customuser_changelist'))

                # Send emails (synchronous)
                from core.email import send_marketing_email

                results = send_marketing_email(opted_in_users, subject, content, sender_email=sender_email, sender_name=None)

                success_count = sum(1 for _, r in results if r.get('ok'))
                fail_count = len(results) - success_count
                sent_recipients = [email for email, response in results if response.get('ok')]
                failed_recipients = [email for email, response in results if not response.get('ok')]
                fatal_errors = [response for _, response in results if response.get('fatal')]

                # Persist an auditable log for compliance and admin visibility.
                AdminEmailSendLog.objects.create(
                    created_by=request.user if request.user.is_authenticated else None,
                    sender_email=sender_email,
                    subject=subject,
                    content=content,
                    recipient_scope=scope,
                    intended_recipients=opted_in_users.count() + excluded_count,
                    sent_count=success_count,
                    failed_count=fail_count,
                    excluded_count=excluded_count,
                    sent_recipients=sent_recipients,
                    failed_recipients=failed_recipients,
                )

                msg = f"Sent to {success_count} recipients. {fail_count} failures."
                if excluded_count:
                    msg = msg + f" {excluded_count} selected users were excluded because they haven't opted in."

                if fatal_errors:
                    msg = msg + f" Sending stopped early due to: {fatal_errors[0].get('error_message')}"

                if fail_count:
                    messages.warning(request, msg)
                else:
                    messages.success(request, msg)
                return redirect(reverse('admin:authentication_customuser_changelist'))
        else:
            ids = request.GET.get('ids', '')
            initial = {'user_ids': ids}
            form = MarketingEmailForm(initial=initial)

        selected_count = 0
        if request.GET.get('ids'):
            selected_count = len([i for i in request.GET.get('ids').split(',') if i.strip()])

        context = {
            **self.admin_site.each_context(request),
            'opts': self.model._meta,
            'form': form,
            'selected_count': selected_count,
        }

        return render(request, 'admin/authentication/send_marketing.html', context)


# ── UserTermsAndPolicy admin (unchanged) ──────────────────────────────────────

@admin.register(UserTermsAndPolicy)
class UserTermsAndPolicyAdmin(admin.ModelAdmin):
    list_display = ("user", "terms_and_conditions_agreed", "age_confirmation",
                    "promotional_emails_agreed", "updated_at")
    list_filter  = ("terms_and_conditions_agreed", "age_confirmation",
                    "promotional_emails_agreed", "created_at")
    search_fields   = ("user__email", "user__username")
    readonly_fields = ("created_at", "updated_at")
    fieldsets = (
        ("User",       {"fields": ("user",)}),
        ("Agreements", {"fields": ("terms_and_conditions_agreed",
                                   "age_confirmation",
                                   "promotional_emails_agreed")}),
        ("Timestamps", {"fields": ("created_at", "updated_at"),
                        "classes": ("collapse",)}),
    )


@admin.register(AdminEmailSendLog)
class AdminEmailSendLogAdmin(admin.ModelAdmin):
    list_display = (
        'created_at',
        'created_by',
        'sender_email',
        'subject',
        'recipient_scope',
        'intended_recipients',
        'sent_count',
        'failed_count',
        'excluded_count',
    )
    list_filter = ('recipient_scope', 'sender_email', 'created_at')
    search_fields = ('subject', 'sender_email', 'created_by__email')
    readonly_fields = (
        'created_at',
        'created_by',
        'sender_email',
        'subject',
        'content',
        'recipient_scope',
        'intended_recipients',
        'sent_count',
        'failed_count',
        'excluded_count',
        'sent_recipients',
        'failed_recipients',
    )

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False