import net from 'node:net';

// Validation failures carry a safe, user-facing message. The HTTP layer maps
// them to 400 without leaking internals.
export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

// Curated library of well-known recursive DNS resolvers. Only endpoint data and
// public policy facts are stored; no keys or account identifiers are involved.
export const resolvers = [
  {
    id: 'cloudflare',
    name: 'Cloudflare 1.1.1.1',
    vendor: 'Cloudflare',
    country: 'US',
    region: 'Глобальный',
    protocols: { doh: 'https://cloudflare-dns.com/dns-query', dot: 'tls://1.1.1.1', udp: 'udp://1.1.1.1' },
    ips: ['1.1.1.1', '1.0.0.1'],
    ipv6Ips: ['2606:4700:4700::1111', '2606:4700:4700::1001'],
    filtering: 'none',
    dnssec: true,
    notes: 'Публичный резолвер без фильтрации; заявляет отсутствие логов.',
  },
  {
    id: 'cloudflare-family',
    name: 'Cloudflare Family',
    vendor: 'Cloudflare',
    country: 'US',
    region: 'Глобальный',
    protocols: { doh: 'https://family.cloudflare-dns.com/dns-query', dot: 'tls://family.cloudflare-dns.com', udp: 'udp://1.1.1.3' },
    ips: ['1.1.1.3', '1.0.0.3'],
    ipv6Ips: ['2606:4700:4700::1113', '2606:4700:4700::1003'],
    filtering: 'malware+adult',
    dnssec: true,
    notes: 'Блокирует вредоносные и взрослые домены.',
  },
  {
    id: 'google',
    name: 'Google Public DNS',
    vendor: 'Google',
    country: 'US',
    region: 'Глобальный',
    protocols: { doh: 'https://dns.google/dns-query', dot: 'tls://dns.google', udp: 'udp://8.8.8.8' },
    ips: ['8.8.8.8', '8.8.4.4'],
    ipv6Ips: ['2001:4860:4860::8888', '2001:4860:4860::8844'],
    filtering: 'none',
    dnssec: true,
    notes: 'Крупный публичный резолвер; поддерживает ECS.',
  },
  {
    id: 'quad9',
    name: 'Quad9',
    vendor: 'Quad9 Foundation',
    country: 'CH',
    region: 'Глобальный',
    protocols: { doh: 'https://dns.quad9.net/dns-query', dot: 'tls://dns.quad9.net', udp: 'udp://9.9.9.9' },
    ips: ['9.9.9.9', '149.112.112.112'],
    ipv6Ips: ['2620:fe::fe', '2620:fe::9'],
    filtering: 'malware',
    dnssec: true,
    notes: 'Некоммерческий резолвер; блокирует вредоносные домены.',
  },
  {
    id: 'quad9-unsecured',
    name: 'Quad9 Unsecured',
    vendor: 'Quad9 Foundation',
    country: 'CH',
    region: 'Глобальный',
    protocols: { doh: 'https://dns10.quad9.net/dns-query', dot: 'tls://dns10.quad9.net', udp: 'udp://9.9.9.10' },
    ips: ['9.9.9.10', '149.112.112.10'],
    filtering: 'none',
    dnssec: true,
    notes: 'Quad9 без блокировки вредоносных доменов.',
  },
  {
    id: 'adguard',
    name: 'AdGuard DNS',
    vendor: 'AdGuard',
    country: 'CY',
    region: 'Глобальный',
    protocols: { doh: 'https://dns.adguard-dns.com/dns-query', dot: 'tls://dns.adguard-dns.com', doq: 'quic://dns.adguard-dns.com:784', udp: 'udp://94.140.14.14' },
    ips: ['94.140.14.14', '94.140.15.15'],
    filtering: 'ads+trackers',
    dnssec: true,
    notes: 'Блокирует рекламу и трекеры; поддерживает DoQ.',
  },
  {
    id: 'adguard-family',
    name: 'AdGuard Family',
    vendor: 'AdGuard',
    country: 'CY',
    region: 'Глобальный',
    protocols: { doh: 'https://family.adguard-dns.com/dns-query', dot: 'tls://family.adguard-dns.com', udp: 'udp://94.140.14.15' },
    ips: ['94.140.14.15', '94.140.15.16'],
    filtering: 'ads+trackers+adult',
    dnssec: true,
    notes: 'Реклама, трекеры и взрослый контент.',
  },
  {
    id: 'opendns',
    name: 'OpenDNS Home',
    vendor: 'Cisco',
    country: 'US',
    region: 'Глобальный',
    protocols: { doh: 'https://doh.opendns.com/dns-query', udp: 'udp://208.67.222.222' },
    ips: ['208.67.222.222', '208.67.220.220'],
    filtering: 'phishing',
    dnssec: false,
    notes: 'Фильтрация фишинга; DNSSEC не валидируется.',
  },
  {
    id: 'cleanbrowsing-security',
    name: 'CleanBrowsing Security',
    vendor: 'CleanBrowsing',
    country: 'US',
    region: 'Глобальный',
    protocols: { doh: 'https://doh.cleanbrowsing.org/doh/security-filter/', dot: 'tls://security-filter-dns.cleanbrowsing.org', udp: 'udp://185.228.168.9' },
    ips: ['185.228.168.9', '185.228.169.9'],
    filtering: 'malware+phishing',
    dnssec: true,
    notes: 'Блокирует вредоносные и фишинговые домены.',
  },
  {
    id: 'mullvad',
    name: 'Mullvad DNS',
    vendor: 'Mullvad',
    country: 'SE',
    region: 'Глобальный',
    protocols: { doh: 'https://dns.mullvad.net/dns-query', udp: 'udp://194.242.2.2' },
    ips: ['194.242.2.2', '194.242.2.3'],
    filtering: 'ads+trackers',
    dnssec: true,
    notes: 'Резолвер VPN-провайдера; в части сетей соединение сбрасывается.',
  },
  {
    id: 'dns.sb',
    name: 'DNS.SB',
    vendor: 'xTom',
    country: 'XX',
    region: 'Глобальный',
    protocols: { doh: 'https://doh.dns.sb/dns-query', udp: 'udp://185.222.222.222' },
    ips: ['185.222.222.222', '45.11.45.11'],
    filtering: 'none',
    dnssec: true,
    notes: 'Anycast-резолвер без логов и фильтрации.',
  },
  {
    id: 'applied-privacy',
    name: 'Applied Privacy',
    vendor: 'Foundation for Applied Privacy',
    country: 'AT',
    region: 'Европа',
    protocols: { doh: 'https://doh.appliedprivacy.net/query' },
    ips: [],
    filtering: 'none',
    dnssec: true,
    notes: 'Вена, Австрия; без логов и фильтрации.',
  },
  {
    id: 'artikel10',
    name: 'Artikel10',
    vendor: 'Artikel10',
    country: 'DE',
    region: 'Европа',
    protocols: { doh: 'https://dns.artikel10.org/dns-query' },
    ips: ['217.197.91.153'],
    filtering: 'none',
    dnssec: true,
    notes: 'Германия; DNSSEC, без логов.',
  },
  {
    id: 'dremaxx',
    name: 'Dremaxx',
    vendor: 'Dremaxx',
    country: 'CH',
    region: 'Глобальный',
    protocols: { doh: 'https://open.dns.dremaxx.com/dns-query' },
    ips: [],
    filtering: 'none',
    dnssec: true,
    notes: 'Цюрих, Дюссельдорф, Хьюстон; собственная рекурсия.',
  },
  {
    id: 'dnsforfamily',
    name: 'DNS for Family',
    vendor: 'DNS for Family',
    country: 'XX',
    region: 'Глобальный',
    protocols: { doh: 'https://dns-doh.dnsforfamily.com/dns-query' },
    ips: [],
    filtering: 'family',
    dnssec: false,
    notes: 'Семейный фильтр: взрослые, азартные игры, вредоносные домены.',
  },
  {
    id: 'dns4eu-unfiltered',
    name: 'DNS4EU Unfiltered',
    vendor: 'DNS4EU',
    country: 'EU',
    region: 'Европа',
    protocols: { doh: 'https://unfiltered.joindns4.eu/dns-query' },
    ips: [],
    filtering: 'none',
    dnssec: true,
    notes: 'Европейский публичный резолвер без фильтрации.',
  },
  {
    id: 'dns4eu-protective',
    name: 'DNS4EU Protective',
    vendor: 'DNS4EU',
    country: 'EU',
    region: 'Европа',
    protocols: { doh: 'https://protective.joindns4.eu/dns-query' },
    ips: [],
    filtering: 'malware+phishing',
    dnssec: true,
    notes: 'Европейский резолвер с защитой от вредоносных доменов.',
  },
  {
    id: 'controld',
    name: 'Control D Free',
    vendor: 'Control D',
    country: 'CA',
    region: 'Глобальный',
    protocols: { doh: 'https://freedns.controld.com/p0', dot: 'tls://p0.freedns.controld.com', udp: 'udp://76.76.2.0' },
    ips: ['76.76.2.0', '76.76.10.0'],
    filtering: 'none',
    dnssec: true,
    notes: 'Бесплатный профиль без фильтрации; в некоторых сетях TLS блокируется.',
  },
  {
    id: 'cira-private',
    name: 'CIRA Private',
    vendor: 'CIRA',
    country: 'CA',
    region: 'Канада',
    protocols: { doh: 'https://private.canadianshield.cira.ca/dns-query', udp: 'udp://149.112.121.10' },
    ips: ['149.112.121.10', '149.112.122.10'],
    filtering: 'none',
    dnssec: true,
    notes: 'Canadian Shield без фильтрации; канадские узлы.',
  },
  {
    id: 'cira-protected',
    name: 'CIRA Protected',
    vendor: 'CIRA',
    country: 'CA',
    region: 'Канада',
    protocols: { doh: 'https://protected.canadianshield.cira.ca/dns-query', udp: 'udp://149.112.121.20' },
    ips: ['149.112.121.20', '149.112.122.20'],
    filtering: 'malware+phishing',
    dnssec: true,
    notes: 'Canadian Shield: вредоносные, фишинговые, ботнет-домены.',
  },
  {
    id: 'adfilter',
    name: 'ADFilter Adelaide',
    vendor: 'ADFilter',
    country: 'AU',
    region: 'Австралия',
    protocols: { doh: 'https://adl.adfilter.net/dns-query' },
    ips: ['103.249.238.124'],
    filtering: 'ads+malware+trackers',
    dnssec: true,
    notes: 'Австралия; реклама, вредоносные и трекеры.',
  },
  {
    id: 'yandex',
    name: 'Yandex DNS',
    vendor: 'Yandex',
    country: 'RU',
    region: 'Россия',
    protocols: { doh: 'https://77.88.8.8/dns-query', udp: 'udp://77.88.8.8' },
    ips: ['77.88.8.8', '77.88.8.1'],
    filtering: 'none',
    dnssec: true,
    notes: 'Публичный DNS Яндекса; доступен в России.',
  },
  {
    id: 'yandex-safe',
    name: 'Yandex DNS Safe',
    vendor: 'Yandex',
    country: 'RU',
    region: 'Россия',
    protocols: { doh: 'https://77.88.8.2/dns-query', udp: 'udp://77.88.8.2' },
    ips: ['77.88.8.2', '77.88.8.88'],
    filtering: 'malware+adult',
    dnssec: true,
    notes: 'Безопасный режим Яндекса: вредоносные и взрослые домены.',
  },
  {
    id: 'comss',
    name: 'Comss.one',
    vendor: 'Comss',
    country: 'RU',
    region: 'Россия',
    protocols: { doh: 'https://dns.comss.one/dns-query' },
    ips: [],
    filtering: 'ads+phishing',
    dnssec: false,
    notes: 'Реклама и фишинг; популярен среди русскоязычных пользователей.',
  },
  {
    id: 'dnscry-moscow',
    name: 'dnscry.pt Москва',
    vendor: 'dnscry.pt',
    country: 'RU',
    region: 'Россия',
    protocols: { doh: 'https://mow01.dnscry.pt/dns-query' },
    ips: [],
    filtering: 'none',
    dnssec: true,
    notes: 'Узел dnscry.pt в Москве; без логов и фильтрации.',
  },
  {
    id: 'iij',
    name: 'IIJ Public DNS',
    vendor: 'Internet Initiative Japan',
    country: 'JP',
    region: 'Япония',
    protocols: { doh: 'https://public.dns.iij.jp/dns-query', udp: 'udp://103.2.57.5' },
    ips: ['103.2.57.5', '103.2.57.6'],
    filtering: 'child-abuse',
    dnssec: true,
    notes: 'Токио; блокирует противоправный контент.',
  },
  {
    id: 'dnscry-tokyo',
    name: 'dnscry.pt Токио',
    vendor: 'dnscry.pt',
    country: 'JP',
    region: 'Япония',
    protocols: { doh: 'https://tyo02.dnscry.pt/dns-query' },
    ips: [],
    filtering: 'none',
    dnssec: true,
    notes: 'Узел dnscry.pt в Токио; в части сетей недоступен.',
  },
  {
    id: 'fdn',
    name: 'FDN',
    vendor: 'FDN',
    country: 'FR',
    region: 'Европа',
    protocols: { doh: 'https://ns1.fdn.fr/dns-query', udp: 'udp://80.67.169.12' },
    ips: ['80.67.169.12', '80.67.169.40'],
    filtering: 'none',
    dnssec: true,
    notes: 'Французский некоммерческий провайдер FDN.',
  },
  {
    id: 'la-contre-voie',
    name: 'La Contre-Voie',
    vendor: 'La Contre-Voie',
    country: 'DE',
    region: 'Европа',
    protocols: { doh: 'https://doh.lacontrevoie.fr/dns-query' },
    ips: [],
    filtering: 'none',
    dnssec: true,
    notes: 'Falkenstein, Германия; без фильтрации, логи соединений 14 дней.',
  },
  {
    id: 'libredns',
    name: 'LibreDNS',
    vendor: 'LibreOps',
    country: 'DE',
    region: 'Европа',
    protocols: { doh: 'https://doh.libredns.gr/dns-query' },
    ips: [],
    filtering: 'none',
    dnssec: false,
    notes: 'Германия; без логов, но без DNSSEC.',
  },
  {
    id: 'dnsforge',
    name: 'DNSforge',
    vendor: 'DNSforge',
    country: 'DE',
    region: 'Европа',
    protocols: { doh: 'https://dnsforge.de/dns-query' },
    ips: [],
    filtering: 'ads',
    dnssec: true,
    notes: 'Германия; Pi-hole, блокировка рекламы.',
  },
  {
    id: 'dnsbunker',
    name: 'DNSBunker',
    vendor: 'DNSBunker',
    country: 'DE',
    region: 'Европа',
    protocols: { doh: 'https://dnsbunker.org/dns-query' },
    ips: [],
    filtering: 'ads+malware',
    dnssec: false,
    notes: 'Германия; реклама, вредоносные, слежка.',
  },
  {
    id: 'ffmuc',
    name: 'Freifunk Munich',
    vendor: 'Freifunk München',
    country: 'DE',
    region: 'Европа',
    protocols: { doh: 'https://doh.ffmuc.net/dns-query' },
    ips: [],
    filtering: 'none',
    dnssec: false,
    notes: 'Германия; без логов, фильтрации и цензуры.',
  },
  {
    id: 'digitale-gesellschaft',
    name: 'Digitale Gesellschaft',
    vendor: 'Digitale Gesellschaft',
    country: 'CH',
    region: 'Европа',
    protocols: { doh: 'https://dns.digitale-gesellschaft.ch/dns-query' },
    ips: [],
    filtering: 'none',
    dnssec: true,
    notes: 'Швейцария; общественная организация.',
  },
  {
    id: 'switch',
    name: 'SWITCH',
    vendor: 'SWITCH',
    country: 'CH',
    region: 'Европа',
    protocols: { doh: 'https://130.59.31.248/dns-query', udp: 'udp://130.59.31.248' },
    ips: ['130.59.31.248', '130.59.31.251'],
    filtering: 'malware',
    dnssec: true,
    notes: 'Швейцария; защита от вредоносных доменов.',
  },
  {
    id: 'dns4all',
    name: 'DNS4All',
    vendor: 'SIDN Labs',
    country: 'NL',
    region: 'Европа',
    protocols: { doh: 'https://doh.dns4all.eu/dns-query' },
    ips: [],
    filtering: 'sanctions',
    dnssec: true,
    notes: 'Нидерланды; фильтрует домены под санкциями ЕС.',
  },
  {
    id: 'uncensoreddns',
    name: 'UncensoredDNS',
    vendor: 'UncensoredDNS',
    country: 'DK',
    region: 'Европа',
    protocols: { doh: 'https://anycast.uncensoreddns.org/dns-query', udp: 'udp://91.239.100.100' },
    ips: ['91.239.100.100', '89.233.43.71'],
    filtering: 'none',
    dnssec: true,
    notes: 'Дания и США; без логов и фильтрации.',
  },
  {
    id: 'njalla',
    name: 'Njalla',
    vendor: 'Njalla',
    country: 'SE',
    region: 'Европа',
    protocols: { doh: 'https://dns.njal.la/dns-query' },
    ips: [],
    filtering: 'none',
    dnssec: false,
    notes: 'Швеция; без логов.',
  },
  {
    id: 'dnscry-stockholm',
    name: 'dnscry.pt Стокгольм',
    vendor: 'dnscry.pt',
    country: 'SE',
    region: 'Европа',
    protocols: { doh: 'https://sto01.dnscry.pt/dns-query' },
    ips: [],
    filtering: 'none',
    dnssec: true,
    notes: 'Узел dnscry.pt в Стокгольме.',
  },
  {
    id: 'dnscry-helsinki',
    name: 'dnscry.pt Хельсинки',
    vendor: 'dnscry.pt',
    country: 'FI',
    region: 'Европа',
    protocols: { doh: 'https://hel01.dnscry.pt/dns-query' },
    ips: [],
    filtering: 'none',
    dnssec: true,
    notes: 'Узел dnscry.pt в Хельсинки.',
  },
  {
    id: 'dnscry-vienna',
    name: 'dnscry.pt Вена',
    vendor: 'dnscry.pt',
    country: 'AT',
    region: 'Европа',
    protocols: { doh: 'https://vie01.dnscry.pt/dns-query' },
    ips: [],
    filtering: 'none',
    dnssec: true,
    notes: 'Узел dnscry.pt в Вене.',
  },
  {
    id: 'dnscry-warsaw',
    name: 'dnscry.pt Варшава',
    vendor: 'dnscry.pt',
    country: 'PL',
    region: 'Европа',
    protocols: { doh: 'https://waw01.dnscry.pt/dns-query' },
    ips: [],
    filtering: 'none',
    dnssec: true,
    notes: 'Узел dnscry.pt в Варшаве.',
  },
  {
    id: 'dnscry-zurich',
    name: 'dnscry.pt Цюрих',
    vendor: 'dnscry.pt',
    country: 'CH',
    region: 'Европа',
    protocols: { doh: 'https://zrh01.dnscry.pt/dns-query' },
    ips: [],
    filtering: 'none',
    dnssec: true,
    notes: 'Узел dnscry.pt в Цюрихе.',
  },
  {
    id: 'alidns',
    name: 'Alibaba AliDNS',
    vendor: 'Alibaba Cloud',
    country: 'CN',
    region: 'Китай',
    protocols: { doh: 'https://dns.alidns.com/dns-query', udp: 'udp://223.5.5.5' },
    ips: ['223.5.5.5', '223.6.6.6'],
    filtering: 'none',
    dnssec: false,
    notes: 'Китай; применяет фильтрацию GFW, вне Китая может блокироваться.',
  },
  {
    id: 'dnspod',
    name: 'Tencent DNSPod',
    vendor: 'Tencent',
    country: 'CN',
    region: 'Китай',
    protocols: { doh: 'https://doh.pub/dns-query', udp: 'udp://119.29.29.29' },
    ips: ['119.29.29.29', '1.12.12.12'],
    filtering: 'none',
    dnssec: false,
    notes: 'Китай; фильтрация GFW, зарубежный доступ нестабилен.',
  },
];
// Public recursive resolvers suitable as bootstrap (plain IPs, UDP/TCP 53).
export const bootstrapResolvers = [
  { id: 'cloudflare', name: 'Cloudflare', vendor: 'Cloudflare', country: 'US', region: 'Глобальный', ips: ['1.1.1.1', '1.0.0.1'], filtering: 'none', notes: 'Публичный резолвер без фильтрации.' },
  { id: 'google', name: 'Google Public DNS', vendor: 'Google', country: 'US', region: 'Глобальный', ips: ['8.8.8.8', '8.8.4.4'], filtering: 'none', notes: 'Крупный публичный резолвер.' },
  { id: 'quad9', name: 'Quad9', vendor: 'Quad9 Foundation', country: 'CH', region: 'Глобальный', ips: ['9.9.9.9', '149.112.112.112'], filtering: 'malware', notes: 'Блокирует вредоносные домены.' },
  { id: 'quad9-unsecured', name: 'Quad9 Unsecured', vendor: 'Quad9 Foundation', country: 'CH', region: 'Глобальный', ips: ['9.9.9.10', '149.112.112.10'], filtering: 'none', notes: 'Quad9 без блокировок.' },
  { id: 'adguard', name: 'AdGuard DNS', vendor: 'AdGuard', country: 'CY', region: 'Глобальный', ips: ['94.140.14.14', '94.140.15.15'], filtering: 'ads+trackers', notes: 'Реклама и трекеры.' },
  { id: 'opendns', name: 'OpenDNS Home', vendor: 'Cisco', country: 'US', region: 'Глобальный', ips: ['208.67.222.222', '208.67.220.220'], filtering: 'phishing', notes: 'Фильтрация фишинга.' },
  { id: 'cleanbrowsing', name: 'CleanBrowsing Security', vendor: 'CleanBrowsing', country: 'US', region: 'Глобальный', ips: ['185.228.168.9'], filtering: 'malware+phishing', notes: 'Вредоносные и фишинговые домены.' },
  { id: 'mullvad', name: 'Mullvad DNS', vendor: 'Mullvad', country: 'SE', region: 'Глобальный', ips: ['194.242.2.2'], filtering: 'ads+trackers', notes: 'Реклама и трекеры.' },
  { id: 'controld', name: 'Control D Free', vendor: 'Control D', country: 'CA', region: 'Глобальный', ips: ['76.76.2.0'], filtering: 'none', notes: 'Без фильтрации.' },
  { id: 'dns.sb', name: 'DNS.SB', vendor: 'xTom', country: 'XX', region: 'Глобальный', ips: ['185.222.222.222', '45.11.45.11'], filtering: 'none', notes: 'Anycast, без логов.' },
  { id: 'uncensoreddns', name: 'UncensoredDNS', vendor: 'UncensoredDNS', country: 'DK', region: 'Европа', ips: ['91.239.100.100', '89.233.43.71'], filtering: 'none', notes: 'Дания и США.' },
  { id: 'fdn', name: 'FDN', vendor: 'FDN', country: 'FR', region: 'Европа', ips: ['80.67.169.12', '80.67.169.40'], filtering: 'none', notes: 'Франция, некоммерческий.' },
  { id: 'iij', name: 'IIJ Public DNS', vendor: 'Internet Initiative Japan', country: 'JP', region: 'Япония', ips: ['103.2.57.5', '103.2.57.6'], filtering: 'child-abuse', notes: 'Токио.' },
  { id: 'yandex', name: 'Yandex DNS', vendor: 'Yandex', country: 'RU', region: 'Россия', ips: ['77.88.8.8', '77.88.8.1'], filtering: 'none', notes: 'Публичный DNS Яндекса.' },
  { id: 'yandex-safe', name: 'Yandex DNS Safe', vendor: 'Yandex', country: 'RU', region: 'Россия', ips: ['77.88.8.2', '77.88.8.88'], filtering: 'malware+adult', notes: 'Безопасный режим.' },
  { id: 'cira', name: 'CIRA Private', vendor: 'CIRA', country: 'CA', region: 'Канада', ips: ['149.112.121.10'], filtering: 'none', notes: 'Canadian Shield.' },
  { id: 'switch', name: 'SWITCH', vendor: 'SWITCH', country: 'CH', region: 'Европа', ips: ['130.59.31.248', '130.59.31.251'], filtering: 'malware', notes: 'Швейцария.' },
  { id: 'artikel10', name: 'Artikel10', vendor: 'Artikel10', country: 'DE', region: 'Европа', ips: ['217.197.91.153'], filtering: 'none', notes: 'Германия, без логов.' },
  { id: 'adfilter', name: 'ADFilter', vendor: 'ADFilter', country: 'AU', region: 'Австралия', ips: ['103.249.238.124'], filtering: 'ads+malware+trackers', notes: 'Австралия.' },
  { id: 'dnspod', name: 'Tencent DNSPod', vendor: 'Tencent', country: 'CN', region: 'Китай', ips: ['119.29.29.29'], filtering: 'none', notes: 'Китай.' },
  { id: 'alidns', name: 'Alibaba AliDNS', vendor: 'Alibaba Cloud', country: 'CN', region: 'Китай', ips: ['223.5.5.5', '223.6.6.6'], filtering: 'none', notes: 'Китай, фильтрация GFW.' },
  { id: 'dns0', name: 'dns0.eu', vendor: 'dns0.eu', country: 'EU', region: 'Европа', ips: ['193.110.81.0', '185.253.5.0'], filtering: 'none', notes: 'Европейский некоммерческий резолвер.' },
  { id: 'neustar', name: 'UltraDNS Public', vendor: 'Neustar', country: 'US', region: 'Глобальный', ips: ['156.154.70.1', '156.154.71.1'], filtering: 'none', notes: 'Публичный резолвер.' },
];


