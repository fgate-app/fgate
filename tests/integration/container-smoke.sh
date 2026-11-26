#!/bin/sh
# Full network test: dedicated Linux Docker host only. Never reuse an existing gateway.
set -eu
cd "$(dirname "$0")/../.."
sh install.sh --container --check
if docker inspect freedomgate >/dev/null 2>&1;then echo 'An existing FreedomGate container must not be used for this test.' >&2;exit 1;fi
COMPOSE_PROJECT_NAME="freedomgate-smoke-$(date -u +%Y%m%d%H%M%S)-$$";export COMPOSE_PROJECT_NAME
cleanup() { docker compose logs --tail=100 || true;docker compose down --volumes; }
trap cleanup EXIT
sh install.sh --container
curl --fail --silent http://127.0.0.1/api/health | grep -q '"ready":true'
docker compose exec -T freedomgate systemctl is-active freedomgate.service freedomgate-network.service
docker compose exec -T freedomgate /opt/freedomgate/runtime/node/bin/node -e 'if(!["arm64","x64"].includes(process.arch))process.exit(1);console.log(process.arch)'
docker compose exec -T freedomgate /opt/freedomgate/modules/mihomo/current/mihomo -v
docker compose exec -T freedomgate /opt/freedomgate/modules/xray/current/xray version
docker compose exec -T freedomgate /opt/freedomgate/modules/adguard/current/AdGuardHome --version
docker compose exec -T freedomgate /opt/freedomgate/modules/zapret/current/nfqws2 --version
docker compose exec -T -u freedomgate -e LD_LIBRARY_PATH=/opt/freedomgate/modules/tor/current/tor freedomgate /opt/freedomgate/modules/tor/current/tor/tor --version
# Only this test's unique disposable module volume is changed.
docker compose exec -T freedomgate sh -c 'cp -a /opt/freedomgate/modules/mihomo/current/. /opt/freedomgate/modules/mihomo/smoke-preserved;ln -sfn smoke-preserved /opt/freedomgate/modules/mihomo/current'
docker compose restart
for attempt in 1 2 3 4 5 6 7 8 9 10;do
 if docker compose exec -T freedomgate /opt/freedomgate/runtime/node/bin/node scripts/install-health.mjs;then break;fi
 sleep 2
done
docker compose exec -T freedomgate test /opt/freedomgate/modules/mihomo/current -ef /opt/freedomgate/modules/mihomo/smoke-preserved
docker compose exec -T freedomgate /opt/freedomgate/runtime/node/bin/node scripts/install-health.mjs
printf 'Container services, modules, HTTP readiness and independent module preservation passed.\n'
