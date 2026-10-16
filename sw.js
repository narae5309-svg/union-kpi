// UNION 사업관리 - 앱 설치용 최소 서비스워커 (데이터는 항상 서버에서 새로 받아요)
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => new Response('<meta charset="utf-8"><meta name="viewport" content="width=device-width"><div style="font-family:sans-serif;padding:40px;text-align:center;color:#555">인터넷에 연결되어 있지 않아요.<br>연결 후 다시 열어 주세요.</div>', {headers:{'Content-Type':'text/html; charset=utf-8'}})));
  }
});