export const defaultDnsSettings = {
  enhancedMode: 'fake-ip',
  ipv6: false,
  preferH3: false,
  respectRules: false,
  useHosts: true,
  cacheAlgorithm: 'lru',
  fakeIpRange: '10.99.0.1/16',
  nameservers: [
    { url: 'https://cloudflare-dns.com/dns-query', via: '' },
    { url: 'https://dns.google/dns-query', via: '' },
  ],
  fallback: [],
  fallbackGeoip: false,
  fallbackGeoipCode: 'RU',
  defaultNameservers: ['1.1.1.1'],
  proxyServerNameservers: [],
};

const SCHEMES = ['https://', 'tls://', 'quic://', 'udp://', 'tcp://', 'dhcp://'];
const VIA_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

export function normalizeResolverUrl(value) {
  if (typeof value !== 'string') throw new ValidationError("Specify the resolver address as a string.");
  const url = value.trim();
  if (!url || url.length > 512) throw new ValidationError("Specify a resolver address of up to 512 characters.");
  if (url === 'system') return 'system';
  if (!SCHEMES.some(scheme => url.toLowerCase().startsWith(scheme))) {
    throw new ValidationError("Specify a resolver address using https://, tls://, quic://, udp:// or tcp://.");
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new ValidationError("Enter a valid resolver address.");
  }
  if (!parsed.hostname) throw new ValidationError("Enter a valid resolver address.");
  return url;
}

