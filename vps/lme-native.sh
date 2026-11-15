#!/usr/bin/env bash
# Перевод украинских источников lampac-ukraine на штатное подключение Lampac (module/repository.yaml).
# Lampac сам скачивает LME.* из GitHub при каждом запуске и обновляет их, если в репозитории есть новый коммит.
# Раз в сутки (ночью) скрипт lme-update.sh проверяет репозиторий и перезапускает Lampac, только если вышло обновление.
#
#   bash lme-native.sh             перейти на repository.yaml
#   bash lme-native.sh --rollback  вернуть как было до последнего запуска
#
# Ничего не удаляет безвозвратно: прежние файлы — в /root/lampac/backup-<время>.
set -u

DIR=/root/lampac
CONF=$DIR/lampac-docker/config/init.conf
REPO_YAML=$DIR/lampac-docker/repository.yaml
UPD=$DIR/lme-update.sh
CRON=/etc/cron.d/lampac-lme

say() { printf '\n== %s\n' "$*"; }
B=""
restore_files() {
  cp "$B/docker-compose.yaml" "$DIR/" 2>/dev/null
  if [ -f "$B/docker-compose.override.yaml" ]; then cp "$B/docker-compose.override.yaml" "$DIR/"; else rm -f "$DIR/docker-compose.override.yaml"; fi
  cp "$B/init.conf" "$CONF" 2>/dev/null
  rm -f "$CRON"
}
die() {
  printf '\nОШИБКА: %s\n' "$*"
  if [ -n "$B" ] && [ -d "$B" ]; then restore_files; echo "Файлы возвращены из $B, Lampac не перезапускался."; fi
  exit 1
}

cd "$DIR" || die "нет каталога $DIR"
command -v docker >/dev/null || die "нет docker"

check() {
  local fail=0
  say "ждём Lampac"
  for i in $(seq 1 60); do curl -s -m5 -o /dev/null http://127.0.0.1:9118/ && break; sleep 5; done
  sleep 25
  local cip
  cip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' lampac-chrome 2>/dev/null)
  if [ -n "$cip" ] && docker run --rm --network lampac curlimages/curl -s -m8 "http://$cip:9223/json/version" | grep -q Browser; then
    echo "OK   Chrome (для ZetflixDB)"
  else
    echo "FAIL Chrome (для ZetflixDB)"; fail=1
  fi
  local h
  h=$(curl -sL -m150 "http://127.0.0.1:9118/lite/zetflixdb?kinopoisk_id=1045479&title=check")
  if echo "$h" | grep -q videos__item; then echo "OK   ZetflixDB"; else echo "FAIL ZetflixDB: $(echo "$h" | head -c 160)"; fail=1; fi
  for b in phantom aladin filmix; do
    echo "     $b: HTTP $(curl -s -m60 -o /dev/null -w '%{http_code}' "http://127.0.0.1:9118/lite/$b?id=1045479&kinopoisk_id=1045479&title=check&serial=0")"
  done
  return $fail
}

check_lme() {
  local q="id=546554&imdb_id=tt8946378&title=%D0%9D%D0%BE%D0%B6%D1%96&original_title=Knives%20Out&year=2019&serial=0"
  for r in lme_uaflix lme_makhno lme_starlight; do
    local c
    c=$(curl -s -m60 -o /dev/null -w '%{http_code}' "http://127.0.0.1:9118/lite/$r?$q")
    if [ "$c" = 404 ] || [ "$c" = 000 ]; then echo "FAIL $r не загрузился (HTTP $c)"; else echo "OK   $r (HTTP $c)"; fi
  done
  echo "(StarLight находит в основном украинский контент: 503 на «Ножах» — «не найдено», это нормально)"
  say "журнал загрузки модулей"
  docker logs lampac --since 15m 2>&1 | grep -iE "repositor|UpdateModules|LME\." | tail -15
}

