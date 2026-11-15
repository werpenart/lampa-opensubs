#!/usr/bin/env bash
# Обновление Lampac на VPS + украинские источники lampac-ukraine (LME.Uaflix, LME.Makhno, LME.StarLight).
# Безопасно для ZetflixDB: резервные копии, проверка после обновления, автоматический откат при сбое.
#
#   bash lme-install.sh            установить / обновить
#   bash lme-install.sh --rollback последний откат вручную (восстановить из последней копии)
#
# Ничего не удаляет: старые образы помечаются тегом lampac-rollback:<время>, файлы копируются в /root/lampac/backup-<время>.
set -u

DIR=/root/lampac
CONF=$DIR/lampac-docker/config/init.conf
MODS="LME.Shared LME.Uaflix LME.Makhno LME.StarLight"
SRC=$DIR/lampac-ukraine
REPO_TGZ=https://codeload.github.com/lampame/lampac-ukraine/tar.gz/refs/heads/main

say() { printf '\n== %s\n' "$*"; }
B=""
# до резервной копии — просто выход; после — вернуть файлы как были (контейнеры не трогаем)
die() {
  printf '\nОШИБКА: %s\n' "$*"
  if [ -n "$B" ] && [ -d "$B" ]; then
    cp "$B/docker-compose.yaml" "$DIR/" 2>/dev/null
    if [ -f "$B/docker-compose.override.yaml" ]; then cp "$B/docker-compose.override.yaml" "$DIR/"; else rm -f "$DIR/docker-compose.override.yaml"; fi
    cp "$B/init.conf" "$CONF" 2>/dev/null
    echo "Файлы возвращены из $B, Lampac не перезапускался."
  fi
  exit 1
}

cd "$DIR" || die "нет каталога $DIR"
command -v docker >/dev/null || die "нет docker"
command -v python3 >/dev/null || die "нет python3"

# ---------- проверки ----------
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
    local c
    c=$(curl -s -m60 -o /dev/null -w '%{http_code}' "http://127.0.0.1:9118/lite/$b?id=1045479&kinopoisk_id=1045479&title=check&serial=0")
    echo "     $b: HTTP $c"
  done
  return $fail
}

check_lme() {
  for r in lme_uaflix lme_makhno lme_starlight; do
    local c
    c=$(curl -s -m60 -o /dev/null -w '%{http_code}' "http://127.0.0.1:9118/lite/$r?id=546554&imdb_id=tt8946378&title=%D0%9D%D0%BE%D0%B6%D1%96&original_title=Knives%20Out&year=2019&serial=0")
    if [ "$c" = 404 ] || [ "$c" = 000 ]; then echo "FAIL $r не загрузился (HTTP $c)"; else echo "OK   $r (HTTP $c)"; fi
  done
  docker logs lampac --since 10m 2>&1 | grep -i "LME\." | grep -iE "error|fail|exception" | head -10
}

rollback() {
  local b="$1"
  say "ОТКАТ из $b"
  cp "$b/docker-compose.yaml" "$DIR/docker-compose.yaml"
  if [ -f "$b/docker-compose.override.yaml" ]; then cp "$b/docker-compose.override.yaml" "$DIR/"; else rm -f "$DIR/docker-compose.override.yaml"; fi
  cp "$b/init.conf" "$CONF"
  while read -r name tag id; do
    [ -n "$tag" ] && docker tag "$id" "$tag" && echo "образ $name → $id"
  done < "$b/images.txt"
  docker compose up -d --force-recreate 2>&1 | tail -5
  check && echo "Откат выполнен, ZetflixDB работает." || echo "После отката проверка не прошла — пришлите этот вывод."
}

if [ "${1:-}" = "--rollback" ]; then
  last=$(ls -d $DIR/backup-* 2>/dev/null | sort | tail -1)
  [ -n "$last" ] || die "нет резервных копий"
  rollback "$last"; exit
fi

# ---------- 1. резервные копии ----------
TS=$(date +%Y%m%d-%H%M%S)
B=$DIR/backup-$TS
say "резервная копия → $B"
mkdir -p "$B"
cp docker-compose.yaml "$B/" || die "нет docker-compose.yaml"
[ -f docker-compose.override.yaml ] && cp docker-compose.override.yaml "$B/"
cp "$CONF" "$B/init.conf" || die "нет $CONF"
: > "$B/images.txt"
for c in $(docker compose ps --format '{{.Name}}'); do
  id=$(docker inspect -f '{{.Image}}' "$c"); tag=$(docker inspect -f '{{.Config.Image}}' "$c")
  docker tag "$id" "lampac-rollback:$TS-$c"
  echo "$c $tag $id" >> "$B/images.txt"
done
cat "$B/images.txt"

say "проверка до обновления"
PRE=0
check || { PRE=1; echo "(до обновления уже есть сбои — откатывать из-за них не будем)"; }

# ---------- 2. модули lampac-ukraine ----------
say "скачиваем lampac-ukraine"
rm -rf "$SRC.new" && mkdir -p "$SRC.new"
curl -fsSL "$REPO_TGZ" | tar -xz -C "$SRC.new" --strip-components=1 || die "не скачался lampac-ukraine"
for m in $MODS; do [ -d "$SRC.new/$m" ] || die "в репозитории нет $m"; done
rm -rf "$SRC.old"; [ -d "$SRC" ] && mv "$SRC" "$SRC.old"; mv "$SRC.new" "$SRC"

SVC=$(docker compose ps --format '{{.Service}} {{.Name}}' | awk '$2=="lampac"{print $1}')
[ -n "$SVC" ] || die "не нашёл сервис контейнера lampac"
if [ -f docker-compose.override.yaml ] && ! grep -q "lampac-ukraine" docker-compose.override.yaml; then
  die "уже есть свой docker-compose.override.yaml — не трогаю его; пришлите его содержимое"
fi
say "подключаем модули (docker-compose.override.yaml, основной файл не меняется)"
{
  echo "services:"
  echo "  $SVC:"
  echo "    volumes:"
  for m in $MODS; do echo "      - ./lampac-ukraine/$m:/lampac/module/$m"; done
} > docker-compose.override.yaml
cat docker-compose.override.yaml

say "init.conf: включаем модули"
python3 - "$CONF" <<'PY' || die "init.conf не прочитался как JSON — ничего не изменено"
import json, sys
p = sys.argv[1]
c = json.load(open(p, encoding="utf-8"))
names = {"LME.Uaflix": "Uaflix", "LME.Makhno": "Makhno", "LME.StarLight": "StarLight"}
for k, dn in names.items():
    c.setdefault(k, {}).setdefault("enable", True)
    c[k].setdefault("displayname", dn)
bm = c.get("BaseModule") or {}
skip = bm.get("SkipModules")
if isinstance(skip, list):
    bm["SkipModules"] = [x for x in skip if not str(x).startswith("LME.")]
json.dump(c, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print("ok:", ", ".join(names))
PY

# ---------- 3. обновление ----------
say "обновляем образы"
docker compose pull -q || die "не скачались образы"
docker compose up -d --force-recreate 2>&1 | tail -5

# ---------- 4. проверка и откат ----------
if check || [ "$PRE" = 1 ]; then
  say "украинские источники"
  check_lme
  docker image prune -f >/dev/null
  say "ГОТОВО. Копия до обновления: $B (откат: bash lme-install.sh --rollback)"
else
  rollback "$B"
fi
