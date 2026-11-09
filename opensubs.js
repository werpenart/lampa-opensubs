/*
 * OpenSubs — субтитры OpenSubtitles во встроенном плеере Lampa.
 * Самостоятельный клиентский плагин: сервер Lampac не нужен и не затрагивается.
 * При старте видео ищет субтитры по TMDB/IMDb id (для сериалов — по сезону и серии)
 * и добавляет их в меню субтитров плеера рядом с субтитрами источника.
 */
(function () {
  'use strict';

  if (window.opensubs_plugin_ready) return;
  window.opensubs_plugin_ready = true;

  var API = 'https://api.opensubtitles.com/api/v1';
  var UA = 'LampaOpenSubs v1.0';

  var LANG_NAMES = { ru: 'Русские', uk: 'Українські', en: 'English' };

  var current = null; // токен текущего видео, чтобы не добавить субтитры к другому

  function log() {
    try {
      var args = Array.prototype.slice.call(arguments);
      args.unshift('OpenSubs');
      console.log.apply(console, args);
    } catch (e) {}
  }

  function setting(name, def) {
    var v = Lampa.Storage.get('opensubs_' + name, def);
    return v === '' || v === null || typeof v === 'undefined' ? def : v;
  }

  function flag(name, def) {
    var v = setting(name, def);
    return v === true || v === 'true';
  }

  function apiKey() {
    return String(setting('apikey', '') || '').trim();
  }

  // ---------- сеть ----------

  function xhr(method, url, body, done, fail) {
    var r = new XMLHttpRequest();
    r.open(method, url, true);
    r.timeout = 15000;
    r.setRequestHeader('Api-Key', apiKey());
    r.setRequestHeader('X-User-Agent', UA);
    r.setRequestHeader('Accept', 'application/json');
    if (body) r.setRequestHeader('Content-Type', 'application/json');
    r.onload = function () {
      var json = null;
      try { json = JSON.parse(r.responseText); } catch (e) {}
      if (r.status >= 200 && r.status < 300 && json) done(json);
      else fail(r.status, json);
    };
    r.onerror = function () { fail(0); };
    r.ontimeout = function () { fail(0); };
    r.send(body ? JSON.stringify(body) : null);
  }

  // API OpenSubtitles требует параметры в алфавитном порядке и в нижнем регистре,
  // иначе отвечает редиректом, который ломает CORS в браузере
  function query(params) {
    var keys = Object.keys(params).sort();
    var out = [];
    for (var i = 0; i < keys.length; i++) {
      var v = params[keys[i]];
      if (v === null || typeof v === 'undefined' || v === '') continue;
      out.push(keys[i] + '=' + encodeURIComponent(String(v).toLowerCase()).replace(/%2C/g, ','));
    }
    return out.join('&');
  }

  // ---------- хранилище субтитров (IndexedDB на устройстве) ----------
  // Скачанный файл хранится по file_id: повторный просмотр не тратит дневной лимит OpenSubtitles.

  var DB_NAME = 'opensubs';
  var STORE = 'files';
  var DB_MAX = 300; // файлов; VTT обычно 30–150 КБ
  var dbPromise = null;
  var blobUrls = [];

  function db(cb) {
    if (dbPromise === false) return cb(null);
    if (dbPromise) return dbPromise.push(cb);
    dbPromise = [cb];
    var flush = function (d) {
      var list = dbPromise;
      dbPromise = d ? { push: function (f) { f(d); } } : false;
      for (var i = 0; i < list.length; i++) list[i](d);
    };
    try {
      var req = window.indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var s = req.result.createObjectStore(STORE, { keyPath: 'id' });
        s.createIndex('t', 't');
      };
      req.onsuccess = function () { flush(req.result); };
      req.onerror = req.onblocked = function () { flush(null); };
    } catch (e) {
      flush(null);
    }
  }

  function storeGet(id, cb) {
    db(function (d) {
      if (!d) return cb(null);
      try {
        var r = d.transaction(STORE, 'readonly').objectStore(STORE).get(id);
        r.onsuccess = function () { cb(r.result ? r.result.text : null); };
        r.onerror = function () { cb(null); };
      } catch (e) { cb(null); }
    });
  }

  function storePut(id, text) {
    db(function (d) {
      if (!d) return;
      try {
        var s = d.transaction(STORE, 'readwrite').objectStore(STORE);
        s.put({ id: id, text: text, t: Date.now() });
        var c = s.count();
        c.onsuccess = function () {
          var extra = c.result - DB_MAX;
          if (extra <= 0) return;
          s.index('t').openCursor().onsuccess = function (e) {
            var cur = e.target.result;
            if (cur && extra-- > 0) {
              cur.delete();
              cur['continue']();
            }
          };
        };
      } catch (e) {}
    });
  }

  function storeStats(cb) {
    db(function (d) {
      if (!d) return cb(-1);
      try {
        var c = d.transaction(STORE, 'readonly').objectStore(STORE).count();
        c.onsuccess = function () { cb(c.result); };
        c.onerror = function () { cb(-1); };
      } catch (e) { cb(-1); }
    });
  }

  function storeClear(cb) {
    db(function (d) {
      if (!d) return cb && cb();
      try {
        var r = d.transaction(STORE, 'readwrite').objectStore(STORE).clear();
        r.onsuccess = r.onerror = function () { cb && cb(); };
      } catch (e) { cb && cb(); }
    });
  }

  function textUrl(text) {
    try {
      var u = URL.createObjectURL(new Blob([text], { type: 'text/vtt' }));
      blobUrls.push(u);
      return u;
    } catch (e) {
      return null;
    }
  }

  function revokeUrls() {
    for (var i = 0; i < blobUrls.length; i++) try { URL.revokeObjectURL(blobUrls[i]); } catch (e) {}
    blobUrls = [];
  }

  function fetchText(url, done, fail) {
    var r = new XMLHttpRequest();
    r.open('GET', url, true);
    r.timeout = 20000;
    r.onload = function () {
      if (r.status >= 200 && r.status < 300 && /-->/.test(r.responseText)) done(r.responseText);
      else fail(r.status);
    };
    r.onerror = r.ontimeout = function () { fail(0); };
    r.send(null);
  }

  // done(text, link): текст файла (из хранилища или свежескачанный); link — прямая ссылка, если текст получить не удалось
  function download(fileId, done, fail) {
    storeGet(fileId, function (text) {
      if (text) return done(text, null);

      xhr('POST', API + '/download', { file_id: fileId, sub_format: 'webvtt' }, function (json) {
        if (!json.link) return fail(json);
        fetchText(json.link, function (body) {
          storePut(fileId, body);
          done(body, null);
        }, function () {
          done(null, json.link);
        });
      }, function (status, json) {
        fail(json || status);
      });
    });
  }

  // ---------- что смотрим ----------

  function activeCard() {
    try {
      var a = Lampa.Activity.active();
      if (!a) return null;
      return a.movie || a.card || (a.object && (a.object.movie || a.object.card)) || null;
    } catch (e) {
      return null;
    }
  }

  function episodeInfo(data) {
    var s = parseInt(data.season, 10);
    var e = parseInt(data.episode, 10);
    if (!(s > 0 && e > 0)) {
      var m = String(data.title || '').match(/s(\d{1,2})\s*e(\d{1,3})/i);
      if (m) {
        s = parseInt(m[1], 10);
        e = parseInt(m[2], 10);
      }
    }
    return s > 0 && e > 0 ? { season: s, episode: e } : null;
  }

  function buildQuery(card, data, langs) {
    var p = { languages: langs.slice().sort().join(','), order_by: 'download_count' };
    var isTv = !!(card.name || card.original_name || card.number_of_seasons || data.season);
    var tmdbOk = card.id && (!card.source || card.source === 'tmdb' || card.source === 'cub');
    var imdb = parseInt(String(card.imdb_id || '').replace(/^tt/, ''), 10) || ''; // без ведущих нулей, иначе редирект

    if (isTv) {
      var ep = episodeInfo(data);
      if (!ep) return null; // без номера серии подберутся субтитры от другой серии
      p.season_number = ep.season;
      p.episode_number = ep.episode;
      if (tmdbOk) p.parent_tmdb_id = card.id;
      else if (imdb) p.parent_imdb_id = imdb;
      else p.query = card.original_name || card.name;
    } else {
      if (imdb) p.imdb_id = imdb;
      else if (tmdbOk) p.tmdb_id = card.id;
      else {
        p.query = card.original_title || card.title;
        var y = String(card.release_date || '').slice(0, 4);
        if (y) p.year = y;
      }
    }
    return p;
  }

  // Экранки и ранние релизы: свой хронометраж, с онлайн-видео не совпадают
  var BAD_RELEASE = /(^|[^a-z])(cam|hdcam|camrip|ts|hdts|telesync|tc|hdtc|telecine|scr|screener|dvdscr|bdscr|workprint|r5)([^a-z]|$)/i;
  // Финальные релизы: онлайн-источники обычно сделаны из них
  var GOOD_RELEASE = /blu-?ray|bdrip|brrip|bdremux|remux|web-?dl|webrip|web|amzn|nf|dsnp|hmax|atvp|itunes|hdrip|dvdrip/i;

  function score(a) {
    var rel = String(a.release || '') + ' ' + String((a.files[0] && a.files[0].file_name) || '');
    var sc = Math.log(1 + (a.download_count || 0)); // 0…~14
    if (BAD_RELEASE.test(rel)) sc -= 100;
    if (GOOD_RELEASE.test(rel)) sc += 6;
    if (a.from_trusted) sc += 3;
    var fps = parseFloat(a.fps) || 0;
    if (fps && Math.abs(fps - 23.976) > 0.1 && Math.abs(fps - 24) > 0.1) sc -= 4; // 25/29.97/30 — чаще всего не наш хронометраж
    if (a.hearing_impaired) sc -= 2;
    return sc;
  }

  // ---------- плеер ----------

  function videoSubs() {
    try {
      var v = Lampa.PlayerVideo.video();
      if (!v) return null;
      return { video: v, subs: v.customSubs || [] };
    } catch (e) {
      return null;
    }
  }

  // ---------- сеанс текущего видео ----------
  // Поиск — при старте (бесплатно). Скачивание — только когда субтитры включены кнопкой CC,
  // и только одного файла на нужном языке; остальные варианты скачиваются при выборе в меню.

  var session = null; // { data, card, audio, found: {lang: [attrs]}, searching, want }

  function langName(code) {
    return LANG_NAMES[code] || String(code || '').toUpperCase();
  }

  function normLang(code) {
    code = String(code || '').toLowerCase();
    if (code === 'ua') return 'uk';
    return code.split('-')[0];
  }

  // язык озвучки: метка дорожки («(EN) Оригинал», «Украинский», «DUB | …»), иначе язык оригинала фильма
  function detectAudio(data, card) {
    var tr = typeof data.translate === 'string' ? data.translate : '';
    var parts = [data.voice_name || '', tr, data.title || ''];
    for (var i = 0; i < parts.length; i++) {
      var t = parts[i];
      if (!t) continue;
      if (/\((en|eng)\)|\beng\b|english|англ/i.test(t)) return 'en';
      if (/\((uk|ua|ukr)\)|\bukr\b|україн|украин/i.test(t)) return 'uk';
      if (/\((ru|rus)\)|\brus\b|русск/i.test(t)) return 'ru';
      // «Субтитры», «Укр. Субтитры» у источников — оригинальная дорожка с вшитым переводом
      if (/оригинал|оригінал|original|субтитр|субтитл/i.test(t)) return normLang(card.original_language) || 'en';
      if (/\b(dub|mvo|avo|dvo)\b|дубл|многогол|двухгол|одногол|закадр|профессион|любительск/i.test(t)) return 'ru';
    }
    return null;
  }

  function fallbackLangs() {
    return String(setting('langs', 'ru,uk,en')).split(',');
  }

  // порядок языков: выбранный режим (по озвучке или фиксированный), затем запасные
  function langOrder(s) {
    var mode = setting('lang', 'audio');
    var first = mode === 'audio' ? (s && s.audio) : mode;
    var out = [];
    var add = function (l) { if (l && out.indexOf(l) < 0) out.push(l); };
    add(first);
    var fb = fallbackLangs();
    for (var i = 0; i < fb.length; i++) add(fb[i]);
    return out;
  }

  // лучшие варианты по языкам: {lang: [attrs…]}
  function groupFound(list, langs) {
    var groups = {};
    for (var i = 0; i < list.length; i++) {
      var a = list[i].attributes;
      if (!a || !a.files || !a.files.length) continue;
      if (a.machine_translated || a.ai_translated) continue;
      var l = normLang(a.language);
      if (langs.indexOf(l) < 0) continue;
      a._score = score(a);
      a._lang = l;
      (groups[l] = groups[l] || []).push(a);
    }
    for (var k in groups) groups[k] = groups[k].sort(function (x, y) { return y._score - x._score; }).slice(0, 3);
    return groups;
  }

  function shortRelease(a) {
    var r = String(a.release || '').replace(/[._]/g, ' ').replace(/\s+/g, ' ').trim();
    return r.length > 40 ? r.slice(0, 40) + '…' : r;
  }

  function trackLabel(a) {
    return langName(a._lang) + ' · OS · ' + shortRelease(a);
  }

  function notify(text) {
    if (flag('notify', true)) Lampa.Noty.show(text);
  }

  function load(data) {
    session = null;
    if (!flag('enabled', true)) return;
    if (data.iptv || data.youtube) return;

    var card = activeCard();
    if (!card) return log('нет карточки');

    var s = session = { data: data, card: card, audio: detectAudio(data, card), found: {}, searching: false, want: undefined };
    log('озвучка', s.audio);

    if (!apiKey()) {
      if (ccWanted()) notify('OpenSubtitles: укажите API-ключ в настройках плагина');
      return;
    }

    var langs = langOrder(s);
    if (langs.indexOf('en') < 0) langs.push('en'); // английские — эталон для автосинхронизации
    var p = buildQuery(card, data, langs);
    if (!p) return log('нет номера серии');

    s.searching = true;
    xhr('GET', API + '/subtitles?' + query(p), null, function (json) {
      if (session !== s) return;
      s.searching = false;
      s.found = groupFound(json.data || [], langs);
      if (ccWanted()) turnOn(s, true);
      updateButtons();
    }, function (status, json) {
      s.searching = false;
      log('search fail', status, json);
      updateButtons();
    });
  }

  // добавить скачанный файл в список субтитров плеера, вернуть объект дорожки из плеера
  function ensureTrack(a, done, fail) {
    var fid = a.files[0].file_id;
    var have = findTrack(fid);
    if (have) return done(have);

    download(fid, function (text, link) {
      if (text) texts[fid] = text;
      var url = text ? textUrl(applySync(text, getSync(fid))) : link;
      var state = videoSubs();
      if (!url || !state) return fail();
      var list = copySubs(state.subs);
      list.push({ label: trackLabel(a), url: url, language: a._lang, opensubs: true, os_id: fid, index: list.length });
      Lampa.Player.subtitles(list);
      var t = findTrack(fid);
      t ? done(t) : fail();
    }, function (err) {
      log('download fail', err);
      if (err && err.remaining === 0) Lampa.Noty.show('OpenSubtitles: дневной лимит скачиваний исчерпан');
      fail();
    });
  }

  function findTrack(fid) {
    var subs = trackList();
    for (var i = 0; i < subs.length; i++) if (subs[i].os_id === fid) return subs[i];
    return null;
  }

  // Lampa определяет у объектов свойство mode — для повторной передачи берём чистые копии
  function copySubs(subs) {
    return subs.map(function (x, i) {
      var c = {};
      for (var k in x) if (k !== 'mode' && k !== 'ready' && k !== 'selected') c[k] = x[k];
      c.index = i;
      return c;
    });
  }

  function sourceTrackFor(langs) {
    var subs = trackList().filter(function (x) { return !x.opensubs; });
    if (!subs.length) return null;
    for (var i = 0; i < langs.length; i++) {
      for (var j = 0; j < subs.length; j++) {
        var l = normLang(subs[j].language || subs[j].lang || subs[j].srclang);
        if (l === langs[i]) return subs[j];
      }
    }
    return null;
  }

  // включить субтитры на нужном языке: субтитры источника на этом языке, иначе лучший файл OpenSubtitles
  function turnOn(s, auto) {
    var langs = langOrder(s);
    for (var i = 0; i < langs.length; i++) {
      var src = sourceTrackFor([langs[i]]);
      if (src) {
        showTrack(src);
        return true;
      }
      var cand = s.found[langs[i]];
      if (cand && cand.length) {
        s.pending = true;
        updateButtons();
        ensureTrack(cand[0], function (t) {
          s.pending = false;
          if (session === s && ccWanted()) {
            showTrack(t);
            maybeAutoSync(t);
          }
          updateButtons();
        }, function () {
          s.pending = false;
          updateButtons();
        });
        return true;
      }
    }
    // на нужных языках ничего — берём любые субтитры источника
    var any = trackList()[0];
    if (any) {
      showTrack(any);
      return true;
    }
    if (!auto) Lampa.Noty.show('Субтитры для этого видео не найдены');
    return false;
  }

  function showTrack(track) {
    if (session) session.want = track.os_id || track.label || track.index;
    selectTrack(track);
    updateButtons();
  }

  function turnOff() {
    if (session) session.want = null;
    selectTrack(null);
    updateButtons();
  }

  function isShowing() {
    var subs = trackList();
    for (var i = 0; i < subs.length; i++) if (subs[i].selected) return subs[i];
    return null;
  }

  function ccWanted() {
    return flag('cc', false);
  }

  function setCc(v) {
    Lampa.Storage.set('opensubs_cc', v ? 'true' : 'false');
  }

  // кнопка CC: включить или выключить
  function toggleCc() {
    if (isShowing()) {
      setCc(false);
      return turnOff();
    }
    setCc(true);
    var s = session;
    if (s && s.searching) {
      updateButtons();
      return Lampa.Noty.show('Ищу субтитры…');
    }
    if (s) {
      if (!turnOn(s, false)) setCc(false);
    } else {
      var any = trackList()[0];
      if (any) showTrack(any);
      else {
        setCc(false);
        Lampa.Noty.show(apiKey() ? 'Субтитры для этого видео не найдены' : 'OpenSubtitles: укажите API-ключ в настройках плагина');
      }
    }
    updateButtons();
  }

  // Lampa после загрузки видео сама выбирает дорожку по своим настройкам — возвращаем выбор пользователя
  function reassert() {
    var s = session;
    if (!s || typeof s.want === 'undefined') return;
    var subs = trackList();
    var on = isShowing();
    if (s.want === null) {
      if (on) selectTrack(null);
    } else {
      for (var i = 0; i < subs.length; i++) {
        var id = subs[i].os_id || subs[i].label || subs[i].index;
        if (id === s.want && on !== subs[i]) {
          selectTrack(subs[i]);
          break;
        }
      }
    }
    updateButtons();
  }

  // ---------- синхронизация ----------
  // Время в файле пересчитывается: t' = t * scale + offset. Параметры хранятся по file_id,
  // поэтому при повторном просмотре синхронизация сохраняется.

  var texts = {}; // file_id → исходный текст VTT (для пересчёта)

  function syncAll() {
    var c = Lampa.Storage.get('opensubs_sync', '{}');
    if (typeof c === 'string') try { c = JSON.parse(c); } catch (e) { c = {}; }
    return c && typeof c === 'object' ? c : {};
  }

  function getSync(fid) {
    var c = syncAll()[fid];
    return { scale: (c && c.scale) || 1, offset: (c && c.offset) || 0, anchors: (c && c.anchors) || [], auto: !!(c && c.auto), known: !!c };
  }

  function setSync(fid, sync) {
    var all = syncAll();
    if (sync.scale === 1 && !sync.offset && !sync.anchors.length && !sync.auto) delete all[fid];
    else all[fid] = { scale: sync.scale, offset: Math.round(sync.offset * 1000) / 1000, anchors: sync.anchors.slice(-4), auto: !!sync.auto, t: Date.now() };
    var keys = Object.keys(all);
    if (keys.length > 300) {
      keys.sort(function (a, b) { return (all[a].t || 0) - (all[b].t || 0); });
      for (var i = 0; i < keys.length - 300; i++) delete all[keys[i]];
    }
    Lampa.Storage.set('opensubs_sync', all);
  }

  function parseTime(h, m, sec, ms) {
    return (parseInt(h || '0', 10) * 3600) + parseInt(m, 10) * 60 + parseInt(sec, 10) + parseInt(ms, 10) / 1000;
  }

  function fmtTime(t) {
    if (t < 0) t = 0;
    var ms = Math.round(t * 1000);
    var h = Math.floor(ms / 3600000); ms -= h * 3600000;
    var m = Math.floor(ms / 60000); ms -= m * 60000;
    var sec = Math.floor(ms / 1000); ms -= sec * 1000;
    var p = function (n, l) { n = String(n); while (n.length < l) n = '0' + n; return n; };
    return p(h, 2) + ':' + p(m, 2) + ':' + p(sec, 2) + '.' + p(ms, 3);
  }

  var TIME_RX = /(?:(\d{1,2}):)?(\d{2}):(\d{2})[.,](\d{3})/g;

  function applySync(text, sync) {
    if (sync.scale === 1 && !sync.offset) return text;
    return text.replace(/^.*-->.*$/gm, function (line) {
      return line.replace(TIME_RX, function (all, h, m, sec, ms) {
        return fmtTime(parseTime(h, m, sec, ms) * sync.scale + sync.offset);
      });
    });
  }

  // реплики исходного файла: [{start, text}]
  function parseCues(text) {
    var out = [];
    var blocks = String(text).replace(/\r/g, '').split(/\n\n+/);
    for (var i = 0; i < blocks.length; i++) {
      var lines = blocks[i].split('\n');
      for (var j = 0; j < lines.length; j++) {
        if (lines[j].indexOf('-->') < 0) continue;
        TIME_RX.lastIndex = 0;
        var m = TIME_RX.exec(lines[j]);
        if (!m) break;
        var body = lines.slice(j + 1).join(' ').replace(/<[^>]+>|\{[^}]*\}/g, '').replace(/\s+/g, ' ').trim();
        if (body) out.push({ start: parseTime(m[1], m[2], m[3], m[4]), text: body });
        break;
      }
    }
    return out;
  }

  // заменить файл дорожки на пересчитанный и оставить её включённой
  function resync(track, sync) {
    var fid = track.os_id;
    setSync(fid, sync);
    var url = textUrl(applySync(texts[fid], sync));
    var state = videoSubs();
    if (!url || !state) return;
    var list = copySubs(state.subs);
    for (var j = 0; j < list.length; j++) if (list[j].os_id === fid) list[j].url = url;
    Lampa.Player.subtitles(list);
    var now = videoSubs();
    if (now) for (var i = 0; i < now.subs.length; i++) {
      if (now.subs[i].os_id === fid) {
        showTrack(now.subs[i]);
      }
    }
  }

  function videoTime() {
    try { return Lampa.PlayerVideo.video().currentTime || 0; } catch (e) { return 0; }
  }

  // Пользователь выбрал реплику, которая звучит прямо сейчас. Одна точка — сдвиг,
  // две точки далеко друг от друга — сдвиг и скорость (лечит «уползание» из-за разной частоты кадров).
  function anchorSync(track, cue, at) {
    var sync = getSync(track.os_id);
    var target = Math.max(0, at - 0.3); // реакция зрителя
    var anchors = sync.anchors.filter(function (x) { return Math.abs(x.o - cue.start) > 1; });
    anchors.push({ o: cue.start, t: target });

    var far = null;
    for (var i = 0; i < anchors.length - 1; i++) {
      if (Math.abs(anchors[i].o - cue.start) > 300 && (!far || Math.abs(anchors[i].o - cue.start) > Math.abs(far.o - cue.start))) far = anchors[i];
    }
    if (far) {
      var scale = (target - far.t) / (cue.start - far.o);
      if (scale > 0.9 && scale < 1.1) {
        sync.scale = scale;
        sync.offset = target - cue.start * scale;
      } else {
        far = null;
      }
    }
    if (!far) sync.offset = target - cue.start * sync.scale;
    sync.anchors = anchors;
    resync(track, sync);
    return !!far;
  }

  // ---------- автосинхронизация по английским субтитрам ----------
  // Реплики одного фильма на разных языках начинаются почти в одни моменты. Перебираем пересчёты частоты кадров
  // и для каждого строим гистограмму разниц «эталон − перевод»: пик даёт сдвиг, высота пика — качество совпадения.

  var SCALES = [1, 25 / 23.976, 23.976 / 25, 24 / 23.976, 23.976 / 24, 25 / 24, 24 / 25];

  function cueStarts(text, sync) {
    var c = parseCues(text);
    var out = [];
    for (var i = 0; i < c.length; i++) out.push(sync ? c[i].start * sync.scale + sync.offset : c[i].start);
    return out.sort(function (a, b) { return a - b; });
  }

  function matchTimings(ref, tgt) {
    var BIN = 0.2, WIN = 300;
    var best = null;
    for (var si = 0; si < SCALES.length; si++) {
      var sc = SCALES[si];
      var hist = {};
      var lo = 0;
      for (var i = 0; i < tgt.length; i++) {
        var x = tgt[i] * sc;
        while (lo < ref.length && ref[lo] < x - WIN) lo++;
        for (var j = lo; j < ref.length && ref[j] <= x + WIN; j++) {
          var k = Math.round((ref[j] - x) / BIN);
          hist[k] = (hist[k] || 0) + 1;
        }
      }
      for (var key in hist) {
        var kk = parseInt(key, 10);
        var score = hist[kk] + (hist[kk - 1] || 0) + (hist[kk + 1] || 0);
        if (!best || score > best.score) best = { scale: sc, k: kk, score: score };
      }
    }
    if (!best) return null;

    // уточняем сдвиг медианой разниц вокруг пика
    var ds = [];
    var lo2 = 0;
    for (var a = 0; a < tgt.length; a++) {
      var y = tgt[a] * best.scale;
      while (lo2 < ref.length && ref[lo2] < y + best.k * BIN - 0.5) lo2++;
      for (var b = lo2; b < ref.length && ref[b] <= y + best.k * BIN + 0.5; b++) {
        var d = ref[b] - y;
        if (Math.abs(d - best.k * BIN) <= 0.4) ds.push(d);
      }
    }
    ds.sort(function (p, q) { return p - q; });
    best.offset = ds.length ? ds[Math.floor(ds.length / 2)] : best.k * BIN;
    best.ratio = best.score / Math.max(1, Math.min(ref.length, tgt.length));
    return best;
  }

  // done(result|null, reason)
  function autoSync(track, done) {
    var s = session;
    var fid = track.os_id;
    var ref = s && s.found.en && s.found.en[0];
    if (!fid || !texts[fid]) return done(null, 'нет файла');
    if (!ref) return done(null, 'нет английских субтитров для сравнения');
    var rid = ref.files[0].file_id;
    if (rid === fid) return done(null, 'это и есть английские');

    download(rid, function (text) {
      if (!text) return done(null, 'не удалось скачать английские');
      texts[rid] = texts[rid] || text;
      setTimeout(function () {
        var res = matchTimings(cueStarts(text, getSync(rid)), cueStarts(texts[fid]));
        if (!res || res.score < 40 || res.ratio < 0.3) return done(null, 'файлы слишком разные');
        var sync = { scale: res.scale, offset: res.offset, anchors: [], auto: true };
        if (findTrack(fid)) resync(findTrack(fid), sync);
        else setSync(fid, sync);
        done(res);
      }, 30);
    }, function () {
      done(null, 'не удалось скачать английские');
    });
  }

  function describeAuto(res) {
    var parts = [];
    for (var i = 0; i < FPS.length; i++) {
      if (FPS[i].scale !== 1 && Math.abs(FPS[i].scale - res.scale) < 0.0005) parts.push('кадры ' + FPS[i].title.split(' (')[0]);
    }
    parts.push('сдвиг ' + (res.offset > 0 ? '+' : '') + res.offset.toFixed(1) + ' с');
    return parts.join(', ');
  }

  // при первом включении неанглийских субтитров — выровнять по английским (один раз на файл)
  function maybeAutoSync(track) {
    if (!flag('autosync', true) || !track || !track.os_id || track.language === 'en') return;
    var sync = getSync(track.os_id);
    if (sync.known) return; // уже выравнивали или пользователь правил вручную
    autoSync(track, function (res, reason) {
      if (res) {
        log('автосинхронизация', describeAuto(res), 'совпадение', res.ratio.toFixed(2));
        if (Math.abs(res.offset) > 0.3 || res.scale !== 1) notify('Субтитры выровнены: ' + describeAuto(res));
      } else {
        log('автосинхронизация не удалась:', reason);
        setSync(track.os_id, { scale: 1, offset: 0, anchors: [], auto: true }); // не пробовать снова
      }
    });
  }

  var FPS = [
    { title: 'Без изменений', scale: 1 },
    { title: '25 → 23.976 (субтитры спешат и уползают)', scale: 25 / 23.976 },
    { title: '23.976 → 25 (субтитры отстают и уползают)', scale: 23.976 / 25 },
    { title: '24 → 23.976', scale: 24 / 23.976 },
    { title: '23.976 → 24', scale: 23.976 / 24 },
    { title: '30 → 23.976', scale: 30 / 23.976 },
    { title: '23.976 → 30', scale: 23.976 / 30 }
  ];

  var STEPS = [-5, -2, -1, -0.5, -0.25, 0.25, 0.5, 1, 2, 5];

  function syncTitle(sync) {
    var parts = [];
    if (Math.abs(sync.offset) >= 0.05) parts.push((sync.offset > 0 ? '+' : '') + sync.offset.toFixed(2) + ' сек.');
    if (Math.abs(sync.scale - 1) > 0.0005) parts.push('скорость ×' + sync.scale.toFixed(4));
    return parts.length ? parts.join(', ') : 'Без коррекции';
  }

  // back — вернуться в меню субтитров, root — закрыть всё и вернуться к просмотру
  function syncMenu(track, back, root) {
    var sync = getSync(track.os_id);
    var reopen = function () {
      closeSelects();
      syncMenu(track, back, root);
    };

    closeSelects();
    Lampa.Select.show({
      title: 'Синхронизация',
      nohide: true,
      items: [
        { title: 'Автоматически', subtitle: 'Выровнять по английским субтитрам: сдвиг и частота кадров', name: 'auto' },
        { title: 'По фразе', subtitle: 'Выберите реплику, которая звучит сейчас. Сделайте так в начале и через 10+ минут — поправится и скорость', name: 'phrase' },
        { title: 'Сдвиг', subtitle: syncTitle(sync), name: 'shift' },
        { title: 'Частота кадров', subtitle: 'Если субтитры уползают всё дальше', name: 'fps' },
        { title: 'Сбросить', subtitle: 'Вернуть исходный файл', name: 'reset' }
      ],
      onBack: back,
      onSelect: function (a) {
        if (a.name === 'phrase') return phraseMenu(track, reopen, root);

        if (a.name === 'auto') {
          Lampa.Noty.show('Сравниваю с английскими субтитрами…');
          autoSync(track, function (res, reason) {
            Lampa.Noty.show(res ? 'Выровнено: ' + describeAuto(res) : 'Не получилось: ' + reason);
          });
          return root();
        }

        if (a.name === 'shift') {
          closeSelects();
          return Lampa.Select.show({
            title: 'Сдвиг: ' + syncTitle(sync),
            nohide: true,
            items: STEPS.map(function (v) {
              return { title: (v > 0 ? 'Позже на ' : 'Раньше на ') + Math.abs(v) + ' сек.', value: v };
            }),
            onBack: reopen,
            onSelect: function (b) {
              sync.offset += b.value;
              sync.anchors = [];
              resync(track, sync);
              reopen();
            }
          });
        }

        if (a.name === 'fps') {
          closeSelects();
          return Lampa.Select.show({
            title: 'Частота кадров',
            nohide: true,
            items: FPS.map(function (f) {
              return { title: f.title, scale: f.scale, selected: Math.abs(f.scale - sync.scale) < 0.0005 };
            }),
            onBack: reopen,
            onSelect: function (b) {
              // сохраняем положение текущего момента, меняя только скорость
              var t = videoTime();
              var orig = (t - sync.offset) / sync.scale;
              sync.scale = b.scale;
              sync.offset = t - orig * b.scale;
              sync.anchors = [];
              resync(track, sync);
              reopen();
            }
          });
        }

        if (a.name === 'reset') {
          resync(track, { scale: 1, offset: 0, anchors: [] });
          Lampa.Noty.show('Синхронизация сброшена');
          return reopen();
        }
      }
    });
  }

  function phraseMenu(track, reopen, root) {
    var cues = parseCues(texts[track.os_id] || '');
    if (!cues.length) {
      Lampa.Noty.show('Не удалось прочитать файл субтитров');
      return reopen();
    }
    var sync = getSync(track.os_id);
    var at = videoTime();
    var v = null;
    try { v = Lampa.PlayerVideo.video(); } catch (e) {}
    var wasPlaying = v && !v.paused;
    if (wasPlaying) try { v.pause(); } catch (e) {}
    var resume = function () {
      if (wasPlaying) try { v.play(); } catch (e) {}
    };

    // реплики вокруг текущего момента по нынешней синхронизации; с запасом — субтитры могут сильно спешить
    var shown = at * 1;
    var near = 0;
    for (var i = 0; i < cues.length; i++) {
      if (cues[i].start * sync.scale + sync.offset <= shown) near = i;
    }
    var from = Math.max(0, near - 25);
    var to = Math.min(cues.length, near + 15);
    var items = [];
    for (var j = from; j < to; j++) {
      var tt = cues[j].start * sync.scale + sync.offset;
      items.push({
        title: cues[j].text.length > 90 ? cues[j].text.slice(0, 90) + '…' : cues[j].text,
        subtitle: fmtTime(tt).slice(0, 8),
        cue: cues[j],
        selected: j === near
      });
    }

    closeSelects();
    Lampa.Select.show({
      title: 'Какая фраза звучит сейчас?',
      nohide: true,
      items: items,
      onBack: function () {
        resume();
        reopen();
      },
      onSelect: function (b) {
        var both = anchorSync(track, b.cue, at);
        Lampa.Noty.show(both ? 'Сдвиг и скорость подобраны' : 'Сдвиг подобран. Для точности повторите через 10+ минут');
        resume();
        root();
      }
    });
  }

  // ---------- кнопка субтитров в плеере ----------

  var SIZES = [
    { value: 'auto', title: 'Как в Lampa' },
    { value: 's', title: 'Маленький', em: 1.6 },
    { value: 'm', title: 'Средний', em: 2 },
    { value: 'l', title: 'Обычный', em: 2.5 },
    { value: 'xl', title: 'Крупный', em: 3 },
    { value: 'xxl', title: 'Очень крупный', em: 3.6 }
  ];

  var SHADOWS = [
    { value: 'auto', title: 'Как в Lampa' },
    { value: 'none', title: 'Без тени' },
    { value: 'soft', title: 'Мягкая тень' },
    { value: 'outline', title: 'Обводка' },
    { value: 'backdrop', title: 'Тёмная подложка' }
  ];

  // Иконка CC в сетке спрайтов плеера Lampa (21×21, линия 2.5). Выключено — контур, включено — заливка
  // (буквы вырезаны маской, сквозь них виден фон кнопки).
  var CC_PATH = 'M9.50 8.37A2.7 2.7 0 1 0 9.50 12.63M15.86 8.37A2.7 2.7 0 1 0 15.86 12.63';
  var ccSeq = 0;

  function ccIcon() {
    var id = 'ops-cc-mask-' + (++ccSeq);
    return '<svg viewBox="0 0 21 21" fill="none">' +
      '<defs><mask id="' + id + '"><rect x="0" y="0" width="21" height="21" fill="#fff"/>' +
      '<path d="' + CC_PATH + '" stroke="#000" stroke-width="2.3" stroke-linecap="round"/></mask></defs>' +
      '<g class="ops-cc-off"><rect x="1.25" y="3.75" width="18.5" height="13.5" rx="3.2" stroke="currentColor" stroke-width="2.5"/>' +
      '<path d="' + CC_PATH + '" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/></g>' +
      '<g class="ops-cc-on"><rect x="0" y="2.5" width="21" height="16" rx="4.4" fill="currentColor" mask="url(#' + id + ')"/></g>' +
      '</svg>';
  }

  var ICON = '<svg viewBox="0 0 21 21" fill="none"><rect x="1.25" y="3.75" width="18.5" height="13.5" rx="3.2" stroke="currentColor" stroke-width="2.5"/>' +
    '<path d="' + CC_PATH + '" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/></svg>';

  function css() {
    if (document.getElementById('opensubs-style')) return;
    var sel = '.player-video__subtitles';
    var rules = [
      'body.ops-has-btn .player-panel__subs{display:none !important}',
      '.ops-btn .ops-cc-on{display:none}',
      '.ops-btn.ops-on .ops-cc-on{display:inline}',
      '.ops-btn.ops-on .ops-cc-off{display:none}',
      '.ops-btn.ops-pending svg{opacity:.5}',
      'body.ops-shadow-none ' + sel + '{text-shadow:none !important}',
      'body.ops-shadow-none ' + sel + ' .player-video__subtitles-text{background:none !important}',
      'body.ops-shadow-soft ' + sel + '{text-shadow:0 0.05em 0.15em rgba(0,0,0,.95),0 0 0.5em rgba(0,0,0,.7) !important}',
      'body.ops-shadow-soft ' + sel + ' .player-video__subtitles-text{background:none !important}',
      'body.ops-shadow-outline ' + sel + '{text-shadow:0 2px 1px #000,0 -2px 1px #000,-2px 1px 0 #000,2px 0 1px #000 !important}',
      'body.ops-shadow-outline ' + sel + ' .player-video__subtitles-text{background:none !important}',
      'body.ops-shadow-backdrop ' + sel + '{text-shadow:none !important}',
      'body.ops-shadow-backdrop ' + sel + ' .player-video__subtitles-text{background:rgba(0,0,0,.6) !important;padding:0 .25em}'
    ];
    for (var i = 0; i < SIZES.length; i++) {
      if (SIZES[i].em) rules.push('body.ops-size-' + SIZES[i].value + ' ' + sel + '{font-size:' + SIZES[i].em + 'em !important}');
    }
    var st = document.createElement('style');
    st.id = 'opensubs-style';
    st.textContent = rules.join('\n');
    document.head.appendChild(st);
  }

  function applyStyle() {
    var b = document.body;
    var cls = b.className.split(/\s+/).filter(function (c) { return !/^ops-(size|shadow)-/.test(c); });
    cls.push('ops-size-' + setting('size', 'auto'));
    cls.push('ops-shadow-' + setting('shadow', 'auto'));
    b.className = cls.join(' ');
  }

  function titleOf(list, value) {
    for (var i = 0; i < list.length; i++) if (list[i].value === value) return list[i].title;
    return list[0].title;
  }

  function trackList() {
    try {
      var v = Lampa.PlayerVideo.video();
      if (!v) return [];
      var subs = v.customSubs || v.textTracks || [];
      var out = [];
      for (var i = 0; i < subs.length; i++) if (subs[i]) out.push(subs[i]);
      return out;
    } catch (e) {
      return [];
    }
  }

  function cueBox(show) {
    var box = document.querySelectorAll('.player-video__subtitles');
    for (var i = 0; i < box.length; i++) box[i].classList.toggle('hide', !show);
  }

  function selectTrack(track) {
    var subs = trackList();
    for (var i = 0; i < subs.length; i++) {
      subs[i].mode = 'disabled';
      subs[i].selected = false;
    }
    if (track) {
      track.mode = 'showing';
      track.selected = true;
    }
    cueBox(!!track);
  }

  // Новая Lampa складывает селекты в стек; закрываем всё и рисуем меню заново, чтобы подписи были свежими
  function closeSelects() {
    if (Lampa.Select.closeAll) Lampa.Select.closeAll();
    else Lampa.Select.close();
  }

  function menu(back) {
    var subs = trackList();
    var on = null;
    for (var i = 0; i < subs.length; i++) if (subs[i].selected || subs[i].mode === 'showing') { on = subs[i]; break; }

    Lampa.Select.show({
      title: 'Субтитры',
      nohide: true,
      items: [
        { title: 'Язык субтитров', subtitle: (on ? (on.label || on.language || 'Дорожка') : 'Выключены') + (session && session.audio && setting('lang', 'audio') === 'audio' ? ' · озвучка: ' + langName(session.audio) : ''), name: 'lang' },
        { title: 'Размер шрифта', subtitle: titleOf(SIZES, setting('size', 'auto')), name: 'size' },
        { title: 'Тень шрифта', subtitle: titleOf(SHADOWS, setting('shadow', 'auto')), name: 'shadow' },
        { title: 'Синхронизация', subtitle: on && on.os_id ? syncTitle(getSync(on.os_id)) : 'Для субтитров OpenSubtitles', name: 'sync' }
      ],
      onBack: back,
      onSelect: function (a) {
        var again = function () {
          closeSelects();
          menu(back);
        };

        if (a.name === 'lang') {
          var items = [{ title: 'Выключены', selected: !on, act: 'off' }];
          for (var j = 0; j < subs.length; j++) {
            items.push({ title: subs[j].label || subs[j].language || ('Дорожка ' + (j + 1)), selected: subs[j] === on, track: subs[j] });
          }
          // найденные, но ещё не скачанные варианты OpenSubtitles
          if (session) {
            var order = langOrder(session);
            for (var l = 0; l < order.length; l++) {
              var cand = session.found[order[l]] || [];
              for (var c = 0; c < cand.length; c++) {
                if (findTrack(cand[c].files[0].file_id)) continue;
                items.push({ title: trackLabel(cand[c]), subtitle: 'Скачать', cand: cand[c] });
              }
            }
          }
          if (items.length === 1) {
            Lampa.Noty.show(!apiKey() ? 'OpenSubtitles: укажите API-ключ в настройках плагина' : session && session.searching ? 'Ищу субтитры…' : 'Субтитры для этого видео не найдены');
            return again();
          }
          closeSelects();
          return Lampa.Select.show({
            title: 'Язык субтитров',
            items: items,
            nohide: true,
            onBack: again,
            onSelect: function (b) {
              if (b.act === 'off') {
                setCc(false);
                turnOff();
              } else if (b.track) {
                setCc(true);
                showTrack(b.track);
                maybeAutoSync(b.track);
              } else if (b.cand) {
                setCc(true);
                ensureTrack(b.cand, function (t) { showTrack(t); maybeAutoSync(t); }, function () {
                  Lampa.Noty.show('Не удалось скачать субтитры');
                });
              }
              back();
            }
          });
        }

        var list = a.name === 'size' ? SIZES : a.name === 'shadow' ? SHADOWS : null;
        if (list) {
          var cur = setting(a.name, 'auto');
          closeSelects();
          return Lampa.Select.show({
            title: a.title,
            items: list.map(function (o) { return { title: o.title, value: o.value, selected: o.value === cur }; }),
            nohide: true,
            onBack: again,
            onSelect: function (b) {
              Lampa.Storage.set('opensubs_' + a.name, b.value);
              applyStyle();
              again();
            }
          });
        }

        if (a.name === 'sync') {
          if (!on || !on.os_id || !texts[on.os_id]) {
            Lampa.Noty.show('Сначала включите субтитры OpenSubtitles');
            return again();
          }
          return syncMenu(on, again, back);
        }
      }
    });
  }

  function makeButton() {
    var btn = document.createElement('div');
    btn.className = 'player-panel__opensubs ops-btn button selector';
    btn.innerHTML = ccIcon() + '<div class="tooltip">Субтитры</div>';
    $(btn).on('hover:enter', function () {
      toggleCc();
    });
    return btn;
  }

  function updateButtons() {
    var on = !!isShowing();
    var pending = !!(session && (session.pending || (session.searching && ccWanted())));
    var btns = document.querySelectorAll('.ops-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('ops-on', on || pending);
      btns[i].classList.toggle('ops-pending', pending && !on);
      var tip = btns[i].querySelector('.tooltip');
      if (tip) tip.textContent = on ? 'Выключить субтитры' : 'Включить субтитры';
    }
  }

  function openSettingsMenu() {
    var back = function () {
      closeSelects();
      Lampa.Controller.toggle(Lampa.Platform.screen('mobile') ? 'player' : 'player_panel');
    };
    closeSelects();
    menu(back);
  }

  // пункт «Субтитры» в настройках плеера (шестерёнка) открывает наше меню
  function hookPlayerSettings() {
    if (!Lampa.Select.listener) return;
    Lampa.Select.listener.follow('preshow', function (e) {
      var act = e && e.active;
      if (!act || !act.items || act._opensubs) return;
      if (!(Lampa.Player.opened && Lampa.Player.opened())) return;
      var item = null;
      for (var i = 0; i < act.items.length; i++) if (act.items[i] && act.items[i].method === 'subs') item = act.items[i];
      if (!item) return;
      act._opensubs = true;
      var on = isShowing();
      item.subtitle = on ? (on.label || 'Включены') : 'Выключены';
      var orig = act.onSelect;
      act.onSelect = function (a) {
        if (a && a.method === 'subs') return openSettingsMenu();
        return orig && orig.apply(this, arguments);
      };
    });
  }

  // кнопка — отдельным блоком сразу после выбора качества (и в начале блока кнопок на телефоне)
  function addButton() {
    if (document.querySelector('.ops-btn')) return;
    var quality = document.querySelector('.player-panel__quality');
    if (!quality) return;

    var box = document.createElement('div');
    box.className = 'player-panel__box-buttons ops-box';
    box.appendChild(makeButton());
    var qbox = quality.parentNode;
    qbox.parentNode.insertBefore(box, qbox.nextSibling);

    var more = document.querySelector('.player-panel__mobile-more');
    if (more) more.parentNode.insertBefore(makeButton(), more);

    document.body.classList.add('ops-has-btn');
  }

  // ---------- настройки ----------

  function settings() {
    if (!Lampa.SettingsApi) return;

    Lampa.SettingsApi.addComponent({
      component: 'opensubs',
      name: 'OpenSubtitles',
      icon: ICON
    });

    Lampa.SettingsApi.addParam({
      component: 'opensubs',
      param: { name: 'opensubs_enabled', type: 'trigger', default: true },
      field: { name: 'Искать субтитры', description: 'При запуске видео. Включаются кнопкой CC в плеере' }
    });

    Lampa.SettingsApi.addParam({
      component: 'opensubs',
      param: {
        name: 'opensubs_lang',
        type: 'select',
        values: { audio: 'Как у озвучки', ru: 'Русские', uk: 'Українські', en: 'English' },
        default: 'audio'
      },
      field: { name: 'Язык субтитров', description: '«Как у озвучки» — по выбранной дорожке: (EN) Оригинал → английские, DUB → русские' }
    });

    Lampa.SettingsApi.addParam({
      component: 'opensubs',
      param: {
        name: 'opensubs_langs',
        type: 'select',
        values: {
          'ru,uk,en': 'Русские, украинские, английские',
          'ru,en': 'Русские, английские',
          'uk,en': 'Украинские, английские',
          'uk,ru,en': 'Украинские, русские, английские',
          'en,ru': 'Английские, русские',
          'en': 'Только английские'
        },
        default: 'ru,uk,en'
      },
      field: { name: 'Запасные языки', description: 'Если на языке озвучки субтитров нет' }
    });

    Lampa.SettingsApi.addParam({
      component: 'opensubs',
      param: { name: 'opensubs_autosync', type: 'trigger', default: true },
      field: { name: 'Автосинхронизация', description: 'Выравнивать русские и украинские субтитры по английским (ещё одно скачивание на фильм)' }
    });

    Lampa.SettingsApi.addParam({
      component: 'opensubs',
      param: { name: 'opensubs_notify', type: 'trigger', default: true },
      field: { name: 'Уведомления', description: 'Сообщать об отсутствующем API-ключе и других проблемах' }
    });

    Lampa.SettingsApi.addParam({
      component: 'opensubs',
      param: { name: 'opensubs_apikey', type: 'input', values: '', placeholder: 'ключ с opensubtitles.com', default: '' },
      field: { name: 'API-ключ', description: 'Обязательно. opensubtitles.com → Профиль → API consumers' }
    });

    Lampa.SettingsApi.addParam({
      component: 'opensubs',
      param: { name: 'opensubs_clear', type: 'button' },
      field: { name: 'Очистить сохранённые субтитры', description: 'Скачанные файлы хранятся на этом устройстве' },
      onRender: function (item) {
        storeStats(function (n) {
          var d = item.find('.settings-param__descr');
          if (n >= 0) d.text('Сохранено на этом устройстве: ' + n + ' (до ' + DB_MAX + ', старые удаляются сами)');
          else d.text('Хранилище недоступно на этом устройстве');
        });
      },
      onChange: function () {
        storeClear(function () {
          Lampa.Noty.show('OpenSubtitles: сохранённые субтитры удалены');
          Lampa.Settings.update();
        });
      }
    });
  }

  function start() {
    settings();
    css();
    applyStyle();
    addButton();
    hookPlayerSettings();
    try {
      Lampa.PlayerVideo.listener.follow('subs', function () { setTimeout(reassert, 0); });
    } catch (e) {}
    var timer = null;
    Lampa.Player.listener.follow('start', function (data) {
      addButton();
      applyStyle();
      clearInterval(timer);
      timer = setInterval(updateButtons, 1000);
      current = null;
      revokeUrls(); // файлы прошлого видео больше не нужны
      try { load(data || {}); } catch (e) { log('error', e); }
    });
    Lampa.Player.listener.follow('destroy', function () {
      current = null;
      clearInterval(timer); // сеанс не сбрасываем: Lampa шлёт destroy и при переключении серий
    });
    try { localStorage.removeItem('opensubs_links'); } catch (e) {} // кеш ссылок из первой версии
  }

  if (window.appready) start();
  else {
    Lampa.Listener.follow('app', function (e) {
      if (e.type === 'ready') start();
    });
  }
})();
