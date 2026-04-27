from django.urls import path
from .views import *

urlpatterns = [
      path('', index_view, name='index'),
      path('connect/', connect_view, name='connect'),
      path('accept-terms/', accept_terms_and_policy, name='accept_terms'),
]