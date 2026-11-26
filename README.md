# FreedomGate

Локальный Linux-шлюз с Vue-админкой: управление VPN-профилями, правилами
маршрутизации, DNS, блокировкой рекламы и обходом DPI. Основной движок — mihomo;
Xray, Outline SDK, Tor со Snowflake, Lantern, zapret и AdGuard Home подключены отдельными модулями.

## Установка

Распакуйте установочный архив FreedomGate или используйте исходники из Git.
Бинарники в архив и текущую версию репозитория не включены. При установке Tor
и FRP загружаются из официальных релизов с проверкой SHA-256; mihomo, Xray
и AdGuard Home — из репозиториев, закреплённых в `packaging/modules.lock.json`.
Для собственного Outline-моста и модифицированного Lantern подходящих готовых
upstream-бинарников нет: они собираются при установке из исходников. Go скачивается
с официального сайта с проверкой SHA-256; Outline SDK включён в vendor, наши модифицированные исходники
Lantern хранятся в `server/lantern/source` и проверяются по SHA-256 перед сборкой.
Остальные Go-зависимости закреплены версиями и `go.sum`.
Для Lantern сохраняются лицензия и соответствующий архив исходников GPL.
Установка требует интернета, компилятора и дополнительного времени на сборку;
установщик подготавливает необходимые зависимости. В контейнерном варианте
загрузка и сборка выполняются при создании образа.

Бинарники прежней публикации остаются в истории Git. Чтобы получить только
текущие исходники, используйте `git clone --depth 1 https://github.com/fgate-app/fgate.git`.

Native: Debian 13, Ubuntu 24.04/26.04 LTS или Raspberry Pi OS 13, Linux ARM64 / AMD64:

```sh
sudo sh install.sh
```

Контейнер на Linux с установленными Docker Engine и Compose v2:

```sh
sudo sh install.sh --container
```

Админка — `http://<локальный-IP-хоста>/`, порт 80. При первом открытии создаётся
администратор. Перед установкой можно выполнить `sh install.sh --check`.
Контейнеру нужны rootful Docker Engine, локальный Linux-хост и cgroup v2;
Docker Desktop и rootless-режим не поддерживаются. Данные сохраняются в volumes;
перед обновлением сохраняйте резервную копию пользовательской базы и настроек.
Установщик, откат, состав релиза, Compose config и ARM64-службы проверены.
Полная чистая установка на каждой ОС и сетевой Docker smoke-test ещё требуют
отдельных стендов; Docker Engine на текущих доступных хостах отсутствует.

## Возможности и ограничения

Правила направляют домены/IP и устройства через отдельный шлюз, группу,
Direct или локальный обход DPI; также доступна блокировка. Вложенные шлюзы
позволяют направить TCP-прокси через внешний выход, включая Tor.
При отказе выбранного шлюза скрытого перехода напрямую нет. Direct в резервной
группе используется только при явном добавлении пользователем. Трафик без
совпавшего правила по умолчанию идёт напрямую.

Диагностика запускается явно и проверяет выбранный путь: DNS, транспорт,
доступность сайтов и дополнительные сетевые признаки. Тайм-аут не считается
доказательством блокировки; технические результаты экспортируются в обезличенный JSON.

Можно развернуть VLESS/REALITY или Shadowsocks на собственном уже созданном VPS
по SSH и получить подключение в интерфейсе. Создание VPS, управление хостингом,
автоматические обновления удалённого Xray и удаление службы при удалении локального
шлюза не входят в эту функцию.

## Резерв соединения с облаком

Для уже зарегистрированной точки «Облачный доступ» FreedomGate сначала пробует
прямое соединение, затем SSH и после него — доступные включённые шлюзы.
SSH использует отдельную ограниченную учётную запись на порту 2222; рабочий
административный SSH не меняется. Независимый случайный ключ создаётся на устройстве;
на облаке хранится только его публичная часть. Ключ сервера закреплён. Оболочка, чужие порты и обратные
перенаправления запрещены. При обрыве соединение восстанавливается автоматически.

