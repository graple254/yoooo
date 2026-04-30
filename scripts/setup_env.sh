#!/bin/bash
set -e
echo "🔐 Setting up environment file..."

ENV_FILE="/home/ubuntu/chichi/.env"

if [ ! -f "$ENV_FILE" ]; then
    echo "📝 Creating .env template..."
    cat > "$ENV_FILE" << 'EOF'
SECRET_KEY=REPLACE_THIS_WITH_A_REAL_SECRET_KEY
DEBUG=False
ALLOWED_HOSTS=REPLACE_WITH_YOUR_SERVER_IP
REDIS_URL=redis://127.0.0.1:6379/0
EOF
    # lock it down so only ubuntu user can read it
    chmod 600 "$ENV_FILE"
    echo "⚠️  .env template created — SSH in and replace the placeholder values"
else
    echo "✅ .env already exists — skipping"
fi