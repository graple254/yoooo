from .views import *
from django.urls import path

urlpatterns = [
      path('login/', auth_view, name='login')
]