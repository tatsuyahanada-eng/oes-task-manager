/* ============================================================
 * DB Controller - Service Worker
 *
 * 方針:
 *   - 画面の外枠 (HTML/CSS/JS/アイコン) だけをキャッシュする
 *   - /api/ の応答は 絶対にキャッシュしない
 *     DB のデータや接続情報が端末に residual として残らないようにするため
 * ========================================================== */

const CACHE = 'dbctl-shell-v33';

const SHELL = [
  './',
  './index.html',
  './login.html',
  './app.js',
  './style.css',
  './theme.css',
  './logo.svg',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // API はキャッシュを一切挟まない (DB のデータを端末に残さない)
  if (url.pathname.startsWith('/api/')) return;

  // ログイン画面へのリダイレクトはキャッシュしない。
  // これを保存すると、ログイン後もリダイレクトが返り続けて画面が出なくなる。
  const cacheable = (res) =>
    res && res.ok && res.status === 200 && res.type === 'basic' && !res.redirected;

  // 画面の外枠は「まずネットワーク、駄目ならキャッシュ」。
  //
  // 以前はキャッシュ優先にしていたが、それだと更新した画面が
  // 次に起動したときにしか反映されず、直したはずの不具合が
  // 直っていないように見えてしまう。
  // このツールはネットワークが繋がっている前提で使うものなので、
  // 常に最新を取りに行き、繋がらないときだけキャッシュで起動する。
  event.respondWith(
    fetch(request)
      .then((res) => {
        if (cacheable(res)) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      })
      .catch(() => caches.match(request).then((hit) => hit || caches.match('./index.html')))
  );
});
