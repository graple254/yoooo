from django.contrib import admin
from django.contrib.auth import get_user_model
from .models import UserTermsAndPolicy

CustomUser = get_user_model()

admin.site.register(CustomUser)


@admin.register(UserTermsAndPolicy)
class UserTermsAndPolicyAdmin(admin.ModelAdmin):
    list_display = ('user', 'terms_and_conditions_agreed', 'age_confirmation', 'promotional_emails_agreed', 'updated_at')
    list_filter = ('terms_and_conditions_agreed', 'age_confirmation', 'promotional_emails_agreed', 'created_at')
    search_fields = ('user__email', 'user__username')
    readonly_fields = ('created_at', 'updated_at')
    fieldsets = (
        ('User', {
            'fields': ('user',)
        }),
        ('Agreements', {
            'fields': ('terms_and_conditions_agreed', 'age_confirmation', 'promotional_emails_agreed')
        }),
        ('Timestamps', {
            'fields': ('created_at', 'updated_at'),
            'classes': ('collapse',)
        }),
    )