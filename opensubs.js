/*
 * OpenSubs — субтитры OpenSubtitles во встроенном плеере Lampa.
 * Самостоятельный клиентский плагин: сервер Lampac не нужен и не затрагивается.
 *
 * Файл собран build.js из mods-src/OpenSubs/src — правьте исходники, не этот файл.
 */
(function () {
  var defs = {
  "analyzers/audio-capture": function (module, exports, require) {
/*
 * Захват звука видео (captureStream → AnalyserNode) и фоновая проверка оценщиком audio.
 * Устанавливается в общий объект app (см. index.js): функции и состояние доступны как app.*.
 */
'use strict';

var audioEstimator = require('../estimators/audio');

module.exports = function (app) {
  // включить субтитры на нужном языке: субтитры источника на этом языке, иначе лучший файл OpenSubtitles
  // Можно ли синхронизировать по звуку до показа (встроенный плеер с доступом к звуку)
  app.canListen = function canListen() {
    if (!app.flag('audiosync', true)) return false;
    try {
      var v = Lampa.PlayerVideo.video();
      return !!(v && v.captureStream);
    } catch (e) {
      return false;
    }
  };


  // ---------- подстройка по звуку ----------
  // Звук видео (captureStream, воспроизведение не затрагивается) → доля энергии в полосе речи каждые 100 мс.
  // Раз в 30 с последние 3 минуты сравниваются с интервалами показа субтитров: сдвиг с максимальной корреляцией
  // и есть поправка. Так находится заставка студии (LostFilm, HDRezka…) и уползание из-за частоты кадров.
  app.audio = null;

  app.audioDenied = '';

  app.AUDIO_MIN = audioEstimator.MIN;

  app.AUDIO_TARGET = 360;

  app.audioStop = function audioStop() {
    if (!app.audio) return;
    clearInterval(app.audio.timer);
    try { app.audio.ctx.close(); } catch (e) {}
    app.audio = null;
  };

  app.audioStart = function audioStart() {
    if (!app.flag('audiosync', true)) return;
    var v = null;
    try { v = Lampa.PlayerVideo.video(); } catch (e) {}
    if (!v || !v.captureStream) { // mozCaptureStream в Firefox глушит звук видео — не используем
      app.audioDenied = 'этот плеер не даёт доступ к звуку';
      return;
    }
    app.audioDenied = '';
    if (app.audio && app.audio.video === v) return;
    app.audioStop();

    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    app.audio = { video: v, samples: [], seg: 0, lastT: -1, lastEval: 0, ctx: null, analyser: null, told: false, fails: 0, status: 'ждёт звук видео' };
    var a = app.audio;

    var connect = function () {
      if (a !== app.audio || a.analyser) return;
      var stream;
      try { stream = v.captureStream(); } catch (e) { // чужой домен без CORS
        app.log('звук недоступен', e && e.message);
        app.audioDenied = 'браузер не даёт читать звук этого видео (другой домен)';
        app.audioStop();
        return app.finishBackground('нет доступа к звуку');
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
        app.log('звук недоступен', e && e.message);
        app.audioDenied = 'ошибка анализа звука: ' + (e && e.message);
        app.audioStop();
        app.finishBackground('ошибка звука');
      }
    };

    a.timer = setInterval(function () {
      if (a !== app.audio) return;
      if (!a.analyser) return connect();
      if (v.paused || v.seeking || v.readyState < 2) return;
      var t = v.currentTime;
      if (a.lastT >= 0 && (t < a.lastT || t - a.lastT > 2)) a.seg++; // перемотка — новый отрезок
      a.lastT = t;
      a.analyser.getFloatFrequencyData(a.freq);
      var hz = a.ctx.sampleRate / 2 / a.freq.length;
      if (!a.prev) {
        a.prev = new Float32Array(a.freq.length);
        for (var pi = 0; pi < a.prev.length; pi++) a.prev[pi] = -200;
      }
      // энергия полосы речи (лог) и спектральный поток — estimators/audio.js
      var ft = audioEstimator.frameFeatures(a.freq, hz, a.prev);
      if (!a.evals) a.status = 'слушает: ' + Math.round(a.samples.length / 10) + ' с из ' + app.AUDIO_MIN + ' нужных';
      a.samples.push({ t: t, e: ft.e, f: ft.f, s: a.seg });
      if (a.samples.length % 10 === 0) app.engineEvents.emit('progress', { value: app.audioProgress() });
      if (a.samples.length > 6000) a.samples.splice(0, a.samples.length - 6000);
      if (Date.now() - a.lastEval > 30000) {
        a.lastEval = Date.now();
        setTimeout(app.audioEvaluate, 0);
      }
    }, 100);
    connect();
  };

  app.audioEvaluate = function audioEvaluate() {
    var a = app.audio;
    var s0 = app.session;
    var track = (s0 && s0.waiting && s0.bg && app.findTrack(s0.bg)) || app.isShowing();
    if (!a || !track || !track.os_id || !app.texts[track.os_id]) return;
    if (s0 && s0.waiting && Date.now() - s0.waiting > 7 * 60 * 1000) return app.finishBackground('долго нет результата');
    var vs0 = app.videoSync();
    if (vs0.manual) {
      a.status = 'не нужна: поправка выставлена вручную';
      a.evals = (a.evals || 0) + 1;
      return;
    }

    var c = app.composed(track.os_id);
    var cues = app.parseCues(app.texts[track.os_id]);
    var vs = app.videoSync();
    // после расчёта по длительности остаётся только заставка площадки и разница релизов — ищем рядом
    // широкий поиск (±90 с) — только пока субтитры скрыты и ждут проверки; при показе звук лишь доводит время
    var dmax = s0 && s0.waiting && !vs.anchors.length && vs.src !== 'duration' ? 90 : 15;
    var res = audioEstimator.evaluateGuarded({
      samples: a.samples,
      cues: cues.map(function (q) { return { start: q.start * c.scale + c.offset, end: q.end * c.scale + c.offset }; }),
      dmaxSec: dmax
    });
    if (!res) return;
    if (res.contradicted) {
      // широкий поиск нашёл уверенный сдвиг вне узкого окна — для калибровки и отчёта
      a.wide = { offsetMs: Math.round((vs.offset + res.contradicted.shift) * 1000), z: res.contradicted.z1 };
      app.log('звук: узкий пик ' + res.shift.toFixed(1) + ' с отвергнут, широкий поиск даёт ' + res.contradicted.shift.toFixed(1) + ' с');
    }
    var shift = res.shift, z1 = res.z1, z2 = res.z2;
    app.log('звук: сдвиг', shift.toFixed(1), 'z', z1.toFixed(1), 'второй', z2.toFixed(1), res.strong ? 'сильное' : '');
    a.evals = (a.evals || 0) + 1;
    var need = res.need;
    // одинаковый сдвиг в двух проверках подряд — тоже уверенность, даже если каждая чуть ниже порога
    var prevE = a.lastShift;
    a.lastShift = { d: shift, z: z1 };
    var agree = prevE && Math.abs(prevE.d - shift) <= 0.3 && prevE.z >= need - 0.5 && z1 >= need - 0.5 && z2 <= z1 * 0.7;
    if (res.edge || (!agree && !res.confident)) {
      a.status = 'слушает ' + Math.round(res.tEnd - res.tStart) + ' с, совпадения нет (уверенность ' + z1.toFixed(1) + ' из ' + need + ')';
      // полное окно прослушано, а уверенности нет — не показываем вслепую (Decider), предлагаем калибровку
      if (s0 && s0.waiting && res.tEnd - res.tStart >= app.AUDIO_TARGET) app.finishBackground('нет уверенности');
      return;
    }
    a.status = 'последняя проверка: ' + (shift > 0 ? '+' : '') + shift.toFixed(1) + ' с (уверенность ' + z1.toFixed(1) + ')';

    var center = (res.tStart + res.tEnd) / 2;
    var o = (center - vs.offset) / vs.scale;
    // сильное совпадение подтверждает само (правило 7); слабее — вместе с кандидатом вставки или повтором
    app.addAnchor(o, center + shift, 'audio', res.strong || agree ? 0.85 : 0.6);
    app.finishBackground('ok');
    if (!a.told && Math.abs(shift) >= 1) {
      a.told = true;
      app.notify('Субтитры подстроены по звуку: ' + (shift > 0 ? '+' : '') + shift.toFixed(1) + ' с');
    }
    app.engineEvents.emit('progress', { value: 1 });
  };

  app.audioProgress = function audioProgress() {
    if (!app.audio || !app.audio.samples.length) return 0;
    var seg = app.audio.samples[app.audio.samples.length - 1].s;
    var first = null, last = 0;
    for (var i = app.audio.samples.length - 1; i >= 0 && app.audio.samples[i].s === seg; i--) first = app.audio.samples[i].t;
    last = app.audio.samples[app.audio.samples.length - 1].t;
    return first === null ? 0 : Math.min(0.97, (last - first) / app.AUDIO_TARGET);
  };
};
  },

  "analyzers/subtitle": function (module, exports, require) {
/*
 * Разбор субтитров (WebVTT/SRT) и пересчёт их таймингов. Время — мс (ADR 6).
 *   parse(text)              → [{ startMs, endMs, text }]
 *   starts(cues[, pieces])   → отсортированные начала реплик, при необходимости через модель
 *   retime(text, pieces)     → тот же файл с пересчитанными таймингами (для плеера)
 *   retimeFn(text, fn)       → то же с произвольной функцией мс → мс (композиция моделей)
 *   build(cues)              → WebVTT из реплик (raw — исходные строки текста с разметкой)
 *   fromFixture(json)        → реплики из фикстуры тестов ([[startMs, endMs, chars]])
 */
'use strict';

var time = require('../engine/time');

var TIME_RX = /(?:(\d{1,3}):)?(\d{2}):(\d{2})[.,](\d{3})/g;

function clockMs(h, m, s, ms) {
  return ((parseInt(h || '0', 10) * 60 + parseInt(m, 10)) * 60 + parseInt(s, 10)) * 1000 + parseInt(ms, 10);
}

function parse(text) {
  var out = [];
  var blocks = String(text || '').replace(/\r/g, '').split(/\n\n+/);
  for (var i = 0; i < blocks.length; i++) {
    var lines = blocks[i].split('\n');
    for (var j = 0; j < lines.length; j++) {
      if (lines[j].indexOf('-->') < 0) continue;
      TIME_RX.lastIndex = 0;
      var a = TIME_RX.exec(lines[j]);
      var b = a && TIME_RX.exec(lines[j]);
      if (!a) break;
      var body = lines.slice(j + 1).join(' ').replace(/<[^>]+>|\{[^}]*\}/g, '').replace(/\s+/g, ' ').trim();
      var st = clockMs(a[1], a[2], a[3], a[4]);
      var raw = lines.slice(j + 1).join('\n').replace(/^\s+|\s+$/g, '');
      if (body) out.push({ startMs: st, endMs: b ? clockMs(b[1], b[2], b[3], b[4]) : st + 2000, text: body, raw: raw });
      break;
    }
  }
  return out;
}

function starts(cues, pieces) {
  var out = [];
  for (var i = 0; i < cues.length; i++) out.push(pieces ? time.apply(pieces, cues[i].startMs) : cues[i].startMs);
  return out.sort(function (a, b) { return a - b; });
}

function isIdentity(pieces) {
  if (!pieces || !pieces.length) return true;
  for (var i = 0; i < pieces.length; i++) {
    if (Math.abs(pieces[i].scale - 1) > 1e-9 || pieces[i].offsetMs) return false;
  }
  return true;
}

function retimeFn(text, fn) {
  return String(text).replace(/^.*-->.*$/gm, function (line) {
    return line.replace(TIME_RX, function (all, h, m, s, ms) {
      return time.formatClock(fn(clockMs(h, m, s, ms)));
    });
  });
}

function retime(text, pieces) {
  if (isIdentity(pieces)) return text;
  return retimeFn(text, function (ms) { return time.apply(pieces, ms); });
}

function build(cues) {
  var out = ['WEBVTT', ''];
  for (var i = 0; i < cues.length; i++) {
    out.push(time.formatClock(cues[i].startMs) + ' --> ' + time.formatClock(cues[i].endMs));
    out.push(cues[i].raw || cues[i].text);
    out.push('');
  }
  return out.join('\n');
}

function fromFixture(json) {
  return json.cues.map(function (c) { return { startMs: c[0], endMs: c[1], text: '' }; });
}

module.exports = { parse: parse, starts: starts, retime: retime, retimeFn: retimeFn, build: build, isIdentity: isIdentity, fromFixture: fromFixture };
  },

  "api/http": function (module, exports, require) {
/*
 * HTTP для браузера (XMLHttpRequest). Модули получают его через create({ http }),
 * тесты подставляют свой объект с тем же интерфейсом.
 *   getText(url, done(text), fail(status|reason))
 *   getJSON(url, done(json), fail(status|reason))
 */
'use strict';

var TIMEOUT = 20000;

function getText(url, done, fail) {
  var r = new XMLHttpRequest();
  r.open('GET', url, true);
  r.timeout = TIMEOUT;
  r.onload = function () {
    if (r.status >= 200 && r.status < 300) done(r.responseText);
    else fail(r.status);
  };
  r.onerror = r.ontimeout = function () { fail(0); };
  r.send(null);
}

function getJSON(url, done, fail) {
  getText(url, function (t) {
    var j = null;
    try { j = JSON.parse(t); } catch (e) {}
    if (j) done(j);
    else fail('json');
  }, fail);
}

module.exports = { getText: getText, getJSON: getJSON };
  },

  "api/lampac": function (module, exports, require) {
/*
 * LampacAdapter — всё, что движок узнаёт от Lampac: адрес и балансер текущего видео,
 * длительности дорожки «Оригинал» той же серии у нескольких источников.
 * Сервер Lampac не меняется: используются его открытые lite API и /externalids.
 *
 * var lampac = require('./lampac').create({ http, cache });
 *   cache: { get(key) → { durationMs } | null, set(key, { durationMs }) } — длительности переживают перезапуск.
 *
 * ctx (описание текущего видео):
 *   { url: data.url плеера, card: карточка Lampa, episode: { season, episode } | null, balancer: 'phantom' | '',
 *     voice: озвучка текущего видео }
 * originals(ctx, done)      — длительности дорожки «Оригинал» у текущего источника и Phantom/Aladin/ZetflixDB;
 * siblings(ctx, max, done)  — длительности других озвучек этой серии у текущего источника.
 */
'use strict';

var hls = require('../probe/hls');

// Источники, где обычно есть дорожка «Оригинал». У одного источника «оригинал» бывает другой сборкой
// (ZetflixDB GoT S3E3: на 30 с короче), поэтому сравниваем с несколькими.
var ORIG_SOURCES = ['phantom', 'aladin', 'zetflixdb'];

var ORIG_RX = /оригинал|оригінал|original|^\s*(english|английск|англ\.?|eng)\b/i;
var SUBS_RX = /^\s*субтитр/i; // оригинальная дорожка с вшитыми субтитрами — запасной эталон
var UKR_RX = /укр|ukr/i;

function pickOriginal(list, nameOf) {
  var alt = null;
  for (var i = 0; i < list.length; i++) {
    var n = nameOf(list[i]) || '';
    if (UKR_RX.test(n)) continue;
    if (ORIG_RX.test(n)) return list[i];
    if (!alt && SUBS_RX.test(n)) alt = list[i];
  }
  return alt;
}

// { host, bal, acc } | null. lastBalancer — значение online_last_balanser для карточки.
function info(url, lastBalancer) {
  url = String(url || '');
  var m = url.match(/^(https?:\/\/[^\/]+)\//);
  var bal = lastBalancer || '';
  if (!bal) {
    var b = url.match(/\/lite\/([a-z0-9_]+)/i);
    bal = b ? b[1] : '';
  }
  if (!m || !bal) return null;
  var acc = [];
  (url.split('?')[1] || '').split('&').forEach(function (x) {
    if (/^(account_email|uid|token|nws_id)=/.test(x)) acc.push(x);
  });
  return { host: m[1], bal: String(bal).toLowerCase(), acc: acc.join('&') };
}

// Ссылки, которые Lampac собрал для себя (127.0.0.1), ведём на тот же адрес, что и видео.
function fixHost(u, host) {
  return String(u || '').replace(/^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)(:\d+)?/i, host);
}

function withAcc(u, acc) {
  return acc ? u + (u.indexOf('?') >= 0 ? '&' : '?') + acc : u;
}

function liteUrl(inf, bal, card, episode) {
  var q = ['rjson=true', 'id=' + encodeURIComponent(card.id)];
  if (card.imdb_id) q.push('imdb_id=' + card.imdb_id);
  if (card.kinopoisk_id) q.push('kinopoisk_id=' + card.kinopoisk_id);
  q.push('title=' + encodeURIComponent(card.title || card.name || ''));
  q.push('original_title=' + encodeURIComponent(card.original_title || card.original_name || ''));
  q.push('serial=' + (card.name ? 1 : 0));
  q.push('original_language=' + (card.original_language || ''));
  q.push('year=' + String(card.release_date || card.first_air_date || '0000').slice(0, 4));
  q.push('source=' + (card.source || 'tmdb'));
  if (episode) q.push('s=' + episode.season);
  return withAcc(inf.host + '/lite/' + bal + '?' + q.join('&'), inf.acc);
}

function seasonNumber(x) {
  return parseInt(x.id || x.s || String(x.name || '').replace(/\D+/g, ''), 10);
}

function create(deps) {
  var http = deps.http;
  var cache = deps.cache || { get: function () { return null; }, set: function () {} };

  // самое низкое качество — плейлист легче, длительность та же
  function playableUrl(item, done, fail) {
    var pickQ = function (j) {
      var q = j.quality || {};
      var keys = Object.keys(q);
      keys.sort(function (a, b) { return parseInt(a, 10) - parseInt(b, 10); });
      return keys.length ? q[keys[0]] : j.url;
    };
    if (item.method === 'call') {
      http.getJSON(item.url, function (j) {
        var u = pickQ(j);
        if (u) done(u);
        else fail('нет ссылки');
      }, fail);
    } else done(pickQ(item));
  }

  function norm(name) {
    return String(name || '').toLowerCase().replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
  }

  // Список озвучек/серий источника для текущего видео: done(json, env) | done(null, why).
  // json.type — 'movie' (data: озвучки) или 'episode' (voice: озвучки, data: серии активной озвучки).
  function listing(ctx, bal, done) {
    var inf = info(ctx.url, ctx.balancer);
    if (!inf) return done(null, 'источник не Lampac');
    bal = bal || inf.bal;
    var ep = ctx.episode;
    var card = ctx.card || {};
    var env = { inf: inf, bal: bal, ep: ep, fix: function (u) { return fixHost(u, inf.host); } };

    var handle = function (json, depth) {
      // источник сначала отдаёт список сезонов — переходим в нужный
      if (json.type === 'season' && ep && depth < 2) {
        var seasons = json.data || [];
        for (var si = 0; si < seasons.length; si++) {
          if (seasonNumber(seasons[si]) === ep.season && seasons[si].url) {
            return http.getJSON(withAcc(env.fix(seasons[si].url), inf.acc), function (j) { handle(j, depth + 1); },
              function (e) { done(null, 'сезон не открылся: ' + e); });
          }
        }
        return done(null, 'у источника нет сезона ' + ep.season);
      }
      if (json.type === 'movie' || (json.type === 'episode' && ep)) return done(json, env);
      if (json.type === 'episode' && !json.voice) return done(null, 'у источника «' + bal + '» одна озвучка, оригинала нет');
      done(null, 'источник «' + bal + '» ответил «' + json.type + '»' + (ep ? '' : ' (серия не определена)'));
    };

    var request = function (c) {
      http.getJSON(liteUrl(inf, bal, c, ep), function (json) { handle(json, 0); },
        function (e) { done(null, 'источник «' + bal + '» не ответил: ' + e); });
    };

    if (card.kinopoisk_id && card.imdb_id) return request(card);
    // id других баз — как это делает онлайн-плагин Lampac (ZetflixDB без kinopoisk_id отвечает 503)
    http.getJSON(withAcc(inf.host + '/externalids?id=' + encodeURIComponent(card.id) + '&serial=' + (card.name ? 1 : 0), inf.acc),
      function (ids) {
        var c = {};
        var k;
        for (k in card) c[k] = card[k];
        for (k in ids) c[k] = ids[k];
        request(c);
      }, function () { request(card); });
  }

  // длительность одного пункта (озвучка фильма или серия): done(ms | null, why)
  function itemDurationMs(env, item, key, done) {
    if (!item) return done(null, 'нет ссылки');
    var hit = key && cache.get(key);
    if (hit && hit.durationMs) return done(hit.durationMs);
    playableUrl({ method: item.method, url: env.fix(item.url), quality: item.quality }, function (u) {
      u = env.fix(u);
      if (!/m3u8/i.test(u)) return done(null, 'не HLS');
      hls.durationMs(http, u, function (r) {
        if (key) cache.set(key, { durationMs: r.durationMs });
        done(r.durationMs);
      }, function (e) { done(null, 'плейлист: ' + e); });
    }, function (e) { done(null, 'ссылка: ' + e); });
  }

  // серии озвучки voice: done(list | null, why)
  function voiceEpisodes(env, json, voice, done) {
    if (voice.active) return done(json);
    http.getJSON(withAcc(env.fix(voice.url), env.inf.acc), done, function (e) { done(null, 'не открылась озвучка «' + voice.name + '»: ' + e); });
  }

  function episodeItem(list, ep) {
    var items = (list && list.data) || [];
    for (var i = 0; i < items.length; i++) if (parseInt(items[i].e, 10) === ep.episode) return items[i];
    return null;
  }

  function cacheKey(env, card, extra) {
    return env.bal + '|' + card.id + (env.ep ? '|' + env.ep.season + 'x' + env.ep.episode : '') + (extra ? '|' + extra : '');
  }

  // done(durationMs | null, why)
  function originalDurationMs(ctx, bal, done) {
    var inf = info(ctx.url, ctx.balancer);
    if (!inf) return done(null, 'источник не Lampac');
    var card = ctx.card || {};
    var ep = ctx.episode;
    var key = (bal || inf.bal) + '|' + card.id + (ep ? '|' + ep.season + 'x' + ep.episode : '');
    var hit = cache.get(key);
    if (hit && hit.durationMs) return done(hit.durationMs);
    listing(ctx, bal, function (json, env) {
      if (!json) return done(null, env);
      if (json.type === 'movie') {
        var it = pickOriginal(json.data || [], function (x) { return x.translate || x.details || x.title; });
        if (!it) {
          return done(null, 'в списке озвучек нет оригинала (' +
            (json.data || []).map(function (x) { return x.translate || x.details || ''; }).join(', ').slice(0, 80) + ')');
        }
        return itemDurationMs(env, it, key, done);
      }
      var voice = json.voice && pickOriginal(json.voice, function (v) { return v.name; });
      if (!voice) {
        return done(null, 'в списке озвучек нет оригинала (' +
          (json.voice || []).map(function (v) { return v.name; }).join(', ').slice(0, 80) + ')');
      }
      voiceEpisodes(env, json, voice, function (list, why) {
        if (!list) return done(null, why);
        var item = episodeItem(list, env.ep);
        if (!item) return done(null, 'в оригинале нет серии ' + env.ep.episode);
        itemDurationMs(env, item, key, done);
      });
    });
  }

  // Другие озвучки той же серии у текущего источника (без оригинала и текущей): их длительности —
  // второе свидетельство «та же сборка» для правила 2. done([{ voice, durationMs }])
  function siblings(ctx, max, done) {
    max = max || 3;
    var current = norm(ctx.voice);
    listing(ctx, null, function (json, env) {
      if (!json) return done([], [env]);
      var card = ctx.card || {};
      var isOrig = function (n) { return !!pickOriginal([n], function (x) { return x; }); };
      var picks = [];
      var i;
      if (json.type === 'movie') {
        var data = json.data || [];
        for (i = 0; i < data.length && picks.length < max; i++) {
          var n = data[i].translate || data[i].details || data[i].title || '';
          if (!isOrig(n) && norm(n) !== current && current.indexOf(norm(n)) < 0) picks.push({ name: n, item: data[i] });
        }
      } else {
        var voices = json.voice || [];
        for (i = 0; i < voices.length && picks.length < max; i++) {
          var vn = voices[i].name || '';
          if (!isOrig(vn) && norm(vn) !== current && current.indexOf(norm(vn)) < 0) picks.push({ name: vn, voice: voices[i] });
        }
      }
      if (!picks.length) return done([], ['других озвучек нет']);
      var out = [];
      var reasons = [];
      // по одной: на параллельные запросы Phantom отвечает 503 (проверено на живом Lampac)
      var next = function (k) {
        if (k >= picks.length) return done(out, reasons);
        var p = picks[k];
        var key = cacheKey(env, card, 'v:' + norm(p.name));
        var got = function (ms, why) {
          if (ms) out.push({ voice: p.name, durationMs: ms });
          else reasons.push(p.name + ': ' + why);
          next(k + 1);
        };
        if (p.item) return itemDurationMs(env, p.item, key, got);
        var hit = cache.get(key);
        if (hit && hit.durationMs) return got(hit.durationMs);
        voiceEpisodes(env, json, p.voice, function (list, why) {
          var item = list && episodeItem(list, env.ep);
          if (!item) return got(null, list ? 'нет серии' : why);
          itemDurationMs(env, item, key, got);
        });
      };
      next(0);
    });
  }


  // done([{ source, durationMs, own }], reasons) — текущий источник и ORIG_SOURCES, параллельно.
  function originals(ctx, done) {
    var inf = info(ctx.url, ctx.balancer);
    if (!inf) return done([], 'источник не Lampac');
    var bals = [inf.bal];
    for (var i = 0; i < ORIG_SOURCES.length; i++) if (bals.indexOf(ORIG_SOURCES[i]) < 0) bals.push(ORIG_SOURCES[i]);
    var out = [];
    var reasons = [];
    var left = bals.length;
    bals.forEach(function (b) {
      originalDurationMs(ctx, b, function (ms, why) {
        if (ms) out.push({ source: b, durationMs: ms, own: b === inf.bal });
        else reasons.push(b + ': ' + why);
        if (--left === 0) {
          out.sort(function (a, c) { return bals.indexOf(a.source) - bals.indexOf(c.source); });
          done(out, reasons.join('; '));
        }
      });
    });
  }

  return {
    info: function (ctx) { return info(ctx.url, ctx.balancer); },
    originalDurationMs: originalDurationMs,
    originals: originals,
    siblings: siblings
  };
}

module.exports = {
  ORIG_SOURCES: ORIG_SOURCES,
  pickOriginal: pickOriginal,
  info: info,
  fixHost: fixHost,
  liteUrl: liteUrl,
  create: create
};
  },

  "api/opensubtitles": function (module, exports, require) {
/*
 * SubtitleProvider: поиск и скачивание OpenSubtitles, кеш файлов в IndexedDB, ранжирование релизов.
 * Устанавливается в общий объект app (см. index.js): функции и состояние доступны как app.*.
 */
'use strict';

var reference = require('../engine/reference');

module.exports = function (app) {
  app.API = 'https://api.opensubtitles.com/api/v1';

  app.UA = 'LampaOpenSubs v1.0';


  // ---------- сеть ----------
  app.xhr = function xhr(method, url, body, done, fail) {
    var r = new XMLHttpRequest();
    r.open(method, url, true);
    r.timeout = 15000;
    r.setRequestHeader('Api-Key', app.apiKey());
    r.setRequestHeader('X-User-Agent', app.UA);
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
  };


  // API OpenSubtitles требует параметры в алфавитном порядке и в нижнем регистре,
  // иначе отвечает редиректом, который ломает CORS в браузере
  app.query = function query(params) {
    var keys = Object.keys(params).sort();
    var out = [];
    for (var i = 0; i < keys.length; i++) {
      var v = params[keys[i]];
      if (v === null || typeof v === 'undefined' || v === '') continue;
      out.push(keys[i] + '=' + encodeURIComponent(String(v).toLowerCase()).replace(/%2C/g, ','));
    }
    return out.join('&');
  };


  // ---------- хранилище субтитров (IndexedDB на устройстве) ----------
  // Скачанный файл хранится по file_id: повторный просмотр не тратит дневной лимит OpenSubtitles.
  app.DB_NAME = 'opensubs';

  app.STORE = 'files';

  app.DB_MAX = 300;

  app.dbPromise = null;

  app.blobUrls = [];

  app.db = function db(cb) {
    if (app.dbPromise === false) return cb(null);
    if (app.dbPromise) return app.dbPromise.push(cb);
    app.dbPromise = [cb];
    var flush = function (d) {
      var list = app.dbPromise;
      app.dbPromise = d ? { push: function (f) { f(d); } } : false;
      for (var i = 0; i < list.length; i++) list[i](d);
    };
    try {
      var req = window.indexedDB.open(app.DB_NAME, 1);
      req.onupgradeneeded = function () {
        var s = req.result.createObjectStore(app.STORE, { keyPath: 'id' });
        s.createIndex('t', 't');
      };
      req.onsuccess = function () { flush(req.result); };
      req.onerror = req.onblocked = function () { flush(null); };
    } catch (e) {
      flush(null);
    }
  };

  app.storeGet = function storeGet(id, cb) {
    app.db(function (d) {
      if (!d) return cb(null);
      try {
        var r = d.transaction(app.STORE, 'readonly').objectStore(app.STORE).get(id);
        r.onsuccess = function () { cb(r.result ? r.result.text : null); };
        r.onerror = function () { cb(null); };
      } catch (e) { cb(null); }
    });
  };

  app.storePut = function storePut(id, text) {
    app.db(function (d) {
      if (!d) return;
      try {
        var s = d.transaction(app.STORE, 'readwrite').objectStore(app.STORE);
        s.put({ id: id, text: text, t: Date.now() });
        var c = s.count();
        c.onsuccess = function () {
          var extra = c.result - app.DB_MAX;
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
  };

  app.storeStats = function storeStats(cb) {
    app.db(function (d) {
      if (!d) return cb(-1);
      try {
        var c = d.transaction(app.STORE, 'readonly').objectStore(app.STORE).count();
        c.onsuccess = function () { cb(c.result); };
        c.onerror = function () { cb(-1); };
      } catch (e) { cb(-1); }
    });
  };

  app.storeClear = function storeClear(cb) {
    app.db(function (d) {
      if (!d) return cb && cb();
      try {
        var r = d.transaction(app.STORE, 'readwrite').objectStore(app.STORE).clear();
        r.onsuccess = r.onerror = function () { cb && cb(); };
      } catch (e) { cb && cb(); }
    });
  };

  app.textUrl = function textUrl(text) {
    try {
      var u = URL.createObjectURL(new Blob([text], { type: 'text/vtt' }));
      app.blobUrls.push(u);
      return u;
    } catch (e) {
      return null;
    }
  };

  app.revokeUrls = function revokeUrls() {
    for (var i = 0; i < app.blobUrls.length; i++) try { URL.revokeObjectURL(app.blobUrls[i]); } catch (e) {}
    app.blobUrls = [];
  };

  app.fetchText = function fetchText(url, done, fail) {
    var r = new XMLHttpRequest();
    r.open('GET', url, true);
    r.timeout = 20000;
    r.onload = function () {
      if (r.status >= 200 && r.status < 300 && /-->/.test(r.responseText)) done(r.responseText);
      else fail(r.status);
    };
    r.onerror = r.ontimeout = function () { fail(0); };
    r.send(null);
  };


  // done(text, link): текст файла (из хранилища или свежескачанный); link — прямая ссылка, если текст получить не удалось
  app.download = function download(fileId, done, fail) {
    app.storeGet(fileId, function (text) {
      if (text) return done(text, null);

      app.xhr('POST', app.API + '/download', { file_id: fileId, sub_format: 'webvtt' }, function (json) {
        if (!json.link) return fail(json);
        app.fetchText(json.link, function (body) {
          app.storePut(fileId, body);
          done(body, null);
        }, function () {
          done(null, json.link);
        });
      }, function (status, json) {
        fail(json || status);
      });
    });
  };

  app.buildQuery = function buildQuery(card, data, langs) {
    var p = { languages: langs.slice().sort().join(','), order_by: 'download_count' };
    var isTv = !!(card.name || card.original_name || card.number_of_seasons || data.season);
    var tmdbOk = card.id && (!card.source || card.source === 'tmdb' || card.source === 'cub');
    var imdb = parseInt(String(card.imdb_id || '').replace(/^tt/, ''), 10) || ''; // без ведущих нулей, иначе редирект

    if (isTv) {
      var ep = app.episodeInfo(data);
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
  };


  // Экранки и ранние релизы: свой хронометраж, с онлайн-видео не совпадают
  // ранжирование релизов — engine/reference.js (ReferenceSelector)
  app.score = function score(a) {
    return reference.score(a, { fps: app.session && app.session.vidFps });
  };

  // лучшие варианты по языкам: {lang: [attrs…]}
  app.groupFound = function groupFound(list, langs) {
    var groups = {};
    for (var i = 0; i < list.length; i++) {
      var a = list[i].attributes;
      if (!a || !a.files || !a.files.length) continue;
      if (a.machine_translated || a.ai_translated) continue;
      var l = app.normLang(a.language);
      if (langs.indexOf(l) < 0) continue;
      a._score = app.score(a);
      a._lang = l;
      (groups[l] = groups[l] || []).push(a);
    }
    for (var k in groups) groups[k] = groups[k].sort(function (x, y) { return y._score - x._score; }).slice(0, 3);
    return groups;
  };

  app.shortRelease = function shortRelease(a) {
    var r = String(a.release || '').replace(/[._]/g, ' ').replace(/\s+/g, ' ').trim();
    return r.length > 40 ? r.slice(0, 40) + '…' : r;
  };

  app.trackLabel = function trackLabel(a) {
    return app.langName(a._lang) + ' · OS · ' + app.shortRelease(a);
  };
};
  },

  "app/boot": function (module, exports, require) {
/*
 * Настройки плагина в Lampa и запуск: подписки на плеер, перенос профилей.
 * Устанавливается в общий объект app (см. index.js): функции и состояние доступны как app.*.
 */
'use strict';

module.exports = function (app) {
  // ---------- настройки ----------
  app.settings = function settings() {
    if (!Lampa.SettingsApi) return;

    Lampa.SettingsApi.addComponent({
      component: 'opensubs',
      name: 'OpenSubtitles',
      icon: app.ICON
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
      param: { name: 'opensubs_ffprobe', type: 'input', values: '', placeholder: 'не используется', default: '' },
      field: { name: 'Служба ffprobe (необязательно)', description: 'Адрес службы, которая отвечает JSON ffprobe на ?url=… Без неё всё считается в браузере' }
    });

    Lampa.SettingsApi.addParam({
      component: 'opensubs',
      param: { name: 'opensubs_clear', type: 'button' },
      field: { name: 'Очистить сохранённые субтитры', description: 'Скачанные файлы хранятся на этом устройстве' },
      onRender: function (item) {
        app.storeStats(function (n) {
          var d = item.find('.settings-param__descr');
          if (n >= 0) d.text('Сохранено на этом устройстве: ' + n + ' (до ' + app.DB_MAX + ', старые удаляются сами)');
          else d.text('Хранилище недоступно на этом устройстве');
        });
      },
      onChange: function () {
        app.storeClear(function () {
          Lampa.Noty.show('OpenSubtitles: сохранённые субтитры удалены');
          Lampa.Settings.update();
        });
      }
    });
  };

  app.start = function start() {
    app.settings();
    app.css();
    app.applyStyle();
    app.addButton();
    app.hookPlayerSettings();
    try {
      Lampa.PlayerVideo.listener.follow('subs', function () { setTimeout(app.reassert, 0); });
    } catch (e) {}
    var timer = null;
    Lampa.Player.listener.follow('start', function (data) {
      app.addButton();
      app.applyStyle();
      clearInterval(timer);
      timer = setInterval(function () { app.updateButtons(); app.checkSecondPrompt(); }, 1000);
      app.audioStop();
      app.current = null;
      app.revokeUrls(); // файлы прошлого видео больше не нужны
      try { app.load(data || {}); } catch (e) { app.log('error', e); }
    });
    Lampa.Player.listener.follow('destroy', function () {
      app.current = null;
      clearInterval(timer); // сеанс не сбрасываем: Lampa шлёт destroy и при переключении серий
      app.audioStop();
    });
    try { localStorage.removeItem('opensubs_links'); } catch (e) {} // кеш ссылок из первой версии
    try { if (app.profiles.migrate()) app.log('профили перенесены из прежних ключей'); } catch (e) { app.log('перенос профилей:', e); }
  };

  app.boot = function () {
    if (window.appready) app.start();
    else {
      Lampa.Listener.follow('app', function (e) {
        if (e.type === 'ready') app.start();
      });
    }
  };
};
  },

  "app/services": function (module, exports, require) {
/*
 * Общие экземпляры: LampacAdapter, ClientProbe, события движка, ProfileStore.
 * Устанавливается в общий объект app (см. index.js): функции и состояние доступны как app.*.
 */
'use strict';

var http = require('../api/http');

module.exports = function (app) {
  app.lampacApi = require('../api/lampac').create({ http: http, cache: {
    get: function (k) { return app.odurGet(k); },
    set: function (k, v) { app.odurSet(k, v); }
  } });

  app.clientProbe = require('../probe/client-probe').create({ http: http });

  // характеристики видео: FFProbe, если указан адрес службы (настройка opensubs_ffprobe), иначе ClientProbe (ADR 1)
  app.videoProbe = {
    probe: function (req, done) {
      var endpoint = String(Lampa.Storage.get('opensubs_ffprobe', '') || '').replace(/^\s+|\s+$/g, '');
      require('../probe/ffprobe').create({ http: http, endpoint: endpoint, fallback: app.clientProbe }).probe(req, done);
    }
  };

  app.engineEvents = require('../engine/events').create();

  // профили (profiles/storage.js): субтитры и видео раздельно, уровни доверия по длительности видео (ADR 4)
  app.profiles = require('../profiles/storage').create({
    read: function (name) {
      var v = Lampa.Storage.get(name, '');
      if (typeof v === 'string' && v) try { v = JSON.parse(v); } catch (e) { v = null; }
      return v === '' ? null : v;
    },
    write: function (name, v) { Lampa.Storage.set(name, v); }
  });
};
  },

  "app/util": function (module, exports, require) {
/*
 * Общие мелочи: журнал, настройки, хранилище Lampa, карточка и серия, язык.
 * Устанавливается в общий объект app (см. index.js): функции и состояние доступны как app.*.
 */
'use strict';

var subtitle = require('../analyzers/subtitle');
var time = require('../engine/time');

module.exports = function (app) {
  app.LANG_NAMES = { ru: 'Русские', uk: 'Українські', en: 'English' };

  app.log = function log() {
    try {
      var args = Array.prototype.slice.call(arguments);
      args.unshift('OpenSubs');
      console.log.apply(console, args);
    } catch (e) {}
  };

  app.setting = function setting(name, def) {
    var v = Lampa.Storage.get('opensubs_' + name, def);
    return v === '' || v === null || typeof v === 'undefined' ? def : v;
  };

  app.flag = function flag(name, def) {
    var v = app.setting(name, def);
    return v === true || v === 'true';
  };

  app.apiKey = function apiKey() {
    return String(app.setting('apikey', '') || '').trim();
  };


  // ---------- что смотрим ----------
  app.activeCard = function activeCard() {
    try {
      var a = Lampa.Activity.active();
      if (!a) return null;
      return a.movie || a.card || (a.object && (a.object.movie || a.object.card)) || null;
    } catch (e) {
      return null;
    }
  };

  app.episodeInfo = function episodeInfo(data) {
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
  };

  app.langName = function langName(code) {
    return app.LANG_NAMES[code] || String(code || '').toUpperCase();
  };

  app.normLang = function normLang(code) {
    code = String(code || '').toLowerCase();
    if (code === 'ua') return 'uk';
    return code.split('-')[0];
  };

  app.notify = function notify(text) {
    if (app.flag('notify', true)) Lampa.Noty.show(text);
  };

  app.store = function store(name) {
    var c = Lampa.Storage.get(name, '{}');
    if (typeof c === 'string') try { c = JSON.parse(c); } catch (e) { c = {}; }
    return c && typeof c === 'object' ? c : {};
  };

  app.storeSave = function storeSave(name, all, max) {
    var keys = Object.keys(all);
    if (keys.length > max) {
      keys.sort(function (a, b) { return (all[a].t || 0) - (all[b].t || 0); });
      for (var i = 0; i < keys.length - max; i++) delete all[keys[i]];
    }
    Lampa.Storage.set(name, all);
  };

  app.round3 = function round3(x) { return Math.round(x * 1000) / 1000; };


  // Разбор и пересчёт таймингов — analyzers/subtitle.js (мс); здесь — переходники на секунды прототипа.
  app.fmtTime = function fmtTime(t) {
    return time.formatClock(t * 1000);
  };


  // реплики файла: [{start, end, text}] в секундах
  app.parseCues = function parseCues(text) {
    return subtitle.parse(text).map(function (c) { return { start: c.startMs / 1000, end: c.endMs / 1000, text: c.text }; });
  };

  app.isMovie = function isMovie(s) {
    return !app.episodeInfo(s.data) && !(s.card && (s.card.name || s.card.original_name));
  };
};
  },

  "calibration/checkpoints": function (module, exports, require) {
/*
 * Калибровка пользователем (документ, «Калибровка пользователем»; задача 5).
 *   choices(cues, maps, atMs, page)    — 4 реплики: звучащая сейчас при каждой гипотезе сдвига, затем
 *                                       недавно прозвучавшие; page 1, 2… — дальше («ни одна не подходит»).
 *   point(cue, toRef, atMs)            — якорь { o, t } в секундах прототипа: момент эталона o звучит в t.
 *   nextPrompt(beforeMs, afterMs, cls, atMs) — когда попросить вторую точку (или null).
 *   alreadyInSync(currentOffsetMs, atMs) — «Субтитры уже совпадают»: текущая модель становится ручной точкой.
 * Время — мс (ADR 6); toPlayer / toRef — функции время реплики → время плеера / эталона.
 */
'use strict';

var PER_PAGE = 4;
var WINDOW_MS = 600000;   // дальше ±10 минут от текущего момента не предлагаем
var REACTION_MS = 300;    // пользователь узнаёт фразу чуть позже её начала
var SECOND_AFTER_MS = 600000;
var SECOND_IF_MS = 1500;

// Реплика, которая звучит в момент atMs при данном переводе времени (последняя начавшаяся).
function playingAt(cues, toPlayer, atMs) {
  var best = -1;
  for (var i = 0; i < cues.length; i++) if (toPlayer(cues[i].startMs) <= atMs) best = i;
  return best;
}

// toPlayer — текущая модель или список переводов: [текущая модель, альтернативы…] (сдвиг 0, отброшенные
// гипотезы, профиль). Первая страница — реплика, звучащая сейчас при каждом варианте, затем ближайшие
// уже прозвучавшие; пользователь узнаёт то, что услышал, а не то, что будет (приёмка 10.11).
function choices(cues, toPlayer, atMs, page) {
  page = page || 0;
  var maps = typeof toPlayer === 'function' ? [toPlayer] : toPlayer;
  var main = maps[0];
  var order = [];
  var seen = {};
  var add = function (i) {
    if (i < 0 || i >= cues.length || seen[i]) return;
    seen[i] = true;
    order.push(i);
  };
  maps.forEach(function (fn) { add(playingAt(cues, fn, atMs)); });
  // затем по текущей модели: прозвучавшие недавно (назад до 10 минут), потом ближайшие следующие
  var past = [], future = [];
  for (var i = 0; i < cues.length; i++) {
    var p = main(cues[i].startMs);
    if (Math.abs(p - atMs) > WINDOW_MS) continue;
    if (p <= atMs) past.push({ i: i, d: atMs - p });
    else future.push({ i: i, d: p - atMs });
  }
  past.sort(function (x, y) { return x.d - y.d; });
  future.sort(function (x, y) { return x.d - y.d; });
  var k = 0;
  while (k < past.length || k < future.length) {
    if (k < past.length) add(past[k].i);
    if (k < past.length && k + 1 < past.length) add(past[k + 1].i);
    if (k < future.length) add(future[k].i);
    k += 2;
  }
  var items = order.slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE).map(function (idx) {
    return { index: idx, text: cues[idx].text, playerMs: main(cues[idx].startMs) };
  });
  items.sort(function (x, y) { return x.playerMs - y.playerMs; }); // на экране — по порядку фильма
  return { items: items, more: order.length > (page + 1) * PER_PAGE };
}

function point(cue, toRef, atMs) {
  return { o: Math.round(toRef(cue.startMs)) / 1000, t: Math.max(0, atMs - REACTION_MS) / 1000 };
}

// Вторая точка нужна, если первая заметно сдвинула модель и это не объяснено пересчётом кадров:
// возможно, дрейф или локальный скачок — спросим через 10 минут просмотра.
function nextPrompt(beforeMs, afterMs, cls, atMs) {
  if (cls === 'drift') return null;
  if (Math.abs(afterMs - beforeMs) <= SECOND_IF_MS) return null;
  return atMs + SECOND_AFTER_MS;
}

function alreadyInSync(currentOffsetMs, atMs) {
  return { offsetMs: currentOffsetMs, atMs: atMs };
}

module.exports = {
  PER_PAGE: PER_PAGE,
  REACTION_MS: REACTION_MS,
  choices: choices,
  point: point,
  nextPrompt: nextPrompt,
  alreadyInSync: alreadyInSync
};
  },

  "engine/decider": function (module, exports, require) {
/*
 * Decider — что делать с субтитрами при данной модели (таблица правил документа, ADR 3 вариант А).
 *
 * decide(model, { movie, canListen, release }) → {
 *   action:    'show' | 'wait' | 'hide',
 *   marker:    'unconfirmed' | null,   // признак неподтверждённой синхронизации на иконке CC
 *   listen:    boolean,                // запустить или продолжать проверку по звуку
 *   calibrate: boolean,                // предложить калибровку пользователем
 *   rule:      номер правила таблицы, reason: текст для меню
 * }
 */
'use strict';

function decide(model, ctx) {
  ctx = ctx || {};
  var status = model ? model.status : 'failed';
  var structural = ctx.release && ctx.release.modelClass === 'structural';
  var listen = !!ctx.canListen && !ctx.movie;

  if (status === 'verified') {
    return { action: 'show', marker: null, listen: false, calibrate: false, rule: 1, reason: 'синхронизация подтверждена' };
  }
  if (status === 'estimated') {
    // правило 3 (вариант А): показываем сразу с признаком, звук уточняет в фоне
    return { action: 'show', marker: 'unconfirmed', listen: listen, calibrate: !listen, rule: 3, reason: 'предварительная поправка, не подтверждена' };
  }
  if (ctx.movie && status === 'failed') {
    // правило 4: у фильма нет оригинала для сравнения — субтитры от релиза, звук не слушаем
    return { action: 'show', marker: 'unconfirmed', listen: false, calibrate: true, rule: 4, reason: 'фильм: без сверки с видео' };
  }
  if (status === 'uncertain' || structural) {
    if (listen) return { action: 'wait', marker: null, listen: true, calibrate: false, rule: structural ? 6 : 7, reason: 'ждёт подтверждения по звуку' };
    return { action: 'hide', marker: null, listen: false, calibrate: true, rule: 6, reason: 'нет уверенности — нужна калибровка' };
  }
  // failed: оригинала нет
  if (listen) return { action: 'wait', marker: null, listen: true, calibrate: false, rule: 7, reason: 'оригинала нет, проверка по звуку' };
  return { action: 'hide', marker: null, listen: false, calibrate: true, rule: 8, reason: 'синхронизация не найдена' };
}

module.exports = { decide: decide };
  },

  "engine/diagnostics": function (module, exports, require) {
/*
 * ReleaseDiagnostics — этап 1 конвейера: чем это видео отличается от оригинала той же серии.
 * Чистая функция: на входе длительности, на выходе класс релиза и гипотезы (ADR 3, 7).
 *
 * diagnose({
 *   videoMs, exact,                                // длительность текущего видео (ClientProbe)
 *   originals: [{ source, durationMs, own }],      // дорожка «Оригинал» у источников (LampacAdapter)
 *   siblings:  [{ voice, durationMs }]             // другие озвучки этого же источника (необязательно)
 * }) → ReleaseInfo {
 *   cls: 'same' | 'near' | 'insertion' | 'fps' | 'cut' | 'different' | 'unknown',
 *   modelClass: 'constant' | 'drift' | 'structural' | null,
 *   nearest: { source, durationMs } | null, deltaMs, ratio,
 *   agree,              // сколько источников подтверждают длительность ближайшего оригинала (±500 мс)
 *   spreadMs,           // разброс длительностей оригиналов между источниками
 *   hypotheses: Hypothesis[], text
 * }
 *
 * Сравниваем с БЛИЖАЙШИМ по длительности оригиналом: «Оригинал» одного источника бывает другой сборкой
 * (GoT S3E3: ZetflixDB 3169.04 против 3201.01 у Phantom и Aladin), а студия не определяет вставку
 * (каталог студий не ведём — одна студия в разных сериалах ведёт себя по-разному).
 */
'use strict';

var types = require('./types');
var time = require('./time');

var LIMITS = {
  sameMs: 300,          // совпадает с оригиналом (HLS даёт сотые секунды)
  sameInexactMs: 1000,  // если длительность видео известна только из video.duration
  nearMs: 3000,         // до 3 с — разница сборок, не вставка
  agreeMs: 500,         // источники согласны о длительности оригинала
  insertionMaxMs: 120000,
  disagreeMs: 1500,     // оригиналы у источников разной длины
  fpsTolMs: 2500,        // пересчёт 25 ↔ 23.976: длительность после пересчёта ±2.5 с (ГоТ 3×3 Кравец: 1.27 с)
  insertionSigmaMs: 7000 // отбивки площадок (Netflix и т. п.) до ~7 с — разница длительностей их не видит
};

var PAL_TO_FILM = time.FPS.PAL / time.FPS.FILM;

function abs(x) {
  return x < 0 ? -x : x;
}

function secs(ms) {
  return (ms / 1000).toFixed(2);
}

function diagnose(input) {
  var videoMs = input.videoMs;
  var originals = input.originals || [];
  var siblings = input.siblings || [];
  var out = { cls: 'unknown', modelClass: null, nearest: null, deltaMs: null, ratio: null, agree: 0, spreadMs: 0, hypotheses: [], text: '' };

  if (!videoMs) {
    out.text = 'длительность видео неизвестна';
    return out;
  }
  if (!originals.length) {
    out.text = 'оригинал не найден';
    return out;
  }

  var nearest = null;
  var i;
  for (i = 0; i < originals.length; i++) {
    if (!nearest || abs(videoMs - originals[i].durationMs) < abs(videoMs - nearest.durationMs)) nearest = originals[i];
  }
  var lo = Infinity;
  var hi = -Infinity;
  var agreeing = {};
  for (i = 0; i < originals.length; i++) {
    var o = originals[i];
    lo = Math.min(lo, o.durationMs);
    hi = Math.max(hi, o.durationMs);
    if (abs(o.durationMs - nearest.durationMs) <= LIMITS.agreeMs) agreeing[o.source] = true;
  }
  var agree = Object.keys(agreeing).length;
  var delta = videoMs - nearest.durationMs;
  var ratio = videoMs / nearest.durationMs;
  var sameMs = input.exact === false ? LIMITS.sameInexactMs : LIMITS.sameMs;

  // другие озвучки той же длительности, что и видео, — ещё одно свидетельство «та же сборка»
  var sameSiblings = 0;
  for (i = 0; i < siblings.length; i++) if (abs(siblings[i].durationMs - videoMs) <= LIMITS.agreeMs) sameSiblings++;

  out.nearest = { source: nearest.source, durationMs: nearest.durationMs };
  out.deltaMs = delta;
  out.ratio = ratio;
  out.agree = agree;
  out.spreadMs = hi - lo;

  var evidence = [{ what: 'длительность видео', value: videoMs, source: input.exact === false ? 'video.duration' : 'hls' }];
  for (i = 0; i < originals.length; i++) {
    evidence.push({ what: 'оригинал', value: originals[i].durationMs, source: originals[i].source });
  }
  if (sameSiblings) evidence.push({ what: 'озвучки той же длительности', value: sameSiblings, source: 'siblings' });

  var conf;
  var disagree = out.spreadMs > LIMITS.disagreeMs;
  // PAL-версия далека от всех оригиналов по длительности, поэтому сверяем пересчёт с каждым
  var fpsLike = false;
  for (i = 0; i < originals.length && !fpsLike && abs(delta) > LIMITS.nearMs; i++) {
    var od = originals[i].durationMs;
    if (abs(videoMs - od * PAL_TO_FILM) <= LIMITS.fpsTolMs || abs(videoMs - od / PAL_TO_FILM) <= LIMITS.fpsTolMs) {
      fpsLike = true;
      ratio = videoMs / od;
      out.nearest = { source: originals[i].source, durationMs: od };
    }
  }

  if (fpsLike) {
    out.cls = 'fps';
    out.modelClass = 'drift';
    conf = agree >= 2 ? 0.8 : 0.6;
    out.hypotheses.push(types.hypothesis({ estimator: 'duration', kind: 'drift', offsetMs: 0, scale: ratio, sigmaMs: 1000, confidence: conf, evidence: evidence }));
    out.text = 'другая частота кадров: ×' + ratio.toFixed(4);
  } else if (abs(delta) <= sameMs) {
    out.cls = 'same';
    out.modelClass = 'constant';
    conf = Math.min(0.95, 0.65 + 0.15 * (agree - 1 + sameSiblings));
    if (input.exact === false) conf -= 0.2;
    out.hypotheses.push(types.hypothesis({ estimator: 'duration', kind: 'offset', offsetMs: 0, sigmaMs: sameMs, confidence: conf, evidence: evidence }));
    out.text = 'совпадает с оригиналом (' + nearest.source + '), вставки нет';
  } else if (abs(delta) <= LIMITS.nearMs) {
    out.cls = 'near';
    out.modelClass = 'constant';
    out.hypotheses.push(types.hypothesis({ estimator: 'duration', kind: 'offset', offsetMs: 0, sigmaMs: abs(delta) + 500, confidence: 0.3, evidence: evidence }));
    out.text = 'почти совпадает с оригиналом (' + (delta > 0 ? '+' : '') + secs(delta) + ' с) — другая сборка';
  } else if (delta > 0 && delta <= LIMITS.insertionMaxMs) {
    out.cls = 'insertion';
    out.modelClass = 'constant';
    conf = 0.35 + (agree >= 2 ? 0.15 : 0) - (disagree ? 0.15 : 0);
    out.hypotheses.push(types.hypothesis({ estimator: 'openingInsertion', kind: 'opening_insertion_candidate', offsetMs: delta,
      sigmaMs: LIMITS.insertionSigmaMs, confidence: Math.max(0.1, conf), evidence: evidence }));
    out.text = 'вероятно, вставка в начале +' + secs(delta) + ' с' + (disagree ? '; оригиналы у источников разной длины' : '');
  } else if (delta < 0) {
    out.cls = 'cut';
    out.modelClass = 'structural';
    out.text = 'видео короче оригинала на ' + secs(-delta) + ' с — вырезано';
  } else {
    out.cls = 'different';
    out.modelClass = 'structural';
    out.text = 'видео длиннее оригинала на ' + secs(delta) + ' с — другая версия';
  }
  return out;
}

module.exports = { diagnose: diagnose, LIMITS: LIMITS };
  },

  "engine/events": function (module, exports, require) {
/*
 * Engine.events — события движка для UI (иконка CC, меню синхронизации).
 *   'state'    { state: 'idle' | 'searching' | 'diagnosing' | 'listening' | 'ready' }
 *   'progress' { value: 0..1 }        — прогресс фоновой проверки по звуку
 *   'model'    SyncModel              — новая модель (после любого изменения гипотез)
 *   'decision' Decision               — решение Decider
 */
'use strict';

function create() {
  var handlers = {};
  return {
    on: function (name, fn) {
      (handlers[name] = handlers[name] || []).push(fn);
    },
    off: function (name, fn) {
      var list = handlers[name] || [];
      for (var i = list.length - 1; i >= 0; i--) if (list[i] === fn) list.splice(i, 1);
    },
    emit: function (name, payload) {
      var list = (handlers[name] || []).slice();
      for (var i = 0; i < list.length; i++) {
        try { list[i](payload); } catch (e) {}
      }
    }
  };
}

module.exports = { create: create };
  },

  "engine/reference": function (module, exports, require) {
/*
 * ReferenceSelector — какие субтитры брать и с чем их сверять.
 *   score(attrs)                 — ранг файла OpenSubtitles: экранки вниз, BluRay/WEB вверх, релизы площадок
 *                                  (NF, AMZN, HMAX…) выше всего (их хронометраж совпадает с видео источников);
 *   pick(list, { fps })          — лучший файл с учётом частоты кадров видео;
 *   reference(enList, target)    — эталон для crossSubs: английские того же релиза, что и показываемые,
 *                                  иначе той же площадки, иначе лучшие по рангу;
 *   timeline(cues, videoMs)      — для фильма без оригинала: укладываются ли реплики в длительность видео
 *                                  (слабая гипотеза, без подтверждения — ADR правило 4).
 */
'use strict';

var types = require('./types');

var BAD_RELEASE = /(^|[^a-z])(cam|hdcam|camrip|ts|hdts|telesync|tc|hdtc|telecine|scr|screener|dvdscr|bdscr|workprint|r5)([^a-z]|$)/i;
var GOOD_RELEASE = /blu-?ray|bdrip|brrip|bdremux|remux|web-?dl|webrip|web|amzn|nf|dsnp|hmax|atvp|itunes|hdrip|dvdrip/i;
// релизы площадок — с их отбивками; видео онлайн-источников обычно оттуда же
var PLATFORM_RELEASE = /(^|[^a-z])(nf|amzn|atvp|dsnp|hmax|hulu|pcok|pmtp|stan|crav|itunes)([^a-z]|$)/i;
var PLATFORMS = ['nf', 'amzn', 'atvp', 'dsnp', 'hmax', 'hulu', 'pcok', 'pmtp', 'stan', 'crav', 'itunes'];
var NOISE = /^(\d{3,4}p|x26[45]|h26[45]|hevc|avc|aac\d*|ac3|dd\d*|ddp\d*|atmos|10bit|hdr|sdr|proper|repack|rerip|internal|mkv|mp4|srt|eng|en|rus|ru)$/i;

function releaseText(a) {
  return String(a.release || '') + ' ' + String((a.files && a.files[0] && a.files[0].file_name) || '');
}

function fpsFamily(f) {
  f = parseFloat(f) || 0;
  if (!f) return null;
  if (Math.abs(f - 25) < 0.1) return 'pal';
  if (Math.abs(f - 23.976) < 0.1 || Math.abs(f - 24) < 0.1) return 'film';
  return 'other';
}

function score(a, opts) {
  opts = opts || {};
  var rel = releaseText(a);
  var sc = Math.log(1 + (a.download_count || 0)); // 0…~14
  if (BAD_RELEASE.test(rel)) sc -= 100;
  if (GOOD_RELEASE.test(rel)) sc += 6;
  if (PLATFORM_RELEASE.test(rel)) sc += 8;
  if (a.from_trusted) sc += 3;
  var fam = fpsFamily(a.fps);
  var vid = fpsFamily(opts.fps);
  if (vid && fam) sc += fam === vid ? 2 : -4;          // частота кадров видео известна
  else if (fam && fam !== 'film') sc -= 4;            // 25/29.97/30 — чаще всего не наш хронометраж
  if (a.hearing_impaired) sc -= 2;
  return sc;
}

function pick(list, opts) {
  var best = null, bestScore = -Infinity;
  for (var i = 0; i < (list || []).length; i++) {
    var s = score(list[i], opts);
    if (s > bestScore) { best = list[i]; bestScore = s; }
  }
  return best;
}

function tokens(a) {
  var out = {};
  releaseText(a).toLowerCase().replace(/\.(srt|vtt|sub|ass)\b/g, ' ').split(/[^a-z0-9]+/).forEach(function (t) {
    if (t && t.length > 1 && !NOISE.test(t) && !/^s\d\de\d\d$/.test(t) && !/^(19|20)\d\d$/.test(t)) out[t] = true;
  });
  return out;
}

function platformOf(a) {
  var t = tokens(a);
  for (var i = 0; i < PLATFORMS.length; i++) if (t[PLATFORMS[i]]) return PLATFORMS[i];
  return null;
}

function similarity(a, b) {
  var x = tokens(a), y = tokens(b), inter = 0, uni = 0, k;
  for (k in x) { uni++; if (y[k]) inter++; }
  for (k in y) if (!x[k]) uni++;
  return uni ? inter / uni : 0;
}

// Эталон должен совпадать по хронометражу с ВИДЕО (оригиналом источника), а не с показываемыми субтитрами:
// субтитры к нему приводятся. Видео онлайн-источников — обычно релиз площадки сериала (NF, HMAX…), поэтому
// opts.platform (из networks карточки) даёт главный бонус. Приёмка 10.11: эталон «того же релиза, что и
// русские» давал ST 1×3 без отбивки Netflix (спешат) и GoT 3×3 с «ранее в сериале» (−89 с).
function reference(enList, target, opts) {
  if (!enList || !enList.length) return null;
  opts = opts || {};
  var best = null, bestScore = -Infinity;
  for (var i = 0; i < enList.length; i++) {
    var e = enList[i];
    var s = score(e, opts) + (opts.platform && platformOf(e) === opts.platform ? 10 : 0);
    if (s > bestScore) { best = e; bestScore = s; }
  }
  return best;
}

// Площадка сериала по networks карточки TMDB: Netflix → nf, HBO → hmax и т. д.
var NETWORKS = [[/netflix/i, 'nf'], [/hbo|max/i, 'hmax'], [/amazon|prime video/i, 'amzn'], [/apple tv/i, 'atvp'],
  [/disney/i, 'dsnp'], [/hulu/i, 'hulu'], [/peacock/i, 'pcok'], [/paramount/i, 'pmtp']];
function platformOfCard(card) {
  var nets = (card && (card.networks || card.production_companies)) || [];
  for (var i = 0; i < nets.length; i++) {
    for (var j = 0; j < NETWORKS.length; j++) if (NETWORKS[j][0].test(nets[i].name || '')) return NETWORKS[j][1];
  }
  return null;
}

// Фильм без оригинала: последняя реплика заканчивается до конца видео, но не раньше чем за 15% (титры).
function timeline(cues, videoMs) {
  if (!cues || !cues.length || !videoMs) return null;
  var last = 0;
  for (var i = 0; i < cues.length; i++) last = Math.max(last, cues[i].endMs);
  var ratio = last / videoMs;
  if (last > videoMs + 5000 || ratio < 0.85) return null;
  return types.hypothesis({
    estimator: 'timeline',
    kind: 'offset',
    offsetMs: 0,
    sigmaMs: 3000,
    confidence: ratio >= 0.93 ? 0.6 : 0.4,
    evidence: [{ what: 'последняя реплика / длительность видео', value: Math.round(ratio * 1000) / 1000, source: 'timeline' }]
  });
}

module.exports = {
  BAD_RELEASE: BAD_RELEASE, GOOD_RELEASE: GOOD_RELEASE, PLATFORM_RELEASE: PLATFORM_RELEASE,
  score: score, pick: pick, reference: reference, platformOfCard: platformOfCard, similarity: similarity, platformOf: platformOf, timeline: timeline
};
  },

  "engine/solver": function (module, exports, require) {
/*
 * Solver — сводит гипотезы оценщиков в одну модель «эталон → видео» (SyncModel) со статусом (ADR 2, 3, 7).
 * Оценщики не объединяются: каждый присылает свои гипотезы, решение принимает только Solver + Decider.
 *
 * solve(hypotheses, { release }) → SyncModel
 *
 * Правила:
 *   1. Точки с местом (fromMs: ручные контрольные точки и проверки звуком) — «якоря». Два и больше якоря
 *      на расстоянии ≥ 5 минут дают наклон (дрейф) методом наименьших квадратов (0.9…1.1).
 *      Одиночный выброс (> 3σ от прямой по остальным) уходит в rejected; два и больше подряд с одним
 *      скачком — локальный скачок: модель из двух кусков (класс local).
 *   2. Ручная точка главнее всего: при ней остальные гипотезы, расходящиеся больше чем на 1.5 с, отброшены.
 *   3. Без якорей — кластер вокруг самой уверенной гипотезы: совместимы те, кто отличается не больше чем
 *      на 3·√(σ₁² + σ₂²). Сдвиг — среднее с весами 1/σ². Несовместимые — в rejected.
 *   4. Статус: verified — ручная точка или суммарная уверенность независимых семейств ≥ 0.8, причём хотя бы
 *      одно из них основное (длительность, звук, точка): FPS, таймлайн и профиль только поддерживают;
 *      кандидат вставки учитывается, только если его подтвердили звук или точка (ADR 3);
 *      estimated — суммарная уверенность ≥ 0.3; uncertain — гипотезы есть, но слабые или релиз
 *      структурно отличается (вырезано, другая версия) без якорей; failed — гипотез нет.
 *   Время просмотра статус не повышает.
 */
'use strict';

var types = require('./types');
var insertion = require('../estimators/opening-insertion');

var VERIFIED = 0.8;
var SUPPORTING = { fps: true, timeline: true, profile: true };
var ESTIMATED = 0.3;
var CONFLICT_MS = 1500;
var SPAN_MS = 300000;
var MIN_SIGMA = 300;

// Семейства независимых доказательств: длительность и кандидат вставки — одно семейство.
var FAMILY = { duration: 'duration', openingInsertion: 'duration', fps: 'fps', crossSubs: 'crossSubs', audio: 'audio', checkpoint: 'checkpoint', profile: 'profile', timeline: 'timeline' };

function sigma(h) {
  return Math.max(MIN_SIGMA, h.sigmaMs);
}

function located(h) {
  return h.fromMs !== null && (h.estimator === 'checkpoint' || h.estimator === 'audio');
}

// Взвешенная прямая через якоря: refMs = fromMs − offsetMs; playerMs = fromMs.
// Якорь говорит: «в момент плеера fromMs нужен сдвиг offsetMs». Модель: player = ref·a + b.
function fitLine(anchors) {
  var sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (var i = 0; i < anchors.length; i++) {
    var h = anchors[i];
    var w = (h.estimator === 'checkpoint' ? 4 : 1) * h.confidence / Math.pow(sigma(h) / 1000, 2);
    var x = h.fromMs - h.offsetMs;
    var y = h.fromMs;
    sw += w; sx += w * x; sy += w * y; sxx += w * x * x; sxy += w * x * y;
  }
  var den = sw * sxx - sx * sx;
  var a = den ? (sw * sxy - sx * sy) / den : 1;
  if (!(a > 0.9 && a < 1.1)) a = 1;
  var b = (sy - a * sx) / sw;
  return { scale: a, offsetMs: b };
}

function spanMs(anchors) {
  var lo = Infinity, hi = -Infinity;
  for (var i = 0; i < anchors.length; i++) {
    lo = Math.min(lo, anchors[i].fromMs);
    hi = Math.max(hi, anchors[i].fromMs);
  }
  return hi - lo;
}

function constFit(anchors) {
  // сдвиг по якорям без наклона: последняя ручная точка главнее, иначе взвешенное среднее
  var manual = anchors.filter(function (h) { return h.estimator === 'checkpoint'; });
  if (manual.length) return { scale: 1, offsetMs: manual[manual.length - 1].offsetMs };
  var sw = 0, s = 0;
  for (var i = 0; i < anchors.length; i++) {
    var w = anchors[i].confidence / Math.pow(sigma(anchors[i]) / 1000, 2);
    sw += w;
    s += w * anchors[i].offsetMs;
  }
  return { scale: 1, offsetMs: s / sw };
}

function predict(line, h) {
  // сдвиг, который даёт прямая в момент h.fromMs
  var ref = (h.fromMs - line.offsetMs) / line.scale;
  return h.fromMs - ref;
}

function spread(list) {
  var lo = Infinity, hi = -Infinity;
  for (var i = 0; i < list.length; i++) {
    lo = Math.min(lo, list[i].offsetMs);
    hi = Math.max(hi, list[i].offsetMs);
  }
  return hi - lo;
}

function fitAny(list) {
  return list.length >= 2 && spanMs(list) >= SPAN_MS ? fitLine(list) : constFit(list);
}

function single(fit) {
  return [{ fromMs: null, toMs: null, scale: fit.scale, offsetMs: fit.offsetMs }];
}

function fitAnchors(anchors) {
  var sorted = anchors.slice().sort(function (a, b) { return a.fromMs - b.fromMs; });

  // локальный скачок: две группы по времени, в каждой ≥ 2 согласных точек, между группами скачок > 1.5 с
  if (sorted.length >= 4) {
    for (var k = 2; k <= sorted.length - 2; k++) {
      var left = sorted.slice(0, k), right = sorted.slice(k);
      if (spread(left) > CONFLICT_MS || spread(right) > CONFLICT_MS) continue;
      var lf = constFit(left), rf = constFit(right);
      if (Math.abs(lf.offsetMs - rf.offsetMs) <= CONFLICT_MS) continue;
      var cut = Math.round((left[left.length - 1].fromMs + right[0].fromMs) / 2);
      var cutRef = cut - lf.offsetMs; // граница куска — во входной шкале (эталон)
      return {
        pieces: [
          { fromMs: null, toMs: cutRef, scale: 1, offsetMs: lf.offsetMs },
          { fromMs: cutRef, toMs: null, scale: 1, offsetMs: rf.offsetMs }
        ],
        rejected: [], cls: 'local', used: sorted
      };
    }
  }

  // выбросы: по одному убираем точку, сильнее всех расходящуюся с прямой по остальным
  var list = sorted.slice();
  var rejected = [];
  while (list.length >= 3) {
    var worst = -1, worstErr = 0;
    for (var i = 0; i < list.length; i++) {
      var rest = list.filter(function (x, j) { return j !== i; });
      var err = Math.abs(predict(fitAny(rest), list[i]) - list[i].offsetMs);
      if (err > 3 * sigma(list[i]) && err > CONFLICT_MS && err > worstErr) {
        worst = i;
        worstErr = err;
      }
    }
    if (worst < 0) break;
    rejected.push(list[worst]);
    list.splice(worst, 1);
  }
  // ручная точка не бывает выбросом относительно автоматических: при споре верим ей
  var manual = list.filter(function (h) { return h.estimator === 'checkpoint'; });
  if (manual.length) {
    var mfit = fitAny(manual);
    list = list.filter(function (h) {
      if (h.estimator === 'checkpoint') return true;
      if (Math.abs(predict(mfit, h) - h.offsetMs) > CONFLICT_MS) {
        rejected.push(h);
        return false;
      }
      return true;
    });
  }
  return { pieces: single(fitAny(list)), rejected: rejected, cls: null, used: list };
}

function compatible(a, b) {
  return Math.abs(a.offsetMs - b.offsetMs) <= 3 * Math.sqrt(sigma(a) * sigma(a) + sigma(b) * sigma(b));
}

// Суммарная уверенность независимых семейств. confirmedOnly: кандидат вставки — только подтверждённый (ADR 3).
function combined(used, confirmedOnly) {
  var fam = {};
  var cand = null;
  var i;
  for (i = 0; i < used.length; i++) if (used[i].kind === 'opening_insertion_candidate') cand = used[i];
  for (i = 0; i < used.length; i++) {
    var h = used[i];
    var c = h.confidence;
    if (h.kind === 'opening_insertion_candidate' && confirmedOnly) {
      var conf = null;
      for (var j = 0; j < used.length && !conf; j++) conf = insertion.confirm(cand, used[j]);
      if (!conf) continue;
      c = conf.confidence;
    }
    var f = FAMILY[h.estimator] || h.estimator;
    fam[f] = Math.max(fam[f] || 0, c);
  }
  // частота кадров, таймлайн фильма и профиль соседней серии лишь поддерживают: одни они не подтверждают
  // синхронизацию (одинаковый FPS бывает у разных монтажей, 23.976/24 путаются, VFR портит среднее)
  if (confirmedOnly) {
    var primary = false;
    for (var p in fam) if (!SUPPORTING[p] && fam[p] > 0) primary = true;
    if (!primary) return 0;
  }
  var miss = 1;
  for (var k in fam) miss *= 1 - fam[k];
  return 1 - miss;
}

function solve(hyps, opts) {
  opts = opts || {};
  hyps = (hyps || []).map(types.hypothesis);
  // crossSubs и fps для субтитров описывают файл субтитров, а не видео — в модель видео не входят,
  // кроме fps-дрейфа видео относительно оригинала (estimator 'duration', kind 'drift').
  hyps = hyps.filter(function (h) { return h.estimator !== 'crossSubs'; });
  if (!hyps.length) return types.syncModel({ status: 'failed', confidence: 0 });

  var structural = opts.release && opts.release.modelClass === 'structural';
  var anchors = hyps.filter(located);
  var rest = hyps.filter(function (h) { return !located(h); });
  var used = [];
  var rejected = [];
  var pieces;
  var cls = null;

  if (anchors.length) {
    var r = fitAnchors(anchors);
    pieces = r.pieces;
    cls = r.cls;
    used = r.used;
    rejected = r.rejected;
    var manual = anchors.some(function (h) { return h.estimator === 'checkpoint'; });
    // якоря не дают наклона (мало или близко), а пересчёт кадров известен — берём его наклон,
    // сдвиг подбираем так, чтобы якоря выполнялись
    var driftH = rest.filter(function (h) { return Math.abs(h.scale - 1) > 0.0005 && h.confidence >= 0.5; })
      .sort(function (a, b) { return b.confidence - a.confidence; })[0];
    if (driftH && pieces.length === 1 && Math.abs(pieces[0].scale - 1) <= 0.0005) {
      var sb = 0;
      used.forEach(function (h) { sb += h.fromMs - driftH.scale * (h.fromMs - h.offsetMs); });
      pieces = [{ fromMs: null, toMs: null, scale: driftH.scale, offsetMs: sb / used.length }];
    }
    // остальные гипотезы: совместимые с моделью якорей — в used, далёкие — в rejected
    rest.forEach(function (h) {
      var off = pieces[0].offsetMs;
      var tooFar = Math.abs(h.offsetMs - off) > (manual ? CONFLICT_MS : 3 * Math.sqrt(sigma(h) * sigma(h) + MIN_SIGMA * MIN_SIGMA));
      if (tooFar || (Math.abs(h.scale - 1) > 0.0005 && Math.abs(h.scale - pieces[0].scale) > 0.0005)) rejected.push(h);
      else used.push(h);
    });
  } else {
    var drift = rest.filter(function (h) { return Math.abs(h.scale - 1) > 0.0005; })
      .sort(function (a, b) { return b.confidence - a.confidence; })[0];
    var flat = rest.filter(function (h) { return Math.abs(h.scale - 1) <= 0.0005; });
    var anchor = flat.slice().sort(function (a, b) { return b.confidence / sigma(b) - a.confidence / sigma(a); })[0];
    var sw = 0, so = 0;
    flat.forEach(function (h) {
      if (anchor && compatible(anchor, h)) {
        used.push(h);
        var w = h.confidence / Math.pow(sigma(h) / 1000, 2);
        sw += w;
        so += w * h.offsetMs;
      } else rejected.push(h);
    });
    if (drift) used.push(drift);
    rest.filter(function (h) { return Math.abs(h.scale - 1) > 0.0005 && h !== drift; }).forEach(function (h) { rejected.push(h); });
    pieces = [{ fromMs: null, toMs: null, scale: drift ? drift.scale : 1, offsetMs: sw ? so / sw : drift ? drift.offsetMs : 0 }];
  }

  var conf = combined(used, true);
  // профиль соседней серии или другого релиза в одиночку не показывает субтитры (ADR 4)
  var loose = combined(used.filter(function (h) { return h.estimator !== 'profile'; }), false);
  var hasManual = used.some(function (h) { return h.estimator === 'checkpoint'; });
  var status;
  if (hasManual) status = 'verified';
  else if (structural && !anchors.length) status = 'uncertain';
  else if (conf >= VERIFIED) status = 'verified';
  else if (loose >= ESTIMATED) status = 'estimated';
  else status = used.length ? 'uncertain' : 'failed';

  if (!cls) cls = structural ? 'structural' : Math.abs(pieces[0].scale - 1) > 0.0005 ? 'drift' : 'constant';
  return types.syncModel({
    pieces: pieces,
    'class': cls,
    status: status,
    confidence: Math.round((status === 'verified' ? conf : loose) * 1000) / 1000,
    used: used,
    rejected: rejected
  });
}

module.exports = { solve: solve, VERIFIED: VERIFIED, ESTIMATED: ESTIMATED, CONFLICT_MS: CONFLICT_MS };
  },

  "engine/synchronizer": function (module, exports, require) {
/*
 * Synchronizer: конвейер для текущего видео — поиск, диагностика, модель, решение, профили.
 * Устанавливается в общий объект app (см. index.js): функции и состояние доступны как app.*.
 */
'use strict';

var crossSubs = require('../estimators/cross-subs');
var decider = require('../engine/decider');
var diagnostics = require('../engine/diagnostics');
var fpsEstimator = require('../estimators/fps');
var reference = require('../engine/reference');
var solver = require('../engine/solver');
var clientProbeLib = require('../probe/client-probe');
var subtitle = require('../analyzers/subtitle');
var time = require('../engine/time');

module.exports = function (app) {
  app.current = null;


  // ---------- сеанс текущего видео ----------
  // Поиск — при старте (бесплатно). Скачивание — только когда субтитры включены кнопкой CC,
  // и только одного файла на нужном языке; остальные варианты скачиваются при выборе в меню.
  app.session = null;


  // язык озвучки: метка дорожки («(EN) Оригинал», «Украинский», «DUB | …»), иначе язык оригинала фильма
  app.detectAudio = function detectAudio(data, card) {
    var tr = typeof data.translate === 'string' ? data.translate : '';
    var parts = [data.voice_name || '', tr, data.title || ''];
    for (var i = 0; i < parts.length; i++) {
      var t = parts[i];
      if (!t) continue;
      if (/\((en|eng)\)|\beng\b|english|англ/i.test(t)) return 'en';
      if (/\((uk|ua|ukr)\)|\bukr\b|україн|украин/i.test(t)) return 'uk';
      if (/\((ru|rus)\)|\brus\b|русск/i.test(t)) return 'ru';
      // «Субтитры», «Укр. Субтитры» у источников — оригинальная дорожка с вшитым переводом
      if (/оригинал|оригінал|original|субтитр|субтитл/i.test(t)) return app.normLang(card.original_language) || 'en';
      if (/\b(dub|mvo|avo|dvo)\b|дубл|многогол|двухгол|одногол|закадр|профессион|любительск/i.test(t)) return 'ru';
      // русские студии озвучки (украинские версии помечены «Украинский» и ловятся выше)
      if (/lostfilm|hdrezka|rezka|newstudio|tvshows|good ?people|кубик|alexfilm|jaskier|coldfilm|baibako|amedia|ideafilm|кравец|red ?head|сыендук|кураж|бомбей|novamedia|softbox|nexus|gears|anilibria|anidub|кинопоиск|пифагор|невафильм|мосфильм/i.test(t)) return 'ru';
    }
    return null;
  };

  app.fallbackLangs = function fallbackLangs() {
    return String(app.setting('langs', 'ru,uk,en')).split(',');
  };


  // порядок языков: выбранный режим (по озвучке или фиксированный), затем запасные
  app.langOrder = function langOrder(s) {
    var mode = app.setting('lang', 'audio');
    var first = mode === 'audio' ? (s && s.audio) : mode;
    var out = [];
    var add = function (l) { if (l && out.indexOf(l) < 0) out.push(l); };
    add(first);
    var fb = app.fallbackLangs();
    for (var i = 0; i < fb.length; i++) add(fb[i]);
    return out;
  };

  app.load = function load(data) {
    app.session = null;
    app.engineEvents.emit('reset', {});
    if (!app.flag('enabled', true)) return;
    if (data.iptv || data.youtube) return;

    var card = app.activeCard();
    if (!card) return app.log('нет карточки');

    var s = app.session = { data: data, card: card, audio: app.detectAudio(data, card), found: {}, searching: false, want: undefined };
    app.log('озвучка', s.audio);

    if (!app.apiKey()) {
      if (app.ccWanted()) app.notify('OpenSubtitles: укажите API-ключ в настройках плагина');
      return;
    }

    var langs = app.langOrder(s);
    if (langs.indexOf('en') < 0) langs.push('en'); // английские — эталон для автосинхронизации
    var p = app.buildQuery(card, data, langs);
    if (!p) return app.log('нет номера серии');

    s.searching = true;
    app.xhr('GET', app.API + '/subtitles?' + app.query(p), null, function (json) {
      if (app.session !== s) return;
      s.searching = false;
      s.found = app.groupFound(json.data || [], langs);
      if (app.ccWanted()) app.turnOn(s, true, s.userTap);
      app.updateButtons();
    }, function (status, json) {
      s.searching = false;
      app.log('search fail', status, json);
      app.updateButtons();
    });
  };


  // Таймлайн субтитров совпадает с видео: последняя реплика заканчивается до конца видео,
  // но не раньше чем за 18% до него (титры). Иначе — другая версия, нужна проверка по звуку.
  app.timelineOk = function timelineOk(t, done) {
    var text = app.texts[t.os_id];
    if (!text) return done(false, 'нет файла');
    var cues = app.parseCues(text);
    if (!cues.length) return done(false, 'пустой файл');
    var c = app.composed(t.os_id);
    var last = 0;
    for (var i = 0; i < cues.length; i++) last = Math.max(last, cues[i].end * c.scale + c.offset);
    app.waitDuration(function (dur) {
      if (!dur) return done(false, 'длительность видео неизвестна');
      var r = last / dur;
      var why = 'последняя реплика ' + app.fmtTime(last).slice(0, 8) + ' из ' + app.fmtTime(dur).slice(0, 8);
      app.log('таймлайн:', why, r.toFixed(3));
      done(last <= dur + 5 && r >= 0.82, why);
    });
  };


  // Автовключение: субтитры скачиваются и синхронизируются по звуку в фоне, а показываются, когда звук подтвердил время.
  app.startBackground = function startBackground(s, t) {
    s.bg = t.os_id;
    s.want = null; // Lampa по своим настройкам может включить дорожку сама — reassert её выключит
    s.waiting = Date.now();
    s.useAudio = true;
    app.selectTrack(null);
    app.log('фоновая синхронизация', t.label);
    app.audioStart();
    app.updateButtons();
    if (!app.audio) return app.finishBackground('нет звука');
    // звук так и не подключился (нет аудиодорожки, плеер не отдаёт) — не держим субтитры скрытыми
    setTimeout(function () {
      if (app.session === s && s.waiting && (!app.audio || !app.audio.analyser || !app.audio.samples.length)) app.finishBackground('звук не подключился');
    }, 20000);
  };


  // проверка по звуку завершена (или невозможна) — показываем
  app.finishBackground = function finishBackground(why) {
    var s = app.session;
    if (!s || !s.waiting) return;
    s.waiting = 0;
    var t = s.bg && app.findTrack(s.bg);
    app.log('фон завершён:', why);
    var d = app.engineDecide();
    if (t && app.ccWanted() && (why === 'ok' || d.action === 'show')) {
      app.showTrack(t);
      if (why === 'ok') app.notify('Субтитры синхронизированы по звуку и включены');
    } else if (t && app.ccWanted()) {
      s.calibrate = true;
      app.notify('Звук не подтвердил синхронизацию (' + why + '). Нажмите CC, чтобы включить субтитры, или выберите фразу в меню');
    }
    app.updateButtons();
  };

  app.turnOn = function turnOn(s, auto, immediate) {
    var langs = app.langOrder(s);
    for (var i = 0; i < langs.length; i++) {
      var src = app.sourceTrackFor([langs[i]]);
      if (src) {
        app.showTrack(src);
        return true;
      }
      var cand = s.found[langs[i]];
      if (cand && cand.length) {
        s.pending = true;
        app.updateButtons();
        app.ensureTrack(cand[0], function (t) {
          s.pending = false;
          if (app.session === s && app.ccWanted()) {
            if (!auto || immediate) {
              app.showTrack(t);
              app.maybeAutoSync(t);
            } else {
              // автовключение: файл выравнивается по английским, видео — по длительности оригинала и кадрам.
              // Что делать дальше, решает Decider: verified/estimated — показать (estimated — с меткой на CC),
              // uncertain/failed — ждать звук или предложить калибровку.
              app.maybeAutoSync(t);
              s.pending = true;
              app.updateButtons();
              app.durationSync(function () {
                s.pending = false;
                if (app.session !== s || !app.ccWanted()) return app.updateButtons();
                if (app.isMovie(s) && !s.release) app.movieTimeline(s, t);
                var d = app.engineDecide();
                app.log('решение:', d.action, 'правило', d.rule, d.reason);
                if (d.action === 'show') {
                  app.showTrack(t);
                  return app.updateButtons();
                }
                if (d.action === 'wait') {
                  app.startBackground(s, t);
                  return app.updateButtons();
                }
                s.calibrate = true;
                s.bg = t.os_id;
                app.notify('Субтитры готовы, но синхронизацию не подтвердить. Субтитры → «Синхронизировать по фразе» или нажмите CC');
                app.updateButtons();
              });
              return;
            }
          }
          app.updateButtons();
        }, function () {
          s.pending = false;
          app.updateButtons();
        });
        return true;
      }
    }
    // на нужных языках ничего — берём любые субтитры источника
    var any = app.trackList()[0];
    if (any) {
      app.showTrack(any);
      return true;
    }
    if (!auto) Lampa.Noty.show('Субтитры для этого видео не найдены');
    return false;
  };

  app.showTrack = function showTrack(track) {
    if (app.session) {
      app.session.want = track.os_id || track.label || track.index;
      app.session.waiting = 0; // показали — фоновое ожидание больше не нужно, звук продолжит доводить время
    }
    app.selectTrack(track);
    app.updateButtons();
    if (track && track.os_id) {
      var s1 = app.session;
      // звук уточняет неподтверждённую модель (у фильмов не нужен) — решает Decider
      app.durationSync(function () {
        if (!s1 || app.session !== s1) return;
        if (app.isMovie(s1) && !s1.release && !s1.timelineHyp) app.movieTimeline(s1, track);
        var d = app.engineDecide();
        if (d.listen) {
          s1.useAudio = true;
          app.audioStart();
        }
      });
    }
  };

  app.turnOff = function turnOff() {
    if (app.session) {
      app.session.want = null;
      app.session.waiting = 0;
    }
    app.selectTrack(null);
    app.updateButtons();
  };

  app.ccWanted = function ccWanted() {
    return app.flag('cc', false);
  };

  app.setCc = function setCc(v) {
    Lampa.Storage.set('opensubs_cc', v ? 'true' : 'false');
  };


  // кнопка CC: включить или выключить
  app.toggleCc = function toggleCc() {
    if (app.isShowing()) {
      app.setCc(false);
      return app.turnOff();
    }
    app.setCc(true);
    var s = app.session;
    if (s && s.searching) {
      s.userTap = true; // нажали сами — покажем сразу, как найдутся
      app.updateButtons();
      return Lampa.Noty.show('Ищу субтитры…');
    }
    if (s) {
      if (!app.turnOn(s, false)) app.setCc(false);
    } else {
      var any = app.trackList()[0];
      if (any) app.showTrack(any);
      else {
        app.setCc(false);
        Lampa.Noty.show(app.apiKey() ? 'Субтитры для этого видео не найдены' : 'OpenSubtitles: укажите API-ключ в настройках плагина');
      }
    }
    app.updateButtons();
  };


  // Lampa после загрузки видео сама выбирает дорожку по своим настройкам — возвращаем выбор пользователя
  app.reassert = function reassert() {
    var s = app.session;
    if (!s || typeof s.want === 'undefined') return;
    var subs = app.trackList();
    var on = app.isShowing();
    if (s.want === null) {
      if (on) app.selectTrack(null);
    } else {
      for (var i = 0; i < subs.length; i++) {
        var id = subs[i].os_id || subs[i].label || subs[i].index;
        if (id === s.want && on !== subs[i]) {
          app.selectTrack(subs[i]);
          break;
        }
      }
    }
    app.updateButtons();
  };


  // --- файл (профиль субтитров: файл → эталон)
  app.fileSync = function fileSync(fid) {
    var p = app.profiles.subs.get(fid);
    return { scale: p.scale, offset: p.offsetMs / 1000, known: p.known, ref: p.refRelease };
  };

  // ref — file_id эталона, к которому приведён файл: сменился эталон — пересчитываем
  app.setFileSync = function setFileSync(fid, f) {
    app.profiles.subs.set(fid, { scale: f.scale, offsetMs: f.offset * 1000, refRelease: f.ref ? String(f.ref) : undefined });
  };

  // эталон для сверки: английские под хронометраж видео — площадка сериала (networks карточки), затем ранг
  app.referenceFor = function referenceFor(s) {
    return s && s.found && reference.reference(s.found.en, null, { fps: s.vidFps, platform: reference.platformOfCard(s.card) });
  };


  // --- видео
  app.sourceBal = function sourceBal(s) {
    var bal = '';
    try {
      var last = app.store('online_last_balanser');
      bal = last[s.card.id] || '';
    } catch (e) {}
    if (!bal) {
      var m = String(s.data.url || '').match(/^https?:\/\/([^\/]+)\/(?:lite\/)?([a-z0-9_-]+)/i);
      bal = m ? m[1] + '/' + m[2] : '';
    }
    return bal;
  };


  // ключ профиля видео: фильм/серия + источник + озвучка
  app.videoKey = function videoKey(s) {
    var ep = app.episodeInfo(s.data);
    return {
      card: s.card.id,
      season: ep ? ep.season : null,
      episode: ep ? ep.episode : null,
      balancer: app.sourceBal(s),
      voice: typeof s.data.translate === 'string' ? s.data.translate : (s.data.voice_name || '')
    };
  };

  app.currentDurationMs = function currentDurationMs(s) {
    return s.probe && s.probe.durationMs ? s.probe.durationMs : null;
  };

  app.videoSync = function videoSync() {
    var s = app.session;
    if (!s) return { scale: 1, offset: 0, anchors: [] };
    if (!s.vsync) {
      var hit = app.profiles.video.lookup(app.videoKey(s), app.currentDurationMs(s));
      var c = hit && hit.record;
      s.vsyncLevel = hit ? hit.level : null;
      // профиль другого видеорелиза под тем же именем — не применяем, только гипотеза (ADR 4)
      if (c && hit.level === 'low') {
        s.lowProfile = c;
        c = null;
      }
      s.vsync = c ? { scale: c.scale, offset: c.offsetMs / 1000, pieces: c.pieces || null, anchors: c.anchors || [], manual: !!c.manual, src: c.src }
        : { scale: 1, offset: 0, anchors: [] };
    }
    return s.vsync;
  };


  // длительность видео стала известна после чтения профиля — проверить, тот ли это видеорелиз
  app.revalidateProfile = function revalidateProfile(s, videoMs) {
    var hit = app.profiles.video.lookup(app.videoKey(s), videoMs);
    if (!hit || hit.level !== 'low' || s.vsyncLevel === 'low') return;
    app.log('профиль записан для другой длительности видео — только гипотеза');
    s.lowProfile = hit.record;
    s.vsyncLevel = 'low';
    s.vsync = { scale: 1, offset: 0, anchors: [] };
  };

  app.setVideoSync = function setVideoSync(v) {
    var s = app.session;
    if (!s) return;
    s.vsync = v;
    var k = app.videoKey(s);
    if (v.scale === 1 && !v.offset && !v.anchors.length && !v.src) return app.profiles.video.remove(k);
    var dd = s.durDiff === null || typeof s.durDiff === 'undefined' ? undefined : app.round3(s.durDiff);
    app.profiles.video.set(k, { scale: v.scale, offsetMs: v.offset * 1000, pieces: v.pieces, anchors: v.anchors, manual: v.manual, src: v.src,
      durationMs: app.currentDurationMs(s), dd: dd });
    s.vsyncLevel = 'high';
  };

  app.composed = function composed(fid) {
    var f = app.fileSync(fid);
    var v = app.videoSync();
    return { scale: f.scale * v.scale, offset: f.offset * v.scale + v.offset };
  };


  // Время реплики файла → время плеера: файл → эталон (fileSync), эталон → видео (videoSync, возможно по кускам).
  app.cueFn = function cueFn(fid) {
    var f = app.fileSync(fid);
    var v = app.videoSync();
    var subsP = time.linear(f.scale, f.offset * 1000);
    var vidP = v.pieces && v.pieces.length > 1 ? v.pieces : time.linear(v.scale, v.offset * 1000);
    return function (ms) { return time.cueToPlayer(subsP, vidP, ms); };
  };


  // ---------- движок: гипотезы → модель → решение (engine/solver.js, engine/decider.js) ----------
  // Якорь: «момент o (в координатах эталона) должен показываться в t» — ручная фраза (checkpoint)
  // или проверка звуком (audio). Модель считает Solver вместе с гипотезами длительности и кадров.
  app.anchorHyps = function anchorHyps(v) {
    var out = [];
    var manualPoint = false;
    for (var i = 0; i < (v.anchors || []).length; i++) {
      var a = v.anchors[i];
      var phrase = a.k === 'phrase';
      if (phrase) manualPoint = true;
      out.push({ estimator: phrase ? 'checkpoint' : 'audio', kind: 'offset', offsetMs: Math.round((a.t - a.o) * 1000),
        fromMs: Math.round(a.t * 1000), toMs: Math.round(a.t * 1000) + 1, sigmaMs: 300, confidence: phrase ? 1 : (a.c || 0.85),
        evidence: [{ what: phrase ? 'фраза' : 'звук', value: app.round3(a.t - a.o), source: phrase ? 'пользователь' : 'audio' }] });
    }
    // ручной сдвиг из меню — тоже решение пользователя
    if (v.manual && !manualPoint) {
      var at = Math.max(1000, Math.round(app.videoTime() * 1000));
      out.push({ estimator: 'checkpoint', kind: 'offset', offsetMs: Math.round(v.offset * 1000), fromMs: at, toMs: at + 1, sigmaMs: 300, confidence: 1,
        evidence: [{ what: 'сдвиг вручную', value: v.offset, source: 'пользователь' }] });
    }
    return out;
  };

  app.engineHyps = function engineHyps(s, v) {
    var hs = [];
    if (s.release) hs = hs.concat(s.release.hypotheses);
    if (s.fpsHyp) hs.push(s.fpsHyp);
    if (s.profileHyp) hs.push(s.profileHyp);
    if (s.timelineHyp) hs.push(s.timelineHyp);
    if (s.lowProfile) {
      hs.push({ estimator: 'profile', kind: 'offset', offsetMs: Math.round(s.lowProfile.offsetMs), sigmaMs: 3000, confidence: 0.3,
        evidence: [{ what: 'профиль другого видеорелиза', value: s.lowProfile.durationMs || null, source: 'profile' }] });
    }
    return hs.concat(app.anchorHyps(v || app.videoSync()));
  };

  app.engineModel = function engineModel(v) {
    var s = app.session;
    if (!s) return null;
    var m = solver.solve(app.engineHyps(s, v), { release: s.release });
    s.model = m;
    app.engineEvents.emit('model', m);
    return m;
  };

  app.engineDecide = function engineDecide() {
    var s = app.session;
    if (!s) return decider.decide(null, {});
    var m = s.model || app.engineModel();
    var was = s.shownStatus;
    var d = decider.decide(m, { movie: app.isMovie(s), canListen: app.canListen(), release: s.release });
    s.decision = d;
    s.shownStatus = m.status;
    app.engineEvents.emit('decision', d); // кнопка CC обновится по событию
    if (was === 'estimated' && m.status === 'verified' && app.isShowing()) app.notify('Синхронизация субтитров подтверждена');
    return d;
  };

  app.fitAnchors = function fitAnchors(v) {
    if (!v.anchors.length) return v;
    var m = app.engineModel(v);
    if (m.status === 'failed') {
      var last = v.anchors[v.anchors.length - 1];
      v.offset = last.t - last.o * v.scale;
      return v;
    }
    v.scale = m.pieces[0].scale;
    v.offset = m.pieces[0].offsetMs / 1000;
    v.pieces = m.pieces.length > 1 ? m.pieces : null;
    return v;
  };


  // добавить якорь (старые рядом с ним заменяются)
  app.addAnchor = function addAnchor(o, t, kind, conf) {
    var v = app.videoSync();
    if (kind === 'phrase') v.manual = true;
    v.anchors = v.anchors.filter(function (x) { return Math.abs(x.o - o) > 90; });
    v.anchors.push({ o: app.round3(o), t: app.round3(t), k: kind, c: conf || undefined });
    if (v.anchors.length > 8) v.anchors = v.anchors.slice(-8);
    v.prior = false;
    app.setVideoSync(app.fitAnchors(v));
    if (kind === 'phrase') app.learnResidual();
    app.resyncAll();
    app.engineDecide();
    return v;
  };


  // пользователь выбрал реплику, которая звучит сейчас
  app.anchorPhrase = function anchorPhrase(track, cue, at) {
    var f = app.fileSync(track.os_id);
    var v = app.addAnchor(cue.start * f.scale + f.offset, Math.max(0, at - 0.3), 'phrase');
    return Math.abs(v.scale - 1) > 0.0005 && v.anchors.length >= 2;
  };


  // ---------- автовыравнивание файла по английским субтитрам ----------
  // Реплики одного фильма на разных языках начинаются почти в одни моменты. Перебираем пересчёты частоты кадров
  // и для каждого строим гистограмму разниц «эталон − перевод»: пик даёт сдвиг, высота пика — качество совпадения.

  // Расчёт — estimators/cross-subs.js; sync файла в секундах прототипа.
  app.cueStartsMs = function cueStartsMs(text, sync) {
    return subtitle.starts(subtitle.parse(text), sync ? time.linear(sync.scale, sync.offset * 1000) : null);
  };


  // done(result|null, reason)
  app.autoSync = function autoSync(track, done) {
    var s = app.session;
    var fid = track.os_id;
    var ref = app.referenceFor(s);
    if (!fid || !app.texts[fid]) return done(null, 'нет файла');
    if (!ref) return done(null, 'нет английских субтитров для сравнения');
    var rid = ref.files[0].file_id;
    if (rid === fid) return done(null, 'это и есть английские');

    app.download(rid, function (text) {
      if (!text) return done(null, 'не удалось скачать английские');
      app.texts[rid] = app.texts[rid] || text;
      setTimeout(function () {
        var est = crossSubs.estimate(app.cueStartsMs(text, app.fileSync(rid)), app.cueStartsMs(app.texts[fid]));
        if (!est.ok) return done(null, est.reason);
        var res = { scale: est.result.scale, offset: est.result.offsetMs / 1000, score: est.result.score, ratio: est.result.ratio };
        app.setFileSync(fid, { scale: res.scale, offset: res.offset, ref: rid });
        s.refUsed = { fid: rid, release: ref.release || '' };
        app.resyncAll();
        done(res);
      }, 30);
    }, function () {
      done(null, 'не удалось скачать английские');
    });
  };

  app.fpsName = function fpsName(scale) {
    for (var i = 0; i < app.FPS.length; i++) {
      if (app.FPS[i].scale !== 1 && Math.abs(app.FPS[i].scale - scale) < 0.0005) return app.FPS[i].title.split(' (')[0];
    }
    return '';
  };

  app.describeAuto = function describeAuto(res) {
    var parts = [];
    var f = app.fpsName(res.scale);
    if (f) parts.push('кадры ' + f);
    parts.push('сдвиг ' + (res.offset > 0 ? '+' : '') + res.offset.toFixed(1) + ' с');
    return parts.join(', ');
  };


  // при первом включении неанглийских субтитров — выровнять файл по английским (один раз на файл)
  app.maybeAutoSync = function maybeAutoSync(track) {
    if (!app.flag('autosync', true) || !track || !track.os_id || track.language === 'en') return;
    var known = app.fileSync(track.os_id);
    var ref = app.referenceFor(app.session);
    // уже выровнен по этому же эталону — не пересчитываем; эталон сменился или запись старая — пересчёт
    if (known.known && (!ref || known.ref === String(ref.files[0].file_id) || (!known.ref && known.scale === 1 && !known.offset))) return;
    app.autoSync(track, function (res, reason) {
      if (res) {
        app.log('по английским:', app.describeAuto(res), 'совпадение', res.ratio.toFixed(2));
        if (Math.abs(res.offset) > 0.3 || res.scale !== 1) app.notify('Субтитры выровнены: ' + app.describeAuto(res));
      } else {
        app.log('по английским не удалось:', reason);
        app.setFileSync(track.os_id, { scale: 1, offset: 0, ref: ref ? ref.files[0].file_id : null }); // не пробовать снова
      }
    });
  };


  // ---------- длительность оригинала у источников Lampac ----------
  // Работа с Lampac — api/lampac.js, плейлисты — probe/hls.js, вывод — engine/diagnostics.js.
  app.odurGet = function odurGet(key) {
    var c = app.store('opensubs_odur')[key];
    if (!c) return null;
    return { durationMs: c.ms || (c.d ? Math.round(c.d * 1000) : 0) };
  };

  app.odurSet = function odurSet(key, v) {
    var all = app.store('opensubs_odur');
    all[key] = { ms: v.durationMs, t: Date.now() };
    app.storeSave('opensubs_odur', all, 300);
  };

  app.lampacCtx = function lampacCtx(s) {
    var bal = '';
    try { bal = app.store('online_last_balanser')[s.card.id] || ''; } catch (e) {}
    var voice = typeof s.data.translate === 'string' ? s.data.translate : (s.data.voice_name || '');
    return { url: s.data.url, card: s.card, episode: app.episodeInfo(s.data), balancer: bal, voice: voice };
  };

  app.platformKey = function platformKey(s) {
    var info = app.lampacApi.info(app.lampacCtx(s));
    return info ? { card: s.card.id, balancer: info.bal } : null;
  };


  // отбивка площадки, выученная на другой серии этого сериала у этого источника (секунды) — только гипотеза
  app.residual = function residual(s) {
    var k = app.platformKey(s);
    var ms = k && app.profiles.platform.get(k);
    return typeof ms === 'number' ? ms / 1000 : null;
  };


  // пользователь поправил вручную при известной заставке озвучки → остаток = заставка площадки
  app.learnResidual = function learnResidual() {
    var s = app.session;
    if (!s || s.durDiff === null || typeof s.durDiff === 'undefined') return;
    var v = app.videoSync();
    if (Math.abs(v.scale - 1) > 0.0005) return;
    var k = app.platformKey(s);
    if (!k) return;
    var o = app.round3(v.offset - s.durDiff);
    if (Math.abs(o) > 60) return;
    app.profiles.platform.set(k, o * 1000);
    app.log('заставка площадки для сериала:', o);
  };

  app.waitDuration = function waitDuration(done) {
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
  };


  // done(ok): поправка под это видео посчитана (по длительности оригинала)
  app.durationSync = function durationSync(done) {
    var s = app.session;
    if (!s) return done && done(false);
    if (s.durDone === 'finished') return done && done(!!s.durOk);
    (s.durWait = s.durWait || []).push(done || function () {});
    if (s.durDone) return;
    s.durDone = true;
    var finishD = function (ok) {
      s.durOk = ok;
      s.durDone = 'finished';
      var w = s.durWait || [];
      s.durWait = [];
      for (var i = 0; i < w.length; i++) try { w[i](ok); } catch (e) { app.log('error', e); }
    };
    if (!app.flag('durationsync', true)) return finishD(false);


    var applyFpsOnly = function (why) {
      if (s.palScale && s.palScale !== 1 && !app.videoSync().manual) {
        app.setVideoSync({ scale: s.palScale, offset: 0, anchors: [], src: 'fps' });
        app.resyncAll();
        s.durStatus = why + '; частота кадров: ×' + s.palScale.toFixed(4);
        app.notify('Субтитры подстроены под частоту кадров видео');
      }
    };

    var runDuration = function () {
    app.lampacApi.originals(app.lampacCtx(s), function (origs, reason) {
      s.originals = origs;
      s.originalsWhy = reason;
      if (app.session !== s) return;
      if (!origs.length) {
        s.durStatus = 'не удалось: ' + reason;
        app.log('длительность оригинала:', reason);
        applyFpsOnly(s.durStatus);
        if (app.isMovie(s)) app.movieTimeline(s);
        return finishD(false);
      }
      var withVideo = function (videoMs, exact) {
        if (app.session !== s) return;
        app.revalidateProfile(s, videoMs);
        var rel = diagnostics.diagnose({ videoMs: videoMs, exact: exact, originals: origs, siblings: s.siblings || [] });
        // совпадает с оригиналом только одного источника — второй источник ищем среди других озвучек (правило 2)
        if (rel.cls === 'same' && rel.agree < 2 && !s.siblingsTried) {
          s.siblingsTried = true;
          return app.lampacApi.siblings(app.lampacCtx(s), 3, function (list) {
            s.siblings = list;
            if (list.length) app.log('другие озвучки:', list.map(function (x) { return x.voice + ' ' + (x.durationMs / 1000).toFixed(2); }).join(', '));
            withVideo(videoMs, exact);
          });
        }
        s.release = rel;
        s.durStatus = rel.text;
        app.log('длительность: видео', (videoMs / 1000).toFixed(2) + (exact ? '' : ' (video.duration)'), 'оригиналы',
          origs.map(function (o) { return o.source + ' ' + (o.durationMs / 1000).toFixed(2); }).join(', '), '→', rel.cls);
        s.durDiff = rel.cls === 'insertion' ? rel.deltaMs / 1000 : rel.cls === 'same' || rel.cls === 'near' ? 0 : null;
        // заставка площадки, выученная на другой серии этого сериала, — только гипотеза с низким доверием (ADR 4)
        var res = app.residual(s);
        s.profileHyp = res !== null && s.durDiff !== null ? { estimator: 'profile', kind: 'offset', offsetMs: Math.round((s.durDiff + res) * 1000),
          sigmaMs: 3000, confidence: 0.3, evidence: [{ what: 'как в другой серии этого источника', value: res, source: 'profile' }] } : null;
        var old = app.videoSync();
        if (old.manual) {
          app.learnResidual(); // ручная поправка этой серии уже есть — узнаём из неё заставку площадки
          app.engineModel();
          return finishD(true);
        }
        var m = app.engineModel({ anchors: old.anchors || [] });
        app.log('модель:', m.status, m['class'], (m.pieces[0].offsetMs / 1000).toFixed(2) + ' с', '×' + m.pieces[0].scale.toFixed(4),
          'уверенность', m.confidence);
        if (m.status === 'failed' || m.status === 'uncertain') {
          applyFpsOnly(s.durStatus);
          return finishD(false);
        }
        var v = { scale: m.pieces[0].scale, offset: m.pieces[0].offsetMs / 1000, pieces: m.pieces.length > 1 ? m.pieces : null,
          anchors: old.anchors || [], src: 'duration' };
        if (s.palScale && s.palScale !== 1) s.durStatus += '; частота кадров субтитров: ×' + s.palScale.toFixed(4);
        app.setVideoSync(v);
        app.resyncAll();
        if (Math.abs(v.offset - (old.offset || 0)) >= 0.5 || v.scale !== (old.scale || 1)) {
          app.notify((m.status === 'verified' ? 'Субтитры подстроены под озвучку: ' : 'Субтитры подстроены предварительно: ') + s.durStatus);
        }
        finishD(true);
      };
      if (s.probe && s.probe.durationMs && s.probe.exact) return withVideo(s.probe.durationMs, true);
      app.waitDuration(function (cur) {
        if (app.session !== s) return;
        if (!cur) {
          s.durStatus = 'не удалось узнать длительность видео';
          applyFpsOnly(s.durStatus);
          return finishD(false);
        }
        withVideo(Math.round(cur * 1000), false);
      });
    });
    };

    // характеристики видео (длительность по плейлисту, заявленный FPS), затем длительность оригинала
    var playerVideo = null;
    try { playerVideo = Lampa.PlayerVideo.video(); } catch (e) {}
    app.videoProbe.probe({ url: s.data.url, video: playerVideo }, function (info) {
      if (app.session !== s) return;
      s.probe = info;
      var vf = info.fps.declared || 0;
      if (info.source === 'ffprobe' && info.fps.measured) s.fpsMeasured = info.fps.measured; // сервер уже посчитал кадры
      if (info.vfr) app.log('видео с переменной частотой кадров (VFR)');
      s.vidFps = vf;
      // эталон — английские того же релиза (ReferenceSelector); если их нет — сам файл показываемых субтитров
      var bgT = s.bg && app.findTrack(s.bg);
      var shownT = bgT || app.isShowing();
      var ref = app.referenceFor(s);
      var refFps = (ref && parseFloat(ref.fps)) || (bgT && bgT.os_fps) || 0;
      s.refFps = refFps;
      var fe = fpsEstimator.estimate({ subsFps: refFps, videoFpsDeclared: vf, videoFpsMeasured: s.fpsMeasured });
      s.palScale = fe.scale;
      s.fpsHyp = fe.hypothesis;
      if (s.palScale !== 1) app.log('кадры: субтитры', refFps, 'видео', vf, '→ ×' + s.palScale.toFixed(4));
      runDuration();
      app.measureVideoFps(s, 0);
    });
  };

  // Отчёт для приёмки (меню «Синхронизация» → «Отчёт»): всё, на чём основано решение, без консоли
  app.syncReport = function syncReport() {
    var s = app.session;
    if (!s) return [{ title: 'Видео не запущено' }];
    var sec = function (ms) { return (ms / 1000).toFixed(2) + ' с'; };
    var key = app.videoKey(s);
    var out = [];
    out.push({ title: 'Источник и озвучка', subtitle: (key.balancer || '—') + ' · ' + (key.voice || '—') + (key.season ? ' · S' + key.season + 'E' + key.episode : ' · фильм') });
    var shownTr = app.isShowing() || (s.bg && app.findTrack(s.bg));
    if (shownTr && shownTr.os_id) {
      var fsr = app.fileSync(shownTr.os_id);
      out.push({ title: 'Субтитры', subtitle: shownTr.os_id + ' · ' + ((shownTr.os_attrs && shownTr.os_attrs.release) || shownTr.label || '') });
      out.push({ title: 'Эталон для сверки', subtitle: s.refUsed ? s.refUsed.fid + ' · ' + s.refUsed.release : (fsr.ref ? 'file ' + fsr.ref : 'не использовался') +
        ' · файл → эталон ' + (fsr.offset >= 0 ? '+' : '') + fsr.offset.toFixed(2) + ' с ×' + fsr.scale.toFixed(4) });
    }
    out.push({ title: 'Длительность видео', subtitle: s.probe && s.probe.durationMs ? sec(s.probe.durationMs) + (s.probe.exact ? ' (плейлист)' : ' (плеер)') + ' · ' + s.probe.source : 'неизвестна' });
    out.push({ title: 'Частота кадров', subtitle: 'метка ' + (s.vidFps || '—') + ', замер ' + (s.fpsMeasured ? s.fpsMeasured.toFixed(2) : '—') + ', субтитры ' + (s.refFps || '—') });
    out.push({ title: 'Оригиналы', subtitle: (s.originals || []).map(function (o) { return o.source + ' ' + sec(o.durationMs); }).join(', ') || (s.originalsWhy || 'не найдены') });
    if (s.siblings && s.siblings.length) out.push({ title: 'Другие озвучки', subtitle: s.siblings.map(function (x) { return x.voice + ' ' + sec(x.durationMs); }).join(', ') });
    out.push({ title: 'Диагностика релиза', subtitle: s.release ? s.release.cls + ': ' + s.release.text : (s.durStatus || '—') });
    var m = s.model;
    if (m) {
      out.push({ title: 'Модель: ' + m.status + ' · ' + m['class'], subtitle: 'сдвиг ' + (m.pieces[0].offsetMs >= 0 ? '+' : '') + sec(m.pieces[0].offsetMs) +
        ', ×' + m.pieces[0].scale.toFixed(4) + (m.pieces.length > 1 ? ', кусков ' + m.pieces.length : '') + ', уверенность ' + m.confidence });
      m.used.forEach(function (h) {
        out.push({ title: '✓ ' + h.estimator + ' · ' + h.kind, subtitle: (h.offsetMs >= 0 ? '+' : '') + sec(h.offsetMs) + ' ±' + sec(h.sigmaMs) + ', ' + h.confidence +
          (h.evidence.length ? ' · ' + h.evidence.map(function (e) { return e.what + ' ' + e.value; }).join('; ').slice(0, 120) : '') });
      });
      m.rejected.forEach(function (h) {
        out.push({ title: '✗ ' + h.estimator + ' · ' + h.kind + ' (отброшено)', subtitle: (h.offsetMs >= 0 ? '+' : '') + sec(h.offsetMs) + ', ' + h.confidence });
      });
    }
    if (s.decision) out.push({ title: 'Решение: ' + s.decision.action + ' (правило ' + s.decision.rule + ')', subtitle: s.decision.reason });
    var v = app.videoSync();
    out.push({ title: 'Применено к видео', subtitle: (v.offset >= 0 ? '+' : '') + v.offset.toFixed(2) + ' с, ×' + v.scale.toFixed(4) + (v.manual ? ', вручную' : '') +
      (s.vsyncLevel ? ', профиль: ' + s.vsyncLevel : ', профиль новый') + (v.anchors && v.anchors.length ? ', точек ' + v.anchors.length : '') });
    out.push({ title: 'Звук', subtitle: app.audioDenied ? 'не работает: ' + app.audioDenied : app.audio ? app.audio.status +
      (app.audio.wide ? '; широкий поиск: ' + (app.audio.wide.offsetMs / 1000).toFixed(1) + ' с (z ' + app.audio.wide.z.toFixed(1) + ')' : '') : 'не запускался' });
    return out;
  };

  // Фильм без оригинала (правило 4): укладываются ли реплики в длительность видео — слабая гипотеза
  app.movieTimeline = function movieTimeline(s, track) {
    var t = track || (s.bg && app.findTrack(s.bg)) || app.isShowing();
    if (!t || !t.os_id || !app.texts[t.os_id]) return;
    var videoMs = s.probe && s.probe.durationMs;
    if (!videoMs) {
      try { videoMs = Math.round(Lampa.PlayerVideo.video().duration * 1000) || null; } catch (e) {}
    }
    var fn = app.cueFn(t.os_id);
    var cues = subtitle.parse(app.texts[t.os_id]).map(function (c) { return { startMs: fn(c.startMs), endMs: fn(c.endMs) }; });
    s.timelineHyp = reference.timeline(cues, videoMs);
    if (s.timelineHyp) app.log('фильм: реплики укладываются в видео,', s.timelineHyp.evidence[0].value);
    app.engineModel();
  };

  // Второй признак частоты кадров (правило 5): замер по кадрам воспроизведения. Метка плейлиста и замер вместе
  // дают пересчёт с уверенностью 0.8; если замер спорит с меткой — пересчёт не предлагается.
  app.measureVideoFps = function measureVideoFps(s, tries) {
    if (app.session !== s || tries > 6 || !s.refFps || s.fpsMeasured) return;
    var v = null;
    try { v = Lampa.PlayerVideo.video(); } catch (e) {}
    var retry = function () { setTimeout(function () { app.measureVideoFps(s, tries + 1); }, 10000); };
    if (!v || v.paused || v.readyState < 2) return retry();
    clientProbeLib.measureFps(v, function (fps) {
      if (app.session !== s) return;
      if (!fps) return retry();
      s.fpsMeasured = fps;
      var fe = fpsEstimator.estimate({ subsFps: s.refFps, videoFpsDeclared: s.vidFps, videoFpsMeasured: fps });
      var before = s.fpsHyp ? s.fpsHyp.confidence + '|' + s.fpsHyp.scale : 'none';
      var after = fe.hypothesis ? fe.hypothesis.confidence + '|' + fe.hypothesis.scale : 'none';
      app.log('кадры: замер', fps.toFixed(2), 'к/с, метка', s.vidFps || '—', '→', fe.reason);
      if (before === after) return;
      s.palScale = fe.scale;
      s.fpsHyp = fe.hypothesis;
      var old = app.videoSync();
      if (old.manual) return;
      var m = app.engineModel({ anchors: old.anchors || [] });
      if (m.status === 'failed' || m.status === 'uncertain') return app.engineDecide();
      if (Math.abs(m.pieces[0].scale - old.scale) > 0.0005 || Math.abs(m.pieces[0].offsetMs / 1000 - old.offset) >= 0.3) {
        app.setVideoSync({ scale: m.pieces[0].scale, offset: m.pieces[0].offsetMs / 1000, pieces: m.pieces.length > 1 ? m.pieces : null,
          anchors: old.anchors || [], src: old.src || 'fps' });
        app.resyncAll();
      }
      app.engineDecide();
    });
  };
};
  },

  "engine/time": function (module, exports, require) {
/*
 * Единая шкала времени движка (ADR 6).
 *
 * Внутри движка все времена — целые миллисекунды шкалы воспроизведения плеера.
 * Другие шкалы переводятся только функциями этого модуля:
 *   - субтитры:  время реплики в файле субтитров (cueMs);
 *   - эталон:    время эталонного релиза, к которому приведены субтитры (refMs);
 *   - плеер:     currentTime видео * 1000 (playerMs);
 *   - потоки:    PTS потока = playerMs + stream.startMs (известно только из FFProbe).
 *
 * Модель — список кусков { fromMs, toMs, scale, offsetMs }: out = in * scale + offsetMs.
 * fromMs/toMs задаются во входной шкале куска; null — без границы.
 * Это ES5: файл попадает в бандл для старых ТВ-браузеров.
 */
'use strict';

// Кадровые частоты. «23.976» на самом деле 24000/1001.
var FPS = {
  FILM: 24000 / 1001,
  CINEMA: 24,
  PAL: 25,
  NTSC: 30000 / 1001
};

function toMs(sec) {
  return Math.round(sec * 1000);
}

function toSec(ms) {
  return ms / 1000;
}

// '01:02:03.456', '02:03,456', '02:03.4' → мс; иначе NaN.
function parseClock(str) {
  var m = /^\s*(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?\s*$/.exec(String(str));
  if (!m) return NaN;
  var frac = m[4] ? Number((m[4] + '00').slice(0, 3)) : 0;
  return ((Number(m[1] || 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + frac;
}

function pad(n, w) {
  var s = String(n);
  while (s.length < w) s = '0' + s;
  return s;
}

// мс → 'HH:MM:SS.mmm' (формат WebVTT). Отрицательное время обрезается до нуля.
function formatClock(ms) {
  ms = Math.max(0, Math.round(ms));
  var h = Math.floor(ms / 3600000);
  var m = Math.floor(ms / 60000) % 60;
  var s = Math.floor(ms / 1000) % 60;
  return pad(h, 2) + ':' + pad(m, 2) + ':' + pad(s, 2) + '.' + pad(ms % 1000, 3);
}

// Отношение частот для пересчёта таймингов: субтитры под fromFps → видео с toFps.
// Пример: субтитры под 25 к/с на видео 23.976 → scale = 25 / 23.976 ≈ 1.0427.
function fpsRatio(fromFps, toFps) {
  return fromFps / toFps;
}

function identity() {
  return [{ fromMs: null, toMs: null, scale: 1, offsetMs: 0 }];
}

function constant(offsetMs) {
  return [{ fromMs: null, toMs: null, scale: 1, offsetMs: Math.round(offsetMs) }];
}

function linear(scale, offsetMs) {
  return [{ fromMs: null, toMs: null, scale: scale, offsetMs: Math.round(offsetMs) }];
}

function covers(piece, ms) {
  return (piece.fromMs === null || piece.fromMs === undefined || ms >= piece.fromMs) &&
    (piece.toMs === null || piece.toMs === undefined || ms < piece.toMs);
}

// Кусок для времени ms; вне всех кусков — ближайший по границе.
function pieceFor(pieces, ms) {
  var best = null;
  var bestDist = Infinity;
  for (var i = 0; i < pieces.length; i++) {
    var p = pieces[i];
    if (covers(p, ms)) return p;
    var d = p.fromMs !== null && p.fromMs !== undefined && ms < p.fromMs ? p.fromMs - ms :
      p.toMs !== null && p.toMs !== undefined && ms >= p.toMs ? ms - p.toMs : Infinity;
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return best;
}

function apply(pieces, ms) {
  if (!pieces || !pieces.length) return Math.round(ms);
  var p = pieceFor(pieces, ms);
  return Math.round(ms * p.scale + p.offsetMs);
}

// Субтитры → эталон → плеер. subs и video — списки кусков.
function cueToPlayer(subs, video, cueMs) {
  return apply(video, apply(subs, cueMs));
}

// Перевод времени плеера во время потока (ADR 6: только явно).
function playerToStream(playerMs, stream) {
  return playerMs + (stream && stream.startMs ? stream.startMs : 0);
}

function streamToPlayer(streamMs, stream) {
  return streamMs - (stream && stream.startMs ? stream.startMs : 0);
}

module.exports = {
  FPS: FPS,
  toMs: toMs,
  toSec: toSec,
  parseClock: parseClock,
  formatClock: formatClock,
  fpsRatio: fpsRatio,
  identity: identity,
  constant: constant,
  linear: linear,
  pieceFor: pieceFor,
  apply: apply,
  cueToPlayer: cueToPlayer,
  playerToStream: playerToStream,
  streamToPlayer: streamToPlayer
};
  },

  "engine/types": function (module, exports, require) {
/*
 * Типы обмена между модулями движка: ProbeInfo, Hypothesis, SyncModel, SubsProfile, VideoProfile.
 * Фабрики нормализуют поля и бросают TypeError на неверных данных, чтобы ошибка оценщика
 * не дошла до плеера. Все времена — целые мс шкалы плеера (ADR 6), см. engine/time.js.
 */
'use strict';

var ESTIMATORS = ['duration', 'openingInsertion', 'fps', 'crossSubs', 'audio', 'checkpoint', 'profile', 'timeline'];

var KINDS = [
  'duration_delta',
  'opening_insertion_candidate',
  'opening_insertion_confirmed',
  'offset',
  'drift',
  'piece'
];

// ADR 7. Порядок — от сильного к слабому.
var STATUS = ['verified', 'estimated', 'uncertain', 'failed'];

var CLASSES = ['constant', 'drift', 'local', 'structural'];

var PROBE_SOURCES = ['client', 'ffprobe', 'unknown'];

function oneOf(list, value, field) {
  for (var i = 0; i < list.length; i++) if (list[i] === value) return value;
  throw new TypeError(field + ': ' + value + ' не из [' + list.join(', ') + ']');
}

function num(value, field, def) {
  if (value === undefined || value === null) {
    if (def !== undefined) return def;
    throw new TypeError(field + ': нет значения');
  }
  if (typeof value !== 'number' || !isFinite(value)) throw new TypeError(field + ': не число');
  return value;
}

function optMs(value, field) {
  return value === undefined || value === null ? null : Math.round(num(value, field));
}

function unit(value, field) {
  var v = num(value, field);
  if (v < 0 || v > 1) throw new TypeError(field + ': вне 0..1');
  return v;
}

function evidenceList(list) {
  if (!list) return [];
  if (!(list instanceof Array)) throw new TypeError('evidence: не массив');
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var e = list[i] || {};
    if (!e.what) throw new TypeError('evidence[' + i + '].what: нет значения');
    out.push({ what: String(e.what), value: e.value === undefined ? null : e.value, source: e.source ? String(e.source) : null });
  }
  return out;
}

function probeInfo(o) {
  o = o || {};
  var fps = o.fps || {};
  var streams = o.streams || [];
  var out = {
    source: oneOf(PROBE_SOURCES, o.source || 'unknown', 'source'),
    durationMs: optMs(o.durationMs, 'durationMs'),
    exact: !!o.exact,
    fps: {
      declared: fps.declared === undefined || fps.declared === null ? null : num(fps.declared, 'fps.declared'),
      measured: fps.measured === undefined || fps.measured === null ? null : num(fps.measured, 'fps.measured')
    },
    vfr: o.vfr === true || o.vfr === false ? o.vfr : null,
    streams: []
  };
  for (var i = 0; i < streams.length; i++) {
    var s = streams[i] || {};
    out.streams.push({
      kind: oneOf(['video', 'audio'], s.kind, 'streams[' + i + '].kind'),
      startMs: optMs(s.startMs, 'streams[' + i + '].startMs') || 0,
      durationMs: optMs(s.durationMs, 'streams[' + i + '].durationMs'),
      timeBase: s.timeBase ? String(s.timeBase) : null
    });
  }
  return out;
}

function hypothesis(o) {
  o = o || {};
  var h = {
    estimator: oneOf(ESTIMATORS, o.estimator, 'estimator'),
    kind: oneOf(KINDS, o.kind, 'kind'),
    offsetMs: Math.round(num(o.offsetMs, 'offsetMs')),
    scale: num(o.scale, 'scale', 1),
    fromMs: optMs(o.fromMs, 'fromMs'),
    toMs: optMs(o.toMs, 'toMs'),
    sigmaMs: Math.round(num(o.sigmaMs, 'sigmaMs')),
    confidence: unit(o.confidence, 'confidence'),
    evidence: evidenceList(o.evidence)
  };
  if (h.scale <= 0) throw new TypeError('scale: должен быть > 0');
  if (h.sigmaMs < 0) throw new TypeError('sigmaMs: отрицательный');
  if (h.fromMs !== null && h.toMs !== null && h.fromMs >= h.toMs) throw new TypeError('fromMs >= toMs');
  return h;
}

function piece(o) {
  o = o || {};
  var p = {
    fromMs: optMs(o.fromMs, 'fromMs'),
    toMs: optMs(o.toMs, 'toMs'),
    scale: num(o.scale, 'scale', 1),
    offsetMs: Math.round(num(o.offsetMs, 'offsetMs', 0))
  };
  if (p.scale <= 0) throw new TypeError('scale: должен быть > 0');
  return p;
}

function syncModel(o) {
  o = o || {};
  var pieces = o.pieces && o.pieces.length ? o.pieces : [{}];
  var out = {
    pieces: [],
    'class': oneOf(CLASSES, o['class'] || 'constant', 'class'),
    status: oneOf(STATUS, o.status || 'failed', 'status'),
    confidence: unit(o.confidence === undefined ? 0 : o.confidence, 'confidence'),
    used: (o.used || []).map(hypothesis),
    rejected: (o.rejected || []).map(hypothesis)
  };
  for (var i = 0; i < pieces.length; i++) out.pieces.push(piece(pieces[i]));
  return out;
}

function subsProfile(o) {
  o = o || {};
  if (o.fileId === undefined || o.fileId === null) throw new TypeError('fileId: нет значения');
  return {
    fileId: String(o.fileId),
    refRelease: o.refRelease ? String(o.refRelease) : null,
    scale: num(o.scale, 'scale', 1),
    offsetMs: Math.round(num(o.offsetMs, 'offsetMs', 0))
  };
}

function videoProfile(o) {
  o = o || {};
  var k = o.key || {};
  if (!k.card) throw new TypeError('key.card: нет значения');
  var cps = o.checkpoints || [];
  var out = {
    key: {
      card: String(k.card),
      season: k.season === undefined || k.season === null ? null : Number(k.season),
      episode: k.episode === undefined || k.episode === null ? null : Number(k.episode),
      balancer: k.balancer ? String(k.balancer) : null,
      voice: k.voice ? String(k.voice) : null,
      durationMs: optMs(k.durationMs, 'key.durationMs')
    },
    model: syncModel(o.model),
    checkpoints: [],
    updated: num(o.updated, 'updated', 0)
  };
  for (var i = 0; i < cps.length; i++) {
    out.checkpoints.push({
      playerMs: Math.round(num(cps[i].playerMs, 'checkpoints[' + i + '].playerMs')),
      refMs: Math.round(num(cps[i].refMs, 'checkpoints[' + i + '].refMs'))
    });
  }
  return out;
}

// Строковый ключ профиля видео: одна серия одного источника и озвучки одной длительности.
function videoKeyString(key) {
  return [key.card, key.season === null ? '' : key.season, key.episode === null ? '' : key.episode,
    key.balancer || '', key.voice || '', key.durationMs === null ? '' : key.durationMs].join('|');
}

module.exports = {
  ESTIMATORS: ESTIMATORS,
  KINDS: KINDS,
  STATUS: STATUS,
  CLASSES: CLASSES,
  PROBE_SOURCES: PROBE_SOURCES,
  probeInfo: probeInfo,
  hypothesis: hypothesis,
  piece: piece,
  syncModel: syncModel,
  subsProfile: subsProfile,
  videoProfile: videoProfile,
  videoKeyString: videoKeyString
};
  },

  "estimators/audio": function (module, exports, require) {
/*
 * Оценщик audio (этап 4, фон): совпадение речи в звуке видео с интервалами показа реплик.
 *
 * Признаки кадра (каждые 100 мс, analyzers в прототипе через AnalyserNode):
 *   e — логарифм энергии полосы речи 300–3400 Гц, f — спектральный поток (всплески новых звуков).
 * evaluate({ samples, cues, dmaxSec, stepSec, winSec, minSec }) → результат или null:
 *   samples: [{ t, e, f, s }] — t секунды плеера, s — номер непрерывного отрезка (перемотка = новый);
 *   cues:    [{ start, end }] — интервалы показа реплик в секундах плеера по текущей модели;
 *   поиск сдвига в ±dmaxSec: при показанных субтитрах ±15 с (уточнение), без модели шире.
 *   → { shift, z1, z2, edge, tStart, tEnd, confident } — shift > 0: субтитры надо показывать позже.
 * hypothesis(result, baseOffsetMs) → Hypothesis (estimator 'audio') с местом проверки.
 */
'use strict';

var types = require('../engine/types');

var STEP = 0.1;
var WIN = 480;   // секунд звука в одной проверке (на реальных сериалах 3 минут мало)
var MIN = 240;
// Пороги откалиброваны на фикстурах (ADR 2, 8): GoT S1E1, 10 файлов субтитров × оригинал/дубляж —
// верный сдвиг +1.8…+3.0 с во всех 40 прогонах, z 2.8–4.9; чужие субтитры (48 прогонов на окно):
// z не выше 3.34 при поиске ±15 с и не выше 4.22 при ±90 с, у второго пика доля ≥ 0.57.
var STRONG = { narrowZ: 3.6, wideZ: 4.0, ratio: 0.6 }; // сам по себе подтверждает (правило 7)

// Признаки одного кадра из спектра в дБ (getFloatFrequencyData). prev — спектр прошлого кадра (меняется).
function frameFeatures(freqDb, hzPerBin, prev) {
  var speech = 0, flux = 0;
  for (var i = 1; i < freqDb.length; i++) {
    var f = i * hzPerBin;
    if (f < 300 || f > 3400) continue;
    var db = freqDb[i] > -200 ? freqDb[i] : -200;
    speech += Math.pow(10, db / 10);
    if (db > prev[i]) flux += db - prev[i];
    prev[i] = db;
  }
  return { e: Math.log(speech + 1e-12), f: flux };
}

function zscore(arr) {
  var n = arr.length, mu = 0, sq = 0, i;
  for (i = 0; i < n; i++) mu += arr[i];
  mu /= n;
  for (i = 0; i < n; i++) sq += (arr[i] - mu) * (arr[i] - mu);
  var sd = Math.sqrt(sq / n) || 1;
  for (i = 0; i < n; i++) arr[i] = (arr[i] - mu) / sd;
  return arr;
}

// Порог уверенности при узком поиске ниже: меньше вариантов — меньше случайных пиков.
function needZ(dmax) {
  return dmax <= 12 ? 3.3 : dmax <= 20 ? 3.6 : 4.0;
}

function evaluate(o) {
  var step = o.stepSec || STEP;
  var win = o.winSec || WIN;
  var min = o.minSec || MIN;
  var dmax = o.dmaxSec || 15;
  var all = o.samples || [];
  if (all.length < 2) return null;
  var seg = all[all.length - 1].s;
  var pts = all.filter(function (x) { return x.s === seg; });
  if (pts.length < 2) return null;
  var tEnd = pts[pts.length - 1].t;
  var tStart = Math.max(pts[0].t, tEnd - win);
  if (tEnd - tStart < min) return null;
  pts = pts.filter(function (x) { return x.t >= tStart; });

  var n = Math.floor((tEnd - tStart) / step);
  var ge = new Float32Array(n), gf = new Float32Array(n);
  var k = 0, i;
  for (i = 0; i < n; i++) {
    var tt = tStart + i * step;
    while (k < pts.length - 1 && pts[k + 1].t <= tt) k++;
    ge[i] = pts[k].e;
    gf[i] = pts[k].f || 0;
  }
  // энергия относительно фона ближайших ±3 с (минус скользящая медиана): музыка и шум уходят, речь остаётся
  var rel = new Float32Array(n);
  var w = [];
  for (i = 0; i < n; i++) {
    w.length = 0;
    for (var j = Math.max(0, i - 30); j <= Math.min(n - 1, i + 30); j++) w.push(ge[j]);
    w.sort(function (x, y) { return x - y; });
    rel[i] = ge[i] - w[w.length >> 1];
  }
  zscore(rel);
  zscore(gf);
  var g = new Float32Array(n);
  for (i = 0; i < n; i++) g[i] = rel[i] + gf[i];

  var D = Math.round(dmax / step);
  var len = n + 2 * D;
  var ind = new Float32Array(len);
  var base = tStart - dmax;
  var cues = o.cues || [];
  for (var q = 0; q < cues.length; q++) {
    var c0 = cues[q].start, c1 = cues[q].end;
    if (c1 < base || c0 > base + len * step) continue;
    var i0 = Math.max(0, Math.round((c0 - base) / step)), i1 = Math.min(len, Math.round((c1 - base) / step));
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
  for (var v = 0; v < scores.length; v++) if (Math.abs(v - D - bestD) > 20) second = Math.max(second, scores[v]);
  var z2 = (second - sm) / sd;
  var shift = bestD * step;
  var edge = Math.abs(shift) >= dmax - 2; // пик на краю диапазона поиска — почти наверняка ложный
  var need = needZ(dmax);
  var strong = !edge && z2 <= z1 * STRONG.ratio && z1 >= (dmax <= 20 ? STRONG.narrowZ : STRONG.wideZ);
  return {
    shift: Math.round(shift * 10) / 10, z1: z1, z2: z2, edge: edge, tStart: tStart, tEnd: tEnd, need: need,
    confident: strong || (!edge && z1 >= need && z2 <= z1 * 0.7), strong: strong
  };
}

// Узкий поиск (±15 с вокруг показанной модели) не видит сдвиг за пределами окна и может принять случайный пик
// (приёмка 10.11: GoT 3×3 Кравец, звук «+7.6 с» при настоящем −89 с). Поэтому тот же звук проверяется и
// широким поиском ±120 с: если там уверенный пик в другом месте, узкий результат не принимается,
// а широкий отдаётся как отдельная гипотеза (contradicted).
function evaluateGuarded(o) {
  var narrow = evaluate(o);
  if (!narrow || (o.dmaxSec || 15) > 20) return narrow;
  var wideOpts = {};
  for (var k in o) wideOpts[k] = o[k];
  wideOpts.dmaxSec = 120;
  var wide = evaluate(wideOpts);
  if (wide && wide.confident && Math.abs(wide.shift - narrow.shift) > 2) {
    narrow.confident = false;
    narrow.strong = false;
    narrow.contradicted = wide;
  }
  return narrow;
}

// Сдвиг модели после проверки: прежний сдвиг + найденная поправка, в центре окна.
function hypothesis(res, baseOffsetMs) {
  var at = Math.round((res.tStart + res.tEnd) / 2 * 1000);
  return types.hypothesis({
    estimator: 'audio',
    kind: 'offset',
    offsetMs: Math.round(baseOffsetMs + res.shift * 1000),
    fromMs: at,
    toMs: at + 1,
    sigmaMs: 300,
    confidence: res.strong ? 0.85 : 0.6,
    evidence: [
      { what: 'совпадение речи и реплик, z', value: Math.round(res.z1 * 10) / 10, source: 'audio' },
      { what: 'прослушано, с', value: Math.round(res.tEnd - res.tStart), source: 'audio' }
    ]
  });
}

module.exports = { evaluateGuarded: evaluateGuarded, STEP: STEP, WIN: WIN, MIN: MIN, STRONG: STRONG, frameFeatures: frameFeatures, evaluate: evaluate, hypothesis: hypothesis, needZ: needZ };
  },

  "estimators/cross-subs": function (module, exports, require) {
/*
 * Оценщик crossSubs: приводит файл субтитров к эталонному (обычно английские того же релиза или того,
 * что показывает видео). Реплики одного фильма на разных языках начинаются почти в одни моменты:
 * для каждого допустимого масштаба строим гистограмму разниц «эталон − перевод», пик даёт сдвиг,
 * его высота — качество совпадения. Текст реплик не нужен — только ритм.
 *
 * match(refStartsMs, tgtStartsMs) → { scale, offsetMs, score, ratio, matched, madMs } | null
 * estimate(refStartsMs, tgtStartsMs) → { ok, hypothesis, result, reason }
 *   hypothesis.estimator = 'crossSubs'; модель переводит время субтитров в шкалу эталона.
 */
'use strict';

var types = require('../engine/types');
var time = require('../engine/time');

var FILM = time.FPS.FILM;
// Допустимые пересчёты частоты кадров. 24 ↔ 23.976 оставлен: здесь его видно по наклону, а не по метке.
var SCALES = [1, 25 / FILM, FILM / 25, 24 / FILM, FILM / 24, 25 / 24, 24 / 25];

var BIN_MS = 200;
var WIN_MS = 300000;   // ищем сдвиг в пределах ±5 минут
var FINE_MS = 400;     // точная подгонка — разницы в пределах ±0.4 с от пика
var MIN_SCORE = 40;
var MIN_RATIO = 0.3;

function match(ref, tgt) {
  var best = null;
  for (var si = 0; si < SCALES.length; si++) {
    var sc = SCALES[si];
    var hist = {};
    var lo = 0;
    for (var i = 0; i < tgt.length; i++) {
      var x = tgt[i] * sc;
      while (lo < ref.length && ref[lo] < x - WIN_MS) lo++;
      for (var j = lo; j < ref.length && ref[j] <= x + WIN_MS; j++) {
        var k = Math.round((ref[j] - x) / BIN_MS);
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

  var center = best.k * BIN_MS;
  var ds = [];
  var lo2 = 0;
  for (var a = 0; a < tgt.length; a++) {
    var y = tgt[a] * best.scale;
    while (lo2 < ref.length && ref[lo2] < y + center - FINE_MS - 100) lo2++;
    for (var b = lo2; b < ref.length && ref[b] <= y + center + FINE_MS + 100; b++) {
      var d = ref[b] - y;
      if (Math.abs(d - center) <= FINE_MS) ds.push(d);
    }
  }
  ds.sort(function (p, q) { return p - q; });
  var offset = ds.length ? ds[Math.floor(ds.length / 2)] : center;
  var dev = ds.map(function (d) { return Math.abs(d - offset); }).sort(function (p, q) { return p - q; });
  return {
    scale: best.scale,
    offsetMs: Math.round(offset),
    score: best.score,
    ratio: best.score / Math.max(1, Math.min(ref.length, tgt.length)),
    matched: ds.length,
    madMs: dev.length ? Math.round(dev[Math.floor(dev.length / 2)]) : null
  };
}

function scaleName(scale) {
  var names = [[25 / FILM, '25 → 23.976'], [FILM / 25, '23.976 → 25'], [24 / FILM, '24 → 23.976'], [FILM / 24, '23.976 → 24'],
    [25 / 24, '25 → 24'], [24 / 25, '24 → 25']];
  for (var i = 0; i < names.length; i++) if (Math.abs(names[i][0] - scale) < 1e-6) return names[i][1];
  return '';
}

// Уверенность из доказательств (ADR 2): доля совпавших реплик и разброс разниц.
function confidence(r) {
  var c = Math.min(1, (r.ratio - MIN_RATIO) / 0.5) * 0.7 + 0.2;
  if (r.madMs !== null && r.madMs > 150) c -= 0.1;
  return Math.max(0.05, Math.min(0.9, c));
}

function estimate(ref, tgt, labels) {
  labels = labels || {};
  if (!ref.length || !tgt.length) return { ok: false, reason: 'нет реплик' };
  var r = match(ref, tgt);
  if (!r || r.score < MIN_SCORE || r.ratio < MIN_RATIO) return { ok: false, result: r, reason: 'файлы слишком разные' };
  var h = types.hypothesis({
    estimator: 'crossSubs',
    kind: Math.abs(r.scale - 1) > 1e-9 ? 'drift' : 'offset',
    offsetMs: r.offsetMs,
    scale: r.scale,
    sigmaMs: Math.max(100, r.madMs || 0),
    confidence: confidence(r),
    evidence: [
      { what: 'совпало реплик', value: r.score, source: labels.ref || 'эталон' },
      { what: 'доля совпадения', value: Math.round(r.ratio * 100) / 100, source: labels.tgt || 'субтитры' },
      { what: 'пересчёт кадров', value: scaleName(r.scale) || 'нет', source: 'crossSubs' }
    ]
  });
  return { ok: true, hypothesis: h, result: r };
}

module.exports = { SCALES: SCALES, MIN_SCORE: MIN_SCORE, MIN_RATIO: MIN_RATIO, match: match, estimate: estimate, scaleName: scaleName };
  },

  "estimators/duration": function (module, exports, require) {
/*
 * Оценщик duration: гипотезы, которые даёт сравнение длительностей с оригиналом
 * (совпадает / почти совпадает / пересчёт частоты кадров). Вставку в начале выдаёт
 * отдельный оценщик openingInsertion (ADR 3). Расчёт — engine/diagnostics.js.
 */
'use strict';

function estimate(release) {
  var hs = (release && release.hypotheses) || [];
  var out = [];
  for (var i = 0; i < hs.length; i++) if (hs[i].estimator === 'duration') out.push(hs[i]);
  return out;
}

module.exports = { estimate: estimate };
  },

  "estimators/fps": function (module, exports, require) {
/*
 * Оценщик fps: частота кадров субтитров против частоты кадров видео.
 * Надёжно различаются только PAL 25 и «плёночные» 24/23.976: метка 24 vs 23.976 врёт
 * (Phantom пишет 24.000 там, где HDRezka 23.974 при одинаковой длительности), поэтому
 * пересчёт 24 ↔ 23.976 этот оценщик не предлагает — его видно только по наклону crossSubs.
 *
 * estimate({ subsFps, videoFpsDeclared, videoFpsMeasured }) → { scale, hypothesis | null, reason }
 * ADR правило 5: пересчёт verified, когда расхождение подтверждено двумя признаками.
 */
'use strict';

var types = require('../engine/types');
var time = require('../engine/time');

function family(f) {
  if (!f) return null;
  if (Math.abs(f - 25) < 0.1) return 'pal';
  if (Math.abs(f - 23.976) < 0.1 || Math.abs(f - 24) < 0.1) return 'film';
  return null;
}

var RATE = { pal: time.FPS.PAL, film: time.FPS.FILM };

function estimate(o) {
  o = o || {};
  var sub = family(o.subsFps);
  var declared = family(o.videoFpsDeclared);
  var measured = family(o.videoFpsMeasured);
  var video = measured || declared;
  if (!sub) return { scale: 1, hypothesis: null, reason: 'частота субтитров неизвестна' };
  if (!video) return { scale: 1, hypothesis: null, reason: 'частота видео неизвестна' };
  if (sub === video) return { scale: 1, hypothesis: null, reason: 'частоты совпадают' };
  if (measured && declared && measured !== declared) return { scale: 1, hypothesis: null, reason: 'метка и замер FPS видео расходятся' };

  var scale = time.fpsRatio(RATE[sub], RATE[video]);
  var signs = (declared ? 1 : 0) + (measured ? 1 : 0);
  var evidence = [{ what: 'FPS субтитров', value: o.subsFps, source: 'opensubtitles' }];
  if (declared) evidence.push({ what: 'FPS видео (метка)', value: o.videoFpsDeclared, source: 'hls' });
  if (measured) evidence.push({ what: 'FPS видео (замер)', value: Math.round(o.videoFpsMeasured * 100) / 100, source: 'player' });
  return {
    scale: scale,
    reason: 'субтитры ' + o.subsFps + ' к/с, видео ' + (o.videoFpsMeasured ? o.videoFpsMeasured.toFixed(2) : o.videoFpsDeclared),
    hypothesis: types.hypothesis({
      estimator: 'fps',
      kind: 'drift',
      offsetMs: 0,
      scale: scale,
      sigmaMs: 1000,
      confidence: signs >= 2 ? 0.8 : 0.5,
      evidence: evidence
    })
  };
}

module.exports = { estimate: estimate, family: family };
  },

  "estimators/opening-insertion": function (module, exports, require) {
/*
 * Оценщик openingInsertion (ADR 3): duration_delta → opening_insertion_candidate → opening_insertion_confirmed.
 *   candidate(release)            — кандидат из ReleaseDiagnostics (или null);
 *   confirm(candidate, evidenceH) — подтверждение независимой гипотезой (звук, контрольная точка)
 *                                   в пределах CONFIRM_MS; иначе null.
 * Подтверждение даёт только независимое доказательство, а не время просмотра.
 */
'use strict';

var types = require('../engine/types');

var CONFIRM_MS = 1000;
var INDEPENDENT = { audio: true, checkpoint: true };

function candidate(release) {
  var hs = (release && release.hypotheses) || [];
  for (var i = 0; i < hs.length; i++) if (hs[i].kind === 'opening_insertion_candidate') return hs[i];
  return null;
}

function confirm(cand, h) {
  if (!cand || !h || !INDEPENDENT[h.estimator]) return null;
  if (Math.abs(h.scale - 1) > 0.0005) return null;
  if (Math.abs(h.offsetMs - cand.offsetMs) > CONFIRM_MS) return null;
  return types.hypothesis({
    estimator: 'openingInsertion',
    kind: 'opening_insertion_confirmed',
    offsetMs: h.offsetMs,
    sigmaMs: Math.min(h.sigmaMs, CONFIRM_MS),
    confidence: Math.min(0.95, Math.max(cand.confidence, h.confidence) + 0.2),
    evidence: cand.evidence.concat([{ what: 'подтверждено', value: h.offsetMs, source: h.estimator }])
  });
}

module.exports = { CONFIRM_MS: CONFIRM_MS, candidate: candidate, confirm: confirm };
  },

  "index": function (module, exports, require) {
/*
 * Точка входа плагина OpenSubs (SubtitleEngine).
 *
 * Чистые модули движка (engine/, estimators/, analyzers/subtitle, probe/, api/lampac, profiles/, calibration/)
 * не знают про Lampa и проверяются в Node. Связь с Lampa — модули-установщики: каждый добавляет свои функции
 * и состояние в общий объект app, чтобы части интерфейса и конвейера могли вызывать друг друга.
 */
'use strict';

if (!window.opensubs_plugin_ready) {
  window.opensubs_plugin_ready = true;

  var app = {};
  require('./app/util')(app);
  require('./app/services')(app);
  require('./api/opensubtitles')(app);
  require('./player/bridge')(app);
  require('./analyzers/audio-capture')(app);
  require('./engine/synchronizer')(app);
  require('./ui/button')(app);
  require('./ui/menu')(app);
  require('./app/boot')(app);
  app.boot();
}
  },

  "player/bridge": function (module, exports, require) {
/*
 * PlayerBridge: дорожки субтитров плеера Lampa, сборка файла по модели, плавная коррекция.
 * Устанавливается в общий объект app (см. index.js): функции и состояние доступны как app.*.
 */
'use strict';

var subtitle = require('../analyzers/subtitle');

module.exports = function (app) {
  // ---------- плеер ----------
  app.videoSubs = function videoSubs() {
    try {
      var v = Lampa.PlayerVideo.video();
      if (!v) return null;
      return { video: v, subs: v.customSubs || [] };
    } catch (e) {
      return null;
    }
  };


  // добавить скачанный файл в список субтитров плеера, вернуть объект дорожки из плеера
  app.ensureTrack = function ensureTrack(a, done, fail) {
    var fid = a.files[0].file_id;
    var have = app.findTrack(fid);
    if (have) return done(have);

    app.download(fid, function (text, link) {
      if (text) app.texts[fid] = text;
      var url = text ? app.buildTrack(fid) : link;
      var state = app.videoSubs();
      if (!url || !state) return fail();
      var list = app.copySubs(state.subs);
      list.push({ label: app.trackLabel(a), url: url, language: a._lang, opensubs: true, os_id: fid, os_fps: parseFloat(a.fps) || 0, os_attrs: a, index: list.length });
      Lampa.Player.subtitles(list);
      var t = app.findTrack(fid);
      t ? done(t) : fail();
    }, function (err) {
      app.log('download fail', err);
      if (err && err.remaining === 0) Lampa.Noty.show('OpenSubtitles: дневной лимит скачиваний исчерпан');
      fail();
    });
  };

  app.findTrack = function findTrack(fid) {
    var subs = app.trackList();
    for (var i = 0; i < subs.length; i++) if (subs[i].os_id === fid) return subs[i];
    return null;
  };


  // Lampa определяет у объектов свойство mode — для повторной передачи берём чистые копии
  app.copySubs = function copySubs(subs) {
    return subs.map(function (x, i) {
      var c = {};
      for (var k in x) if (k !== 'mode' && k !== 'ready' && k !== 'selected') c[k] = x[k];
      c.index = i;
      return c;
    });
  };

  app.sourceTrackFor = function sourceTrackFor(langs) {
    var subs = app.trackList().filter(function (x) { return !x.opensubs; });
    if (!subs.length) return null;
    for (var i = 0; i < langs.length; i++) {
      for (var j = 0; j < subs.length; j++) {
        var l = app.normLang(subs[j].language || subs[j].lang || subs[j].srclang);
        if (l === langs[i]) return subs[j];
      }
    }
    return null;
  };

  app.isShowing = function isShowing() {
    var subs = app.trackList();
    for (var i = 0; i < subs.length; i++) if (subs[i].selected) return subs[i];
    return null;
  };


  // ---------- синхронизация ----------
  // Два уровня поправок времени:
  //   файл  → английский эталон (fileSync, по file_id): частота кадров и сдвиг самого файла субтитров;
  //   видео → конкретный источник (videoSync, по фильму/серии + источнику + озвучке): заставка студии
  //           (LostFilm, HDRezka…), частота кадров видео, ручные правки, подстройка по звуку.
  // Итог: t' = (t * f.scale + f.offset) * v.scale + v.offset.
  app.texts = {};

  app.applied = {};


  // Файл для плеера. hold: { at, prev } — плавная коррекция: реплики, которые при новой модели
  // всплыли бы посреди показа или повторились бы, в этом файле пропускаются (вернутся при перемотке).
  app.buildTrack = function buildTrack(fid, hold) {
    var fn = app.cueFn(fid);
    var cues = subtitle.parse(app.texts[fid]);
    var out = [];
    var now = [];
    for (var i = 0; i < cues.length; i++) {
      var a = fn(cues[i].startMs), b = fn(cues[i].endMs);
      now.push({ start: a / 1000, end: b / 1000 });
      if (hold && hold.prev && hold.prev[i]) {
        var at = hold.at * 1000, p = hold.prev[i];
        var popsUp = a < at && b > at && !(p.start * 1000 <= at && p.end * 1000 > at);
        var repeats = p.end * 1000 <= at && a >= at;
        if (popsUp || repeats) continue;
      }
      out.push({ startMs: a, endMs: b, text: cues[i].text, raw: cues[i].raw });
    }
    app.applied[fid] = now;
    return app.textUrl(subtitle.build(out));
  };


  // пересобрать файлы всех дорожек OpenSubtitles с текущими поправками, выбранную оставить включённой
  app.resyncNow = function resyncNow(hold) {
    var state = app.videoSubs();
    if (!state) return;
    var on = app.isShowing();
    var onId = on && (on.os_id || on.label);
    var list = app.copySubs(state.subs);
    var changed = false;
    for (var j = 0; j < list.length; j++) {
      var fid = list[j].os_id;
      if (!fid || !app.texts[fid]) continue;
      var url = app.buildTrack(fid, hold && fid === hold.fid ? hold : null);
      if (url) {
        list[j].url = url;
        changed = true;
      }
    }
    if (!changed) return;
    Lampa.Player.subtitles(list);
    if (!onId) return;
    var now = app.trackList();
    for (var i = 0; i < now.length; i++) {
      if ((now[i].os_id || now[i].label) === onId) {
        app.showTrack(now[i]);
        break;
      }
    }
  };


  // Плавная коррекция (документ, «После показа»): новая модель применяется в паузе между репликами
  // не короче 1 с; реплика на экране досиживает со старыми таймингами; при перемотке — сразу.
  app.resyncTimer = null;

  app.resyncAll = function resyncAll() {
    clearInterval(app.resyncTimer);
    var on = app.isShowing();
    var v = null;
    try { v = Lampa.PlayerVideo.video(); } catch (e) {}
    var fid = on && on.os_id;
    if (!fid || !app.applied[fid] || !v || v.paused || v.seeking) return app.resyncNow();
    var prev = app.applied[fid];
    var started = Date.now();
    var onSeek = function () { stop(); app.resyncNow(); };
    var stop = function () {
      clearInterval(app.resyncTimer);
      app.resyncTimer = null;
      try { v.removeEventListener('seeking', onSeek); } catch (e) {}
    };
    try { v.addEventListener('seeking', onSeek); } catch (e) {}
    var tick = function () {
      var t = v.currentTime;
      if (Date.now() - started < 20000) { // не дольше 20 с ждём паузу
        // реплика на экране или начнётся меньше чем через секунду — ждём
        for (var i = 0; i < prev.length; i++) if (prev[i].start <= t + 1 && prev[i].end >= t) return;
      }
      stop();
      app.resyncNow({ fid: fid, at: t, prev: prev });
    };
    app.resyncTimer = setInterval(tick, 200);
    tick();
  };

  app.videoTime = function videoTime() {
    try { return Lampa.PlayerVideo.video().currentTime || 0; } catch (e) { return 0; }
  };

  app.trackList = function trackList() {
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
  };

  app.cueBox = function cueBox(show) {
    var box = document.querySelectorAll('.player-video__subtitles');
    for (var i = 0; i < box.length; i++) box[i].classList.toggle('hide', !show);
  };

  app.selectTrack = function selectTrack(track) {
    var subs = app.trackList();
    for (var i = 0; i < subs.length; i++) {
      subs[i].mode = 'disabled';
      subs[i].selected = false;
    }
    if (track) {
      track.mode = 'showing';
      track.selected = true;
    }
    app.cueBox(!!track);
  };
};
  },

  "probe/client-probe": function (module, exports, require) {
/*
 * ClientProbe — характеристики видео, доступные в браузере (ADR 1).
 *   длительность: HLS-плейлист (сумма EXTINF, exact) или video.duration (exact = false);
 *   FPS заявленный: FRAME-RATE в master-плейлисте (24 и 23.976 путаются — только подсказка);
 *   FPS измеренный: getVideoPlaybackQuality за несколько секунд воспроизведения —
 *     отличает 25 от 24, но не 24 от 23.976;
 *   VFR и начало потоков браузеру недоступны: vfr = null, startMs = 0.
 *
 * var probe = require('./client-probe').create({ http });
 * probe.probe({ url, video }, done(ProbeInfo))
 */
'use strict';

var hls = require('./hls');
var types = require('../engine/types');

// Номинальная частота по измерению: 25 (PAL) или «плёночная» 24/23.976; иначе null.
function nominalFps(measured) {
  if (!measured) return null;
  if (measured > 24.6 && measured < 25.4) return 25;
  if (measured > 23.5 && measured < 24.5) return 24;
  if (measured > 29.5 && measured < 30.5) return 30;
  return null;
}

function videoDurationMs(video) {
  var d = video && video.duration;
  return d && isFinite(d) && d > 60 ? Math.round(d * 1000) : null;
}

// Кадры за время воспроизведения: done(fps | null). Без getVideoPlaybackQuality — null.
function measureFps(video, done, windowMs, timer) {
  timer = timer || setTimeout;
  windowMs = windowMs || 6000;
  var sample = function () {
    try {
      var q = video.getVideoPlaybackQuality && video.getVideoPlaybackQuality();
      if (!q || typeof q.totalVideoFrames !== 'number') return null;
      return { frames: q.totalVideoFrames, t: video.currentTime };
    } catch (e) {
      return null;
    }
  };
  var a = sample();
  if (!a) return done(null);
  timer(function () {
    var b = sample();
    var dt = b ? b.t - a.t : 0;
    // перемотка или пауза портят замер
    if (!b || dt < windowMs / 2000 || dt > windowMs / 500) return done(null);
    done((b.frames - a.frames) / dt);
  }, windowMs);
}

function create(deps) {
  var http = deps.http;

  function probe(req, done) {
    var url = String(req.url || '');
    var fallback = function (declared) {
      done(types.probeInfo({
        source: 'client',
        durationMs: videoDurationMs(req.video),
        exact: false,
        fps: { declared: declared || null },
        streams: [{ kind: 'video' }, { kind: 'audio' }]
      }));
    };
    if (!/m3u8/i.test(url)) return fallback(null);
    hls.durationMs(http, url, function (r) {
      done(types.probeInfo({
        source: 'client',
        durationMs: r.durationMs,
        exact: true,
        fps: { declared: r.frameRate },
        streams: [{ kind: 'video', durationMs: r.durationMs }, { kind: 'audio' }]
      }));
    }, function () { fallback(null); });
  }

  return { name: 'client', probe: probe };
}

module.exports = { create: create, nominalFps: nominalFps, measureFps: measureFps, videoDurationMs: videoDurationMs };
  },

  "probe/ffprobe": function (module, exports, require) {
/*
 * FFProbe — необязательный серверный анализ видео (ADR 1). Плагин сервер не меняет: этот модуль работает,
 * только если в настройке opensubs_ffprobe указан адрес службы, которая отвечает выводом
 *   ffprobe -v error -print_format json -show_format -show_streams <url>
 * (адрес получает ?url=<ссылка на видео>). Без настройки или при ошибке — ClientProbe.
 *
 * parse(json) → ProbeInfo { source: 'ffprobe', exact, durationMs, fps { declared, measured }, vfr, streams[] }
 *   declared = r_frame_rate, measured = avg_frame_rate; VFR — если они заметно различаются;
 *   start потоков (start_time) — для явного перевода шкал в engine/time.js.
 */
'use strict';

var types = require('../engine/types');

function rate(s) {
  var m = /^(\d+)\/(\d+)$/.exec(String(s || ''));
  if (m) return Number(m[2]) ? Number(m[1]) / Number(m[2]) : null;
  var f = parseFloat(s);
  return isFinite(f) && f > 0 ? f : null;
}

function ms(sec) {
  var f = parseFloat(sec);
  return isFinite(f) ? Math.round(f * 1000) : null;
}

function parse(json) {
  var streams = (json && json.streams) || [];
  var video = null;
  var out = [];
  for (var i = 0; i < streams.length; i++) {
    var st = streams[i];
    if (st.codec_type !== 'video' && st.codec_type !== 'audio') continue;
    if (st.codec_type === 'video' && !video) video = st;
    out.push({ kind: st.codec_type, startMs: ms(st.start_time) || 0, durationMs: ms(st.duration), timeBase: st.time_base || null });
  }
  var declared = video ? rate(video.r_frame_rate) : null;
  var measured = video ? rate(video.avg_frame_rate) : null;
  return types.probeInfo({
    source: 'ffprobe',
    exact: true,
    durationMs: ms(json && json.format && json.format.duration) || (video && ms(video.duration)),
    fps: { declared: declared, measured: measured },
    vfr: declared && measured ? Math.abs(declared - measured) > 0.05 : null,
    streams: out
  });
}

// endpoint — адрес службы; fallback — ClientProbe
function create(deps) {
  var http = deps.http;
  var endpoint = deps.endpoint;
  var fallback = deps.fallback;
  function probe(req, done) {
    if (!endpoint) return fallback.probe(req, done);
    var url = endpoint + (endpoint.indexOf('?') >= 0 ? '&' : '?') + 'url=' + encodeURIComponent(req.url || '');
    http.getJSON(url, function (json) {
      var info = null;
      try { info = parse(json); } catch (e) {}
      if (info && info.durationMs) done(info);
      else fallback.probe(req, done);
    }, function () { fallback.probe(req, done); });
  }
  return { name: 'ffprobe', probe: probe };
}

module.exports = { create: create, parse: parse, rate: rate };
  },

  "probe/hls": function (module, exports, require) {
/*
 * Разбор HLS-плейлистов: длительность по сумме EXTINF (до сотых секунды) и заявленная частота кадров.
 * Чистые функции + durationMs(http, url), который проходит master → media.
 */
'use strict';

function resolveUrl(base, ref) {
  ref = String(ref);
  if (/^https?:\/\//i.test(ref)) return ref;
  var origin = String(base).match(/^https?:\/\/[^\/]+/i);
  if (ref.charAt(0) === '/') return (origin ? origin[0] : '') + ref;
  return String(base).replace(/[^\/?]*(\?.*)?$/, '') + ref;
}

// → { type: 'media', durationMs, ended, segments }
//   { type: 'master', variants: [{ url, bandwidth, frameRate }] }
//   { type: 'unknown' }
function parse(text, baseUrl) {
  text = String(text || '').replace(/\r/g, '');
  if (/#EXTINF/.test(text)) {
    var ms = 0;
    var segments = 0;
    text.replace(/#EXTINF:\s*([0-9.]+)/g, function (all, d) {
      // сумма в мс по каждому сегменту, иначе ошибка округления float копится на тысячах сегментов
      ms += Math.round(parseFloat(d) * 1000);
      segments++;
      return all;
    });
    return { type: 'media', durationMs: ms, ended: /#EXT-X-ENDLIST/.test(text), segments: segments };
  }
  var lines = text.split('\n');
  var variants = [];
  var attrs = null;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].replace(/^\s+|\s+$/g, '');
    if (!line) continue;
    if (/^#EXT-X-STREAM-INF:/.test(line)) {
      attrs = line;
      continue;
    }
    if (line.charAt(0) === '#') continue;
    var bw = attrs && attrs.match(/[:,]BANDWIDTH=(\d+)/);
    var fr = attrs && attrs.match(/FRAME-RATE=([0-9.]+)/);
    variants.push({
      url: resolveUrl(baseUrl || '', line),
      bandwidth: bw ? parseInt(bw[1], 10) : null,
      frameRate: fr ? parseFloat(fr[1]) : null
    });
    attrs = null;
  }
  return variants.length ? { type: 'master', variants: variants } : { type: 'unknown' };
}

// Заявленная частота кадров (первая найденная). Ненадёжна: 24.000 и 23.976 путают (ADR, факты).
function frameRate(parsed) {
  if (!parsed || parsed.type !== 'master') return null;
  for (var i = 0; i < parsed.variants.length; i++) if (parsed.variants[i].frameRate) return parsed.variants[i].frameRate;
  return null;
}

// done({ durationMs, frameRate }) | fail(reason). Глубина — защита от зацикленных плейлистов.
function durationMs(http, url, done, fail, depth) {
  depth = depth || 0;
  if (depth > 3) return fail('слишком глубокий плейлист');
  http.getText(url, function (text) {
    var p = parse(text, url);
    if (p.type === 'media') {
      if (!p.ended) return fail('live');
      return done({ durationMs: p.durationMs, frameRate: null });
    }
    if (p.type !== 'master') return fail('нет вариантов');
    var fr = frameRate(p);
    durationMs(http, p.variants[0].url, function (r) {
      done({ durationMs: r.durationMs, frameRate: fr || r.frameRate });
    }, fail, depth + 1);
  }, fail);
}

module.exports = { parse: parse, resolveUrl: resolveUrl, frameRate: frameRate, durationMs: durationMs };
  },

  "probe/unknown": function (module, exports, require) {
/*
 * UnknownProbe — характеристики видео недоступны (ADR 1).
 * Общий интерфейс VideoProbe: probe(req, done), done(ProbeInfo).
 * Колбэк вместо Promise: часть ТВ-браузеров Lampa старше Promise.
 * ClientProbe (HTML5-плеер, HLS) появится в задаче 2, FFProbe — по отдельному решению.
 */
'use strict';

var types = require('../engine/types');

module.exports = {
  name: 'unknown',
  probe: function (req, done) {
    done(types.probeInfo({ source: 'unknown' }));
  }
};
  },

  "profiles/storage": function (module, exports, require) {
/*
 * ProfileStore (этап 6, ADR 4): профили субтитров и профили видео хранятся раздельно.
 *   субтитры: file_id → { scale, offsetMs, refRelease, auto, t }      — файл → эталон (crossSubs);
 *   видео:    ключ серии+источника+озвучки → { scale, offsetMs, pieces, anchors, manual, src,
 *             durationMs, dd, t }                                      — эталон → это видео;
 *   площадка: сериал+источник → { offsetMs, t }                       — отбивка площадки, выученная на другой серии.
 *
 * Уровни доверия при чтении профиля видео (lookup):
 *   high   — та же серия, источник, озвучка и длительность видео (±100 мс) — применить и показать;
 *   medium — то же, но длительность неизвестна (старые записи) — применить, статус по остальным доказательствам;
 *   low    — длительность другая (другой видеорелиз под тем же именем) — только гипотеза, без автопоказа.
 * Соседняя серия той же озвучки — только гипотеза (platform), студия — не основание (ADR 4).
 *
 * var store = require('./storage').create({ read(name) → object, write(name, object) });
 * Старые ключи прототипа (opensubs_fsync, opensubs_vsync3, opensubs_resid3) переносятся migrate().
 */
'use strict';

var NAMES = { subs: 'opensubs_sprof', video: 'opensubs_vprof', platform: 'opensubs_pprof', version: 'opensubs_prof_v' };
var LIMITS = { subs: 300, video: 500, platform: 300 };
var SAME_DURATION_MS = 100;

function prune(all, max) {
  var keys = Object.keys(all);
  if (keys.length <= max) return all;
  keys.sort(function (a, b) { return (all[a].t || 0) - (all[b].t || 0); });
  for (var i = 0; i < keys.length - max; i++) delete all[keys[i]];
  return all;
}

function round(x) {
  return Math.round(x);
}

// Ключ видео: фильм/серия + источник + озвучка (как в прототипе: card|bal|voice[|SxE]).
function videoKey(k) {
  var ep = k.season && k.episode ? '|' + k.season + 'x' + k.episode : '';
  return k.card + '|' + String(k.balancer || '').toLowerCase() + '|' +
    String(k.voice || '').toLowerCase().replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '') + ep;
}

function platformKey(k) {
  return k.card + '|' + String(k.balancer || '').toLowerCase();
}

function create(io, now) {
  now = now || function () { return Date.now(); };
  var cache = {};
  function all(name) {
    if (!cache[name]) {
      var v = io.read(name);
      cache[name] = v && typeof v === 'object' ? v : {};
    }
    return cache[name];
  }
  function save(name, max) {
    io.write(name, prune(all(name), max));
  }

  var subs = {
    get: function (fileId) {
      var c = all(NAMES.subs)[fileId];
      return c ? { scale: c.scale || 1, offsetMs: c.offsetMs || 0, refRelease: c.refRelease || null, auto: !!c.auto, known: true }
        : { scale: 1, offsetMs: 0, refRelease: null, auto: false, known: false };
    },
    set: function (fileId, p) {
      all(NAMES.subs)[fileId] = { scale: p.scale, offsetMs: round(p.offsetMs), refRelease: p.refRelease || undefined, auto: p.auto !== false, t: now() };
      save(NAMES.subs, LIMITS.subs);
    }
  };

  var video = {
    // → { record, level: 'high' | 'medium' | 'low' } | null
    lookup: function (key, durationMs) {
      var r = all(NAMES.video)[videoKey(key)];
      if (!r) return null;
      var level = 'medium';
      if (r.durationMs && durationMs) level = Math.abs(r.durationMs - durationMs) <= SAME_DURATION_MS ? 'high' : 'low';
      // записи прототипа (без версии) часто хранили ошибочные сдвиги — только гипотеза (приёмка 10.11)
      if (!r.v) level = 'low';
      return { record: r, level: level };
    },
    set: function (key, v) {
      var rec = {
        scale: v.scale, offsetMs: round(v.offsetMs), pieces: v.pieces || undefined, anchors: (v.anchors || []).slice(-8),
        manual: !!v.manual, src: v.src || undefined, durationMs: v.durationMs || undefined, v: 2,
        dd: v.dd === null || v.dd === undefined ? undefined : v.dd, t: now()
      };
      all(NAMES.video)[videoKey(key)] = rec;
      save(NAMES.video, LIMITS.video);
      return rec;
    },
    remove: function (key) {
      delete all(NAMES.video)[videoKey(key)];
      save(NAMES.video, LIMITS.video);
    }
  };

  var platform = {
    get: function (key) {
      var r = all(NAMES.platform)[platformKey(key)];
      return r ? r.offsetMs : null;
    },
    set: function (key, offsetMs) {
      all(NAMES.platform)[platformKey(key)] = { offsetMs: round(offsetMs), t: now() };
      save(NAMES.platform, LIMITS.platform);
    }
  };

  // Перенос записей прототипа (секунды → мс). Старые ключи не трогаем: откат на старую версию не теряет поправки.
  function migrate() {
    if (io.read(NAMES.version) === 1) return false;
    var oldF = io.read('opensubs_fsync') || {};
    var oldV = io.read('opensubs_vsync3') || {};
    var oldR = io.read('opensubs_resid3') || {};
    var k;
    var sp = all(NAMES.subs), vp = all(NAMES.video), pp = all(NAMES.platform);
    for (k in oldF) if (!sp[k]) sp[k] = { scale: oldF[k].scale || 1, offsetMs: round((oldF[k].offset || 0) * 1000), auto: !!oldF[k].auto, t: oldF[k].t || 0 };
    for (k in oldV) {
      if (vp[k]) continue;
      var o = oldV[k];
      vp[k] = { scale: o.scale || 1, offsetMs: round((o.offset || 0) * 1000), pieces: o.pieces || undefined, anchors: o.anchors || [],
        manual: !!o.manual, src: o.src || undefined, dd: o.dd, t: o.t || 0 };
    }
    for (k in oldR) if (!pp[k]) pp[k] = { offsetMs: round((oldR[k].o || 0) * 1000), t: oldR[k].t || 0 };
    save(NAMES.subs, LIMITS.subs);
    save(NAMES.video, LIMITS.video);
    save(NAMES.platform, LIMITS.platform);
    io.write(NAMES.version, 1);
    return true;
  }

  return { subs: subs, video: video, platform: platform, migrate: migrate };
}

module.exports = { create: create, NAMES: NAMES, videoKey: videoKey, platformKey: platformKey, SAME_DURATION_MS: SAME_DURATION_MS };
  },

  "ui/button": function (module, exports, require) {
/*
 * Кнопка CC в панели плеера: иконка с заливкой прогресса и меткой «не подтверждено», стили.
 * Устанавливается в общий объект app (см. index.js): функции и состояние доступны как app.*.
 */
'use strict';

module.exports = function (app) {
  // состояние кнопки приходит событиями движка (engine/events.js): решение Decider и прогресс проверки по звуку
  app.ui = { decision: null, progress: 0 };
  app.engineEvents.on('decision', function (d) {
    app.ui.decision = d;
    app.updateButtons();
  });
  app.engineEvents.on('progress', function (p) {
    app.ui.progress = p.value;
  });
  app.engineEvents.on('reset', function () {
    app.ui.decision = null;
    app.ui.progress = 0;
  });

  // Иконка CC в сетке спрайтов плеера Lampa (21×21, линия 2.5). Выключено — контур, включено — заливка
  // (буквы вырезаны маской, сквозь них виден фон кнопки).
  app.CC_PATH = 'M9.50 8.37A2.7 2.7 0 1 0 9.50 12.63M15.86 8.37A2.7 2.7 0 1 0 15.86 12.63';

  app.ccSeq = 0;


  // Контур — субтитры выключены; заливка снизу вверх — прогресс (поиск, скачивание, проверка по звуку);
  // полная заливка — включены. Заливка обрезается прямоугольником clipPath, высоту которого двигает ccTick.
  app.ccIcon = function ccIcon() {
    var n = ++app.ccSeq;
    return '<svg viewBox="0 0 21 21" fill="none">' +
      '<defs><mask id="ops-cc-mask-' + n + '"><rect x="0" y="0" width="21" height="21" fill="#fff"/>' +
      '<path d="' + app.CC_PATH + '" stroke="#000" stroke-width="2.3" stroke-linecap="round"/></mask>' +
      '<clipPath id="ops-cc-clip-' + n + '"><rect class="ops-cc-cliprect" x="0" y="21" width="21" height="0"/></clipPath>' +
      '<clipPath id="ops-cc-rest-' + n + '"><rect class="ops-cc-restrect" x="0" y="0" width="21" height="21"/></clipPath></defs>' +
      '<g class="ops-cc-off" clip-path="url(#ops-cc-rest-' + n + ')"><rect x="1.25" y="3.75" width="18.5" height="13.5" rx="3.2" stroke="currentColor" stroke-width="2.5"/>' +
      '<path d="' + app.CC_PATH + '" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/></g>' +
      '<g class="ops-cc-on" clip-path="url(#ops-cc-clip-' + n + ')"><rect x="0" y="2.5" width="21" height="16" rx="4.4" fill="currentColor" mask="url(#ops-cc-mask-' + n + ')"/></g>' +
      '<circle class="ops-cc-dot" cx="18.6" cy="4" r="3.1" fill="#f5b400" stroke="rgba(0,0,0,.55)" stroke-width="1.2"/>' +
      '</svg>';
  };

  app.ccAnim = { p: 0, target: 0, loop: false, t0: 0, timer: null };

  app.ccTick = function ccTick() {
    var tgt = app.ccAnim.target;
    if (app.ccAnim.loop) {
      var ph = ((Date.now() - app.ccAnim.t0) % 1800) / 1800;
      tgt = ph < 0.5 ? ph * 2 : 2 - ph * 2; // заполняется и опустошается, пока идёт работа без известного прогресса
    }
    app.ccAnim.p += (tgt - app.ccAnim.p) * 0.2;
    if (Math.abs(tgt - app.ccAnim.p) < 0.004) app.ccAnim.p = tgt;
    // залитая рамка занимает по высоте 2.5…18.5 единиц сетки — заполняем её снизу вверх
    var h = 16 * app.ccAnim.p;
    var rects = document.querySelectorAll('.ops-cc-cliprect');
    for (var i = 0; i < rects.length; i++) {
      rects[i].setAttribute('y', String(18.5 - h));
      rects[i].setAttribute('height', String(h));
    }
    // контур виден только над заливкой
    var rest = document.querySelectorAll('.ops-cc-restrect');
    for (var j = 0; j < rest.length; j++) rest[j].setAttribute('height', String(app.ccAnim.p >= 1 ? 0 : 18.5 - h));
    if (!app.ccAnim.loop && app.ccAnim.p === tgt) {
      clearInterval(app.ccAnim.timer);
      app.ccAnim.timer = null;
    }
  };

  app.setCcFill = function setCcFill(p, loop) {
    if (loop && !app.ccAnim.loop) app.ccAnim.t0 = Date.now() - (app.ccAnim.p * 900); // продолжаем с текущего уровня
    app.ccAnim.loop = !!loop;
    app.ccAnim.target = Math.max(0, Math.min(1, p));
    if (!app.ccAnim.timer) app.ccAnim.timer = setInterval(app.ccTick, 40);
  };

  app.ICON = '<svg viewBox="0 0 21 21" fill="none"><rect x="1.25" y="3.75" width="18.5" height="13.5" rx="3.2" stroke="currentColor" stroke-width="2.5"/>' +
    '<path d="' + app.CC_PATH + '" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/></svg>';

  app.css = function css() {
    if (document.getElementById('opensubs-style')) return;
    var sel = '.player-video__subtitles';
    var rules = [
      'body.ops-has-btn .player-panel__subs{display:none !important}',
      // метка «синхронизация не подтверждена» (статус estimated, ADR 3)
      '.ops-btn .ops-cc-dot{display:none}',
      '.ops-btn.ops-on.ops-unconfirmed .ops-cc-dot{display:inline}',

      'body.ops-shadow-none ' + sel + '{text-shadow:none !important}',
      'body.ops-shadow-none ' + sel + ' .player-video__subtitles-text{background:none !important}',
      'body.ops-shadow-soft ' + sel + '{text-shadow:0 0.05em 0.15em rgba(0,0,0,.95),0 0 0.5em rgba(0,0,0,.7) !important}',
      'body.ops-shadow-soft ' + sel + ' .player-video__subtitles-text{background:none !important}',
      'body.ops-shadow-outline ' + sel + '{text-shadow:0 2px 1px #000,0 -2px 1px #000,-2px 1px 0 #000,2px 0 1px #000 !important}',
      'body.ops-shadow-outline ' + sel + ' .player-video__subtitles-text{background:none !important}',
      'body.ops-shadow-backdrop ' + sel + '{text-shadow:none !important}',
      'body.ops-shadow-backdrop ' + sel + ' .player-video__subtitles-text{background:rgba(0,0,0,.6) !important;padding:0 .25em}'
    ];
    for (var i = 0; i < app.SIZES.length; i++) {
      if (app.SIZES[i].em) rules.push('body.ops-size-' + app.SIZES[i].value + ' ' + sel + '{font-size:' + app.SIZES[i].em + 'em !important}');
    }
    var st = document.createElement('style');
    st.id = 'opensubs-style';
    st.textContent = rules.join('\n');
    document.head.appendChild(st);
  };

  app.applyStyle = function applyStyle() {
    var b = document.body;
    var cls = b.className.split(/\s+/).filter(function (c) { return !/^ops-(size|shadow)-/.test(c); });
    cls.push('ops-size-' + app.setting('size', 'auto'));
    cls.push('ops-shadow-' + app.setting('shadow', 'auto'));
    b.className = cls.join(' ');
  };

  app.makeButton = function makeButton() {
    var btn = document.createElement('div');
    btn.className = 'player-panel__opensubs ops-btn button selector';
    btn.innerHTML = app.ccIcon() + '<div class="tooltip">Субтитры</div>';
    $(btn).on('hover:enter', function () {
      app.toggleCc();
    });
    return btn;
  };

  // Кнопка «Сверить по фразе» рядом с CC: калибровка в одно нажатие, без пути через настройки (приёмка 10.11).
  // Видна, пока показаны субтитры OpenSubtitles. Иконка — Lucide «timer», в размер и толщину CC.
  app.SYNC_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
    '<line x1="10" x2="14" y1="2" y2="2"/><line x1="12" x2="15" y1="14" y2="11"/><circle cx="12" cy="14" r="8"/></svg>';

  app.makeSyncButton = function makeSyncButton() {
    var btn = document.createElement('div');
    btn.className = 'player-panel__opensubs ops-sync button selector hide';
    btn.innerHTML = app.SYNC_ICON + '<div class="tooltip">Сверить субтитры по фразе</div>';
    $(btn).on('hover:enter', function () {
      var t = app.isShowing() || app.calibTrack();
      if (!t || !t.os_id) return Lampa.Noty.show('Сначала включите субтитры OpenSubtitles');
      var close = function () { app.closeSelects(); };
      app.calibrationMenu(t, close, close);
    });
    return btn;
  };

  app.updateButtons = function updateButtons() {
    var on = !!app.isShowing();
    var waiting = !!(app.session && app.session.waiting);
    var pending = !!(app.session && (app.session.pending || waiting || (app.session.searching && app.ccWanted())));
    var shown = app.isShowing();
    var d = app.ui.decision;
    var unconfirmed = !!(shown && shown.os_id && d && d.marker === 'unconfirmed' && !app.videoSync().manual);
    var btns = document.querySelectorAll('.ops-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('ops-on', on);
      btns[i].classList.toggle('ops-pending', pending && !on);
      btns[i].classList.toggle('ops-unconfirmed', unconfirmed);
      var tip = btns[i].querySelector('.tooltip');
      if (tip) tip.textContent = on ? (unconfirmed ? 'Выключить субтитры (синхронизация не подтверждена)' : 'Выключить субтитры') : waiting ? 'Сверяю субтитры со звуком: ' + Math.round(app.audioProgress() * 100) + '% — нажмите, чтобы включить сразу' : pending ? 'Готовлю субтитры…' : 'Включить субтитры';
    }
    var syncShown = !!((shown && shown.os_id) || app.calibTrack());
    var sb = document.querySelectorAll('.ops-sync');
    for (var j = 0; j < sb.length; j++) sb[j].classList.toggle('hide', !syncShown);
    if (on) app.setCcFill(1, false);
    else if (waiting && app.ui.progress > 0) app.setCcFill(app.ui.progress, false); // известный прогресс проверки по звуку
    else if (pending) app.setCcFill(0, true);
    else app.setCcFill(0, false);
  };


  // кнопка — отдельным блоком сразу после выбора качества (и в начале блока кнопок на телефоне)
  app.addButton = function addButton() {
    if (document.querySelector('.ops-btn')) return;
    var quality = document.querySelector('.player-panel__quality');
    if (!quality) return;

    var box = document.createElement('div');
    box.className = 'player-panel__box-buttons ops-box';
    box.appendChild(app.makeButton());
    box.appendChild(app.makeSyncButton());
    var qbox = quality.parentNode;
    qbox.parentNode.insertBefore(box, qbox.nextSibling);

    var more = document.querySelector('.player-panel__mobile-more');
    if (more) {
      more.parentNode.insertBefore(app.makeButton(), more);
      more.parentNode.insertBefore(app.makeSyncButton(), more);
    }

    document.body.classList.add('ops-has-btn');
  };
};
  },

  "ui/menu": function (module, exports, require) {
/*
 * Меню «Субтитры» в плеере: язык, вид, синхронизация, калибровка по фразе.
 * Устанавливается в общий объект app (см. index.js): функции и состояние доступны как app.*.
 */
'use strict';

var calibration = require('../calibration/checkpoints');
var subtitle = require('../analyzers/subtitle');

module.exports = function (app) {
  // ---------- меню синхронизации ----------
  app.FPS = [
    { title: 'Без изменений', scale: 1 },
    { title: '25 → 23.976 (субтитры спешат и уползают)', scale: 25 / 23.976 },
    { title: '23.976 → 25 (субтитры отстают и уползают)', scale: 23.976 / 25 },
    { title: '24 → 23.976', scale: 24 / 23.976 },
    { title: '23.976 → 24', scale: 23.976 / 24 },
    { title: '30 → 23.976', scale: 30 / 23.976 },
    { title: '23.976 → 30', scale: 23.976 / 30 }
  ];

  app.STEPS = [-5, -2, -1, -0.5, -0.25, 0.25, 0.5, 1, 2, 5];

  app.syncTitle = function syncTitle() {
    var v = app.videoSync();
    var parts = [];
    if (Math.abs(v.offset) >= 0.05) parts.push((v.offset > 0 ? '+' : '') + v.offset.toFixed(2) + ' сек.');
    if (Math.abs(v.scale - 1) > 0.0005) parts.push('скорость ×' + v.scale.toFixed(4));
    var from = v.manual ? ' (вручную)' : v.src === 'duration' ? ' (по длительности оригинала)' : '';
    return parts.length ? parts.join(', ') + ' для этого источника' + from : 'Без поправок для этого источника';
  };


  // back — вернуться в меню субтитров, root — закрыть всё и вернуться к просмотру
  app.syncMenu = function syncMenu(track, back, root) {
    var reopen = function () {
      app.closeSelects();
      app.syncMenu(track, back, root);
    };
    var v = app.videoSync();
    var aud = app.flag('audiosync', true);

    app.closeSelects();
    Lampa.Select.show({
      title: 'Синхронизация',
      nohide: true,
      items: [
        { title: 'По длительности оригинала', subtitle: app.session && app.session.durStatus ? app.session.durStatus : app.flag('durationsync', true) ? 'Сравнивает с дорожкой «Оригинальный» источника…' : 'Выключено', name: 'dur' },
        { title: 'Подстройка по звуку', subtitle: !aud ? 'Выключена' : app.audioDenied ? 'Не работает: ' + app.audioDenied : app.audio ? (app.audio.analyser ? app.audio.status : 'ждёт звук видео') : 'Не запущена', name: 'audio' },
        { title: 'По английским субтитрам', subtitle: 'Выровнять файл: частота кадров и сдвиг', name: 'auto' },
        { title: 'По фразе', subtitle: 'Выберите реплику, которая звучит сейчас', name: 'phrase' },
        { title: 'Сдвиг', subtitle: app.syncTitle(), name: 'shift' },
        { title: 'Частота кадров видео', subtitle: 'Если субтитры уползают всё дальше', name: 'fps' },
        { title: 'Сбросить для этого источника', subtitle: 'Убрать поправки под это видео', name: 'reset' },
        { title: 'Отчёт для проверки', subtitle: 'На чём основана синхронизация этого видео', name: 'report' }
      ],
      onBack: back,
      onSelect: function (a) {
        if (a.name === 'phrase') return app.calibrationMenu(track, reopen, root);

        if (a.name === 'dur') {
          var on = app.flag('durationsync', true);
          Lampa.Storage.set('opensubs_durationsync', on ? 'false' : 'true');
          if (!on && app.session) { app.session.durDone = false; app.session.durWait = []; app.durationSync(); }
          return reopen();
        }

        if (a.name === 'audio') {
          Lampa.Storage.set('opensubs_audiosync', aud ? 'false' : 'true');
          if (aud) app.audioStop();
          else app.audioStart();
          return reopen();
        }

        if (a.name === 'auto') {
          Lampa.Noty.show('Сравниваю с английскими субтитрами…');
          app.autoSync(track, function (res, reason) {
            Lampa.Noty.show(res ? 'Выровнено: ' + app.describeAuto(res) : 'Не получилось: ' + reason);
          });
          return root();
        }

        if (a.name === 'shift') {
          app.closeSelects();
          return Lampa.Select.show({
            title: 'Сдвиг: ' + app.syncTitle(),
            nohide: true,
            items: app.STEPS.map(function (x) {
              return { title: (x > 0 ? 'Позже на ' : 'Раньше на ') + Math.abs(x) + ' сек.', value: x };
            }),
            onBack: reopen,
            onSelect: function (b) {
              v.offset += b.value;
              v.manual = true;
              v.anchors = [];
              app.setVideoSync(v);
              app.learnResidual();
              app.resyncAll();
              reopen();
            }
          });
        }

        if (a.name === 'fps') {
          app.closeSelects();
          return Lampa.Select.show({
            title: 'Частота кадров видео',
            nohide: true,
            items: app.FPS.map(function (f) {
              return { title: f.title, scale: f.scale, selected: Math.abs(f.scale - v.scale) < 0.0005 };
            }),
            onBack: reopen,
            onSelect: function (b) {
              var t = app.videoTime(); // текущий момент остаётся на месте, меняется только скорость
              var o = (t - v.offset) / v.scale;
              v.scale = b.scale;
              v.offset = t - o * b.scale;
              v.manual = true;
              v.anchors = [];
              app.setVideoSync(v);
              app.resyncAll();
              reopen();
            }
          });
        }

        if (a.name === 'report') {
          app.closeSelects();
          return Lampa.Select.show({ title: 'Отчёт синхронизации', nohide: true, items: app.syncReport(), onBack: reopen, onSelect: reopen });
        }

        if (a.name === 'reset') {
          app.setVideoSync({ scale: 1, offset: 0, anchors: [] });
          if (app.session) { app.session.vsync = null; app.session.durDone = false; app.session.durWait = []; }
          app.resyncAll();
          app.durationSync();
          if (app.audio) { app.audio.samples = []; app.audio.told = false; }
          Lampa.Noty.show('Поправки для этого источника сброшены');
          return reopen();
        }
      }
    });
  };


  // Калибровка (calibration/checkpoints.js): 3 реплики вокруг текущего момента по текущей модели,
  // «ни одна не подходит» — следующие 3, «уже совпадают» — текущая модель становится ручной.
  app.calibrationMenu = function calibrationMenu(track, reopen, root, page, at, wasPlaying) {
    var text = app.texts[track.os_id] || '';
    var cues = subtitle.parse(text);
    if (!cues.length) {
      Lampa.Noty.show('Не удалось прочитать файл субтитров');
      return reopen();
    }
    page = page || 0;
    var vid = null;
    try { vid = Lampa.PlayerVideo.video(); } catch (e) {}
    if (typeof at !== 'number') {
      at = app.videoTime();
      wasPlaying = vid && !vid.paused;
      if (wasPlaying) try { vid.pause(); } catch (e) {}
    }
    var resume = function () {
      if (wasPlaying) try { vid.play(); } catch (e) {}
    };
    var toPlayer = app.cueFn(track.os_id);
    var f = app.fileSync(track.os_id);
    var toRef = function (ms) { return ms * f.scale + f.offset * 1000; };
    // варианты сдвига: текущая модель, без поправки, каждая гипотеза движка (в том числе отброшенные) —
    // показываем реплику, звучащую сейчас при каждом из них
    var maps = [toPlayer];
    var offs = [app.videoSync().offset * 1000];
    var addAlt = function (offMs, scale) {
      for (var q = 0; q < offs.length; q++) if (Math.abs(offs[q] - offMs) < 1000) return;
      offs.push(offMs);
      maps.push(function (ms) { return Math.round(toRef(ms) * (scale || 1) + offMs); });
    };
    addAlt(0, 1);
    var sm = app.session && app.session.model;
    if (sm) sm.used.concat(sm.rejected).forEach(function (h) { addAlt(h.offsetMs, h.scale); });
    if (app.session && app.session.lowProfile) addAlt(app.session.lowProfile.offsetMs, app.session.lowProfile.scale);
    if (app.audio && app.audio.wide) addAlt(app.audio.wide.offsetMs, 1);
    var ch = calibration.choices(cues, maps, at * 1000, page);
    var items = ch.items.map(function (x) {
      return { title: x.text.length > 90 ? x.text.slice(0, 90) + '…' : x.text, subtitle: app.fmtTime(x.playerMs / 1000).slice(0, 8), cue: cues[x.index] };
    });
    if (ch.more) items.push({ title: 'Ни одна не подходит', subtitle: 'Показать другие реплики', act: 'more' });
    items.push({ title: 'Субтитры уже совпадают', subtitle: 'Запомнить текущую синхронизацию', act: 'ok' });
    items.push({ title: 'Полный список реплик', act: 'list' });

    app.closeSelects();
    Lampa.Select.show({
      title: 'Какая фраза звучит сейчас?',
      nohide: true,
      items: items,
      onBack: function () {
        resume();
        reopen();
      },
      onSelect: function (b) {
        if (b.act === 'more') return app.calibrationMenu(track, reopen, root, page + 1, at, wasPlaying);
        if (b.act === 'list') return app.phraseMenu(track, reopen, root, at, wasPlaying);
        var s = app.session;
        if (b.act === 'ok') {
          var v0 = app.videoSync();
          app.addAnchor((at - v0.offset) / v0.scale, at, 'phrase');
          Lampa.Noty.show('Синхронизация запомнена');
        } else {
          var before = app.videoSync().offset;
          var pt = calibration.point(b.cue, toRef, at * 1000);
          var v = app.addAnchor(pt.o, pt.t, 'phrase');
          var next = calibration.nextPrompt(before * 1000, v.offset * 1000, s && s.model ? s.model['class'] : 'constant', at * 1000);
          if (s) s.secondAt = next;
          Lampa.Noty.show(next ? 'Сдвиг подобран. Через 10 минут предложу проверить ещё раз' : 'Сдвиг подобран');
        }
        if (s) s.calibrate = false;
        if (!app.isShowing()) {
          app.setCc(true);
          app.showTrack(track);
        }
        resume();
        root();
      }
    });
  };


  // вторая точка калибровки: подсказка, а не диалог посреди сцены
  app.checkSecondPrompt = function checkSecondPrompt() {
    var s = app.session;
    if (!s || !s.secondAt || !app.isShowing()) return;
    if (app.videoTime() * 1000 < s.secondAt) return;
    s.secondAt = null;
    app.notify('Проверьте синхронизацию: Субтитры → Синхронизация → По фразе');
  };

  app.phraseMenu = function phraseMenu(track, reopen, root, atGiven, playingGiven) {
    var cues = app.parseCues(app.texts[track.os_id] || '');
    if (!cues.length) {
      Lampa.Noty.show('Не удалось прочитать файл субтитров');
      return reopen();
    }
    var c = app.composed(track.os_id);
    var at = typeof atGiven === 'number' ? atGiven : app.videoTime();
    var vid = null;
    try { vid = Lampa.PlayerVideo.video(); } catch (e) {}
    var wasPlaying = typeof atGiven === 'number' ? playingGiven : vid && !vid.paused;
    if (wasPlaying && typeof atGiven !== 'number') try { vid.pause(); } catch (e) {}
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
        subtitle: app.fmtTime(tt).slice(0, 8),
        cue: cues[j],
        selected: j === near
      });
    }

    app.closeSelects();
    Lampa.Select.show({
      title: 'Какая фраза звучит сейчас?',
      nohide: true,
      items: items,
      onBack: function () {
        resume();
        reopen();
      },
      onSelect: function (b) {
        var both = app.anchorPhrase(track, b.cue, at);
        Lampa.Noty.show(both ? 'Сдвиг и скорость подобраны' : 'Сдвиг подобран. Для точности повторите через 10+ минут');
        resume();
        root();
      }
    });
  };


  // ---------- кнопка субтитров в плеере ----------
  app.SIZES = [
    { value: 'auto', title: 'Как в Lampa' },
    { value: 's', title: 'Маленький', em: 1.6 },
    { value: 'm', title: 'Средний', em: 2 },
    { value: 'l', title: 'Обычный', em: 2.5 },
    { value: 'xl', title: 'Крупный', em: 3 },
    { value: 'xxl', title: 'Очень крупный', em: 3.6 }
  ];

  app.SHADOWS = [
    { value: 'auto', title: 'Как в Lampa' },
    { value: 'none', title: 'Без тени' },
    { value: 'soft', title: 'Мягкая тень' },
    { value: 'outline', title: 'Обводка' },
    { value: 'backdrop', title: 'Тёмная подложка' }
  ];

  app.titleOf = function titleOf(list, value) {
    for (var i = 0; i < list.length; i++) if (list[i].value === value) return list[i].title;
    return list[0].title;
  };


  // Новая Lampa складывает селекты в стек; закрываем всё и рисуем меню заново, чтобы подписи были свежими
  app.closeSelects = function closeSelects() {
    if (Lampa.Select.closeAll) Lampa.Select.closeAll();
    else Lampa.Select.close();
  };


  // дорожка для калибровки: показанная неподтверждённая или скрытая после неудачной проверки
  app.calibTrack = function calibTrack() {
    var s = app.session;
    if (!s) return null;
    var on = app.isShowing();
    if (on && on.os_id && app.ui.decision && app.ui.decision.marker === 'unconfirmed' && !app.videoSync().manual) return on;
    if (s.calibrate && s.bg) return app.findTrack(s.bg);
    return null;
  };

  app.menu = function menu(back) {
    var subs = app.trackList();
    var on = null;
    for (var i = 0; i < subs.length; i++) if (subs[i].selected || subs[i].mode === 'showing') { on = subs[i]; break; }

    Lampa.Select.show({
      title: 'Субтитры',
      nohide: true,
      items: [
        { title: 'Язык субтитров', subtitle: (on ? (on.label || on.language || 'Дорожка') : 'Выключены') + (app.session && app.session.audio && app.setting('lang', 'audio') === 'audio' ? ' · озвучка: ' + app.langName(app.session.audio) : ''), name: 'lang' },
        { title: 'Размер шрифта', subtitle: app.titleOf(app.SIZES, app.setting('size', 'auto')), name: 'size' },
        { title: 'Тень шрифта', subtitle: app.titleOf(app.SHADOWS, app.setting('shadow', 'auto')), name: 'shadow' },
        { title: 'Синхронизация', subtitle: on && on.os_id ? app.syncTitle() : 'Для субтитров OpenSubtitles', name: 'sync' }
      ].concat(app.calibTrack() ? [{ title: 'Синхронизировать по фразе', subtitle: 'Синхронизация не подтверждена — выберите реплику, которая звучит', name: 'calib' }] : []),
      onBack: back,
      onSelect: function (a) {
        var again = function () {
          app.closeSelects();
          app.menu(back);
        };

        if (a.name === 'calib') return app.calibrationMenu(app.calibTrack(), again, back);

        if (a.name === 'lang') {
          var items = [{ title: 'Выключены', selected: !on, act: 'off' }];
          for (var j = 0; j < subs.length; j++) {
            items.push({ title: subs[j].label || subs[j].language || ('Дорожка ' + (j + 1)), selected: subs[j] === on, track: subs[j] });
          }
          // найденные, но ещё не скачанные варианты OpenSubtitles
          if (app.session) {
            var order = app.langOrder(app.session);
            for (var l = 0; l < order.length; l++) {
              var cand = app.session.found[order[l]] || [];
              for (var c = 0; c < cand.length; c++) {
                if (app.findTrack(cand[c].files[0].file_id)) continue;
                items.push({ title: app.trackLabel(cand[c]), subtitle: 'Скачать', cand: cand[c] });
              }
            }
          }
          if (items.length === 1) {
            Lampa.Noty.show(!app.apiKey() ? 'OpenSubtitles: укажите API-ключ в настройках плагина' : app.session && app.session.searching ? 'Ищу субтитры…' : 'Субтитры для этого видео не найдены');
            return again();
          }
          app.closeSelects();
          return Lampa.Select.show({
            title: 'Язык субтитров',
            items: items,
            nohide: true,
            onBack: again,
            onSelect: function (b) {
              if (b.act === 'off') {
                app.setCc(false);
                app.turnOff();
              } else if (b.track) {
                app.setCc(true);
                app.showTrack(b.track);
                app.maybeAutoSync(b.track);
              } else if (b.cand) {
                app.setCc(true);
                app.ensureTrack(b.cand, function (t) { app.showTrack(t); app.maybeAutoSync(t); }, function () {
                  Lampa.Noty.show('Не удалось скачать субтитры');
                });
              }
              back();
            }
          });
        }

        var list = a.name === 'size' ? app.SIZES : a.name === 'shadow' ? app.SHADOWS : null;
        if (list) {
          var cur = app.setting(a.name, 'auto');
          app.closeSelects();
          return Lampa.Select.show({
            title: a.title,
            items: list.map(function (o) { return { title: o.title, value: o.value, selected: o.value === cur }; }),
            nohide: true,
            onBack: again,
            onSelect: function (b) {
              Lampa.Storage.set('opensubs_' + a.name, b.value);
              app.applyStyle();
              again();
            }
          });
        }

        if (a.name === 'sync') {
          if (!on || !on.os_id || !app.texts[on.os_id]) {
            Lampa.Noty.show('Сначала включите субтитры OpenSubtitles');
            return again();
          }
          return app.syncMenu(on, again, back);
        }
      }
    });
  };

  app.openSettingsMenu = function openSettingsMenu() {
    var back = function () {
      app.closeSelects();
      Lampa.Controller.toggle(Lampa.Platform.screen('mobile') ? 'player' : 'player_panel');
    };
    app.closeSelects();
    app.menu(back);
  };


  // пункт «Субтитры» в настройках плеера (шестерёнка) открывает наше меню
  app.hookPlayerSettings = function hookPlayerSettings() {
    if (!Lampa.Select.listener) return;
    Lampa.Select.listener.follow('preshow', function (e) {
      var act = e && e.active;
      if (!act || !act.items || act._opensubs) return;
      if (!(Lampa.Player.opened && Lampa.Player.opened())) return;
      var item = null;
      for (var i = 0; i < act.items.length; i++) if (act.items[i] && act.items[i].method === 'subs') item = act.items[i];
      if (!item) return;
      act._opensubs = true;
      var on = app.isShowing();
      item.subtitle = on ? (on.label || 'Включены') : 'Выключены';
      var orig = act.onSelect;
      act.onSelect = function (a) {
        if (a && a.method === 'subs') return app.openSettingsMenu();
        return orig && orig.apply(this, arguments);
      };
    });
  };
};
  }
  };

  var cache = {};
  function resolve(from, to) {
    if (to.charAt(0) !== '.') return to;
    var parts = from.split('/');
    var segs = to.split('/');
    parts.pop();
    for (var i = 0; i < segs.length; i++) {
      if (segs[i] === '..') parts.pop();
      else if (segs[i] !== '.' && segs[i] !== '') parts.push(segs[i]);
    }
    return parts.join('/').replace(/\.js$/, '');
  }
  function load(id) {
    if (cache[id]) return cache[id].exports;
    if (!defs[id]) throw new Error('OpenSubs: нет модуля ' + id);
    var module = cache[id] = { exports: {} };
    defs[id].call(module.exports, module, module.exports, function (to) { return load(resolve(id, to)); });
    return module.exports;
  }
  load('index');
})();
