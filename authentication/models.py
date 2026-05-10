from django.db import models
from django.conf import settings
from django.contrib.auth.models import AbstractUser
from django.utils import timezone

class CustomUser(AbstractUser):
    username = models.CharField(max_length=100)
    email = models.EmailField(max_length=100, unique=True)
    password = models.CharField(max_length=100)

    USERNAME_FIELD = 'email'
    REQUIRED_FIELDS = ['username']


class UserTermsAndPolicy(models.Model):
    user = models.OneToOneField(CustomUser, on_delete=models.CASCADE, related_name='terms_and_policy')
    terms_and_conditions_agreed = models.BooleanField(default=False, help_text="User agrees to terms and acceptable use policy")
    age_confirmation = models.BooleanField(default=False, help_text="User confirms they are at least 18 years old")
    promotional_emails_agreed = models.BooleanField(default=False, help_text="User agrees to receive promotional emails")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "User Terms and Policy"
        verbose_name_plural = "User Terms and Policies"

    def __str__(self):
        return f"{self.user.email} - Terms Agreement"


class AdminEmailSendLog(models.Model):
    SCOPE_SELECTED = 'selected'
    SCOPE_OPTED_IN_ALL = 'opted_in_all'

    RECIPIENT_SCOPE_CHOICES = (
        (SCOPE_SELECTED, 'Selected users'),
        (SCOPE_OPTED_IN_ALL, 'All opted-in users'),
    )

    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='email_send_logs',
    )
    sender_email = models.EmailField(max_length=254)
    subject = models.CharField(max_length=200)
    content = models.TextField()
    recipient_scope = models.CharField(max_length=20, choices=RECIPIENT_SCOPE_CHOICES)
    intended_recipients = models.PositiveIntegerField(default=0)
    sent_count = models.PositiveIntegerField(default=0)
    failed_count = models.PositiveIntegerField(default=0)
    excluded_count = models.PositiveIntegerField(default=0)
    sent_recipients = models.JSONField(default=list, blank=True)
    failed_recipients = models.JSONField(default=list, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ('-created_at',)
        verbose_name = 'Admin Email Send Log'
        verbose_name_plural = 'Admin Email Send Logs'

    def __str__(self):
        return f"{self.subject} ({self.sent_count} sent)"


