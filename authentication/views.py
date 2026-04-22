from django.shortcuts import render

# Create your views here.


def auth_view(request):
    return render(request, 'files/login.html')