Внутри SSH остаётся FRP с прежней проверкой TLS: сохраняются TCP/UDP реле,
клиентские ключи и правила FreedomGate. Эта функция резервирует участок
FreedomGate → облако; блокировку внешнего подключения Outline → VPS она не снимает.
Для первого создания облачного экземпляра по-прежнему нужна успешная регистрация
по HTTPS. Облачная часть устанавливается оператором через
`scripts/install-cloud-relay.sh`.

## Tor и Snowflake

Tor — встроенная строка шлюзов, изначально выключенная. По умолчанию включён
режим «Только Snowflake»; явный Auto сначала пробует прямое подключение к Tor,
которое может быть видно провайдеру, затем Snowflake. Число попыток ограничено.
Tor переносит TCP; произвольный UDP/QUIC не поддерживается и не выпускается напрямую.
Tor можно выбрать внешним шлюзом для TCP-прокси. При его отказе цепочка закрывается.

Tor, Snowflake, Lantern и Outline подготавливаются установщиком для ARM64
или x86-64. Они закреплены за версией приложения и обновляются/откатываются вместе
с ней. Скачивание и сборка происходят при установке, до запуска служб.

Tor в шлюзе не обеспечивает обычному браузеру защиту от идентификации уровня
Tor Browser. Возможны CAPTCHA, ограничения выходных узлов и снижение скорости.
Адресные DNS-запросы для Tor-пути используют runtime fake-IP; прочие типы,
например TXT/MX, остаются в общем DNS-контуре. Служебный bootstrap Snowflake
отделён от трафика сайтов. Доступность в любой сети не гарантируется.

## Lantern (экспериментальный)

Lantern — встроенная строка шлюзов между Tor и «Обход DPI», изначально выключенная.
Его нельзя создать повторно, переименовать или удалить; после включения можно
выбрать в маршрутах или как внешний шлюз для TCP-прокси. Поддерживается один
экземпляр, только TCP. UDP/QUIC через него отклоняется. При отказе внешних прокси
прямого резерва нет; служебные обращения Lantern к своему сервису идут отдельно.

