#!/usr/bin/env bash
# Makhno (lampac-ukraine): перевод на repository.yaml, диагностика и исправление.
#   bash lme-fix.sh
# 1) Если модули ещё подключены папками — переводит на штатный repository.yaml (скрипт lme-native.sh).
# 2) Проверяет с VPS цепочку Makhno: версия модуля → сервис автора (zrok) → плеер ashdi.
# 3) Если ashdi не отвечает напрямую, но отвечает через прокси, который уже настроен для Eneyida,
#    включает этот же прокси для LME.Makhno (init.conf перечитывается Lampac на лету; копия — рядом).
set -u
DIR=/root/lampac
CONF=$DIR/lampac-docker/config/init.conf
PAGES=https://werpenart.github.io/lampa-opensubs/vps
UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
say() { printf '\n== %s\n' "$*"; }
cd "$DIR" || exit 1

# ---------- 1. repository.yaml ----------
if ! grep -q "repository.yaml" docker-compose.override.yaml 2>/dev/null; then
  say "модули подключены вручную — переводим на repository.yaml"
  curl -fsSL "$PAGES/lme-native.sh" -o lme-native.sh && bash lme-native.sh
else
  say "repository.yaml уже подключён"
fi

say "версия модулей в контейнере"
for m in LME.Shared LME.Uaflix LME.Makhno LME.StarLight; do
  v=$(docker exec lampac sh -c "find /lampac/module -path '*$m/ModInit.cs' 2>/dev/null | head -1 | xargs -r grep -ho 'Version => [0-9.]*' | head -1")
  echo "  $m: ${v:-нет}"
done
docker exec lampac sh -c 'cat /lampac/module/.repository_state.json 2>/dev/null'; echo
docker exec lampac sh -c "grep -c skip_zrok_interstitial /lampac/module/LME.Makhno/MakhnoInvoke.cs 2>/dev/null" | sed 's/^/  исправление zrok в коде (должно быть 1): /'

# ---------- 2. цепочка Makhno ----------
say "сервис автора (zrok), Игра престолов"
W=$(curl -sS -m30 -A "$UA" -H 'skip_zrok_interstitial: 1' 'https://makhno.shares.zrok.io/?imdb_id=tt0944947' -w '\n%{http_code}')
WCODE=$(echo "$W" | tail -1); WBODY=$(echo "$W" | sed '$d')
echo "  HTTP $WCODE: $(echo "$WBODY" | head -c 300)"
PLAY=$(echo "$WBODY" | python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("play") or "")
except Exception: print("")')
if [ -z "$PLAY" ]; then
  echo "  ссылки на плеер нет — сервис автора не отдаёт данные этому VPS. Пришлите этот вывод."
  docker logs lampac --since 2h 2>&1 | grep -i makhno | tail -10
  exit 0
fi
echo "  плеер: $PLAY"

say "плеер ashdi напрямую с VPS"
code=$(curl -s -m30 -A "$UA" -H 'Referer: https://ashdi.vip/' -o /tmp/ashdi.html -w '%{http_code}' "$PLAY")
size=$(wc -c < /tmp/ashdi.html 2>/dev/null || echo 0)
grep -q "file" /tmp/ashdi.html 2>/dev/null && hasfile=1 || hasfile=0
echo "  HTTP $code, $size байт, данные плеера: $([ $hasfile = 1 ] && echo есть || echo нет)"
if [ "$code" = 200 ] && [ $hasfile = 1 ]; then
  say "цепочка работает с VPS напрямую"
  echo "  Проверка Lampac:"
  for q in "id=1399&imdb_id=tt0944947&title=GoT&original_title=Game%20of%20Thrones&year=2011&serial=1" \
           "id=546554&imdb_id=tt8946378&title=Knives&original_title=Knives%20Out&year=2019&serial=0"; do
    echo "  lme_makhno: HTTP $(curl -s -m60 -o /dev/null -w '%{http_code}' "http://127.0.0.1:9118/lite/lme_makhno?$q")"
  done
  docker logs lampac --since 2h 2>&1 | grep -i makhno | tail -10
  exit 0
fi

echo "  ответ ashdi: $(head -c 287 /tmp/ashdi.html | tr '\n' ' ')"

makhno_check() {
  echo "  перезапуск Lampac, чтобы модуль перечитал настройки"
  docker restart lampac >/dev/null
  for i in $(seq 1 60); do curl -s -m5 -o /dev/null http://127.0.0.1:9118/ && break; sleep 5; done
  sleep 20
  for q in "id=1399&imdb_id=tt0944947&title=GoT&original_title=Game%20of%20Thrones&year=2011&serial=1" \
           "id=546554&imdb_id=tt8946378&title=Knives&original_title=Knives%20Out&year=2019&serial=0"; do
    echo "  lme_makhno: HTTP $(curl -s -m60 -o /dev/null -w '%{http_code}' "http://127.0.0.1:9118/lite/lme_makhno?$q")"
  done
}