function normalizeVia(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || !VIA_PATTERN.test(value)) {
    throw new ValidationError("Specify a valid resolver proxy tag.");
  }
  return value;
}

function normalizeEntry(input) {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return { url: normalizeResolverUrl(input.url), via: normalizeVia(input.via) };
  }
  return { url: normalizeResolverUrl(input), via: '' };
}

function normalizeEntries(input, label, { min = 0, max = 8 } = {}) {
  if (input === undefined || input === null) input = [];
  if (!Array.isArray(input)) throw new ValidationError(`Specify ${label} as a list.`);
  if (input.length < min) throw new ValidationError(`Specify at least one address in the "${label}".`);
  if (input.length > max) throw new ValidationError(`Specify no more than ${max} addresses in the "${label}".`);
  return input.map(normalizeEntry);
}

function normalizeIpList(input, label, max) {
  if (input === undefined || input === null) input = [];
  if (!Array.isArray(input)) throw new ValidationError(`Specify ${label} as a list.`);
  if (input.length > max) throw new ValidationError(`Specify no more than ${max} addresses in the "${label}".`);
  return input.map(value => {
    const address = typeof value === 'string' ? value.trim() : '';
    if (net.isIP(address) === 0) throw new ValidationError(`Specify ${label} as IP addresses.`);
    return address;
  });
}

