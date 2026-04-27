from django.shortcuts import render, redirect, get_object_or_404
from django.contrib import messages
from django.contrib.auth.decorators import login_required
from django.http import JsonResponse
from authentication.models import UserTermsAndPolicy


def index_view(request):
    return render(request, 'files/index.html', {
        'is_authenticated': request.user.is_authenticated,
    })


@login_required
def connect_view(request):
    # Check if user has terms and policy agreement
    try:
        terms_and_policy = UserTermsAndPolicy.objects.get(user=request.user)
        has_agreed_to_terms = (terms_and_policy.terms_and_conditions_agreed and
                               terms_and_policy.age_confirmation)
    except UserTermsAndPolicy.DoesNotExist:
        has_agreed_to_terms = False
    
    return render(request, 'files/connect.html', {
        'has_agreed_to_terms': has_agreed_to_terms,
    })


@login_required
def accept_terms_and_policy(request):
    """Handle terms and policy acceptance"""
    if request.method == 'POST':
        terms_agreed = request.POST.get('terms_and_conditions') == 'on'
        age_confirmed = request.POST.get('age_confirmation') == 'on'
        promotional = request.POST.get('promotional_emails') == 'on'
        
        # Get or create the UserTermsAndPolicy record
        terms_and_policy, created = UserTermsAndPolicy.objects.get_or_create(user=request.user)
        
        # Update the fields
        terms_and_policy.terms_and_conditions_agreed = terms_agreed
        terms_and_policy.age_confirmation = age_confirmed
        terms_and_policy.promotional_emails_agreed = promotional
        terms_and_policy.save()
        
        if request.headers.get('X-Requested-With') == 'XMLHttpRequest':
            return JsonResponse({'success': True, 'message': 'Terms and policy accepted'})
        
        messages.success(request, 'Thank you for accepting our terms and policies.')
        return redirect('connect')
    
    return JsonResponse({'error': 'Method not allowed'}, status=405)


##StartUp commands;  daphne -b 0.0.0.0 -p 8000 chichi.asgi:application
## Redis Startup command; redis-server --port 6380
## Remember to change csrf origins in settings.py and google oauth credentials.