# ---------- 3a. APN автора модуля (штатный обход для ashdi в LME) ----------
APN='https://tut.im/proxy.php?url={encodeurl}'
say "ashdi через APN модуля (tut.im)"
ENC=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$PLAY")
code=$(curl -s -m40 -A "$UA" -H 'Referer: https://ashdi.vip/' -o /tmp/ashdi.html -w '%{http_code}' "https://tut.im/proxy.php?url=$ENC")
grep -q "file" /tmp/ashdi.html 2>/dev/null && hasfile=1 || hasfile=0
echo "  через APN: HTTP $code, $(wc -c < /tmp/ashdi.html) байт, данные плеера: $([ $hasfile = 1 ] && echo есть || echo нет)"
if [ "$code" = 200 ] && [ $hasfile = 1 ]; then
  say "включаем APN для LME.Makhno"
  cp "$CONF" "$CONF.bak-makhno-$(date +%Y%m%d-%H%M%S)"
  python3 - "$CONF" "$APN" <<'PY'
import json, sys
p = sys.argv[1]
c = json.load(open(p, encoding="utf-8"))
m = c.setdefault("LME.Makhno", {})
m["apn"] = True
m["apn_host"] = sys.argv[2]
json.dump(c, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print("ok")
PY
  makhno_check
  echo "Готово. Вернуть как было: восстановить init.conf из $CONF.bak-makhno-*"
  exit 0
fi

# ---------- 3b. прокси от Eneyida ----------
say "ищем прокси Eneyida в init.conf"
PROXY=$(python3 - "$CONF" <<'PY'
import json, sys
c = json.load(open(sys.argv[1], encoding="utf-8"))
cands = []
for k, v in c.items():
    if isinstance(v, dict) and "eneyida" in k.lower() and isinstance(v.get("proxy"), dict):
        cands.append(v["proxy"])
if isinstance(c.get("proxy"), dict): cands.append(c["proxy"])
for p in cands:
    for u in p.get("list") or []:
        if p.get("useAuth") and p.get("username") and "@" not in u:
            sch, rest = u.split("://", 1) if "://" in u else ("http", u)
            u = "%s://%s:%s@%s" % (sch, p["username"], p.get("password", ""), rest)
        print(u.replace("socks5://", "socks5h://")); sys.exit()
PY
)
if [ -z "$PROXY" ]; then echo "  прокси Eneyida не найден. Пришлите этот вывод."; exit 0; fi
echo "  прокси найден (${PROXY%%://*})"
code=$(curl -s -m40 -x "$PROXY" -A "$UA" -H 'Referer: https://ashdi.vip/' -o /tmp/ashdi.html -w '%{http_code}' "$PLAY")
grep -q "file" /tmp/ashdi.html 2>/dev/null && hasfile=1 || hasfile=0
echo "  через прокси: HTTP $code, данные плеера: $([ $hasfile = 1 ] && echo есть || echo нет)"
if [ "$code" != 200 ] || [ $hasfile != 1 ]; then echo "  через прокси тоже нет. Пришлите этот вывод."; exit 0; fi

say "включаем прокси Eneyida для LME.Makhno"
cp "$CONF" "$CONF.bak-makhno-$(date +%Y%m%d-%H%M%S)"
python3 - "$CONF" <<'PY'
import json, sys
p = sys.argv[1]
c = json.load(open(p, encoding="utf-8"))
src = None
for k, v in c.items():
    if isinstance(v, dict) and "eneyida" in k.lower() and isinstance(v.get("proxy"), dict):
        src = v["proxy"]; break
if src is None: src = c.get("proxy")
m = c.setdefault("LME.Makhno", {})
m["useproxy"] = True
m["proxy"] = src
json.dump(c, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print("ok")
PY
sleep 10
for q in "id=1399&imdb_id=tt0944947&title=GoT&original_title=Game%20of%20Thrones&year=2011&serial=1" \
         "id=546554&imdb_id=tt8946378&title=Knives&original_title=Knives%20Out&year=2019&serial=0"; do
  echo "  lme_makhno: HTTP $(curl -s -m60 -o /dev/null -w '%{http_code}' "http://127.0.0.1:9118/lite/lme_makhno?$q")"
done
echo "Готово. Вернуть как было: восстановить init.conf из $CONF.bak-makhno-*"
