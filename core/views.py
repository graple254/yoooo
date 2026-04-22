from django.shortcuts import render, redirect, get_object_or_404
from django.contrib import messages
from django.contrib.auth.decorators import login_required


@login_required
def home_view(request):
    return render(request, 'files/home.html')
