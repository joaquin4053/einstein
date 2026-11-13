#!/usr/bin/env bash
# Starts metaphactory 6.1 + GraphDB 10.8 (free mode, no license) in Docker for Einstein.
# Needs Docker Desktop and a Docker Hub login with access to the metaphacts registry
# (token from https://metaphacts.com/get-started → "Docker - any graph database").
#
#   ./metaphactory/setup.sh        # first setup + start (safe to re-run)
#   ./metaphactory/setup.sh down   # stop the containers (data is kept)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$ROOT/metaphactory-docker-compose"
DEPLOY="$REPO/my-deployment"
export PATH="$HOME/.docker/bin:/Applications/Docker.app/Contents/Resources/bin:$PATH"

command -v docker >/dev/null || { echo "Docker not found – install and start Docker Desktop first." >&2; exit 1; }

if [[ "${1:-}" == "down" ]]; then
  (cd "$DEPLOY" && docker compose down)
  exit 0
fi

[[ -d "$REPO" ]] || git clone https://github.com/metaphacts/metaphactory-docker-compose.git "$REPO"
[[ -d "$DEPLOY" ]] || cp -r "$REPO/service-template" "$DEPLOY"

cd "$DEPLOY"
if ! grep -q '^COMPOSE_PROJECT_NAME=einstein$' .env 2>/dev/null; then
  [[ -f .env ]] && cp .env ".env.backup-$(date +%s)"
  cp database-config/.env_graphdb .env
  # GraphDB 10 runs in free mode; GraphDB 11 (template default) needs a license.
  sed -i.bak -e 's/^COMPOSE_PROJECT_NAME=.*/COMPOSE_PROJECT_NAME=einstein/' \
             -e 's#^GRAPHDB_IMAGE=.*#GRAPHDB_IMAGE=ontotext/graphdb:10.8.8#' .env && rm -f .env.bak
fi

# Expose GraphDB on :7200 so Einstein can write evidence graphs into it.
python3 - <<'PY'
p = "database-config/docker-compose.graphdb.yml"
s = open(p).read()
old = '    #ports:\n    #  - "7200:7200"'
if old in s:
    s = s.replace(old, '    # Einstein pushes its evidence graphs here; Workbench at http://localhost:7200\n    ports:\n      - "7200:7200"')
    open(p, "w").write(s)
PY

docker compose pull
docker compose up -d

echo "Waiting for metaphactory…"
curl -s -o /dev/null --retry 60 --retry-delay 3 --retry-all-errors --max-time 10 http://localhost:10214/login
curl -s -o /dev/null --retry 20 --retry-delay 3 --retry-all-errors http://localhost:7200/repositories/metaphactory/size

cat <<MSG

metaphactory:  http://localhost:10214   (login admin / admin – change it for anything shared)
GraphDB:       http://localhost:7200

Add to einstein/.env.local, then restart \`npm run dev\`:
  METAPHACTORY_URL=http://localhost:10214
  METAPHACTORY_GRAPHDB_URL=http://localhost:7200/repositories/metaphactory
MSG
