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

  // done(url): blob-ссылка на сохранённый файл, либо прямая ссылка, если хранилище недоступно
  function download(fileId, done, fail) {
    storeGet(fileId, function (text) {
      var u = text && textUrl(text);
      if (u) return done(u);

      xhr('POST', API + '/download', { file_id: fileId, sub_format: 'webvtt' }, function (json) {
        if (!json.link) return fail(json);
        fetchText(json.link, function (body) {
          storePut(fileId, body);
          done(textUrl(body) || json.link);
        }, function () {
          done(json.link);
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

  // лучшие N на язык: живые переводы, без пометок для слабослышащих, по числу скачиваний
  function pick(list, langs, perLang) {
    var groups = {};
    for (var i = 0; i < list.length; i++) {
      var a = list[i].attributes;
      if (!a || !a.files || !a.files.length) continue;
      if (a.machine_translated || a.ai_translated) continue;
      (groups[a.language] = groups[a.language] || []).push(a);
    }
    var out = [];
    for (var j = 0; j < langs.length; j++) {
      var g = (groups[langs[j]] || []).sort(function (x, y) {
        if (!!x.hearing_impaired !== !!y.hearing_impaired) return x.hearing_impaired ? 1 : -1;
        return (y.download_count || 0) - (x.download_count || 0);
      });
      out = out.concat(g.slice(0, perLang));
    }
    return out;
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

  function inject(token, items) {
    if (token !== current || !items.length) return;

    var state = videoSubs();
    if (!state) return log('встроенный плеер не активен, субтитры не добавлены');

    // у видео есть свои дорожки (например, из HLS) — не перекрываем их своим списком
    if (!state.subs.length && state.video.textTracks && state.video.textTracks.length) {
      return log('у видео есть встроенные дорожки, пропускаем');
    }

    var list = state.subs.filter(function (s) { return !s.opensubs; });
    var base = list.length;
    for (var i = 0; i < items.length; i++) {
      items[i].index = base + i;
      list.push(items[i]);
    }

    Lampa.Player.subtitles(list);

    var anyShowing = state.subs.some(function (s) { return s.selected; });
    if (!anyShowing && Lampa.Storage.field('subtitles_start')) {
      var code = Lampa.Storage.field('subtitles_lang');
      if (!code || code === 'auto') code = Lampa.Storage.get('language', 'ru');
      // Lampa клонирует список, поэтому выбираем уже в том, что лежит в видео
      var now = videoSubs();
      var want = null;
      if (now) for (var j = 0; j < now.subs.length; j++) {
        if (now.subs[j].opensubs && now.subs[j].language === code) { want = now.subs[j]; break; }
      }
      if (want) {
        want.selected = true;
        want.mode = 'showing';
        var box = document.querySelectorAll('.player-video__subtitles');
        for (var b = 0; b < box.length; b++) box[b].classList.remove('hide');
      }
    }

    if (flag('notify', true)) Lampa.Noty.show('OpenSubtitles: ' + items.length + ' субт.');
  }

  function shortRelease(a) {
    var r = String(a.release || '').replace(/[._]/g, ' ').replace(/\s+/g, ' ').trim();
    return r.length > 40 ? r.slice(0, 40) + '…' : r;
  }

  function load(data) {
    if (!flag('enabled', true)) return;
    if (!apiKey()) {
      if (!window.opensubs_nokey_shown) {
        window.opensubs_nokey_shown = true;
        Lampa.Noty.show('OpenSubtitles: укажите API-ключ в настройках плагина');
      }
      return;
    }
    if (data.iptv || data.youtube) return;

    var card = activeCard();
    if (!card) return log('нет карточки');

    var langs = String(setting('langs', 'ru,uk,en')).split(',');
    var p = buildQuery(card, data, langs);
    if (!p) return log('нет номера серии');

    var token = current = {};

    xhr('GET', API + '/subtitles?' + query(p), null, function (json) {
      if (token !== current) return;

      var chosen = pick(json.data || [], langs, parseInt(setting('perlang', '1'), 10) || 1);
      if (!chosen.length) return log('ничего не найдено', p);

      var items = [];
      var left = chosen.length;
      var finish = function () { if (--left === 0) inject(token, items); };

      chosen.forEach(function (a) {
        download(a.files[0].file_id, function (link) {
          items.push({
            label: (LANG_NAMES[a.language] || a.language) + ' · OS · ' + shortRelease(a),
            url: link,
            language: a.language,
            opensubs: true
          });
          finish();
        }, function (err) {
          log('download fail', err);
          if (err && err.remaining === 0 && flag('notify', true)) {
            Lampa.Noty.show('OpenSubtitles: дневной лимит скачиваний исчерпан');
          }
          finish();
        });
      });
    }, function (status, json) {
      log('search fail', status, json);
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

  // Lucide «captions» (ISC), подогнана под иконки плеера Lampa: поле 21×21 (viewBox обрезан по рамке) и линия 2.5
  var ICON = '<svg viewBox="1.5 1.5 21 21" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M7 15h4M15 15h2M7 11h2M13 11h4"/></svg>';

  var SHIFTS = [-10, -5, -3, -2, -1, -0.5, 0, 0.5, 1, 2, 3, 5, 10];

  function css() {
    if (document.getElementById('opensubs-style')) return;
    var sel = '.player-video__subtitles';
    var rules = [
      'body.ops-has-btn .player-panel__subs{display:none !important}',
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

  function shiftTitle(v) {
    v = parseFloat(v) || 0;
    return (v > 0 ? '+' : '') + v + ' сек.';
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
        { title: 'Язык субтитров', subtitle: on ? (on.label || on.language || 'Дорожка') : (subs.length ? 'Выключены' : 'Нет субтитров'), name: 'lang' },
        { title: 'Размер шрифта', subtitle: titleOf(SIZES, setting('size', 'auto')), name: 'size' },
        { title: 'Тень шрифта', subtitle: titleOf(SHADOWS, setting('shadow', 'auto')), name: 'shadow' },
        { title: 'Сдвиг по времени', subtitle: shiftTitle(Lampa.Storage.get('player_subs_shift_time', '0')), name: 'shift' }
      ],
      onBack: back,
      onSelect: function (a) {
        var again = function () {
          closeSelects();
          menu(back);
        };

        if (a.name === 'lang') {
          if (!subs.length) {
            Lampa.Noty.show(apiKey() ? 'Субтитры для этого видео не найдены' : 'OpenSubtitles: укажите API-ключ в настройках плагина');
            return again();
          }
          var items = [{ title: 'Выключены', selected: !on, track: null }];
          for (var j = 0; j < subs.length; j++) {
            items.push({ title: subs[j].label || subs[j].language || ('Дорожка ' + (j + 1)), selected: subs[j] === on, track: subs[j] });
          }
          closeSelects();
          return Lampa.Select.show({
            title: 'Язык субтитров',
            items: items,
            nohide: true,
            onBack: again,
            onSelect: function (b) {
              selectTrack(b.track);
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

        if (a.name === 'shift') {
          var now = parseFloat(Lampa.Storage.get('player_subs_shift_time', '0')) || 0;
          closeSelects();
          return Lampa.Select.show({
            title: a.title,
            items: SHIFTS.map(function (v) { return { title: shiftTitle(v), value: v, selected: v === now }; }),
            nohide: true,
            onBack: again,
            onSelect: function (b) {
              Lampa.Storage.set('player_subs_shift_time', String(b.value));
              again();
            }
          });
        }
      }
    });
  }

  function makeButton() {
    var btn = document.createElement('div');
    btn.className = 'player-panel__opensubs ops-btn button selector';
    btn.innerHTML = ICON + '<div class="tooltip">Субтитры</div>';
    $(btn).on('hover:enter', function () {
      var enabled = Lampa.Controller.enabled().name;
      menu(function () {
        closeSelects();
        Lampa.Controller.toggle(enabled);
        // панель при возврате ставит фокус на «паузу» — возвращаем его на нашу кнопку
        try {
          if (enabled === 'player_panel' && document.body.contains(btn)) {
            Lampa.Controller.collectionFocus(btn, Lampa.PlayerPanel.render());
          }
        } catch (e) {}
      });
    });
    return btn;
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
      field: { name: 'Искать субтитры', description: 'При запуске видео во встроенном плеере' }
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
          'ru,uk': 'Русские, украинские',
          'ru': 'Только русские',
          'uk': 'Только украинские',
          'en': 'Только английские'
        },
        default: 'ru,uk,en'
      },
      field: { name: 'Языки', description: 'Каждая дорожка — одно скачивание из дневного лимита' }
    });

    Lampa.SettingsApi.addParam({
      component: 'opensubs',
      param: { name: 'opensubs_perlang', type: 'select', values: { '1': '1', '2': '2', '3': '3' }, default: '1' },
      field: { name: 'Вариантов на язык', description: 'Разные релизы — на случай, если субтитры не совпали по времени' }
    });

    Lampa.SettingsApi.addParam({
      component: 'opensubs',
      param: { name: 'opensubs_notify', type: 'trigger', default: true },
      field: { name: 'Уведомления', description: 'Показывать, сколько субтитров найдено' }
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
    Lampa.Player.listener.follow('start', function (data) {
      addButton();
      applyStyle();
      current = null;
      revokeUrls(); // файлы прошлого видео больше не нужны
      try { load(data || {}); } catch (e) { log('error', e); }
    });
    Lampa.Player.listener.follow('destroy', function () {
      current = null;
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
