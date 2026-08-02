/* テスト・LAN用の簡易サーバー。
   - このフォルダの中身（アプリ画面）を配信する
   - /api/rooms/... で部屋の状態を全端末に中継する
   同じPC・同じWi-Fi内での利用向け。インターネット越しの本番は Firebase を使う（README.md 参照）。

   起動: node dev-server.js  */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { initialState, applyOp } = require('./js/store.js');

const PORT = parseInt(process.env.PORT || '8790', 10);
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/plain; charset=utf-8'
};

const rooms = new Map();

function getRoom(id) {
  let room = rooms.get(id);
  if (!room) {
    room = { state: initialState(), clients: new Set(), images: new Map() };
    rooms.set(id, room);
  }
  return room;
}

function broadcast(room) {
  const payload = 'data: ' + JSON.stringify({ state: room.state, now: Date.now() }) + '\n\n';
  for (const client of room.clients) {
    try { client.res.write(payload); } catch (e) { /* 切断済みは close イベント側で片付く */ }
  }
}

function lanUrls() {
  const urls = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const ni of ifs[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) urls.push('http://' + ni.address + ':' + PORT);
    }
  }
  return urls;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);

  if (url.pathname === '/api/info') {
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ mode: 'server', urls: lanUrls() }));
    return;
  }

  if (parts[0] === 'api' && parts[1] === 'rooms' && parts[3] === 'events' && req.method === 'GET') {
    const room = getRoom(decodeURIComponent(parts[2]));
    const member = {
      id: url.searchParams.get('mid') || ('m-' + Math.random().toString(36).slice(2)),
      name: url.searchParams.get('name') || '無名',
      role: url.searchParams.get('role') || 'talent',
      online: true,
      lastSeen: Date.now()
    };
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(': connected\n\n');
    const client = { res, mid: member.id };
    room.clients.add(client);
    applyOp(room.state, { t: 'member', member });
    broadcast(room);

    req.on('close', () => {
      room.clients.delete(client);
      const stillHere = [...room.clients].some((c) => c.mid === client.mid);
      if (!stillHere) {
        applyOp(room.state, { t: 'memberOffline', mid: client.mid, ts: Date.now() });
        broadcast(room);
      }
    });
    return;
  }

  if (parts[0] === 'api' && parts[1] === 'rooms' && parts[3] === 'op' && req.method === 'POST') {
    const room = getRoom(decodeURIComponent(parts[2]));
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try {
        const { op } = JSON.parse(body);
        // カウント開始時刻は端末ではなくサーバーの時計で決める（端末間の時計ズレ対策）
        if (op && op.t === 'countdown' && op.cd) op.cd.startAt = Date.now() + 1000;
        if (op && op.t === 'clearCues') room.images.clear();
        applyOp(room.state, op);
        broadcast(room);
        res.writeHead(200, { 'Content-Type': MIME['.json'] });
        res.end('{"ok":true}');
      } catch (e) {
        res.writeHead(400, { 'Content-Type': MIME['.json'] });
        res.end('{"ok":false}');
      }
    });
    return;
  }

  // 画像の受け取り（部屋の状態とは別置き。配信は下のGETで行う）
  if (parts[0] === 'api' && parts[1] === 'rooms' && parts[3] === 'image' && req.method === 'POST') {
    const room = getRoom(decodeURIComponent(parts[2]));
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 6e6) req.destroy(); });
    req.on('end', () => {
      try {
        const j = JSON.parse(body);
        const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(j.data || '');
        if (!m) throw new Error('bad image');
        const id = 'img-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
        room.images.set(id, { type: m[1], buf: Buffer.from(m[2], 'base64') });
        while (room.images.size > 40) room.images.delete(room.images.keys().next().value);
        res.writeHead(200, { 'Content-Type': MIME['.json'] });
        res.end(JSON.stringify({ id }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': MIME['.json'] });
        res.end('{"ok":false}');
      }
    });
    return;
  }

  if (parts[0] === 'api' && parts[1] === 'rooms' && parts[3] === 'image' && parts[4] && req.method === 'GET') {
    const room = getRoom(decodeURIComponent(parts[2]));
    const img = room.images.get(decodeURIComponent(parts[4]));
    if (!img) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': img.type, 'Cache-Control': 'private, max-age=86400' });
    res.end(img.buf);
    return;
  }

  let filePath = decodeURIComponent(url.pathname);
  if (filePath === '/') filePath = '/index.html';
  const abs = path.join(ROOT, filePath);
  if (!abs.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(abs, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    const ext = path.extname(abs).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

// 途中の機器に接続を切られないよう、20秒ごとに小さな生存信号を流す
setInterval(() => {
  for (const room of rooms.values()) {
    for (const client of room.clients) {
      try { client.res.write(': ping\n\n'); } catch (e) {}
    }
  }
}, 20000);

server.listen(PORT, '0.0.0.0', () => {
  console.log('KIPzKanvas を起動しました');
  console.log('  このPCで開く:   http://localhost:' + PORT);
  for (const u of lanUrls()) console.log('  同じWi-Fiから:  ' + u);
});
