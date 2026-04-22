from django.contrib import admin
from django.urls import path, include
from django.conf import settings
from django.conf.urls.static import static
from django.shortcuts import redirect




urlpatterns = [
    path('admin/', admin.site.urls),
    path('', include('core.urls')), 
    path('authentication/', include('authentication.urls')),
    path(
        "accounts/3rdparty/login/cancelled",
        lambda request: redirect("login"),
    ),
    path(
        "accounts/3rdparty/login/cancelled/",
        lambda request: redirect("login"),
    ),
    path('accounts/', include('allauth.urls')),
] + static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)

###328304880568-n2dv544j4o3j028nrcts94a2enovrram.apps.googleusercontent.com###