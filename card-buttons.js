/*
 * CardButtons — клиентский плагин Lampa (сервер не трогает).
 * В карточке фильма выносит в ряд кнопок отдельные кнопки UAFresh, «Онлайн» (Lampac) и «Торренты»
 * (штатно Lampa прячет их за «Смотреть»), убирает кнопки «Смотреть» и «Реакции» (счётчики реакций остаются).
 * Кнопки — копии спрятанных оригиналов: нажатие передаётся оригиналу, поэтому работают так же,
 * как из списка «Смотреть».
 * ES5, без сборщика.
 */
(function () {
  'use strict';
  if (window.cardbuttons_ready) return;
  window.cardbuttons_ready = true;

  var SPECS = [
    { key: 'uafresh', test: function (b) { return /ua\s*-?\s*fresh/i.test(b.text() + ' ' + (b.attr('class') || '') + ' ' + (b.attr('data-subtitle') || '')); } },
    { key: 'online', test: function (b) { return b.hasClass('lampac--button'); } },
    { key: 'torrent', test: function (b) { return b.hasClass('view--torrent'); } }
  ];

  function originals(container) {
    return container.children('.full-start__button').not('.hide').not('.cbx-btn');
  }

  function sync(root) {
    var row = root.find('.full-start-new__buttons').first();
    var container = root.find('.buttons--container').first();
    if (!row.length || !container.length) return;
    var changed = false;

    var extra = row.find('.button--reaction, .button--play');
    if (extra.length) { extra.remove(); changed = true; }

    var anchor = null; // последняя вставленная наша кнопка
    var list = originals(container);

    SPECS.forEach(function (spec) {
      var orig = null;
      list.each(function () { if (!orig && spec.test($(this))) orig = $(this); });
      var clone = row.find('.cbx-btn[data-cbx="' + spec.key + '"]');

      if (!orig) {
        if (clone.length) { clone.remove(); changed = true; }
        return;
      }
      if (clone.length && clone.data('cbx-orig') === orig[0]) { anchor = clone; return; }
      if (clone.length) clone.remove();

      clone = orig.clone();
      clone.removeClass('focus hide view--torrent view--online lampac--button shots-view-button button--priority')
        .addClass('cbx-btn selector').attr('data-cbx', spec.key).data('cbx-orig', orig[0]);
      clone.on('hover:enter', function () { orig.trigger('hover:enter'); });

      if (anchor) anchor.after(clone);
      else row.prepend(clone);
      anchor = clone;
      changed = true;
    });

    // Lampa показывает «приоритетную» копию одной из кнопок (долгое нажатие в «Смотреть»); если это наша — она лишняя
    row.find('.button--priority').each(function () {
      var p = $(this), dup = false;
      row.find('.cbx-btn').each(function () { if ($(this).find('span').text() === p.find('span').text()) dup = true; });
      if (dup) { p.remove(); changed = true; }
    });

    if (changed) refocus(root);
  }

  function refocus(root) {
    try {
      var ctr = Lampa.Controller.enabled();
      if (ctr && ctr.name === 'full_start') {
        var focused = root.find('.full-start-new__buttons .focus')[0];
        Lampa.Controller.collectionSet(root);
        Lampa.Controller.collectionFocus(focused && document.body.contains(focused) ? focused : false, root);
      }
    } catch (e) {}
  }

  function attach(root) {
    if (!root || !root.length || root.data('cbx-attached')) return;
    root.data('cbx-attached', true);
    var timer = 0;
    var later = function () { clearTimeout(timer); timer = setTimeout(function () { sync(root); }, 50); };
    sync(root);
    var container = root.find('.buttons--container')[0];
    if (container && window.MutationObserver) {
      new MutationObserver(later).observe(container, { childList: true, subtree: false, attributes: true, attributeFilter: ['class'] });
    }
    // кнопки плагинов могут появиться позже
    setTimeout(later, 1000);
    setTimeout(later, 4000);
  }

  function start() {
    Lampa.Listener.follow('full', function (e) {
      if (e.type !== 'complite') return;
      var root = e.object && e.object.activity && e.object.activity.render ? $(e.object.activity.render()) : $('.activity--active');
      attach(root);
    });
    var active = $('.activity--active');
    if (active.find('.full-start-new__buttons').length) attach(active);
  }

  if (window.appready) start();
  else Lampa.Listener.follow('app', function (e) { if (e.type === 'ready') start(); });
})();
