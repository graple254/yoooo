#!/bin/bash
set -e
cd ~/chichi

echo "🐍 Setting up Python environment..."
python3 -m venv venv
source venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt

echo "✅ Python dependencies installed"