/*
 * LampaUi — общие улучшения интерфейса Lampa (Lampac NextGen).
 * Отдаётся модулем Lampac: /lampaui.js. Стили — plugin.css (сервер встраивает их в строку CSS ниже).
 * ES5: Lampa работает и на старых ТВ-браузерах.
 */
(function () {
  'use strict';

  if (window.lampaui_ready) return;
  window.lampaui_ready = true;

  var CSS = "/*\n * LampaUi — общие стили Lampa по макетам Figma «lampac» (телефон 390px):\n *  шапка — 154:2394 (Rectangle 6 + строка 64px), нижнее меню — 154:3417 + 154:3442.\n *\n * Обводки в макете — белые в режиме overlay. Белый (непрозрачность a) в overlay над тёмным = яркость ×(1+a):\n * это backdrop-filter: brightness(1+a). mix-blend-mode здесь не работает: слои Lampa изолированы\n * (will-change, z-index, backdrop-filter) и overlay смешивался бы с прозрачностью — обводка стала бы белой.\n * Поэтому обводка — кольцо 1px (маска) с backdrop-filter. Размытие подложки — в ::before, не на элементе:\n * иначе элемент становится «корнем» для фильтров внутри, и кольцо видело бы только его собственный фон.\n */\n\n/* ---------- шапка (все экраны) ---------- */\n\n.head {\n  background: rgba(0, 0, 0, 0.16);\n  -webkit-backdrop-filter: blur(16px) saturate(1.5);\n  backdrop-filter: blur(16px) saturate(1.5);\n  border-bottom: 1px solid rgba(255, 255, 255, 0.08);\n}\n\n@supports not ((-webkit-backdrop-filter: blur(1px)) or (backdrop-filter: blur(1px))) {\n  .head { background: rgba(0, 0, 0, 0.48); }\n}\n\nbody.lampaui--lite .head {\n  -webkit-backdrop-filter: none;\n  backdrop-filter: none;\n  background: rgba(0, 0, 0, 0.48);\n}\n\n/* ---------- обводка «overlay» ----------\n   Белый в overlay над тёмным = яркость ×2; над фоном экрана это ≈ белый 12%. Обычная рамка, не backdrop-filter:\n   Safari не обрезает backdrop-filter маской, и «кольцо» осветляло весь элемент поверх содержимого. */\n\n.lui-ring::after,\nbody.true--mobile .navigation-bar__body::after,\nbody.true--mobile .selectbox__content::after,\nbody.true--mobile .settings__content::after {\n  content: '';\n  position: absolute;\n  top: 0;\n  left: 0;\n  right: 0;\n  bottom: 0;\n  border: 1px solid rgba(255, 255, 255, 0.12);\n  border-radius: inherit;\n  pointer-events: none;\n}\n\n/* ---------- телефон: шапка 64px (154:2394) ---------- */\n\nbody.true--mobile .head {\n  padding-top: env(safe-area-inset-top); /* подложка заходит под статус-бар (viewport-fit=cover ставит plugin.js) */\n  background: transparent;\n  -webkit-backdrop-filter: none;\n  backdrop-filter: none;\n  border-bottom: 0;\n}\n\n/* подложка: чёрный 24% + размытие 16px */\nbody.true--mobile .head::before {\n  content: '';\n  position: absolute;\n  top: 0;\n  left: 0;\n  right: 0;\n  bottom: 0;\n  background: rgba(0, 0, 0, 0.24);\n  -webkit-backdrop-filter: blur(16px) saturate(1.5);\n  backdrop-filter: blur(16px) saturate(1.5);\n  pointer-events: none;\n}\n\n/* нижняя линия: белый 48% в overlay над тёмной шапкой ≈ белый 12% */\nbody.true--mobile .head::after {\n  content: '';\n  position: absolute;\n  left: 0;\n  right: 0;\n  bottom: 0;\n  height: 1px;\n  background: rgba(255, 255, 255, 0.12);\n  pointer-events: none;\n}\n\nbody.true--mobile .head__body {\n  position: relative;\n  height: 64px;\n  box-sizing: border-box;\n  padding: 0 16px !important;\n  display: flex;\n  align-items: center;\n}\n\n/* контент начинается ровно под шапкой */\nbody.true--mobile .wrap__content {\n  padding-top: calc(64px + env(safe-area-inset-top)) !important;\n}\n\n/* кнопку меню из шапки убираем — меню открывается из нижней панели; время на телефоне не нужно */\nbody.true--mobile .head__menu-icon,\nbody.true--mobile .head__logo-icon,\nbody.true--mobile .head__time {\n  display: none !important;\n}\n\nbody.true--mobile .head__title {\n  flex: 1 1 auto;\n  min-width: 0;\n  margin: 0 !important;\n  font-size: 20px !important;\n  line-height: 24px !important;\n  font-weight: 500;\n  color: #fff;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n\nbody.true--mobile .head__actions {\n  display: flex;\n  align-items: center;\n  margin: 0 0 0 8px !important;\n}\n\n/* в шапке телефона — только колокольчик и профиль (154:2394); поиск и настройки — в нижней панели */\nbody.true--mobile .head__action {\n  display: none !important;\n}\n\nbody.true--mobile .head__action.notice--icon,\nbody.true--mobile .head__action.open--notice,\nbody.true--mobile .head__action.open--profile {\n  display: flex !important;\n}\n\n/* кнопки шапки: 40×40, иконка 24, отступ 8 */\nbody.true--mobile .head__action.notice--icon,\nbody.true--mobile .head__action.open--notice,\nbody.true--mobile .head__action.open--profile {\n  width: 40px !important;\n  height: 40px !important;\n  margin: 0 0 0 8px !important;\n  padding: 8px !important;\n  box-sizing: border-box;\n  border-radius: 99px !important;\n  align-items: center;\n  justify-content: center;\n  background: transparent;\n  color: #fff;\n}\n\nbody.true--mobile .head__action > svg,\nbody.true--mobile .head__action .lui-ico {\n  width: 24px !important;\n  height: 24px !important;\n}\n\n/* колокольчик — с подложкой, как в макете */\nbody.true--mobile .head__action.notice--icon,\nbody.true--mobile .head__action.open--notice {\n  background: rgba(255, 255, 255, 0.08) !important;\n}\n\n/* три точки состояния справа: 4×20, 8px от кнопок */\nbody.true--mobile .head__markers {\n  display: flex !important;\n  flex-direction: column;\n  justify-content: space-between;\n  width: 4px;\n  height: 20px;\n  margin: 0 0 0 8px !important;\n}\n\nbody.true--mobile .head__markers-item {\n  width: 4px !important;\n  height: 4px !important;\n  margin: 0 !important;\n  border-radius: 50%;\n  background: rgba(255, 255, 255, 0.24) !important;\n}\n\nbody.true--mobile .head__markers-item.status--live,\nbody.true--mobile .head__markers-item.status--active,\nbody.true--mobile .head__markers-item.status--online {\n  background: #76e67a !important;\n}\n\n/* ---------- телефон: нижнее меню (154:3417 «таблетка» + 154:3442 поиск) ---------- */\n\n/* Контейнер нулевой высоты: Lampa вычитает высоту .navigation-bar из высоты ленты, и под панелью\n   оставалась пустая полоса с фоном страницы. Теперь лента идёт под панель, как в макете. */\nbody.true--mobile.orientation--portrait .navigation-bar {\n  display: block;\n  top: auto;\n  left: 0;\n  right: 0;\n  bottom: 0;\n  height: 0;\n  padding: 0;\n  background: none !important;\n  overflow: visible;\n}\n\nbody.true--mobile .navigation-bar__body,\n.lui-nav-search {\n  position: absolute;\n  height: 64px;\n  box-sizing: border-box;\n  border-radius: 32px !important;\n  background: transparent !important;\n  -webkit-backdrop-filter: none !important;\n  backdrop-filter: none !important;\n  box-shadow: none !important;\n}\n\nbody.true--mobile.orientation--portrait .navigation-bar__body {\n  left: 16px;\n  right: 86px; /* 16 + 64 + 6 */\n  bottom: calc(15px + env(safe-area-inset-bottom));\n}\n\nbody.true--mobile.orientation--portrait .lui-nav-search {\n  right: 16px;\n  bottom: calc(15px + env(safe-area-inset-bottom));\n}\n\n/* подложка: чёрный 64% + размытие 8px */\nbody.true--mobile .navigation-bar__body::before,\n.lui-nav-search::before {\n  content: '';\n  position: absolute;\n  top: 0;\n  left: 0;\n  right: 0;\n  bottom: 0;\n  border-radius: inherit;\n  background: rgba(0, 0, 0, 0.64);\n  -webkit-backdrop-filter: blur(8px) saturate(1.5);\n  backdrop-filter: blur(8px) saturate(1.5);\n  pointer-events: none;\n}\n\nbody.true--mobile .navigation-bar__body {\n  display: flex !important;\n  align-items: center;\n  padding: 0 4px !important;\n  margin: 0 !important;\n}\n\nbody.true--mobile .navigation-bar__item {\n  position: relative;\n  flex: 1 1 0;\n  min-width: 0;\n  height: 56px;\n  margin: 0 !important;\n  padding: 0 !important;\n  display: flex !important;\n  align-items: center;\n  justify-content: center;\n  border-radius: 100px;\n  color: #fff;\n  opacity: 1 !important;\n}\n\n/* только эффект нажатия: белый 16% (в макете — plus-lighter). Без mix-blend-mode: режим наложения у потомка\n   заставляет браузер изолировать весь слой меню, и размытие подложки ::before видело бы только само меню,\n   а не страницу под ним — стекло панели не размывало фон. */\nbody.true--mobile .navigation-bar__item::before {\n  content: '';\n  position: absolute;\n  top: 0;\n  left: 0;\n  right: 0;\n  bottom: 0;\n  border-radius: 100px;\n  background: rgba(255, 255, 255, 0.16);\n  opacity: 0;\n  -webkit-transition: opacity 0.15s;\n  transition: opacity 0.15s;\n  pointer-events: none;\n}\n\nbody.true--mobile .navigation-bar__item:active::before,\nbody.true--mobile .navigation-bar__item.lui-pressed::before {\n  opacity: 1;\n}\n\nbody.true--mobile .navigation-bar__icon {\n  position: relative;\n  width: 24px !important;\n  height: 24px !important;\n  margin: 0 !important;\n}\n\nbody.true--mobile .navigation-bar__icon svg {\n  display: block;\n  width: 24px !important;\n  height: 24px !important;\n}\n\nbody.true--mobile .navigation-bar__label {\n  display: none !important;\n}\n\n.lui-nav-search {\n  width: 64px;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  color: #fff;\n}\n\nbody.true--mobile .lui-nav-search .navigation-bar__item {\n  -webkit-flex: 0 0 64px;\n  flex: 0 0 64px;\n  width: 64px;\n  height: 64px;\n  border-radius: 50%;\n}\n\n/* нажатие на поиск — круг во весь кружок, а не «таблетка» пунктов */\nbody.true--mobile .lui-nav-search .navigation-bar__item::before {\n  border-radius: 50%;\n}\n\n/* место под нижнее меню в конце прокручиваемых списков */\nbody.true--mobile.orientation--portrait .activity__body .scroll__body {\n  padding-bottom: calc(96px + env(safe-area-inset-bottom)) !important;\n}\n\n/* альбомная ориентация: колонка справа */\nbody.true--mobile.orientation--landscape .navigation-bar {\n  display: flex;\n  flex-direction: column;\n  justify-content: center;\n  padding: 16px 16px 16px 0;\n  background: none !important;\n}\n\nbody.true--mobile.orientation--landscape .navigation-bar__body,\nbody.true--mobile.orientation--landscape .lui-nav-search {\n  position: relative;\n}\n\nbody.true--mobile.orientation--landscape .navigation-bar__body {\n  flex-direction: column;\n  height: auto;\n  width: 64px;\n  padding: 4px 0 !important;\n}\n\nbody.true--mobile.orientation--landscape .navigation-bar__item {\n  flex: 0 0 56px;\n  width: 56px;\n}\n\nbody.true--mobile.orientation--landscape .lui-nav-search {\n  margin-top: 6px;\n}\n\n/* ---------- телефон: меню — выезжает слева поверх всей страницы ---------- */\n\n/* .wrap (z-index 10) иначе запирает меню под шапкой (15) и нижней панелью */\nbody.true--mobile .wrap {\n  z-index: auto;\n}\n\nbody.true--mobile .wrap__left {\n  position: fixed !important;\n  top: 0;\n  bottom: 0;\n  left: 0;\n  width: 288px !important;\n  max-width: 85vw;\n  margin: 0 !important;\n  padding: calc(16px + env(safe-area-inset-top)) 0 calc(16px + env(safe-area-inset-bottom)) !important;\n  box-sizing: border-box;\n  z-index: 120;\n  border-radius: 0 32px 32px 0;\n  visibility: hidden;\n  -webkit-transform: translate3d(-100%, 0, 0) !important;\n  transform: translate3d(-100%, 0, 0) !important;\n  -webkit-transition: -webkit-transform 0.25s ease-out, visibility 0s 0.25s;\n  transition: transform 0.25s ease-out, visibility 0s 0.25s;\n}\n\n/* подложка как у шторок: чёрный 72% + размытие 12px */\nbody.true--mobile .wrap__left::before {\n  content: '';\n  position: absolute;\n  top: 0;\n  left: 0;\n  right: 0;\n  bottom: 0;\n  border-radius: inherit;\n  background: rgba(0, 0, 0, 0.72);\n  -webkit-backdrop-filter: blur(12px) saturate(1.5);\n  backdrop-filter: blur(12px) saturate(1.5);\n  pointer-events: none;\n}\n\nbody.true--mobile .wrap__left > * {\n  position: relative;\n}\n\nbody.true--mobile.menu--open .wrap__left {\n  visibility: visible;\n  -webkit-transform: translate3d(0, 0, 0) !important;\n  transform: translate3d(0, 0, 0) !important;\n  -webkit-transition: -webkit-transform 0.25s ease-out, visibility 0s;\n  transition: transform 0.25s ease-out, visibility 0s;\n}\n\n/* страница остаётся на месте */\nbody.true--mobile.menu--open .wrap__content {\n  -webkit-transform: none !important;\n  transform: none !important;\n}\n\nbody.true--mobile.menu--open .background {\n  opacity: 1;\n}\n\n.lui-menu-dim {\n  position: fixed;\n  top: 0;\n  left: 0;\n  right: 0;\n  bottom: 0;\n  z-index: 119;\n  background: rgba(0, 0, 0, 0.4);\n  opacity: 0;\n  visibility: hidden;\n  -webkit-transition: opacity 0.25s, visibility 0s 0.25s;\n  transition: opacity 0.25s, visibility 0s 0.25s;\n}\n\nbody.true--mobile.menu--open .lui-menu-dim {\n  opacity: 1;\n  visibility: visible;\n  -webkit-transition: opacity 0.25s, visibility 0s;\n  transition: opacity 0.25s, visibility 0s;\n}\n\n/* пункты меню — в языке макетов: 48px, радиус 12, иконка 24, текст 16 */\nbody.true--mobile .wrap__left .menu__item {\n  display: flex;\n  align-items: center;\n  height: 48px;\n  margin: 0 16px 4px !important;\n  padding: 0 12px !important;\n  border-radius: 12px !important;\n  background: transparent;\n  color: #fff;\n}\n\nbody.true--mobile .wrap__left .menu__item.focus,\nbody.true--mobile .wrap__left .menu__item.hover,\nbody.true--mobile .wrap__left .menu__item.active {\n  background: rgba(255, 255, 255, 0.16) !important;\n  color: #fff !important;\n}\n\nbody.true--mobile .wrap__left .menu__ico {\n  width: 24px !important;\n  height: 24px !important;\n  margin-right: 12px !important;\n}\n\nbody.true--mobile .wrap__left .menu__text {\n  font-size: 16px !important;\n  line-height: 20px !important;\n  font-weight: 500;\n}\n\nbody.true--mobile .wrap__left .menu__split {\n  margin: 12px 28px !important;\n  border-color: rgba(255, 255, 255, 0.08) !important;\n}\n\n\n/* ---------- телефон: штатные шторки Lampa (списки выбора, настройки) в стиле 154:2775 ---------- */\n\nbody.true--mobile .selectbox__layer,\nbody.true--mobile .settings__layer {\n  background: transparent !important; /* в макете страница под шторкой не затемняется */\n  -webkit-backdrop-filter: none !important;\n  backdrop-filter: none !important;\n}\n\n/* position не трогаем: Lampa держит шторку fixed у нижнего края и прячет её transform */\nbody.true--mobile .selectbox__content,\nbody.true--mobile .settings__content {\n  box-sizing: border-box;\n  padding: 16px 0 calc(16px + env(safe-area-inset-bottom)) !important;\n  border-radius: 32px 32px 0 0 !important;\n  background: transparent !important;\n  box-shadow: none !important;\n  color: #fff;\n}\n\n/* подложка: чёрный 72% + размытие 12px */\nbody.true--mobile .selectbox__content::before,\nbody.true--mobile .settings__content::before {\n  content: '';\n  position: absolute;\n  top: 0;\n  left: 0;\n  right: 0;\n  bottom: 0;\n  border-radius: inherit;\n  background: rgba(0, 0, 0, 0.72);\n  -webkit-backdrop-filter: blur(12px) saturate(1.5);\n  backdrop-filter: blur(12px) saturate(1.5);\n  pointer-events: none;\n}\n\nbody.true--mobile .selectbox__content > *,\nbody.true--mobile .settings__content > * {\n  position: relative;\n}\n\n/* шапка: заголовок 20/24 слева (отступ 8), круглый крестик 40 справа */\nbody.true--mobile .selectbox__head,\nbody.true--mobile .settings__head {\n  display: flex !important;\n  align-items: center;\n  justify-content: space-between;\n  min-height: 40px;\n  margin: 0 16px 16px !important;\n  padding: 0 0 0 8px !important;\n  background: none !important;\n  border: 0 !important;\n}\n\nbody.true--mobile .selectbox__title,\nbody.true--mobile .settings__title {\n  min-width: 0;\n  margin: 0 !important;\n  padding: 0 !important;\n  font-size: 20px !important;\n  line-height: 24px !important;\n  font-weight: 500;\n  color: #fff !important;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n\n/* крестик 154:3017: круг 40, белый 12% + размытие 8, обводка 24%, иконка 24 */\n.lui-sheet-close {\n  position: relative;\n  flex: 0 0 40px;\n  width: 40px;\n  height: 40px;\n  margin-left: 16px;\n  box-sizing: border-box;\n  border-radius: 32px;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  background: rgba(255, 255, 255, 0.12);\n  /* обводка в макете — белый 24% в режиме Overlay: на тёмной подложке это лишь ~+10 к яркости заливки */\n  border: 1px solid rgba(255, 255, 255, 0.05);\n  color: #fff;\n  cursor: pointer;\n  -webkit-tap-highlight-color: transparent;\n}\n\n.lui-sheet-close svg {\n  display: block;\n  flex: 0 0 24px;\n  width: 24px !important;\n  height: 24px !important;\n  margin: 0 !important;\n  pointer-events: none;\n}\n\nbody.true--mobile .selectbox__body,\nbody.true--mobile .settings__body {\n  padding: 0 16px !important;\n}\n\n/* без затухания сверху/снизу: первый пункт виден целиком */\nbody.true--mobile .selectbox__body .scroll--mask,\nbody.true--mobile .settings__body .scroll--mask,\nbody.true--mobile .wrap__left .scroll--mask {\n  -webkit-mask-image: none !important;\n  mask-image: none !important;\n}\n\nbody.true--mobile .selectbox__body .scroll__content,\nbody.true--mobile .settings__body .scroll__content {\n  padding-top: 0 !important;\n  padding-bottom: 0 !important;\n}\n\nbody.true--mobile .selectbox__body .scroll__body,\nbody.true--mobile .settings__body .scroll__body {\n  padding: 0 0 8px !important;\n}\n\n/* пункты — как в меню: 48px, радиус 12, без подложки и обводки; фокус и выбранный — белый 16% */\nbody.true--mobile .selectbox-item,\nbody.true--mobile .settings-folder,\nbody.true--mobile .settings-param {\n  position: relative;\n  margin: 0 0 4px !important;\n  padding: 14px 12px !important;\n  min-height: 48px;\n  box-sizing: border-box;\n  border-radius: 12px !important;\n  background: transparent !important;\n  color: #fff !important;\n  box-shadow: none !important;\n  -webkit-transform: none !important;\n  transform: none !important;\n}\n\n/* у Lampa на ::after выбранного пункта — галочка; рамок у пунктов нет */\nbody.true--mobile .selectbox-item::after,\nbody.true--mobile .settings-folder::after,\nbody.true--mobile .settings-param::after {\n  display: none !important;\n}\n\nbody.true--mobile .selectbox-item.focus,\nbody.true--mobile .settings-folder.focus,\nbody.true--mobile .settings-param.focus,\nbody.true--mobile .selectbox-item.hover,\nbody.true--mobile .settings-folder.hover,\nbody.true--mobile .settings-param.hover,\nbody.true--mobile .selectbox-item.selected,\nbody.true--mobile .selectbox-item.picked {\n  background: rgba(255, 255, 255, 0.16) !important;\n  color: #fff !important;\n}\n\nbody.true--mobile .selectbox-item__title,\nbody.true--mobile .settings-folder__name,\nbody.true--mobile .settings-param__name {\n  font-size: 16px !important;\n  line-height: 20px !important;\n  font-weight: 500;\n  color: #fff !important;\n}\n\nbody.true--mobile .selectbox-item__subtitle,\nbody.true--mobile .settings-param__descr,\nbody.true--mobile .settings-param__value {\n  margin-top: 4px;\n  font-size: 12px !important;\n  line-height: 14px !important;\n  color: rgba(255, 255, 255, 0.48) !important;\n  opacity: 1 !important;\n}\n\nbody.true--mobile .settings-folder {\n  display: flex !important;\n  align-items: center;\n  padding-top: 12px !important;\n  padding-bottom: 12px !important;\n}\n\nbody.true--mobile .settings-folder__icon {\n  width: 24px !important;\n  height: 24px !important;\n  margin: 0 12px 0 0 !important;\n  flex: 0 0 24px;\n}\n\nbody.true--mobile .settings-folder__icon svg,\nbody.true--mobile .settings-folder__icon img {\n  width: 24px !important;\n  height: 24px !important;\n}\n\n\n/* ---------- псевдостекло (по мотивам watched.cx): блик по верхней кромке + мягкая тень ---------- */\n\nbody.true--mobile .navigation-bar__body,\nbody.true--mobile .lui-nav-search {\n  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.28);\n}\n\n/* блик — на кольце-обводке (::after), подложка ::before иначе закрыла бы его */\nbody.true--mobile .navigation-bar__body::after,\n.lui-ring::after,\nbody.true--mobile .selectbox__content::after,\nbody.true--mobile .settings__content::after,\nbody.true--mobile .wrap__left::after {\n  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.22);\n}\n\nbody.true--mobile .wrap__left::after {\n  content: '';\n  position: absolute;\n  top: 0;\n  left: 0;\n  right: 0;\n  bottom: 0;\n  border: 1px solid rgba(255, 255, 255, 0.12);\n  border-left: 0;\n  border-radius: inherit;\n  pointer-events: none;\n}\n\n.lui-sheet-close {\n  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.22);\n}\n\nbody.true--mobile .head__action.open--notice,\nbody.true--mobile .head__action.notice--icon {\n  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.14);\n}\n\n/* ---------- тест: «жидкое стекло» нижнего меню (по мотивам codepen.io/fooontic/pen/KwpRaGr) ----------\n   body.lui-liquid — блики, тени и «капля» (везде, где есть нижнее меню);\n   body.lui-liquid-refract — ещё и преломление краёв: backdrop-filter с url(#…) (только Chromium,\n   фильтры #lui-lg-nav / #lui-lg-search строит plugin.js: карта и параметры пена 1:1, в долях элемента).\n   Значения — тёмная тема пена: стекло #bbbbbc 12%, блики белым ×0.3, тени чёрным ×2, насыщенность 150%. */\n\nbody.lui-liquid .navigation-bar__body::before,\nbody.lui-liquid .lui-nav-search::before {\n  background: rgba(187, 187, 188, 0.12);\n  -webkit-backdrop-filter: blur(8px) saturate(1.5);\n  backdrop-filter: blur(8px) saturate(1.5);\n}\n\n/* Safari такую строку отбросит целиком (url в backdrop-filter не понимает) — останется строка выше */\nbody.lui-liquid-refract .navigation-bar__body::before {\n  backdrop-filter: blur(8px) url(#lui-lg-nav) saturate(1.5);\n}\nbody.lui-liquid-refract .lui-nav-search::before {\n  backdrop-filter: blur(8px) url(#lui-lg-search) saturate(1.5);\n}\n\n/* кромка: блики сверху-слева, тени снизу-справа (вместо кольца 1px) */\nbody.lui-liquid .navigation-bar__body::after,\nbody.lui-liquid .lui-nav-search.lui-ring::after {\n  border: 0;\n  box-shadow:\n    inset 0 0 0 1px rgba(255, 255, 255, 0.03),\n    inset 1.8px 3px 0 -2px rgba(255, 255, 255, 0.27),\n    inset -2px -2px 0 -2px rgba(255, 255, 255, 0.24),\n    inset -3px -8px 1px -6px rgba(255, 255, 255, 0.18),\n    inset -0.3px -1px 4px 0 rgba(0, 0, 0, 0.24),\n    inset -1.5px 2.5px 0 -2px rgba(0, 0, 0, 0.4),\n    inset 0 3px 4px -2px rgba(0, 0, 0, 0.4),\n    inset 2px -6.5px 1px -4px rgba(0, 0, 0, 0.2);\n}\n\nbody.lui-liquid .navigation-bar__body,\nbody.lui-liquid .lui-nav-search {\n  box-shadow:\n    0 1px 5px 0 rgba(0, 0, 0, 0.2),\n    0 6px 16px 0 rgba(0, 0, 0, 0.16) !important;\n}\n\n/* «капля» под текущим разделом */\n.lui-lg-thumb {\n  position: absolute;\n  left: 0;\n  top: 4px;\n  border-radius: 100px;\n  background: rgba(187, 187, 188, 0.36);\n  box-shadow:\n    inset 0 0 0 1px rgba(255, 255, 255, 0.03),\n    inset 2px 1px 0 -1px rgba(255, 255, 255, 0.27),\n    inset -1.5px -1px 0 -1px rgba(255, 255, 255, 0.24),\n    inset -2px -6px 1px -5px rgba(255, 255, 255, 0.18),\n    inset -1px 2px 3px -1px rgba(0, 0, 0, 0.4),\n    inset 0 -4px 1px -2px rgba(0, 0, 0, 0.2),\n    0 3px 6px 0 rgba(0, 0, 0, 0.16);\n  pointer-events: none;\n  -webkit-transition: -webkit-transform 400ms cubic-bezier(1, 0, 0.4, 1), opacity 200ms;\n  transition: transform 400ms cubic-bezier(1, 0, 0.4, 1), opacity 200ms;\n}\n.lui-lg-thumb--hidden { opacity: 0; }\n.lui-lg-thumb--pulse { -webkit-animation: lui-lg-pulse 440ms ease; animation: lui-lg-pulse 440ms ease; }\n\n/* пружинка через scale отдельным свойством: transform занят перемещением */\n@-webkit-keyframes lui-lg-pulse { 0% { scale: 1 1; } 50% { scale: 1.2 1; } 100% { scale: 1 1; } }\n@keyframes lui-lg-pulse { 0% { scale: 1 1; } 50% { scale: 1.2 1; } 100% { scale: 1 1; } }\n\n/* с «каплей» подсветка нажатия не нужна */\nbody.lui-liquid .navigation-bar__body .navigation-bar__item::before { display: none; }\n";

  function injectStyles() {
    if (document.getElementById('lampaui-css')) return;
    var style = document.createElement('style');
    style.id = 'lampaui-css';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  // ---------- статус-бар: подложка шапки заходит под него ----------

  function viewportCover() {
    var meta = document.querySelector('meta[name="viewport"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'viewport';
      meta.content = 'width=device-width, initial-scale=1.0';
      document.head.appendChild(meta);
    }
    if (meta.content.indexOf('viewport-fit') < 0) meta.content += ', viewport-fit=cover';
  }

  // Цвет системных панелей (Android Chrome, старые iOS): страницы могут задать свой через lampaui:theme
  function themeColor(color) {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'theme-color';
      document.head.appendChild(meta);
    }
    if (!meta.getAttribute('data-lui-default')) meta.setAttribute('data-lui-default', meta.content || '#1d1f20');
    meta.content = color || meta.getAttribute('data-lui-default');
  }

  // ---------- нижнее меню телефона (154:2394) ----------

  // Иконки — из макета Figma 154:2394 (ассеты как есть, только stroke → currentColor)
  var ICONS = {
    back: '<path d="M14 18L8 12L14 6"/>',
    menu: '<path d="M4 5H20"/><path d="M4 12H20"/><path d="M4 19H20"/>',
    main: '<path d="M3 10C2.99993 9.70907 3.06333 9.42162 3.18579 9.15772C3.30824 8.89381 3.4868 8.6598 3.709 8.472L10.709 2.472C11.07 2.16691 11.5274 1.99952 12 1.99952C12.4726 1.99952 12.93 2.16691 13.291 2.472L20.291 8.472C20.5132 8.6598 20.6918 8.89381 20.8142 9.15772C20.9367 9.42162 21.0001 9.70907 21 10V19C21 19.5304 20.7893 20.0391 20.4142 20.4142C20.0391 20.7893 19.5304 21 19 21H5C4.46957 21 3.96086 20.7893 3.58579 20.4142C3.21071 20.0391 3 19.5304 3 19V10Z"/>',
    bookmarks: '<path d="M17 3C17.5304 3 18.0391 3.21071 18.4142 3.58579C18.7893 3.96086 19 4.46957 19 5V20C18.9999 20.1751 18.9539 20.3472 18.8665 20.4989C18.7791 20.6506 18.6533 20.7767 18.5019 20.8646C18.3504 20.9525 18.1785 20.9991 18.0034 20.9997C17.8283 21.0003 17.6561 20.9549 17.504 20.868L12.992 18.29C12.6899 18.1174 12.3479 18.0266 12 18.0266C11.6521 18.0266 11.3101 18.1174 11.008 18.29L6.496 20.868C6.34394 20.9549 6.17174 21.0003 5.99662 20.9997C5.8215 20.9991 5.64961 20.9525 5.49814 20.8646C5.34667 20.7767 5.22094 20.6506 5.13352 20.4989C5.0461 20.3472 5.00006 20.1751 5 20V5C5 4.46957 5.21071 3.96086 5.58579 3.58579C5.96086 3.21071 6.46957 3 7 3H17Z"/>',
    settings: '<path d="M21 16V8C20.9996 7.64927 20.9071 7.30481 20.7315 7.00116C20.556 6.69752 20.3037 6.44536 20 6.27L13 2.27C12.696 2.09446 12.3511 2.00205 12 2.00205C11.6489 2.00205 11.304 2.09446 11 2.27L4 6.27C3.69626 6.44536 3.44398 6.69752 3.26846 7.00116C3.09294 7.30481 3.00036 7.64927 3 8V16C3.00036 16.3507 3.09294 16.6952 3.26846 16.9988C3.44398 17.3025 3.69626 17.5546 4 17.73L11 21.73C11.304 21.9055 11.6489 21.998 12 21.998C12.3511 21.998 12.696 21.9055 13 21.73L20 17.73C20.3037 17.5546 20.556 17.3025 20.7315 16.9988C20.9071 16.6952 20.9996 16.3507 21 16Z"/><path d="M16 12C16 14.2091 14.2091 16 12 16C9.79086 16 8 14.2091 8 12C8 9.79086 9.79086 8 12 8C14.2091 8 16 9.79086 16 12Z"/>',
    search: '<path d="M21 21L16.66 16.66"/><path d="M19 11C19 15.4183 15.4183 19 11 19C6.58172 19 3 15.4183 3 11C3 6.58172 6.58172 3 11 3C15.4183 3 19 6.58172 19 11Z"/>',
    bell: '<path d="M10.2676 21C10.4431 21.304 10.6956 21.5565 10.9996 21.732C11.3037 21.9075 11.6485 21.9999 11.9996 21.9999C12.3506 21.9999 12.6955 21.9075 12.9995 21.732C13.3036 21.5565 13.556 21.304 13.7316 21"/><path d="M3.26225 15.326C3.13161 15.4692 3.0454 15.6472 3.0141 15.8385C2.9828 16.0298 3.00777 16.226 3.08595 16.4034C3.16414 16.5807 3.29218 16.7316 3.4545 16.8375C3.61682 16.9434 3.80642 16.9999 4.00025 17H20.0002C20.194 17.0001 20.3837 16.9438 20.5461 16.8381C20.7085 16.7324 20.8367 16.5817 20.9151 16.4045C20.9935 16.2273 21.0187 16.0311 20.9877 15.8398C20.9566 15.6485 20.8707 15.4703 20.7402 15.327C19.4102 13.956 18.0002 12.499 18.0002 8C18.0002 6.4087 17.3681 4.88258 16.2429 3.75736C15.1177 2.63214 13.5915 2 12.0002 2C10.4089 2 8.88282 2.63214 7.75761 3.75736C6.63239 4.88258 6.00025 6.4087 6.00025 8C6.00025 12.499 4.58925 13.956 3.26225 15.326Z"/>',
    profile: '<path d="M17 8C17 10.7614 14.7614 13 12 13C9.23858 13 7 10.7614 7 8C7 5.23858 9.23858 3 12 3C14.7614 3 17 5.23858 17 8Z"/><path d="M20 21C20 18.8783 19.1571 16.8434 17.6569 15.3431C16.1566 13.8429 14.1217 13 12 13C9.87827 13 7.84344 13.8429 6.34315 15.3431C4.84285 16.8434 4 18.8783 4 21"/>'
  };

  function icon(name) {
    return '<svg class="lui-ico" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + (ICONS[name] || '') + '</svg>';
  }

  function navItem(action, fn) {
    var item = $('<div class="navigation-bar__item" data-action="' + action + '">' +
      '<div class="navigation-bar__icon">' + icon(action) + '</div></div>');
    item.on('click', fn);
    return item;
  }

  function openBookmarks() {
    // через пункт меню Lampa: так работают родительский контроль и синхронизация закладок
    var menuItem = $('.menu .menu__item[data-action="favorite"]').first();
    if (menuItem.length) menuItem.trigger('hover:enter');
    else Lampa.Activity.push({ url: '', title: 'Закладки', component: 'bookmarks', page: 1 });
  }

  // Lampa рисует .navigation-bar только на телефоне. Перестраиваем порядок как в макете:
  // назад, меню, главная, закладки, настройки — в «таблетке»; поиск — отдельный круг справа.
  function buildNav() {
    var bar = $('.navigation-bar').first();
    if (!bar.length || bar.attr('data-lui') === '1') return;
    bar.attr('data-lui', '1');

    var body = bar.find('.navigation-bar__body').first();
    var items = {};
    body.children('.navigation-bar__item').each(function () {
      items[$(this).attr('data-action')] = $(this);
    });

    // штатные пункты оставляем (их обработчики — от Lampa), меняем только иконки
    ['back', 'main', 'search', 'settings'].forEach(function (key) {
      if (items[key]) items[key].find('.navigation-bar__icon').html(icon(key));
    });

    items.menu = navItem('menu', function () {
      try { Lampa.Menu.toggle(); } catch (e) {}
    });
    items.bookmarks = navItem('bookmarks', openBookmarks);

    ['back', 'menu', 'main', 'bookmarks', 'settings'].forEach(function (key) {
      if (items[key]) body.append(items[key]);
    });

    if (items.search) {
      var circle = $('<div class="lui-nav-search lui-ring"></div>');
      circle.append(items.search);
      bar.append(circle);
    }

    // эффект нажатия (на iOS :active без обработчика касаний не срабатывает)
    bar.find('.navigation-bar__item').on('touchstart', function () {
      var item = $(this).addClass('lui-pressed');
      setTimeout(function () { item.removeClass('lui-pressed'); }, 180);
    });
  }

  // Иконки шапки — тоже из макета (колокольчик, профиль без аватара)
  function headIcons() {
    if (!document.body.classList.contains('true--mobile')) return;
    var bell = $('.head .notice--icon, .head .open--notice').first();
    if (bell.length && !bell.find('.lui-ico').length) bell.html(icon('bell'));
    var profile = $('.head .open--profile').first();
    if (profile.length && !profile.find('img').length && !profile.find('.lui-ico').length) profile.html(icon('profile'));
  }

  // Штатные шторки Lampa (списки выбора, настройки): круглый крестик из макета в шапке
  var ICON_CLOSE = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18"/><path d="M6 6L18 18"/></svg>';

  function closeLampaSheet(kind) {
    try {
      if (kind === 'select') { Lampa.Controller.back(); return; }
      // настройки: «назад» до полного закрытия (из вложенного раздела — несколько шагов).
      // Открыты ли — только по body.settings--open: закрытая шторка остаётся в DOM (уехала вниз),
      // и лишний «назад» на главной открывал вопрос о выходе.
      var guard = 0;
      var step = function () {
        if (!document.body.classList.contains('settings--open') || guard++ > 6) return;
        Lampa.Controller.back();
        setTimeout(step, 80);
      };
      step();
    } catch (e) {}
  }

  function sheetClose() {
    if (!document.body.classList.contains('true--mobile')) return;
    $('.selectbox__head, .settings__head').each(function () {
      var head = $(this);
      if (head.children('.lui-sheet-close').length) return;
      var kind = head.hasClass('selectbox__head') ? 'select' : 'settings';
      var btn = $('<div class="lui-sheet-close">' + ICON_CLOSE + '</div>');
      // iOS: шторки Lampa сами ловят касания (свайп вниз), поэтому слушаем и touchend, и click
      var at = 0;
      btn.on('touchstart', function (e) { e.stopPropagation(); });
      btn.on('touchend click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var now = Date.now();
        if (now - at < 500) return;
        at = now;
        closeLampaSheet(kind);
      });
      head.append(btn);
    });
  }

  // Меню и настройки на телефоне всегда открываются с начала списка.
  // Lampa на телефоне прокручивает нативно (scrollTop у .scroll) к последнему пункту с фокусом.
  function scrollTop(box) {
    if (!box || !box.length) return;
    box.find('.scroll').each(function () {
      if (this.classList.contains('scroll--horizontal')) return;
      this.scrollTop = 0;
      var body = this.querySelector('.scroll__body');
      if (body && body.style.transform) body.style.transform = '';
      if (body && body.style.webkitTransform) body.style.webkitTransform = '';
    });
  }

  function scrollTopSoon(selector) {
    [0, 60, 180, 400].forEach(function (ms) {
      setTimeout(function () { scrollTop($(selector)); }, ms);
    });
  }

  var bodyState = { menu: false, settings: false };
  var settingsPage = null;

  function watchOpen() {
    if (!document.body.classList.contains('true--mobile')) return;
    var cl = document.body.classList;
    var menu = cl.contains('menu--open');
    var settings = cl.contains('settings--open');
    if (menu && !bodyState.menu) scrollTopSoon('.wrap__left');
    if (settings && !bodyState.settings) scrollTopSoon('.settings__body');
    bodyState.menu = menu;
    bodyState.settings = settings;

    // новый раздел настроек — новый .scroll
    var page = settings ? $('.settings__body .scroll').get(0) : null;
    if (page && page !== settingsPage) scrollTopSoon('.settings__body');
    settingsPage = page;
  }

  function watchSheets() {
    if (!window.MutationObserver) return;
    var queued = false;
    var run = function () {
      if (queued) return;
      queued = true;
      setTimeout(function () { queued = false; sheetClose(); watchOpen(); }, 30);
    };
    new MutationObserver(function (list) {
      for (var i = 0; i < list.length; i++) {
        var t = list[i].target;
        if (t && t.classList && t.classList.contains('lui-sheet-close')) continue;
        run();
        return;
      }
    }).observe(document.body, { childList: true, subtree: true });
    new MutationObserver(run).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }

  // Меню выезжает слева поверх страницы; затемнение под ним закрывает его по нажатию
  function menuDim() {
    if ($('.lui-menu-dim').length) return;
    var dim = $('<div class="lui-menu-dim"></div>');
    dim.on('click touchend', function (e) {
      e.preventDefault();
      if (document.body.classList.contains('menu--open')) {
        try { Lampa.Menu.toggle(); } catch (err) {}
      }
    });
    $('body').append(dim);
  }

  // Lampa считает высоту ленты по высоте шапки и панели (frameUpdate на resize) — пересчитать после наших стилей
  function relayout() {
    try {
      var ev = document.createEvent('Event');
      ev.initEvent('resize', true, true);
      window.dispatchEvent(ev);
    } catch (e) {}
  }



  // ---------- тест: «жидкое стекло» нижнего меню (по мотивам codepen.io/fooontic/pen/KwpRaGr) ----------
  //
  // Три части, как в пене:
  //  1) преломление — backdrop-filter: url(#фильтр) с картой смещения (feDisplacementMap): у кромки фон
  //     берётся из точек ближе к центру, и под краем он «затягивается», как в линзе. Только Chromium:
  //     Safari (и Lampa на iPhone) url() в backdrop-filter не поддерживает — там без преломления;
  //  2) блики и тени по кромке — набор inset-теней (значения тёмной темы пена);
  //  3) стеклянная «капля» под текущим разделом, переезжает с пружинкой.
  // Карта смещения рисуется на canvas под точный размер элемента (у пена — готовая картинка 244×70).

  var LIQUID_KEY = 'lampaui_liquid';

  function liquidOn() {
    var v = Lampa.Storage.get(LIQUID_KEY, true);
    return v === true || v === 'true';
  }

  function liquidRefractSupported() {
    var ua = navigator.userAgent || '';
    // Chrome/Edge/Android; на iPhone все браузеры — WebKit (CriOS и т.п.), там не поддерживается
    if (!/Chrome\/\d+/.test(ua) || /iPhone|iPad|iPod/i.test(ua)) return false;
    // window.CSS: внутри плагина CSS — это строка со стилями
    try { return !!(window.CSS && window.CSS.supports && window.CSS.supports('backdrop-filter', 'url(#a)')); } catch (e) { return false; }
  }

  // Карта смещения — из пена (codepen.io/fooontic/pen/KwpRaGr, 488×136): линза на всю «таблетку»,
  // G сверху вниз сжимает картинку к центру, R — лёгкий сдвиг по горизонтали, у краёв — затухание.
  var LENS_MAP = 'data:image/webp;base64,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'
  var SVGNS = 'http://www.w3.org/2000/svg';

  // Фильтр 1:1 как в пене: координаты в долях элемента (objectBoundingBox), поэтому от размера не зависит.
  function liquidFilter(id, blurDev) {
    if (document.getElementById(id)) return;
    var holder = document.getElementById('lui-liquid-svg');
    if (!holder) {
      holder = document.createElementNS(SVGNS, 'svg');
      holder.setAttribute('id', 'lui-liquid-svg');
      holder.setAttribute('width', '0');
      holder.setAttribute('height', '0');
      holder.setAttribute('aria-hidden', 'true');
      holder.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
      document.body.appendChild(holder);
    }
    var f = document.createElementNS(SVGNS, 'filter');
    f.setAttribute('id', id);
    f.setAttribute('primitiveUnits', 'objectBoundingBox');

    var map = document.createElementNS(SVGNS, 'feImage');
    map.setAttribute('x', '0');
    map.setAttribute('y', '0');
    map.setAttribute('width', '100%');
    map.setAttribute('height', '100%');
    map.setAttribute('preserveAspectRatio', 'none');
    map.setAttribute('result', 'map');
    map.setAttribute('href', LENS_MAP);

    var blur = document.createElementNS(SVGNS, 'feGaussianBlur');
    blur.setAttribute('in', 'SourceGraphic');
    blur.setAttribute('stdDeviation', blurDev);
    blur.setAttribute('result', 'blur');

    var disp = document.createElementNS(SVGNS, 'feDisplacementMap');
    disp.setAttribute('in', 'blur');
    disp.setAttribute('in2', 'map');
    disp.setAttribute('scale', '0.5');
    disp.setAttribute('xChannelSelector', 'R');
    disp.setAttribute('yChannelSelector', 'G');

    f.appendChild(map);
    f.appendChild(blur);
    f.appendChild(disp);
    holder.appendChild(f);
  }

  function liquidMeasure() {
    if (!document.body.classList.contains('lui-liquid-refract')) return;
    liquidFilter('lui-lg-nav', '0.04');
    liquidFilter('lui-lg-search', '0.04');
  }

  // «Капля» — под текущим разделом: меню / настройки (открыты), главная, закладки
  function liquidCurrent() {
    var cls = document.body.classList;
    if (cls.contains('menu--open')) return 'menu';
    if (cls.contains('settings--open')) return 'settings';
    var a = null;
    try { a = Lampa.Activity.active(); } catch (e) {}
    var c = a && a.component;
    if (c === 'main') return 'main';
    if (c === 'bookmarks' || c === 'favorite') return 'bookmarks';
    return '';
  }

  var thumbAt = null;

  function liquidThumb(action) {
    var body = $('.navigation-bar__body').first();
    if (!body.length) return;
    var thumb = body.children('.lui-lg-thumb');
    if (!thumb.length) {
      thumb = $('<div class="lui-lg-thumb"></div>');
      body.prepend(thumb);
    }
    if (action === undefined) action = liquidCurrent();
    var item = action ? body.children('.navigation-bar__item[data-action="' + action + '"]') : $();
    if (!item.length) {
      thumb.addClass('lui-lg-thumb--hidden');
      thumbAt = null;
      return;
    }
    var el = item[0];
    var moved = thumbAt !== null && thumbAt !== action;
    thumb.removeClass('lui-lg-thumb--hidden').css({
      width: el.offsetWidth + 'px',
      height: el.offsetHeight + 'px',
      top: el.offsetTop + 'px',
      transform: 'translateX(' + el.offsetLeft + 'px)'
    });
    if (moved) {
      // пружинка, как в пене: растягивается в сторону движения и возвращается
      thumb.removeClass('lui-lg-thumb--pulse');
      void thumb[0].offsetWidth;
      thumb.addClass('lui-lg-thumb--pulse');
    }
    thumbAt = action;
  }

  var liquidWatching = false;

  function applyLiquid() {
    var on = liquidOn() && document.body.classList.contains('true--mobile');
    // не classList.toggle(name, force): в Lampa для старых ТВ он без второго аргумента и просто переключает
    var refract = on && liquidRefractSupported();
    $('body').toggleClass('lui-liquid', !!on).toggleClass('lui-liquid-refract', !!refract);
    if (!on) { $('.lui-lg-thumb').remove(); thumbAt = null; return; }
    liquidMeasure();
    liquidThumb();
    if (liquidWatching) return;
    liquidWatching = true;

    // нажатие — «капля» сразу едет под пункт, потом встаёт под текущий раздел
    $(document).on('touchstart click', '.navigation-bar__body .navigation-bar__item', function () {
      if (!document.body.classList.contains('lui-liquid')) return;
      liquidThumb($(this).attr('data-action'));
      setTimeout(function () { if (document.body.classList.contains('lui-liquid')) liquidThumb(); }, 700);
    });
    Lampa.Listener.follow('activity', function (e) {
      if (e.type === 'start' && document.body.classList.contains('lui-liquid')) setTimeout(function () { liquidThumb(); }, 50);
    });
    new MutationObserver(function () {
      if (document.body.classList.contains('lui-liquid')) liquidThumb();
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    window.addEventListener('resize', function () {
      setTimeout(function () {
        if (!document.body.classList.contains('lui-liquid')) return;
        liquidMeasure();
        liquidThumb();
      }, 200);
    });
  }

  function liquidSettings() {
    try {
      Lampa.SettingsApi.addParam({
        component: 'interface',
        param: { name: LIQUID_KEY, type: 'trigger', default: true },
        field: {
          name: 'Жидкое стекло (тест)',
          description: 'Нижнее меню на телефоне: блики, «капля» под разделом; преломление краёв — только в Chrome/Android'
        },
        onChange: function () { setTimeout(applyLiquid, 0); }
      });
    } catch (e) {}
  }

  // Live reload (только для разработки: "LampaUi": { "livereload": true } в init.conf)
  function liveReload() {
    var url = '/lampaui/api/version';
    var first = null;

    function poll() {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url + '?t=' + Date.now(), true);
      xhr.timeout = 5000;
      xhr.onload = function () {
        var v = 0;
        try { v = JSON.parse(xhr.responseText).v || 0; } catch (e) {}
        if (!v) return;
        if (first === null) first = v;
        else if (v !== first) {
          setTimeout(function () { window.location.reload(); }, 500);
          return;
        }
        setTimeout(poll, 2000);
      };
      xhr.onerror = xhr.ontimeout = function () { setTimeout(poll, 3000); };
      xhr.send();
    }

    poll();
  }

  function start() {
    injectStyles();
    viewportCover();
    menuDim();
    watchSheets();
    liquidSettings();
    var tries = 0;
    var boot = function () {
      buildNav();
      headIcons();
      relayout();
      applyLiquid();
      // Lampa может создать панель и иконки шапки чуть позже — проверяем несколько секунд
      if (++tries < 10) setTimeout(boot, 1000);
    };
    boot();

    // страницы (NovaPlus) сообщают цвет фона — красим им системные панели
    window.addEventListener('lampaui:theme', function (e) {
      themeColor(e.detail && e.detail.color);
    });

    liveReload();
  }

  if (window.appready) start();
  else {
    Lampa.Listener.follow('app', function (e) {
      if (e.type === 'ready') start();
    });
  }
})();