if [ "${1:-}" = "--rollback" ]; then
  B=$(ls -d $DIR/backup-* 2>/dev/null | sort | tail -1)
  [ -n "$B" ] || die "нет резервных копий"
  say "ОТКАТ из $B"
  restore_files
  [ -d "$B/lampac-ukraine" ] && [ ! -d "$DIR/lampac-ukraine" ] && cp -a "$B/lampac-ukraine" "$DIR/"
  docker compose up -d --force-recreate 2>&1 | tail -5
  check; check_lme; exit
fi

# ---------- 1. резервная копия ----------
TS=$(date +%Y%m%d-%H%M%S)
B=$DIR/backup-$TS
say "резервная копия → $B"
mkdir -p "$B"
cp docker-compose.yaml "$B/" || die "нет docker-compose.yaml"
[ -f docker-compose.override.yaml ] && cp docker-compose.override.yaml "$B/"
cp "$CONF" "$B/init.conf" || die "нет $CONF"

if [ -f docker-compose.override.yaml ] && ! grep -qE "lampac-ukraine|repository.yaml" docker-compose.override.yaml; then
  die "есть чужой docker-compose.override.yaml — не трогаю его; пришлите его содержимое"
fi
SVC=$(docker compose ps --format '{{.Service}} {{.Name}}' | awk '$2=="lampac"{print $1}')
[ -n "$SVC" ] || die "не нашёл сервис контейнера lampac"

# ---------- 2. repository.yaml вместо ручного подключения ----------
say "module/repository.yaml"
cat > "$REPO_YAML" <<'YAML'
- repository: https://github.com/lampame/lampac-ukraine
  branch: main
  modules:
    - LME.Shared
    - LME.Uaflix
    - LME.Makhno
    - LME.StarLight
YAML
cat "$REPO_YAML"

say "docker-compose.override.yaml: вместо папок модулей — только repository.yaml"
{
  echo "services:"
  echo "  $SVC:"
  echo "    volumes:"
  echo "      - ./lampac-docker/repository.yaml:/lampac/module/repository.yaml:ro"
} > docker-compose.override.yaml
cat docker-compose.override.yaml

# ---------- 3. ночная проверка обновлений ----------
say "ежедневная проверка обновлений lampac-ukraine (04:37)"
cat > "$UPD" <<'SH'
#!/usr/bin/env bash
# Перезапускает Lampac, только если в lampame/lampac-ukraine появился новый коммит: при запуске Lampac сам скачает обновление.
STATE=/root/lampac/.lme-sha
sha=$(curl -fsS -m20 -H 'Accept: application/vnd.github+json' https://api.github.com/repos/lampame/lampac-ukraine/commits/main | grep -m1 '"sha"' | cut -d'"' -f4)
[ -n "$sha" ] || exit 0
[ "$sha" = "$(cat "$STATE" 2>/dev/null)" ] && exit 0
docker restart lampac >/dev/null && echo "$sha" > "$STATE" && logger -t lampac-lme "updated to $sha"
SH
chmod +x "$UPD"
curl -fsS -m20 https://api.github.com/repos/lampame/lampac-ukraine/commits/main | grep -m1 '"sha"' | cut -d'"' -f4 > "$DIR/.lme-sha"
echo "37 4 * * * root $UPD" > "$CRON"
cat "$CRON"

# ---------- 4. перезапуск и проверка ----------
say "перезапуск Lampac"
docker compose up -d 2>&1 | tail -5
if check; then
  check_lme
  [ -d "$DIR/lampac-ukraine" ] && mv "$DIR/lampac-ukraine" "$B/" && rm -rf "$DIR/lampac-ukraine.old"
  say "ГОТОВО. Модули обновляются сами. Копия до изменений: $B (откат: bash lme-native.sh --rollback)"
else
  say "ОТКАТ: после перезапуска проверка не прошла"
  restore_files
  docker compose up -d 2>&1 | tail -5
  check && echo "Откат выполнен, ZetflixDB работает." || echo "После отката проверка не прошла — пришлите этот вывод."
fi
