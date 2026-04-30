#!/bin/bash
set -e
cd ~/chichi

echo "🚀 Starting application..."
source venv/bin/activate

python manage.py migrate --noinput
python manage.py collectstatic --noinput

sudo systemctl start redis-server
sudo systemctl start daphne
sudo systemctl start nginx

echo "✅ Application started"