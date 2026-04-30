# scripts/daphne.sh — installs the service and socket files
#!/bin/bash
set -e
echo "⚙️ Configuring Daphne..."

sudo cp ~/chichi/daphne/daphne.service /etc/systemd/system/daphne.service
sudo cp ~/chichi/daphne/daphne.socket  /etc/systemd/system/daphne.socket

sudo systemctl daemon-reload
sudo systemctl enable daphne.socket
sudo systemctl enable daphne.service
sudo systemctl start daphne.socket

echo "✅ Daphne configured"