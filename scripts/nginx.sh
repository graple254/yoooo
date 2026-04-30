#!/bin/bash
set -e
echo "🌐 Configuring Nginx..."

sudo tee /etc/nginx/sites-available/chichi > /dev/null << 'EOF'
upstream daphne {
    server 127.0.0.1:8001;
}

server {
    listen 80;
    server_name _;

    location /static/ {
        alias /home/ubuntu/chichi/staticfiles/;
        expires 1y;
        add_header Cache-Control "public, immutable";
        access_log off;
    }

    location /media/ {
        alias /home/ubuntu/chichi/media/;
        expires 7d;
    }

    # WebSocket — MUST come before the general / block
    location /ws/ {
        proxy_pass http://daphne;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
    }

    # Everything else
    location / {
        proxy_pass http://daphne;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_redirect off;
    }
}
EOF

sudo ln -sf /etc/nginx/sites-available/chichi /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl enable nginx
echo "✅ Nginx configured"