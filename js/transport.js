/* 通信部分。2つのモードを自動で切り替える。
   - firebase-config.js に設定あり → Firebase 経由（インターネット越し・本番用）
   - 設定なし → dev-server.js 経由（同じPC・同じWi-Fi内のテスト用）
   app.js からはどちらも同じ形（connect / sendOp / uploadImage / imageSrc / serverNow / on）で見える。
   画像は大きいので、部屋の状態とは別置きにして必要なときだけ取りに行く。 */
(function () {
  'use strict';

  function makeEmitter() {
    var handlers = {};
    return {
      on: function (ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); },
      emit: function (ev, arg) { (handlers[ev] || []).forEach(function (fn) { try { fn(arg); } catch (e) { console.error(e); } }); }
    };
  }

  function newImgId() { return 'img-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7); }

  /* ---- dev-server.js 経由 ---- */
  function createServerTransport() {
    var em = makeEmitter();
    var offset = 0;
    var es = null;
    var roomId = null;

    function connect(room, member) {
      roomId = room;
      var q = new URLSearchParams({ mid: member.id, name: member.name, role: member.role });
      es = new EventSource('/api/rooms/' + encodeURIComponent(room) + '/events?' + q.toString());
      es.onopen = function () { em.emit('conn', true); };
      es.onerror = function () { em.emit('conn', false); };
      es.onmessage = function (e) {
        try {
          var msg = JSON.parse(e.data);
          offset = msg.now - Date.now();
          em.emit('state', msg.state);
        } catch (err) { /* 生存信号などデータ以外は無視 */ }
      };
    }

    function sendOp(op) {
      fetch('/api/rooms/' + encodeURIComponent(roomId) + '/op', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: op })
      }).catch(function () { em.emit('conn', false); });
    }

    function uploadImage(dataUrl, w, h) {
      return fetch('/api/rooms/' + encodeURIComponent(roomId) + '/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: dataUrl, w: w, h: h })
      }).then(function (r) {
        if (!r.ok) throw new Error('upload failed');
        return r.json();
      }).then(function (j) { return j.id; });
    }

    function imageSrc(imgId) {
      return Promise.resolve('/api/rooms/' + encodeURIComponent(roomId) + '/image/' + encodeURIComponent(imgId));
    }

    return {
      mode: 'server',
      on: em.on,
      connect: connect,
      sendOp: sendOp,
      uploadImage: uploadImage,
      imageSrc: imageSrc,
      serverNow: function () { return Date.now() + offset; },
      leave: function () { if (es) es.close(); }
    };
  }

  /* ---- Firebase 経由（本番） ---- */
  function createFirebaseTransport(config) {
    var em = makeEmitter();
    var offset = 0;
    var fb = null;
    var roomPath = null;   /* rooms/<room>/state  … 部屋の状態（軽い） */
    var imagesPath = null; /* rooms/<room>/images … 画像（重いので別置き） */
    var member = null;
    var imgCache = {};

    function normalize(raw) {
      var s = raw || {};
      var state = {
        presets: (Array.isArray(s.presets) && s.presets.length) ? s.presets : window.KanpeStore.DEFAULT_PRESETS,
        cues: s.cues || {},
        countdown: s.countdown || null,
        members: s.members || {}
      };
      Object.keys(state.cues).forEach(function (id) {
        if (!state.cues[id].acks) state.cues[id].acks = {};
      });
      return state;
    }

    function connect(room, m) {
      member = m;
      roomPath = 'rooms/' + room + '/state';
      imagesPath = 'rooms/' + room + '/images';
      Promise.all([
        import('https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js'),
        import('https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js')
      ]).then(function (mods) {
        var appMod = mods[0], dbMod = mods[1];
        var app = appMod.initializeApp(config);
        var db = dbMod.getDatabase(app);
        fb = { db: db, mod: dbMod };

        dbMod.onValue(dbMod.ref(db, '.info/serverTimeOffset'), function (snap) {
          offset = snap.val() || 0;
        });

        dbMod.onValue(dbMod.ref(db, '.info/connected'), function (snap) {
          var ok = snap.val() === true;
          em.emit('conn', ok);
          if (ok) {
            var meRef = dbMod.ref(db, roomPath + '/members/' + member.id);
            /* 通信が切れたら自動で「オフライン」と記録される仕掛け */
            dbMod.onDisconnect(meRef).update({ online: false, lastSeen: dbMod.serverTimestamp() });
            dbMod.update(meRef, { id: member.id, name: member.name, role: member.role, online: true, lastSeen: dbMod.serverTimestamp() });
          }
        });

        dbMod.onValue(dbMod.ref(db, roomPath), function (snap) {
          em.emit('state', normalize(snap.val()));
        });
      }).catch(function (err) {
        console.error('Firebaseに接続できません', err);
        em.emit('conn', false);
        em.emit('fatal', 'Firebaseに接続できませんでした。firebase-config.js の内容とインターネット接続を確認してください。');
      });
    }

    function sendOp(op) {
      if (!fb) return;
      var dbMod = fb.mod, db = fb.db;
      function r(p) { return dbMod.ref(db, roomPath + '/' + p); }
      switch (op.t) {
        case 'cue': dbMod.set(r('cues/' + op.cue.id), op.cue); break;
        case 'cancelCue': dbMod.update(r('cues/' + op.id), { canceled: true }); break;
        case 'cueUpdate': dbMod.update(r('cues/' + op.id), { segments: op.segments || null, text: op.text || '', url: op.url || null }); break;
        case 'ack': dbMod.set(r('cues/' + op.cueId + '/acks/' + op.mid), { name: op.name, stamp: op.stamp, ts: op.ts }); break;
        case 'presets': dbMod.set(r('presets'), op.presets); break;
        case 'countdown': dbMod.set(r('countdown'), op.cd); break;
        case 'cancelCountdown': dbMod.update(r('countdown'), { canceled: true }); break;
        case 'member': dbMod.update(r('members/' + op.member.id), op.member); break;
        case 'clearCues':
          dbMod.update(dbMod.ref(db, roomPath), { cues: null, countdown: null });
          dbMod.remove(dbMod.ref(db, imagesPath));
          imgCache = {};
          break;
      }
    }

    function uploadImage(dataUrl, w, h) {
      if (!fb) return Promise.reject(new Error('not connected'));
      var id = newImgId();
      imgCache[id] = dataUrl;
      return fb.mod.set(fb.mod.ref(fb.db, imagesPath + '/' + id), { data: dataUrl, w: w, h: h, ts: Date.now() })
        .then(function () { return id; });
    }

    function imageSrc(imgId) {
      if (imgCache[imgId]) return Promise.resolve(imgCache[imgId]);
      if (!fb) return Promise.reject(new Error('not connected'));
      return fb.mod.get(fb.mod.ref(fb.db, imagesPath + '/' + imgId)).then(function (snap) {
        var v = snap.val();
        if (!v || !v.data) throw new Error('image not found');
        imgCache[imgId] = v.data;
        return v.data;
      });
    }

    return {
      mode: 'firebase',
      on: em.on,
      connect: connect,
      sendOp: sendOp,
      uploadImage: uploadImage,
      imageSrc: imageSrc,
      serverNow: function () { return Date.now() + offset; },
      leave: function () {
        if (fb && member) {
          fb.mod.update(fb.mod.ref(fb.db, roomPath + '/members/' + member.id), { online: false, lastSeen: Date.now() });
        }
      }
    };
  }

  window.KanpeTransport = {
    create: function () {
      if (window.FIREBASE_CONFIG) return createFirebaseTransport(window.FIREBASE_CONFIG);
      return createServerTransport();
    }
  };
})();
