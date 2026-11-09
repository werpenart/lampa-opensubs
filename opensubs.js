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
      // русские студии озвучки (украинские версии помечены «Украинский» и ловятся выше)
      if (/lostfilm|hdrezka|rezka|newstudio|tvshows|good ?people|кубик|alexfilm|jaskier|coldfilm|baibako|amedia|ideafilm|кравец|red ?head|сыендук|кураж|бомбей|novamedia|softbox|nexus|gears|anilibria|anidub|кинопоиск|пифагор|невафильм|мосфильм/i.test(t)) return 'ru';
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
      var url = text ? textUrl(applySync(text, composed(fid))) : link;
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
    if (track && track.os_id) {
      durationSync();
      audioStart();
    }
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
  // Два уровня поправок времени:
  //   файл  → английский эталон (fileSync, по file_id): частота кадров и сдвиг самого файла субтитров;
  //   видео → конкретный источник (videoSync, по фильму/серии + источнику + озвучке): заставка студии
  //           (LostFilm, HDRezka…), частота кадров видео, ручные правки, подстройка по звуку.
  // Итог: t' = (t * f.scale + f.offset) * v.scale + v.offset.

  var texts = {}; // file_id → исходный текст VTT

  function store(name) {
    var c = Lampa.Storage.get(name, '{}');
    if (typeof c === 'string') try { c = JSON.parse(c); } catch (e) { c = {}; }
    return c && typeof c === 'object' ? c : {};
  }

  function storeSave(name, all, max) {
    var keys = Object.keys(all);
    if (keys.length > max) {
      keys.sort(function (a, b) { return (all[a].t || 0) - (all[b].t || 0); });
      for (var i = 0; i < keys.length - max; i++) delete all[keys[i]];
    }
    Lampa.Storage.set(name, all);
  }

  function round3(x) { return Math.round(x * 1000) / 1000; }

  // --- файл
  function fileSync(fid) {
    var c = store('opensubs_sync')[fid];
    return { scale: (c && c.scale) || 1, offset: (c && c.offset) || 0, known: !!c };
  }

  function setFileSync(fid, f) {
    var all = store('opensubs_sync');
    all[fid] = { scale: f.scale, offset: round3(f.offset), auto: true, t: Date.now() };
    storeSave('opensubs_sync', all, 300);
  }

  // --- видео
  function sourceKey(s) {
    var bal = '';
    try {
      var last = store('online_last_balanser');
      bal = last[s.card.id] || '';
    } catch (e) {}
    if (!bal) {
      var m = String(s.data.url || '').match(/^https?:\/\/([^\/]+)\/(?:lite\/)?([a-z0-9_-]+)/i);
      bal = m ? m[1] + '/' + m[2] : '';
    }
    var voice = typeof s.data.translate === 'string' ? s.data.translate : (s.data.voice_name || '');
    return String(bal).toLowerCase() + '|' + String(voice).toLowerCase().replace(/\s+/g, ' ').trim();
  }

  // студия озвучки: «LostFilm», «HDRezka Studio», «Кубик в Кубе»… — заставка у студии одна на все сериалы
  function studioKey(s) {
    var v = [typeof s.data.translate === 'string' ? s.data.translate : '', s.data.voice_name || ''].join(' ').toLowerCase();
    v = v.replace(/\b(\d{3,4}p|4k|uhd|hdr|sdr|fhd|hd)\b|\(.*?\)|[|·•\-_.,]/g, ' ').replace(/\s+/g, ' ').trim();
    return v ? 'studio|' + v : '';
  }

  function videoKeys(s) {
    var src = s.card.id + '|' + sourceKey(s);
    var ep = episodeInfo(s.data);
    return { exact: src + (ep ? '|' + ep.season + 'x' + ep.episode : ''), source: src, studio: studioKey(s) };
  }

  function videoSync() {
    var s = session;
    if (!s) return { scale: 1, offset: 0, anchors: [] };
    if (!s.vsync) {
      var k = videoKeys(s);
      var c = store('opensubs_vsync')[k.exact];
      var pr = store('opensubs_vprior');
      // другая серия того же источника, затем любой сериал этой студии: заставка обычно та же
      var prior = !c && (pr[k.source] || (k.studio && pr[k.studio]));
      s.vsync = c ? { scale: c.scale, offset: c.offset, anchors: c.anchors || [], manual: !!c.manual, src: c.src }
        : prior ? { scale: pr[k.source] ? prior.scale : 1, offset: prior.offset, anchors: [], prior: pr[k.source] ? 'source' : 'studio' }
        : { scale: 1, offset: 0, anchors: [] };
      if (prior) log('поправка из', s.vsync.prior, s.vsync.offset);
    }
    return s.vsync;
  }

  function setVideoSync(v) {
    var s = session;
    if (!s) return;
    s.vsync = v;
    var k = videoKeys(s);
    var all = store('opensubs_vsync');
    var pr = store('opensubs_vprior');
    if (v.scale === 1 && !v.offset && !v.anchors.length && !v.src) {
      delete all[k.exact];
      delete pr[k.source];
    } else {
      all[k.exact] = { scale: v.scale, offset: round3(v.offset), anchors: v.anchors.slice(-8), manual: !!v.manual, src: v.src, t: Date.now() };
      pr[k.source] = { scale: v.scale, offset: round3(v.offset), t: Date.now() };
      // студии запоминаем только сдвиг начала (заставку), скорость у разных сериалов своя
      if (k.studio) pr[k.studio] = { scale: 1, offset: round3(v.offset + (v.anchors.length ? v.anchors[0].o * (v.scale - 1) : 0)), t: Date.now() };
    }
    storeSave('opensubs_vsync', all, 500);
    storeSave('opensubs_vprior', pr, 200);
  }

  function composed(fid) {
    var f = fileSync(fid);
    var v = videoSync();
    return { scale: f.scale * v.scale, offset: f.offset * v.scale + v.offset };
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
    if (Math.abs(sync.scale - 1) < 1e-9 && Math.abs(sync.offset) < 0.0005) return text;
    return text.replace(/^.*-->.*$/gm, function (line) {
      return line.replace(TIME_RX, function (all, h, m, sec, ms) {
        return fmtTime(parseTime(h, m, sec, ms) * sync.scale + sync.offset);
      });
    });
  }

  // реплики файла: [{start, end, text}]
  function parseCues(text) {
    var out = [];
    var blocks = String(text).replace(/\r/g, '').split(/\n\n+/);
    for (var i = 0; i < blocks.length; i++) {
      var lines = blocks[i].split('\n');
      for (var j = 0; j < lines.length; j++) {
        if (lines[j].indexOf('-->') < 0) continue;
        TIME_RX.lastIndex = 0;
        var m1 = TIME_RX.exec(lines[j]);
        var m2 = m1 && TIME_RX.exec(lines[j]);
        if (!m1) break;
        var body = lines.slice(j + 1).join(' ').replace(/<[^>]+>|\{[^}]*\}/g, '').replace(/\s+/g, ' ').trim();
        var st = parseTime(m1[1], m1[2], m1[3], m1[4]);
        if (body) out.push({ start: st, end: m2 ? parseTime(m2[1], m2[2], m2[3], m2[4]) : st + 2, text: body });
        break;
      }
    }
    return out;
  }

  // пересобрать файлы всех дорожек OpenSubtitles с текущими поправками, выбранную оставить включённой
  function resyncAll() {
    var state = videoSubs();
    if (!state) return;
    var on = isShowing();
    var onId = on && (on.os_id || on.label);
    var list = copySubs(state.subs);
    var changed = false;
    for (var j = 0; j < list.length; j++) {
      var fid = list[j].os_id;
      if (!fid || !texts[fid]) continue;
      var url = textUrl(applySync(texts[fid], composed(fid)));
      if (url) {
        list[j].url = url;
        changed = true;
      }
    }
    if (!changed) return;
    Lampa.Player.subtitles(list);
    if (!onId) return;
    var now = trackList();
    for (var i = 0; i < now.length; i++) {
      if ((now[i].os_id || now[i].label) === onId) {
        showTrack(now[i]);
        break;
      }
    }
  }

  function videoTime() {
    try { return Lampa.PlayerVideo.video().currentTime || 0; } catch (e) { return 0; }
  }

  // Якорь: «момент o (в координатах выровненного файла) должен показываться в t». Одна точка — сдвиг,
  // точки дальше 5 минут друг от друга — сдвиг и скорость (наклон прямой по методу наименьших квадратов).
  function fitAnchors(v) {
    var an = v.anchors;
    if (!an.length) return v;
    var minO = Infinity, maxO = -Infinity;
    for (var i = 0; i < an.length; i++) {
      minO = Math.min(minO, an[i].o);
      maxO = Math.max(maxO, an[i].o);
    }
    if (an.length >= 2 && maxO - minO >= 300) {
      var n = an.length, so = 0, st = 0, soo = 0, sot = 0;
      for (var j = 0; j < n; j++) {
        so += an[j].o; st += an[j].t; soo += an[j].o * an[j].o; sot += an[j].o * an[j].t;
      }
      var den = n * soo - so * so;
      var sc = den ? (n * sot - so * st) / den : 1;
      if (sc > 0.9 && sc < 1.1) {
        v.scale = sc;
        v.offset = (st - sc * so) / n;
        return v;
      }
    }
    var last = an[an.length - 1];
    v.offset = last.t - last.o * v.scale;
    return v;
  }

  // добавить якорь (старые рядом с ним заменяются)
  function addAnchor(o, t, kind) {
    var v = videoSync();
    if (kind === 'phrase') v.manual = true;
    v.anchors = v.anchors.filter(function (x) { return Math.abs(x.o - o) > 90; });
    v.anchors.push({ o: round3(o), t: round3(t), k: kind });
    if (v.anchors.length > 8) v.anchors = v.anchors.slice(-8);
    v.prior = false;
    setVideoSync(fitAnchors(v));
    if (kind === 'phrase') learnResidual();
    resyncAll();
    return v;
  }

  // пользователь выбрал реплику, которая звучит сейчас
  function anchorPhrase(track, cue, at) {
    var f = fileSync(track.os_id);
    var v = addAnchor(cue.start * f.scale + f.offset, Math.max(0, at - 0.3), 'phrase');
    return Math.abs(v.scale - 1) > 0.0005 && v.anchors.length >= 2;
  }

  // ---------- автовыравнивание файла по английским субтитрам ----------
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
        var res = matchTimings(cueStarts(text, fileSync(rid)), cueStarts(texts[fid]));
        if (!res || res.score < 40 || res.ratio < 0.3) return done(null, 'файлы слишком разные');
        setFileSync(fid, { scale: res.scale, offset: res.offset });
        resyncAll();
        done(res);
      }, 30);
    }, function () {
      done(null, 'не удалось скачать английские');
    });
  }

  function fpsName(scale) {
    for (var i = 0; i < FPS.length; i++) {
      if (FPS[i].scale !== 1 && Math.abs(FPS[i].scale - scale) < 0.0005) return FPS[i].title.split(' (')[0];
    }
    return '';
  }

  function describeAuto(res) {
    var parts = [];
    var f = fpsName(res.scale);
    if (f) parts.push('кадры ' + f);
    parts.push('сдвиг ' + (res.offset > 0 ? '+' : '') + res.offset.toFixed(1) + ' с');
    return parts.join(', ');
  }

  // при первом включении неанглийских субтитров — выровнять файл по английским (один раз на файл)
  function maybeAutoSync(track) {
    if (track && track.os_id) audioStart();
    if (!flag('autosync', true) || !track || !track.os_id || track.language === 'en') return;
    if (fileSync(track.os_id).known) return;
    autoSync(track, function (res, reason) {
      if (res) {
        log('по английским:', describeAuto(res), 'совпадение', res.ratio.toFixed(2));
        if (Math.abs(res.offset) > 0.3 || res.scale !== 1) notify('Субтитры выровнены: ' + describeAuto(res));
      } else {
        log('по английским не удалось:', reason);
        setFileSync(track.os_id, { scale: 1, offset: 0 }); // не пробовать снова
      }
    });
  }

  // ---------- длительность оригинала у того же источника ----------
  // Озвучки студий отличаются от оригинала вставленной заставкой (LostFilm, HDRezka, Newstudio…), и вставляют её не всегда.
  // Источник Lampac отдаёт рядом с озвучками дорожку «Оригинальный» — та же серия без заставки. Разница длительностей
  // (до сотых секунды по HLS-плейлисту) и есть длина заставки. Если разница = 25/23.976 — это пересчёт частоты кадров.

  function getText(url, done, fail) {
    var r = new XMLHttpRequest();
    r.open('GET', url, true);
    r.timeout = 20000;
    r.onload = function () { r.status >= 200 && r.status < 300 ? done(r.responseText) : fail(r.status); };
    r.onerror = r.ontimeout = function () { fail(0); };
    r.send(null);
  }

  function getJSON(url, done, fail) {
    getText(url, function (t) {
      var j = null;
      try { j = JSON.parse(t); } catch (e) {}
      j ? done(j) : fail('json');
    }, fail);
  }

  function lampacInfo(s) {
    var m = String(s.data.url || '').match(/^(https?:\/\/[^\/]+)\//);
    var bal = '';
    try { bal = store('online_last_balanser')[s.card.id] || ''; } catch (e) {}
    if (!bal) {
      var b = String(s.data.url || '').match(/\/lite\/([a-z0-9_]+)/i);
      bal = b ? b[1] : '';
    }
    if (!m || !bal) return null;
    var acc = [];
    var qs = String(s.data.url).split('?')[1] || '';
    qs.split('&').forEach(function (x) { if (/^(account_email|uid|token|nws_id)=/.test(x)) acc.push(x); });
    return { host: m[1], bal: String(bal).toLowerCase(), acc: acc.join('&') };
  }

  var ORIG_RX = /^\s*(оригинал|оригинальный|оригінал|original)/i;
  var SUBS_RX = /^\s*субтитр/i; // оригинальная дорожка с вшитыми субтитрами — запасной эталон

  function pickOriginal(list, nameOf) {
    var alt = null;
    for (var i = 0; i < list.length; i++) {
      var n = nameOf(list[i]) || '';
      if (ORIG_RX.test(n)) return list[i];
      if (!alt && SUBS_RX.test(n)) alt = list[i];
    }
    return alt;
  }

  // длительность HLS по плейлисту (сумма EXTINF)
  function hlsDuration(url, done, fail) {
    getText(url, function (m) {
      if (/#EXTINF/.test(m)) {
        if (!/#EXT-X-ENDLIST/.test(m)) return fail('live');
        var sum = 0;
        m.replace(/#EXTINF:([0-9.]+)/g, function (a, d) { sum += parseFloat(d); return a; });
        return done(sum);
      }
      var v = m.match(/^\s*([^#\s][^\s]*)\s*$/m);
      if (!v) return fail('нет вариантов');
      var u = v[1];
      if (!/^https?:/.test(u)) u = url.replace(/[^\/?]*(\?.*)?$/, '') + u;
      hlsDuration(u, done, fail);
    }, fail);
  }

  function playableUrl(item, done, fail) {
    var pickQ = function (j) {
      var q = j.quality || {};
      var keys = Object.keys(q);
      // самое низкое качество — плейлист легче, длительность та же
      keys.sort(function (a, b) { return parseInt(a, 10) - parseInt(b, 10); });
      return keys.length ? q[keys[0]] : j.url;
    };
    if (item.method === 'call') getJSON(item.url, function (j) { pickQ(j) ? done(pickQ(j)) : fail('нет ссылки'); }, fail);
    else done(pickQ(item));
  }

  function originalDuration(s, done) {
    var info = lampacInfo(s);
    if (!info) return done(null, 'источник не Lampac');
    var ep = episodeInfo(s.data);
    var key = info.bal + '|' + s.card.id + (ep ? '|' + ep.season + 'x' + ep.episode : '');
    var cache = store('opensubs_odur');
    if (cache[key]) return done(cache[key].d);

    var finish = function (item) {
      if (!item) return done(null, 'у источника нет оригинальной дорожки');
      playableUrl(item, function (u) {
        if (!/m3u8/i.test(u)) return done(null, 'не HLS');
        hlsDuration(u, function (d) {
          cache[key] = { d: d, t: Date.now() };
          storeSave('opensubs_odur', cache, 300);
          done(d);
        }, function (e) { done(null, 'плейлист: ' + e); });
      }, function (e) { done(null, 'ссылка: ' + e); });
    };

    var episodesOf = function (json, cb) {
      // json.type === 'episode': серии выбранной озвучки и список озвучек
      var voice = json.voice && pickOriginal(json.voice, function (v) { return v.name; });
      if (!voice) return cb(null);
      if (voice.active) return cb(json);
      getJSON(withAcc(voice.url), cb, function () { cb(null); });
    };

    var withAcc = function (u) { return info.acc ? u + (u.indexOf('?') >= 0 ? '&' : '?') + info.acc : u; };

    var request = function (card) {
      var q = ['rjson=true', 'id=' + encodeURIComponent(card.id)];
      if (card.imdb_id) q.push('imdb_id=' + card.imdb_id);
      if (card.kinopoisk_id) q.push('kinopoisk_id=' + card.kinopoisk_id);
      q.push('title=' + encodeURIComponent(card.title || card.name || ''));
      q.push('original_title=' + encodeURIComponent(card.original_title || card.original_name || ''));
      q.push('serial=' + (card.name ? 1 : 0));
      q.push('original_language=' + (card.original_language || ''));
      q.push('year=' + String(card.release_date || card.first_air_date || '0000').slice(0, 4));
      q.push('source=' + (card.source || 'tmdb'));
      if (ep) q.push('s=' + ep.season);
      getJSON(withAcc(info.host + '/lite/' + info.bal + '?' + q.join('&')), function (json) {
        if (json.type === 'movie') return finish(pickOriginal(json.data || [], function (x) { return x.translate || x.details || x.title; }));
        if (json.type === 'episode' && ep) {
          return episodesOf(json, function (list) {
            if (!list) return finish(null);
            var items = list.data || [];
            for (var i = 0; i < items.length; i++) if (parseInt(items[i].e, 10) === ep.episode) return finish(items[i]);
            finish(null);
          });
        }
        done(null, 'ответ источника: ' + json.type);
      }, function (e) { done(null, 'запрос к источнику: ' + e); });
    };

    var card = s.card;
    if (card.kinopoisk_id || card.imdb_id) return request(card);
    // id других баз — как это делает онлайн-плагин Lampac
    getJSON(withAcc(info.host + '/externalids?id=' + encodeURIComponent(card.id) + '&serial=' + (card.name ? 1 : 0)), function (ids) {
      var c = {};
      for (var k in card) c[k] = card[k];
      for (var n in ids) c[n] = ids[n];
      request(c);
    }, function () { request(card); });
  }

  function residualKey(s) {
    var info = lampacInfo(s);
    return info ? s.card.id + '|' + info.bal : null;
  }

  function residual(s) {
    var k = residualKey(s);
    var r = k && store('opensubs_resid')[k];
    return r ? r.o : null;
  }

  // пользователь поправил вручную при известной заставке озвучки → остаток = заставка площадки
  function learnResidual() {
    var s = session;
    if (!s || s.durDiff === null || typeof s.durDiff === 'undefined') return;
    var v = videoSync();
    if (Math.abs(v.scale - 1) > 0.0005) return;
    var k = residualKey(s);
    if (!k) return;
    var all = store('opensubs_resid');
    var o = round3(v.offset - s.durDiff);
    if (Math.abs(o) > 60) return;
    all[k] = { o: o, t: Date.now() };
    storeSave('opensubs_resid', all, 300);
    log('заставка площадки для сериала:', o);
  }

  function waitDuration(done) {
    var tries = 0;
    var tick = function () {
      var v = null;
      try { v = Lampa.PlayerVideo.video(); } catch (e) {}
      var d = v && v.duration;
      if (d && isFinite(d) && d > 60) return done(d);
      if (++tries > 60) return done(null);
      setTimeout(tick, 1000);
    };
    tick();
  }

  // один раз за сеанс: сравнить длительность текущей озвучки с оригиналом
  function durationSync() {
    var s = session;
    if (!s || s.durDone) return;
    s.durDone = true;
    if (!flag('durationsync', true)) return;

    originalDuration(s, function (orig, reason) {
      if (session !== s) return;
      if (!orig) {
        s.durStatus = 'не удалось: ' + reason;
        return log('длительность оригинала:', reason);
      }
      waitDuration(function (cur) {
        if (session !== s) return;
        if (!cur) {
          s.durStatus = 'не удалось узнать длительность видео';
          return;
        }
        var diff = cur - orig, ratio = cur / orig;
        log('длительность: видео', cur.toFixed(2), 'оригинал', orig.toFixed(2), 'разница', diff.toFixed(2));
        var v = { scale: 1, offset: 0, anchors: [], src: 'duration' };
        if (Math.abs(ratio - 23.976 / 25) < 0.002 || Math.abs(ratio - 25 / 23.976) < 0.002) {
          v.scale = ratio;
          s.durStatus = 'другая частота кадров: ×' + ratio.toFixed(4);
        } else if (Math.abs(diff) <= 0.3) {
          diff = 0;
          s.durStatus = 'совпадает с оригиналом, заставки нет';
        } else if (Math.abs(diff) <= 180) {
          v.offset = diff;
          s.durStatus = 'заставка озвучки ' + (diff > 0 ? '+' : '') + diff.toFixed(1) + ' с';
        } else {
          s.durStatus = 'разница ' + diff.toFixed(0) + ' с — слишком большая, похоже на другую версию';
          return;
        }
        s.durDiff = v.scale === 1 ? diff : null;
        // заставка площадки (Netflix и т. п.) есть и в оригинале, но не в релизе, под который сделаны субтитры:
        // её размер узнаём из ручной поправки на любой серии этого сериала у этого источника
        var res = residual(s);
        if (res !== null && v.scale === 1) {
          v.offset += res;
          s.durStatus += ', заставка площадки ' + (res > 0 ? '+' : '') + res.toFixed(1) + ' с';
        }
        var old = videoSync();
        if (old.manual) {
          learnResidual(); // ручная поправка этой серии уже есть — узнаём из неё заставку площадки
          return;
        }
        setVideoSync(v);
        resyncAll();
        if (Math.abs(v.offset - (old.offset || 0)) >= 0.5 || v.scale !== (old.scale || 1)) notify('Субтитры подстроены под озвучку: ' + s.durStatus);
      });
    });
  }

  // ---------- подстройка по звуку ----------
  // Звук видео (captureStream, воспроизведение не затрагивается) → доля энергии в полосе речи каждые 100 мс.
  // Раз в 30 с последние 3 минуты сравниваются с интервалами показа субтитров: сдвиг с максимальной корреляцией
  // и есть поправка. Так находится заставка студии (LostFilm, HDRezka…) и уползание из-за частоты кадров.

  var audio = null;
  var audioDenied = ''; // почему подстройка по звуку не работает (для меню)
  var AUDIO_STEP = 0.1;
  var AUDIO_WIN = 180;

  function audioStop() {
    if (!audio) return;
    clearInterval(audio.timer);
    try { audio.ctx.close(); } catch (e) {}
    audio = null;
  }

  function audioStart() {
    if (!flag('audiosync', true)) return;
    var v = null;
    try { v = Lampa.PlayerVideo.video(); } catch (e) {}
    if (!v || !v.captureStream) { // mozCaptureStream в Firefox глушит звук видео — не используем
      audioDenied = 'этот плеер не даёт доступ к звуку';
      return;
    }
    audioDenied = '';
    if (audio && audio.video === v) return;
    audioStop();

    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    audio = { video: v, samples: [], seg: 0, lastT: -1, lastEval: 0, ctx: null, analyser: null, told: false, fails: 0, status: 'ждёт звук видео' };
    var a = audio;

    var connect = function () {
      if (a !== audio || a.analyser) return;
      var stream;
      try { stream = v.captureStream(); } catch (e) { // чужой домен без CORS
        log('звук недоступен', e && e.message);
        audioDenied = 'браузер не даёт читать звук этого видео (другой домен)';
        return audioStop();
      }
      if (!stream.getAudioTracks().length) return; // дорожка появится после начала воспроизведения
      try {
        a.ctx = a.ctx || new Ctx();
        var src = a.ctx.createMediaStreamSource(stream);
        var an = a.ctx.createAnalyser();
        an.fftSize = 1024;
        an.smoothingTimeConstant = 0;
        var mute = a.ctx.createGain();
        mute.gain.value = 0;
        src.connect(an);
        an.connect(mute);
        mute.connect(a.ctx.destination); // анализатор должен быть в графе; звук нулевой
        a.analyser = an;
        a.freq = new Float32Array(an.frequencyBinCount);
        if (a.ctx.state === 'suspended' && a.ctx.resume) a.ctx.resume();
      } catch (e) {
        log('звук недоступен', e && e.message);
        audioDenied = 'ошибка анализа звука: ' + (e && e.message);
        audioStop();
      }
    };

    a.timer = setInterval(function () {
      if (a !== audio) return;
      if (!a.analyser) return connect();
      if (v.paused || v.seeking || v.readyState < 2) return;
      var t = v.currentTime;
      if (a.lastT >= 0 && (t < a.lastT || t - a.lastT > 2)) a.seg++; // перемотка — новый отрезок
      a.lastT = t;
      a.analyser.getFloatFrequencyData(a.freq);
      var hz = a.ctx.sampleRate / 2 / a.freq.length;
      var speech = 0, total = 0;
      for (var i = 1; i < a.freq.length; i++) {
        var f = i * hz;
        if (f < 80 || f > 8000) continue;
        var p = Math.pow(10, a.freq[i] / 10);
        total += p;
        if (f >= 300 && f <= 3400) speech += p;
      }
      if (!a.evals) a.status = 'слушает: ' + Math.round(a.samples.length / 10) + ' с из 120 нужных';
      a.samples.push({ t: t, e: total > 0 ? Math.log(speech + 1e-12) + 2 * (speech / total) : -30, s: a.seg });
      if (a.samples.length > 6000) a.samples.splice(0, a.samples.length - 6000);
      if (Date.now() - a.lastEval > 30000) {
        a.lastEval = Date.now();
        setTimeout(audioEvaluate, 0);
      }
    }, 100);
    connect();
  }

  function audioEvaluate() {
    var a = audio;
    var track = isShowing();
    if (!a || !track || !track.os_id || !texts[track.os_id]) return;
    var vs0 = videoSync();
    if (vs0.src === 'duration' || vs0.manual) {
      a.status = vs0.manual ? 'не нужна: поправка выставлена вручную' : 'не нужна: заставка посчитана по длительности';
      return;
    }

    // непрерывный кусок последних AUDIO_WIN секунд
    var seg = a.samples.length ? a.samples[a.samples.length - 1].s : -1;
    var pts = a.samples.filter(function (x) { return x.s === seg; });
    if (pts.length < 2) return;
    var tEnd = pts[pts.length - 1].t;
    var tStart = Math.max(pts[0].t, tEnd - AUDIO_WIN);
    if (tEnd - tStart < 120) return;
    pts = pts.filter(function (x) { return x.t >= tStart; });

    var n = Math.floor((tEnd - tStart) / AUDIO_STEP);
    var g = new Float32Array(n);
    var k = 0;
    for (var i = 0; i < n; i++) {
      var tt = tStart + i * AUDIO_STEP;
      while (k < pts.length - 1 && pts[k + 1].t <= tt) k++;
      g[i] = pts[k].e;
    }
    var mean = 0;
    for (var m = 0; m < n; m++) mean += g[m];
    mean /= n;
    for (var m2 = 0; m2 < n; m2++) g[m2] -= mean;

    var c = composed(track.os_id);
    var cues = parseCues(texts[track.os_id]);
    var vs = videoSync();
    var dmax = vs.anchors.length ? 20 : vs.prior ? 15 : 90;
    var D = Math.round(dmax / AUDIO_STEP);
    var len = n + 2 * D;
    var ind = new Float32Array(len); // показ субтитров на сетке [tStart − dmax, tEnd + dmax]
    var base = tStart - dmax;
    for (var q = 0; q < cues.length; q++) {
      var s0 = cues[q].start * c.scale + c.offset, s1 = cues[q].end * c.scale + c.offset;
      if (s1 < base || s0 > base + len * AUDIO_STEP) continue;
      var i0 = Math.max(0, Math.round((s0 - base) / AUDIO_STEP)), i1 = Math.min(len, Math.round((s1 - base) / AUDIO_STEP));
      for (var z = i0; z < i1; z++) ind[z] = 1;
    }

    // score(d): субтитры, показанные в t − d, совпадают с речью в t
    var scores = [];
    var best = -Infinity, bestD = 0;
    for (var d = -D; d <= D; d++) {
      var sum = 0;
      var off = D - d;
      for (var r = 0; r < n; r++) sum += g[r] * ind[r + off];
      scores.push(sum);
      if (sum > best) { best = sum; bestD = d; }
    }
    var sm = 0, sq = 0;
    for (var u = 0; u < scores.length; u++) { sm += scores[u]; sq += scores[u] * scores[u]; }
    sm /= scores.length;
    var sd = Math.sqrt(Math.max(1e-12, sq / scores.length - sm * sm));
    var z1 = (best - sm) / sd;
    var second = -Infinity;
    for (var w = 0; w < scores.length; w++) if (Math.abs(w - D - bestD) > 20) second = Math.max(second, scores[w]);
    var z2 = (second - sm) / sd;
    var shift = bestD * AUDIO_STEP;
    log('звук: сдвиг', shift.toFixed(1), 'z', z1.toFixed(1), 'второй', z2.toFixed(1));
    a.evals = (a.evals || 0) + 1;
    var need = dmax <= 20 ? 3.8 : 4.5; // при узком поиске хватает меньшей уверенности
    if (z1 < need || z2 > z1 * 0.8) {
      a.status = 'слушает ' + Math.round(tEnd - tStart) + ' с, совпадения нет (уверенность ' + z1.toFixed(1) + ' из ' + need + ')';
      return;
    }
    a.status = 'последняя проверка: ' + (shift > 0 ? '+' : '') + shift.toFixed(1) + ' с (уверенность ' + z1.toFixed(1) + ')';

    if (Math.abs(shift) < 0.25) return;
    var center = (tStart + tEnd) / 2;
    var o = (center - vs.offset) / vs.scale;
    addAnchor(o, center + shift, 'audio');
    if (!a.told && Math.abs(shift) >= 1) {
      a.told = true;
      notify('Субтитры подстроены по звуку: ' + (shift > 0 ? '+' : '') + shift.toFixed(1) + ' с');
    }
  }

  // ---------- меню синхронизации ----------

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

  function syncTitle() {
    var v = videoSync();
    var parts = [];
    if (Math.abs(v.offset) >= 0.05) parts.push((v.offset > 0 ? '+' : '') + v.offset.toFixed(2) + ' сек.');
    if (Math.abs(v.scale - 1) > 0.0005) parts.push('скорость ×' + v.scale.toFixed(4));
    var from = v.manual ? ' (вручную)' : v.src === 'duration' ? ' (по длительности оригинала)' : v.prior === 'studio' ? ' (взято у студии озвучки)' : v.prior === 'source' ? ' (с прошлой серии)' : '';
    return parts.length ? parts.join(', ') + ' для этого источника' + from : 'Без поправок для этого источника';
  }

  // back — вернуться в меню субтитров, root — закрыть всё и вернуться к просмотру
  function syncMenu(track, back, root) {
    var reopen = function () {
      closeSelects();
      syncMenu(track, back, root);
    };
    var v = videoSync();
    var aud = flag('audiosync', true);

    closeSelects();
    Lampa.Select.show({
      title: 'Синхронизация',
      nohide: true,
      items: [
        { title: 'По длительности оригинала', subtitle: session && session.durStatus ? session.durStatus : flag('durationsync', true) ? 'Сравнивает с дорожкой «Оригинальный» источника…' : 'Выключено', name: 'dur' },
        { title: 'Подстройка по звуку', subtitle: !aud ? 'Выключена' : audioDenied ? 'Не работает: ' + audioDenied : audio ? (audio.analyser ? audio.status : 'ждёт звук видео') : 'Не запущена', name: 'audio' },
        { title: 'По английским субтитрам', subtitle: 'Выровнять файл: частота кадров и сдвиг', name: 'auto' },
        { title: 'По фразе', subtitle: 'Выберите реплику, которая звучит сейчас', name: 'phrase' },
        { title: 'Сдвиг', subtitle: syncTitle(), name: 'shift' },
        { title: 'Частота кадров видео', subtitle: 'Если субтитры уползают всё дальше', name: 'fps' },
        { title: 'Сбросить для этого источника', subtitle: 'Убрать поправки под это видео', name: 'reset' }
      ],
      onBack: back,
      onSelect: function (a) {
        if (a.name === 'phrase') return phraseMenu(track, reopen, root);

        if (a.name === 'dur') {
          var on = flag('durationsync', true);
          Lampa.Storage.set('opensubs_durationsync', on ? 'false' : 'true');
          if (!on && session) { session.durDone = false; durationSync(); }
          return reopen();
        }

        if (a.name === 'audio') {
          Lampa.Storage.set('opensubs_audiosync', aud ? 'false' : 'true');
          if (aud) audioStop();
          else audioStart();
          return reopen();
        }

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
            title: 'Сдвиг: ' + syncTitle(),
            nohide: true,
            items: STEPS.map(function (x) {
              return { title: (x > 0 ? 'Позже на ' : 'Раньше на ') + Math.abs(x) + ' сек.', value: x };
            }),
            onBack: reopen,
            onSelect: function (b) {
              v.offset += b.value;
              v.manual = true;
              v.anchors = [];
              setVideoSync(v);
              learnResidual();
              resyncAll();
              reopen();
            }
          });
        }

        if (a.name === 'fps') {
          closeSelects();
          return Lampa.Select.show({
            title: 'Частота кадров видео',
            nohide: true,
            items: FPS.map(function (f) {
              return { title: f.title, scale: f.scale, selected: Math.abs(f.scale - v.scale) < 0.0005 };
            }),
            onBack: reopen,
            onSelect: function (b) {
              var t = videoTime(); // текущий момент остаётся на месте, меняется только скорость
              var o = (t - v.offset) / v.scale;
              v.scale = b.scale;
              v.offset = t - o * b.scale;
              v.manual = true;
              v.anchors = [];
              setVideoSync(v);
              resyncAll();
              reopen();
            }
          });
        }

        if (a.name === 'reset') {
          setVideoSync({ scale: 1, offset: 0, anchors: [] });
          if (session) { session.vsync = null; session.durDone = false; }
          resyncAll();
          durationSync();
          if (audio) { audio.samples = []; audio.told = false; }
          Lampa.Noty.show('Поправки для этого источника сброшены');
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
    var c = composed(track.os_id);
    var at = videoTime();
    var vid = null;
    try { vid = Lampa.PlayerVideo.video(); } catch (e) {}
    var wasPlaying = vid && !vid.paused;
    if (wasPlaying) try { vid.pause(); } catch (e) {}
    var resume = function () {
      if (wasPlaying) try { vid.play(); } catch (e) {}
    };

    var near = 0;
    for (var i = 0; i < cues.length; i++) if (cues[i].start * c.scale + c.offset <= at) near = i;
    var from = Math.max(0, near - 25);
    var to = Math.min(cues.length, near + 15);
    var items = [];
    for (var j = from; j < to; j++) {
      var tt = cues[j].start * c.scale + c.offset;
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
        var both = anchorPhrase(track, b.cue, at);
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
        { title: 'Синхронизация', subtitle: on && on.os_id ? syncTitle() : 'Для субтитров OpenSubtitles', name: 'sync' }
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
      param: { name: 'opensubs_durationsync', type: 'trigger', default: true },
      field: { name: 'Заставки озвучек по длительности', description: 'Сравнивать длительность серии в озвучке с дорожкой «Оригинальный» того же источника и сдвигать субтитры на разницу' }
    });

    Lampa.SettingsApi.addParam({
      component: 'opensubs',
      param: { name: 'opensubs_audiosync', type: 'trigger', default: true },
      field: { name: 'Подстройка по звуку', description: 'Слушать речь в видео и сдвигать субтитры: заставки студий (LostFilm, HDRezka), разная частота кадров' }
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
      audioStop();
      current = null;
      revokeUrls(); // файлы прошлого видео больше не нужны
      try { load(data || {}); } catch (e) { log('error', e); }
    });
    Lampa.Player.listener.follow('destroy', function () {
      current = null;
      clearInterval(timer); // сеанс не сбрасываем: Lampa шлёт destroy и при переключении серий
      audioStop();
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