function normalizeFakeIpRange(value) {
  const range = typeof value === 'string' ? value.trim() : '';
  const match = /^([^/]+)\/(\d{1,2})$/.exec(range);
  if (!match || net.isIP(match[1]) !== 4 || Number(match[2]) > 32) {
    throw new ValidationError("Specify a fake-IP range in IPv4/CIDR format, such as 198.18.0.1/16.");
  }
  return range;
}

export function validateDnsSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError("Specify DNS settings as an object.");
  }
  const enhancedMode = input.enhancedMode ?? defaultDnsSettings.enhancedMode;
  if (!['redir-host', 'fake-ip'].includes(enhancedMode)) {
    throw new ValidationError("Specify the DNS mode: redir-host or fake-ip.");
  }
  const cacheAlgorithm = input.cacheAlgorithm ?? defaultDnsSettings.cacheAlgorithm;
  if (!['lru', 'arc'].includes(cacheAlgorithm)) {
    throw new ValidationError("Specify the cache algorithm: lru or arc.");
  }
  const fallbackGeoipCode = String(input.fallbackGeoipCode ?? defaultDnsSettings.fallbackGeoipCode).trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(fallbackGeoipCode)) {
    throw new ValidationError("Specify the geo-filter country code using two Latin letters.");
  }
  return {
    enhancedMode,
    ipv6: input.ipv6 === true,
    preferH3: input.preferH3 === true,
    respectRules: input.respectRules === true,
    useHosts: input.useHosts !== false,
    cacheAlgorithm,
    fakeIpRange: normalizeFakeIpRange(input.fakeIpRange ?? defaultDnsSettings.fakeIpRange),
    nameservers: normalizeEntries(input.nameservers ?? defaultDnsSettings.nameservers, 'primary resolvers', { min: 1, max: 8 }),
    fallback: normalizeEntries(input.fallback, 'fallback resolvers', { max: 8 }),
    fallbackGeoip: input.fallbackGeoip === true,
    fallbackGeoipCode,
    defaultNameservers: normalizeIpList(input.defaultNameservers, 'bootstrap resolvers', 4),
    proxyServerNameservers: normalizeEntries(input.proxyServerNameservers, 'proxy server resolvers', { max: 4 }),
  };
}

