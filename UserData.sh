#!/bin/bash
set -e

GIT_REPO_URL="https://github.com/graple254/yoooo.git"
PROJECT_MAIN_DIR_NAME="chichi"

git clone "$GIT_REPO_URL" "/home/ubuntu/$PROJECT_MAIN_DIR_NAME"
cd "/home/ubuntu/$PROJECT_MAIN_DIR_NAME"

chmod +x scripts/*.sh

./scripts/instance_os_dependencies.sh
./scripts/python_dependencies.sh
./scripts/setup_env.sh          # ← creates .env template on server
./scripts/daphne.sh
./scripts/nginx.sh
./scripts/start_app.sh