Используется производная сборка [Lantern headless 1.2.8](https://github.com/getlantern/lantern-headless-client)
с отключёнными пользовательскими direct/proxyless-путями. Штатный бинарник
Lantern вместо неё не принимается. Анонимные данные устройства сохраняются
приватно между перезапусками. Авторизация Pro пока не реализована; действуют
ограничения внешнего сервиса, доступность в конкретной сети не гарантируется.
TCP-соединения к реле привязаны к обнаруженному uplink, чтобы TUN не сообщал
ложный успех. Сборка и GPL-исходники изменений создаются установщиком; для сборки нужны Go/C++,
которые подготавливаются установщиком. Отдельное обновление Lantern отсутствует по выбранной
политике, версия меняется только с FreedomGate.

Сборщик установочного архива исключает все `server/*/bin`. Установщик вызывает
`scripts/release-bundles.py --prepare` для архитектуры хоста, создаёт манифест
полученных файлов и проверяет его до активации. Готовые бинарники включаются
в установленный каталог приложения, чтобы обновление и откат сохраняли их вместе
с соответствующими исходниками.

## Конфигурации mihomo

Окно добавления шлюза принимает отдельный узел, массив узлов и `proxies` из
YAML/JSON Clash/mihomo. Из полного конфига извлекаются только подключения:
DNS, порты, провайдеры и правила приложения не заменяются. В списке можно выбрать
нужные узлы. Поддерживается до 200 подключений и файл до 256 КБ.

Для native-конфигураций доступны 24 типа outbound из mihomo v1.19.33:
Shadowsocks/SSR, SOCKS5, HTTP/HTTPS, VMess, VLESS, Snell, Trojan, Hysteria 1/2,
WireGuard, TUIC, ShadowQUIC, Gost Relay, SSH, Mieru, AnyTLS, Sudoku, MASQUE,
TrustTunnel, OpenVPN, Tailscale, ZeroTier и EasyTier. Основные параметры
редактируются в обычных полях, остальные — в поле дополнительных JSON-параметров;
вложенные настройки сохраняются при повторном открытии и изменении полей.
Существующие VLESS/Outline-профили используют прежние движки; native-варианты
отдельно обозначены в списке типов. NaiveProxy не входит в парсер этой версии.

Добавлены ссылки `trojan://`, `vmess://` (Base64 JSON), `ssr://`, `tuic://`,
`hysteria://`, `anytls://`, `http://`, `https://` и `ssh://`, в том числе в
TXT/Base64-списках. Неизвестные параметры новых ссылок отклоняются.
Внешние файлы ключей/сертификатов и runtime-параметры маршрутизации узла
не импортируются: используются встроенные ключи и настройки цепочек FreedomGate.
Все заданные peers проверяются на рекурсию через собственные точки доступа.
EasyTier используется как исходящий шлюз, без серверных listeners и объявления exit-node.

Поддержка установлена на рабочую систему. Mihomo v1.19.34 проверил 24 конфигурации;
HTTP, SOCKS5, Shadowsocks, VMess, VLESS и Trojan прошли проверку передачи через
контрольные серверы. Это не гарантирует совместимость со всеми внешними серверами:
проверенный Amnezia REALITY-сервер отклоняет объявляемую mihomo версию клиента
1.8.2; клиентские пробы установили границу 26.3.27. Исходный Xray-путь работает,
а для native mihomo требуется совместимая серверная политика minClientVer. Автоматической
замены движка существующих VLESS-профилей нет. Доступность overlay-протоколов
зависит также от build tags установленного mihomo. Runtime-библиотека YAML 2.9.1
включена в подготовленный комплект и Docker-образ; для неё не нужен npm на устройстве.
Проверки: `node --test tests/mihomo-proxy.test.js` и
`node tests/mihomo-proxy-browser.mjs`. Изолированная проверка установленных движков
и передачи: `tests/mihomo-native-live.mjs` (явные пути `FREEDOMGATE_MIHOMO` и
`FREEDOMGATE_XRAY`, отдельное сетевое пространство имён с loopback).

## Hysteria 2

Поддерживаются ссылки `hy2://` и `hysteria2://`, TXT/Base64-подписки и обычная
ручная форма шлюза. Сохранение использует native outbound mihomo: один порт,
пароль либо `user:password`, SNI, проверка сертификата, SHA-256 pin и Salamander.
Проверка сертификата по умолчанию включена; изменение порта или имени не теряет
настройки TLS и маскировки. Port hopping, Gecko, ECH и неизвестные параметры
пока отклоняются при импорте вместо незаметного удаления настроек.

Формат сверен с [официальной схемой URI](https://hysteria.network/docs/developers/URI-Scheme/)
и [Hysteria 2 outbound mihomo v1.19.34](https://github.com/MetaCubeX/mihomo/blob/v1.19.34/adapter/outbound/hysteria2.go).
Сетевая проверка всех поддерживаемых сочетаний требует отдельного стенда.

## Разработка

Веб/API: Node.js >=22.13, встроенный SQLite. Интерфейс: Vue, Vite, D3.
Go >=1.25 нужен для сборки моста Outline SDK; его зависимости включены в vendor.

```sh
npm ci
npm run build
npm run dev
```

Локальная админка: `http://127.0.0.1:8787`. Для отдельного Vite-сервера:
`npm run dev:web` → `http://127.0.0.1:5173` с проксированием API.
База разработки — `.data/freedomgate.sqlite`; её можно изменить через
`FREEDOMGATE_DB`. Адрес и порт задаются `HOST` и `PORT`.

```sh
npm test
node tests/dns-browser.mjs
node tests/auth-browser.mjs
node tests/mobile-browser.mjs
node tests/modules-browser.mjs
```

Браузерным тестам нужен установленный Chrome. Они создают временные базы,
проверяют реальные формы, действия и мобильные карточки. Сетевые интеграционные
тесты из `tests/integration/` запускаются на выделенном Linux-стенде.

Дизайн-система: `npm run storybook` → `http://127.0.0.1:6006`;
`npm run build:storybook` создаёт статическую сборку.
Шрифты Ubuntu, Material Design Icons, D3 и библиотеки интерфейса включены в
бандл, CDN не используются. Интерфейс поддерживает английский, русский,
упрощённый китайский, светлую/тёмную тему и мобильные браузеры.

## Структура

- `web/src/pages/`, `components/`, `composables/` — страницы, общие контролы,
  состояние и опрос API.
- `server/index.js` — HTTP/API; `runtime.js` — запуск и завершение движков.
- `server/store.js` — пользовательские данные; `database.js` — транзакции.
- `server/network-config.js` — генерация конфигов, без привилегированных действий.
- `scripts/freedomgate-network-helper.mjs` — применение сети от root через Unix-сокет.
- `shared/` — общие схемы, правила и валидация сервера и интерфейса.
- `packaging/` — systemd и закреплённые версии/контрольные суммы модулей.
- `scripts/install.sh`, `Dockerfile`, `compose.yaml` — установка и контейнер.

Веб-служба работает от `freedomgate`; helper отдельно управляет AP, DHCP,
перехватом DNS и nftables. Авторизация поддерживает роли admin/operator/viewer,
проверки прав и CSRF. Профили и пароли не включаются в архивы релизов.

### Установка как PWA

При открытии по HTTPS с доверенным сертификатом FreedomGate можно установить
как отдельное приложение. В Chrome/Edge используйте «Установить приложение»
в меню профиля (когда браузер предлагает установку) или меню браузера.
На iPhone/iPad: Safari → «Поделиться» → «На экран Домой».
Обычный HTTP по IP-адресу не поддерживает полноценную PWA; исключение — localhost.
Самоподписанный сертификат требует настройки доверия на каждом устройстве.

При отсутствии соединения показывается экран повторного подключения.
Настройки, ключи, страницы авторизации и ответы API не сохраняются в кэш PWA.
Новая версия service worker вступает в силу после закрытия всех открытых окон
приложения, без принудительной перезагрузки формы во время редактирования.

Проверка: `npm run build && npm run test:browser:pwa`.
Иконки из фирменного SVG: `node scripts/build-pwa-icons.mjs` (нужен Chrome).


## Резервное копирование конфигурации

В «Настройки → Система» администратор может скачать переносимый `.fgconfig`.
Файл зашифрован AES-256-GCM; ключ выводится scrypt из секретной строки,
соль и nonce случайны для каждого экспорта. Генератор строки использует
32 случайных байта. Для восстановления на другом устройстве нужны только
файл и эта строка; ключ исходного устройства не требуется.

В файл входят все шлюзы и их конфиги, подписки, группы и маршруты, DNS,
AdGuard, zapret, сеть и DHCP, пользователи с хешами паролей, точки доступа
и развёрнутые VPN с персональными ключами и SSH-секретами. Сохраняются
идентификаторы облачного доступа. Активные сеансы входа не переносятся.
В снимке версии 2 сохраняются только выбранные списки адресов, один раз
в отдельном каталоге. Правила содержат ссылки по ID, ручные записи и исключения.
Восстановление работает без сети; обновление модуля обновляет связанные списки
по этим ID. Более новый полный каталог целевого устройства сохраняется.
Старые файлы читаются; при экспорте старой копии она преобразуется в компактный
формат без изменения исходного файла. Для чтения нового формата нужна версия
FreedomGate с поддержкой снимков v2.
Это конфигурация FreedomGate, а не образ ОС: установленные бинарники,
системные учётные записи, журналы и временные сетевые кэши не включаются.

Секретную строку храните отдельно. При переносе остановите исходный
экземпляр, прежде чем включать восстановленный с той же облачной
идентичностью. Если интерфейсы отличаются, восстановление позволяет
сохранить сеть и DHCP-резервации целевого устройства.

Локальные копии зашифрованы отдельным ключом устройства и ограничены
20 экземплярами. Они не заменяют скачанный файл на другом носителе. Перед
восстановлением и заводским сбросом автоматически создаётся локальная
страховочная копия; при нехватке места операция не начинается. После замены
настроек сеансы входа отзываются, служба перезапускается. Сброс не удаляет
серверы на внешних VPS и сохраняет локальные резервные копии.

## Каталог пресетов адресов

Основной источник — `MetaCubeX/meta-rules-dat`, сгенерированная ветка `meta`.
Модуль получает доменные и IP-наборы одной зафиксированной ревизии через
общий загрузчик: напрямую, затем через доступные шлюзы. Используются полные
текстовые `geo/geosite/classical/*.list` и `geo/geoip/classical/*.list`, без
подмены на lite. Бинарные дубликаты и ASN-каталоги не импортируются.

Одноимённые GeoSite/GeoIP объединяются в один пресет. `@ads` и `@telemetry`
дают отдельные рекламные поднаборы и исключаются из сервисного пресета.
Поднаборы `@cn` и `@!cn` доступны отдельно. При обновлении сохраняются ручные
правила, исключения и сохранённые данные категорий, исчезнувших у источника.
Большие наборы поддерживают до 500000 записей без обрезания; ручной ввод
сохраняет прежний лимит 50000. Первый поиск строит индекс, последующие
используют его кэш; IP-наборы не раздувают доменный триграммный индекс.

Cloud access registration requires an administrator-issued access token in addition
 to the device's public Instance ID. On the cloud, run `node scripts/cloud-invite.mjs`
from the FreedomGate source directory as its administrator; share the resulting
secret over a private channel. Enter the HTTPS cloud address and token in Cloud
access settings. Each token is bound to one Instance ID on its first successful
registration. The cloud stores only its hash. Custom endpoints require a publicly
trusted TLS certificate. Fresh installations have no cloud address, certificate or
SSH host key configured. Obtain the HTTPS address and invitation from your cloud
administrator and enter both in Cloud access settings. The SSH host key is received
only after authenticated HTTPS enrollment. Existing saved configurations are retained.
To operate a cloud server, provision its trusted TLS certificate and key under
`/etc/freedomgate-cloud`, then run `FG_CLOUD_HOST=<public-IP> scripts/install-cloud-relay.sh`
as root.

SSH fallback uses an independent random Ed25519 device key, encrypted in the local
configuration. Only the public key is registered on the cloud. Under systemd the
private runtime file is placed in `/run/freedomgate-cloud-ssh-client` with mode600,
removed on connection shutdown and cleared with the service runtime directory.
The cloud account permits only its own relay and registration forwards, without
shell, SFTP or administrative access. Removing an invitation prevents subsequent
registration; revoking existing access also requires removing the corresponding
SSH authorization and stopping its relay.

Configuration restore checks the saved cloud instance before confirmation and
again before replacement. If it is occupied by another device or its availability
cannot be verified, restore continues with Cloud access disabled and a fresh
Instance ID. Its old enrollment token and SSH identity are discarded; a new cloud
invitation is required to enable it later. Saved Cloud access user keys are not restored when its identity is reset.
Other gateways and their client records are preserved. A verified connection owned by the current device is preserved during
an in-place restore. The check is a point-in-time observation, not an exclusive
reservation of the cloud instance.

Cloud access offers both Outline/Shadowsocks and VLESS with REALITY/XTLS Vision
for the same user keys and routing policy. Select the connection protocol in the
key dialog to display its URI/QR or download its mihomo configuration. Outline
clients use the original Shadowsocks keys; VLESS needs a compatible client.
Cloud REALITY exports enable X25519MLKEM768 for current Xray/mihomo compatibility.
The encrypted REALITY connection uses its own public TCP port; existing
Shadowsocks and relay ports remain unchanged. The REALITY private key stays on
the device and is included only in encrypted configuration backups.

The REALITY TLS target defaults to `www.gstatic.com`; it must support TLS 1.3
and be reachable from the device. It can be changed under Advanced settings in
Cloud access. This changes the SNI in VLESS links, so previously imported VLESS
clients must be updated. Outline links remain unchanged. Registration and
transport, including SSH fallback, are shared by both protocols.
