#!/usr/bin/bash
echo "Pull Finished"
sudo systemctl daemon-reload
sudo systemctl restart daphne
sudo systemctl reload nginx
echo "✅ Services restarted"