function yamlValue(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function entryValue(entry) {
  return entry.via ? `${entry.url}#${entry.via}` : entry.url;
}

function pushList(lines, key, values, render) {
  if (!values.length) return;
  lines.push(`  ${key}:`);
  for (const value of values) lines.push(`    - ${render(value)}`);
}

// Produces the `dns:` block only. Never includes providers, keys or inbound data.
export function buildMihomoDnsConfig(settings) {
  const lines = [
    'dns:',
    '  enable: true',
    `  enhanced-mode: ${settings.enhancedMode}`,
    `  ipv6: ${settings.ipv6}`,
    `  prefer-h3: ${settings.preferH3}`,
    `  respect-rules: ${settings.respectRules}`,
    `  use-hosts: ${settings.useHosts}`,
    `  cache-algorithm: ${settings.cacheAlgorithm}`,
  ];
  if (settings.enhancedMode === 'fake-ip') lines.push(`  fake-ip-range: ${settings.fakeIpRange}`);
  pushList(lines, 'default-nameserver', settings.defaultNameservers, yamlValue);
  pushList(lines, 'proxy-server-nameserver', settings.proxyServerNameservers, entry => yamlValue(entryValue(entry)));
  pushList(lines, 'nameserver', settings.nameservers, entry => yamlValue(entryValue(entry)));
  if (settings.fallback.length) {
    pushList(lines, 'fallback', settings.fallback, entry => yamlValue(entryValue(entry)));
    lines.push('  fallback-filter:', `    geoip: ${settings.fallbackGeoip}`);
    if (settings.fallbackGeoip) lines.push(`    geoip-code: ${settings.fallbackGeoipCode}`);
  }
  return lines.join('\n') + '\n';
}

// Every resolver the UI shows a status for: pools, fallback, proxy-address and bootstrap.
export function statusTargets(settings) {
  return [...new Set([
    ...settings.nameservers.map(entry => entry.url),
    ...settings.fallback.map(entry => entry.url),
    ...settings.proxyServerNameservers.map(entry => entry.url),
    ...settings.defaultNameservers,
  ].filter(Boolean))];
}

// Russian and common aliases so search finds providers by local names.
const providerAliases = {
  cloudflare: ['клаудфлэр', 'cloudflare'],
  'cloudflare-family': ['клаудфлэр', 'cloudflare'],
  google: ['гугл', 'google'],
  quad9: ['квад9', 'quad9'],
  'quad9-unsecured': ['квад9', 'quad9'],
  adguard: ['адгард', 'adguard'],
  'adguard-family': ['адгард', 'adguard'],
  opendns: ['опенднс', 'cisco'],
  'cleanbrowsing-security': ['клинбраузинг', 'cleanbrowsing'],
  cleanbrowsing: ['клинбраузинг', 'cleanbrowsing'],
  mullvad: ['муллвад', 'mullvad'],
  controld: ['контрол', 'controld'],
  'dns.sb': ['днс сб', 'dnssb'],
  'applied-privacy': ['приватность', 'applied privacy'],
  artikel10: ['артикель', 'artikel10'],
  dremaxx: ['дремакс', 'dremaxx'],
  dnsforfamily: ['семейный', 'dns for family'],
  'dns4eu-unfiltered': ['европа', 'dns4eu'],
  'dns4eu-protective': ['европа', 'dns4eu'],
  'cira-private': ['сира', 'cira'],
  'cira-protected': ['сира', 'cira'],
  cira: ['сира', 'cira'],
  adfilter: ['адфильтр', 'adfilter'],
  yandex: ['яндекс', 'yandex'],
  'yandex-safe': ['яндекс', 'yandex', 'безопасный'],
  comss: ['комсс', 'comss'],
  iij: ['ииджей', 'iij'],
  fdn: ['фдн', 'fdn'],
  'la-contre-voie': ['контр-вуа', 'la contre voie'],
  libredns: ['либреднс', 'libredns'],
  dnsforge: ['днсфорж', 'dnsforge'],
  dnsbunker: ['днсбанкер', 'dnsbunker'],
  ffmuc: ['фрайфунк', 'freifunk'],
  'digitale-gesellschaft': ['дигитале', 'digitale gesellschaft'],
  switch: ['свитч', 'switch'],
  dns4all: ['днс4олл', 'dns4all'],
  uncensoreddns: ['uncensored', 'uncensoreddns'],
  njalla: ['ньялла', 'njalla'],
  alidns: ['алиднс', 'алибаба', 'alidns'],
  dnspod: ['днспод', 'dnspod', 'tencent'],
  dns0: ['днс0', 'dns0'],
  neustar: ['ультраднс', 'neustar', 'ultradns'],
};
for (const entry of [...resolvers, ...bootstrapResolvers]) {
  entry.aliases = providerAliases[entry.id] || (entry.id.startsWith('dnscry-') ? ['dnscry', 'днскрай'] : []);
}
