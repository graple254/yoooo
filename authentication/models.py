from django.db import models
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


