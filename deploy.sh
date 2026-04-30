#!/bin/bash
set -e
echo "🚀 Starting deployment..."

cd ~/chichi || exit

if [ ! -d "venv" ]; then
    echo "🧪 Creating virtual environment..."
    python3 -m venv venv
fi

echo "🐍 Activating virtual environment..."
source venv/bin/activate

echo "📥 Pulling latest code..."
git pull origin main

echo "📦 Installing dependencies..."
pip install --upgrade pip
pip install -r requirements.txt

echo "🗃️ Applying database migrations..."
python manage.py migrate --noinput

echo "🧹 Collecting static files..."
python manage.py collectstatic --noinput

echo "🔁 Restarting Daphne..."
sudo systemctl restart daphne

echo "🔄 Reloading Nginx..."
sudo systemctl reload nginx

echo "✅ Deployment complete!"