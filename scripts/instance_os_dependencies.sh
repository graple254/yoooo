#!/bin/bash
set -e
echo "📦 Installing OS dependencies..."

sudo apt-get update -y
sudo apt-get install -y \
    python3-pip \
    python3-venv \
    nginx \
    redis-server \
    postgresql \
    postgresql-contrib

sudo systemctl start redis-server
sudo systemctl enable redis-server
sudo systemctl start postgresql
sudo systemctl enable postgresql

echo "✅ OS dependencies installed"