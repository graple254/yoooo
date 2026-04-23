from django.shortcuts import render, redirect, get_object_or_404
from django.contrib import messages
from django.contrib.auth.decorators import login_required


@login_required
def home_view(request):
    return render(request, 'files/home.html')


@login_required
def connect_view(request):
    return render(request, 'files/connect.html')


##StartUp commands;  daphne -b 0.0.0.0 -p 8000 chichi.asgi:application
## Redis Startup command; redis-server --port 6380
## Remember to change csrf origins in settings.py and google oauth credentials.