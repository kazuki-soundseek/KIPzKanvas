/* KIPzKanvas 画面まわりの処理すべて。通信は js/transport.js、状態の形は js/store.js に分離してある。 */
(function () {
  'use strict';

  var Store = window.KanpeStore;
  var URL_RE = /(https?:\/\/[^\s<>"']+)/g;

  /* ---------- 小道具 ---------- */
  function $(sel) { return document.querySelector(sel); }
  function $all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function uid() { return 'c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function fmtTime(ts) {
    var d = new Date(ts);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }
  function chipEl(text, cls) {
    var s = document.createElement('span');
    s.className = 'chip ' + (cls || '');
    s.textContent = text;
    return s;
  }
  function colorLabel(c) { return c === 'urgent' ? '緊急' : c === 'warn' ? '注意' : '通常'; }

  /* ---------- 文字とマーカー（segments = [{text, mark}] の並び） ---------- */
  function segsFromText(text) { return text ? [{ text: String(text), mark: false }] : []; }
  function segsText(segs) { return (segs || []).map(function (s) { return s.text; }).join(''); }

  /* 「==文字==」をマーカー扱いに変換（定型ボタン用の書き方） */
  function parseMarkSyntax(text) {
    var segs = [];
    var re = /==([^=\n]+)==/g;
    var last = 0, m;
    text = String(text || '');
    while ((m = re.exec(text))) {
      if (m.index > last) segs.push({ text: text.slice(last, m.index), mark: false });
      segs.push({ text: m[1], mark: true });
      last = re.lastIndex;
    }
    if (last < text.length) segs.push({ text: text.slice(last), mark: false });
    return segs;
  }

  function firstUrl(text) { URL_RE.lastIndex = 0; var m = URL_RE.exec(text || ''); return m ? m[1] : null; }
  function domainOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return url; } }
  function cueKind(c) { return c.imgId ? 'image' : ((c.url && c.text && c.text.trim() === c.url) ? 'url' : 'text'); }

  function appendLinkified(target, text, links) {
    var parts = String(text).split(URL_RE);
    parts.forEach(function (part) {
      if (!part) return;
      if (links && /^https?:\/\//.test(part)) {
        var a = document.createElement('a');
        a.href = part; a.target = '_blank'; a.rel = 'noopener';
        a.textContent = part;
        target.appendChild(a);
      } else {
        target.appendChild(document.createTextNode(part));
      }
    });
  }
  function renderSegmentsInto(el, segs, links) {
    el.textContent = '';
    (segs || []).forEach(function (seg) {
      if (seg.mark) {
        var mk = document.createElement('mark');
        appendLinkified(mk, seg.text, links);
        el.appendChild(mk);
      } else {
        appendLinkified(el, seg.text, links);
      }
    });
  }

  /* ---------- アプリの状態 ---------- */
  var me = null;
  var joined = false;
  var joinRole = null;
  var transport = null;
  var roomState = Store.initialState();
  var gotFirstState = false;
  var latestSeenCueId = null;
  var lastCueSig = '';
  var soundOn = (localStorage.getItem('kanpe-sound') || '1') === '1';
  var fontScale = parseFloat(localStorage.getItem('kanpe-font-scale') || '1') || 1;
  var connEverOk = false;
  var bannerTimer = null;
  var wakeLockSentinel = null;
  var cdView = { id: null, lastNum: null, flashUntil: 0 };
  var cdBarId = null; /* タイムバーの刻みをどのカウント用に組んだか */
  var serverInfo = null;
  var editingCueId = null;
  var pendingImage = null;
  var imgSrcCache = {};
  var composeEl = null;
  var drawCv = null, drawCtx = null;
  var drawStrokes = [];
  var drawCur = null;
  var drawPen = { color: '#171a20', marker: false, size: 'medium' };
  var DRAW_W = 1280, DRAW_H = 720;
  var DRAW_PAD = 60;
  var drawBg = null;        /* 下地: null | {type:'text', segments, text} | {type:'image', img} */
  var drawSource = 'blank'; /* どこから開いたか: blank | compose | pending | cue */
  var DRAW_FONT = '-apple-system, BlinkMacSystemFont, "Hiragino Sans", "Yu Gothic UI", "Noto Sans JP", "Meiryo", sans-serif';

  function serverNow() { return transport ? transport.serverNow() : Date.now(); }

  function cueList() {
    return Object.keys(roomState.cues).map(function (k) { return roomState.cues[k]; })
      .sort(function (a, b) { return a.ts - b.ts; });
  }
  /* 現地発の簡易メッセージ。東京からの指示と違い、現地の大画面には表示しない */
  function isTalentMsg(c) { return (c.fromRole || 'director') === 'talent'; }
  function directorCues() { return cueList().filter(function (c) { return !isTalentMsg(c); }); }
  function latestCue() {
    var l = directorCues();
    return l.length ? l[l.length - 1] : null;
  }
  function latestActiveCue() {
    var l = directorCues().filter(function (c) { return !c.canceled; });
    return l.length ? l[l.length - 1] : null;
  }
  function activeCountdown() {
    var c = roomState.countdown;
    if (!c || c.canceled) return null;
    if (serverNow() > c.startAt + c.seconds * 1000 + 1500) return null;
    return c;
  }

  /* 自分の操作は送信と同時に手元へ即反映する（体感を速くするため）。
     サーバーからの正式な状態が後から届いて同じ内容で上書きされる。 */
  function dispatch(op) {
    Store.applyOp(roomState, op);
    renderAll();
    transport.sendOp(op);
  }

  function baseCue(extra) {
    return Object.assign({
      id: uid(), ts: serverNow(), from: { id: me.id, name: me.name },
      fromRole: me.role,
      color: 'normal', canceled: false, acks: {},
      segments: null, text: '', url: null, imgId: null, imgW: 0, imgH: 0
    }, extra);
  }

  /* ---------- 音（端末内で合成するので音声ファイル不要） ---------- */
  var audioCtx = null;
  function initAudio() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC && !audioCtx) audioCtx = new AC();
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) { /* 音が出せない端末では黙って諦める */ }
  }
  function tone(freq, durMs, delayMs, type, vol) {
    if (!audioCtx || !soundOn) return;
    try {
      var t0 = audioCtx.currentTime + (delayMs || 0) / 1000;
      var o = audioCtx.createOscillator();
      var g = audioCtx.createGain();
      o.type = type || 'sine';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol || 0.35, t0 + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + durMs / 1000);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(t0); o.stop(t0 + durMs / 1000 + 0.05);
    } catch (e) {}
  }
  function playCueSound(color) {
    if (color === 'urgent') { tone(988, 110, 0, 'square', 0.28); tone(988, 110, 170, 'square', 0.28); tone(988, 200, 340, 'square', 0.28); }
    else { tone(660, 120, 0); tone(990, 190, 130); }
  }
  function pip() { tone(880, 70, 0, 'sine', 0.4); }
  function goSound() { tone(1245, 450, 0, 'sine', 0.45); }
  function vibrate(pat) { if (navigator.vibrate) { try { navigator.vibrate(pat); } catch (e) {} } }

  /* ---------- 全画面表示 ---------- */
  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }
  function toggleFullscreen() {
    var root = document.documentElement;
    if (isFullscreen()) {
      var ex = document.exitFullscreen || document.webkitExitFullscreen;
      if (ex) ex.call(document);
      return;
    }
    var fn = root.requestFullscreen || root.webkitRequestFullscreen;
    if (!fn) {
      /* iPhoneのSafariは全画面APIが使えないため、代わりの方法を案内する */
      alert('この端末のブラウザは全画面表示に対応していません。\niPhoneの場合は、共有ボタン →「ホーム画面に追加」から開くと全画面で使えます。');
      return;
    }
    var p = fn.call(root);
    if (p && p.catch) p.catch(function () {});
  }
  function updateFsBtn() {
    var b = $('#btn-fullscreen');
    if (b) b.textContent = isFullscreen() ? '元に戻す' : '全画面';
  }

  /* ---------- 画面スリープ防止 ---------- */
  function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    navigator.wakeLock.request('screen').then(function (s) {
      wakeLockSentinel = s;
    }).catch(function () { /* 省電力設定などで拒否されることがある */ });
  }

  /* ---------- 入室 ---------- */
  function selectRole(r) {
    joinRole = r;
    $('#role-director').classList.toggle('selected', r === 'director');
    $('#role-talent').classList.toggle('selected', r === 'talent');
  }

  function sanitizeRoom(room) {
    return room.replace(/[.#$\[\]\/\s]+/g, '-');
  }

  function join() {
    var room = sanitizeRoom($('#join-room').value.trim());
    var name = $('#join-name').value.trim();
    var hint = $('#join-hint');
    if (!room) { hint.hidden = false; hint.textContent = '部屋コードを入れてください（東京と現地で同じコードにします）'; $('#join-room').focus(); return; }
    if (!joinRole) { hint.hidden = false; hint.textContent = '「東京」か「現地」かを選んでください'; return; }
    hint.hidden = true;

    localStorage.setItem('kanpe-room', room);
    localStorage.setItem('kanpe-name', name);
    localStorage.setItem('kanpe-role', joinRole);

    var mid = sessionStorage.getItem('kanpe-mid');
    if (!mid) { mid = 'm-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); sessionStorage.setItem('kanpe-mid', mid); }

    me = { id: mid, name: name || (joinRole === 'director' ? '東京' : '現地'), role: joinRole, room: room };

    initAudio(); /* ボタンを押した直後だけ音の許可が取れる（ブラウザの仕様） */

    transport = window.KanpeTransport.create();
    transport.on('state', onState);
    transport.on('conn', onConn);
    transport.on('fatal', function (msg) {
      var b = $('#conn-banner');
      b.hidden = false; b.textContent = msg; b.className = 'bad';
    });
    transport.connect(room, { id: me.id, name: me.name, role: me.role });

    joined = true;
    document.body.dataset.joined = '1';
    document.body.dataset.view = me.role;
    $('#hdr-room').textContent = room;

    requestWakeLock();
    startLoops();
    setInterval(function () {
      if (transport) transport.sendOp({ t: 'member', member: { id: me.id, name: me.name, role: me.role, online: true, lastSeen: Date.now() } });
    }, 25000);
  }

  /* ---------- 通信イベント ---------- */
  function onState(s) {
    roomState = s;
    var all = cueList();
    var lastAny = all.length ? all[all.length - 1] : null;
    var lc = latestCue();
    var isFirst = !gotFirstState;
    gotFirstState = true;
    var isNew = lastAny && lastAny.id !== latestSeenCueId;
    if (lastAny) latestSeenCueId = lastAny.id;
    var sig = lc ? (lc.id + '|' + (lc.text || '') + '|' + JSON.stringify(lc.segments || null)) : '';
    renderAll();
    if (!isFirst && isNew && lastAny.from && lastAny.from.id !== me.id && !lastAny.canceled) {
      playCueSound(lastAny.color);
      vibrate(lastAny.color === 'urgent' ? [120, 80, 120, 80, 240] : [160]);
      if (!isTalentMsg(lastAny)) flashCueArea();
    } else if (!isFirst && !isNew && lc && lc.from && lc.from.id !== me.id && !lc.canceled && lastCueSig && sig !== lastCueSig) {
      /* 同じ指示の文言・マーカーが書き換わった（マーカー編集） */
      pip();
      flashCueArea();
    }
    lastCueSig = sig;
  }

  function onConn(ok) {
    var b = $('#conn-banner');
    if (ok) {
      if (connEverOk) {
        b.hidden = false; b.textContent = '接続しました'; b.className = 'ok';
        clearTimeout(bannerTimer);
        bannerTimer = setTimeout(function () { b.hidden = true; }, 1600);
      } else {
        b.hidden = true;
      }
      connEverOk = true;
    } else {
      clearTimeout(bannerTimer);
      b.hidden = false; b.textContent = '再接続中… 通信が切れています'; b.className = 'bad';
    }
  }

  /* ---------- 送信の操作 ---------- */
  function selectedColor() {
    var el = document.querySelector('input[name="cuecolor"]:checked');
    return el ? el.value : 'normal';
  }

  function composeSegments() {
    var segs = [];
    function add(text, mark) {
      if (!text) return;
      var last = segs[segs.length - 1];
      if (last && last.mark === mark) last.text += text;
      else segs.push({ text: text, mark: mark });
    }
    function walk(node, inMark) {
      node.childNodes.forEach(function (n) {
        if (n.nodeType === 3) add(n.nodeValue, inMark);
        else if (n.nodeName === 'BR') add('\n', inMark);
        else if (n.nodeName === 'MARK') walk(n, true);
        else {
          if ((n.nodeName === 'DIV' || n.nodeName === 'P') && segs.length) add('\n', inMark);
          walk(n, inMark);
        }
      });
    }
    walk(composeEl, false);
    while (segs.length && !segs[0].text.trim()) segs.shift();
    while (segs.length && !segs[segs.length - 1].text.trim()) segs.pop();
    if (segs.length) {
      segs[0].text = segs[0].text.replace(/^\s+/, '');
      segs[segs.length - 1].text = segs[segs.length - 1].text.replace(/\s+$/, '');
    }
    return segs;
  }

  function setComposeSegments(segs) {
    composeEl.textContent = '';
    (segs || []).forEach(function (seg) {
      var container = seg.mark ? document.createElement('mark') : null;
      var parts = String(seg.text).split('\n');
      parts.forEach(function (p, i) {
        if (i) (container || composeEl).appendChild(document.createElement('br'));
        if (p) (container || composeEl).appendChild(document.createTextNode(p));
      });
      if (container) composeEl.appendChild(container);
    });
  }

  function applyMark() {
    composeEl.focus();
    var sel = window.getSelection();
    if (!sel.rangeCount) return;
    var range = sel.getRangeAt(0);
    if (range.collapsed || !composeEl.contains(range.commonAncestorContainer)) return;
    var frag = range.extractContents();
    if (frag.querySelectorAll) {
      frag.querySelectorAll('mark').forEach(function (m) {
        while (m.firstChild) m.parentNode.insertBefore(m.firstChild, m);
        m.remove();
      });
    }
    var mark = document.createElement('mark');
    mark.appendChild(frag);
    range.insertNode(mark);
    composeEl.normalize();
    sel.removeAllRanges();
  }

  function clearMarks() {
    composeEl.querySelectorAll('mark').forEach(function (m) {
      while (m.firstChild) m.parentNode.insertBefore(m.firstChild, m);
      m.remove();
    });
    composeEl.normalize();
  }

  function insertPlainText(text) {
    var sel = window.getSelection();
    if (!sel.rangeCount || !composeEl.contains(sel.getRangeAt(0).commonAncestorContainer)) {
      composeEl.appendChild(document.createTextNode(text));
      return;
    }
    var range = sel.getRangeAt(0);
    range.deleteContents();
    var node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.setEndAfter(node);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function sendCompose() {
    var segs = composeSegments();
    var text = segsText(segs);
    if (!text.trim()) return;
    var url = firstUrl(text);
    if (editingCueId && roomState.cues[editingCueId] && !roomState.cues[editingCueId].canceled) {
      dispatch({ t: 'cueUpdate', id: editingCueId, segments: segs, text: text, url: url });
    } else {
      dispatch({ t: 'cue', cue: baseCue({ segments: segs, text: text, url: url, color: selectedColor() }) });
    }
    stopEditing();
    composeEl.textContent = '';
  }

  function startEditing(cue) {
    editingCueId = cue.id;
    setComposeSegments(cue.segments && cue.segments.length ? cue.segments : segsFromText(cue.text));
    $('#edit-badge').hidden = false;
    $('#btn-send').textContent = '更新';
    composeEl.focus();
  }
  function stopEditing() {
    editingCueId = null;
    $('#edit-badge').hidden = true;
    $('#btn-send').textContent = '送信';
  }

  function startCountdown(sec) {
    if (activeCountdown()) return;
    /* 開始まで1秒の「構え」を置き、以降は各数字がきっかり1秒ずつになる */
    transport.sendOp({ t: 'countdown', cd: { id: uid(), seconds: sec, startAt: serverNow() + 1000, canceled: false } });
  }
  function cancelCountdown() {
    var c = roomState.countdown;
    if (c && !c.canceled) dispatch({ t: 'cancelCountdown', id: c.id });
  }
  function sendStamp(stamp) {
    var active = latestActiveCue();
    if (!active) return;
    dispatch({ t: 'ack', cueId: active.id, mid: me.id, name: me.name, stamp: stamp, ts: serverNow() });
    vibrate([40]);
  }

  /* ---------- 画像 ---------- */
  function onImageChosen(file) {
    if (!file || !/^image\//.test(file.type)) return;
    var img = new Image();
    var fr = new FileReader();
    fr.onload = function () {
      img.onload = function () {
        /* 長辺1400pxまで縮小して軽くしてから送る */
        var MAX = 1400;
        var w = img.naturalWidth, h = img.naturalHeight;
        var scale = Math.min(1, MAX / Math.max(w, h));
        var cw = Math.round(w * scale), ch = Math.round(h * scale);
        var canvas = document.createElement('canvas');
        canvas.width = cw; canvas.height = ch;
        canvas.getContext('2d').drawImage(img, 0, 0, cw, ch);
        pendingImage = { dataUrl: canvas.toDataURL('image/jpeg', 0.82), w: cw, h: ch };
        $('#img-pending-thumb').src = pendingImage.dataUrl;
        $('#img-pending').hidden = false;
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  }

  function sendPendingImage() {
    if (!pendingImage) return;
    var p = pendingImage;
    pendingImage = null;
    $('#img-pending').hidden = true;
    transport.uploadImage(p.dataUrl, p.w, p.h).then(function (imgId) {
      imgSrcCache[imgId] = p.dataUrl;
      dispatch({ t: 'cue', cue: baseCue({ imgId: imgId, imgW: p.w, imgH: p.h, text: '📷 画像', color: selectedColor() }) });
    }).catch(function () {
      alert('画像を送れませんでした。通信を確認してもう一度お試しください。');
    });
  }

  /* 画像を端末にファイルとして保存する（どの役割からでも使える） */
  function downloadImage(imgId, ts) {
    transport.imageSrc(imgId).then(function (src) {
      return fetch(src).then(function (r) { return r.blob(); });
    }).then(function (blob) {
      var d = new Date(ts || Date.now());
      var name = 'kipzkanvas_' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '_' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds()) + '.jpg';
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    }).catch(function () {
      alert('保存できませんでした。画像を長押し（または右クリック）して保存する方法もお試しください。');
    });
  }

  function loadImageInto(imgEl, imgId) {
    if (!imgId) return;
    if (imgSrcCache[imgId]) {
      if (imgEl.dataset.imgId !== imgId || !imgEl.getAttribute('src')) {
        imgEl.src = imgSrcCache[imgId];
        imgEl.dataset.imgId = imgId;
      }
      return;
    }
    imgEl.removeAttribute('src');
    imgEl.dataset.imgId = imgId;
    transport.imageSrc(imgId).then(function (src) {
      imgSrcCache[imgId] = src;
      if (imgEl.dataset.imgId === imgId) imgEl.src = src;
    }).catch(function () {});
  }

  /* ---------- 手書き ---------- */
  var PEN_COLORS = { black: '#171a20', red: '#dc2626', blue: '#2563eb' };
  var PEN_W = { small: 8, medium: 16, large: 28 };
  var MARKER_W = { small: 34, medium: 52, large: 76 };

  function drawPos(e) {
    var r = drawCv.getBoundingClientRect();
    return { x: (e.clientX - r.left) * DRAW_W / r.width, y: (e.clientY - r.top) * DRAW_H / r.height };
  }
  function paintStroke(s) {
    var p = s.points;
    drawCtx.save();
    drawCtx.lineJoin = 'round';
    drawCtx.lineCap = 'round';
    if (s.marker) {
      /* 蛍光ペン: 半透明の黄色を「乗算」で重ねると、下の文字が透けて見える */
      drawCtx.strokeStyle = 'rgba(250, 204, 21, .55)';
      drawCtx.fillStyle = 'rgba(250, 204, 21, .55)';
      drawCtx.lineWidth = MARKER_W[s.size] || MARKER_W.medium;
      drawCtx.globalCompositeOperation = 'multiply';
    } else {
      drawCtx.strokeStyle = s.color;
      drawCtx.fillStyle = s.color;
      drawCtx.lineWidth = PEN_W[s.size] || PEN_W.medium;
    }
    if (p.length === 1) {
      drawCtx.beginPath();
      drawCtx.arc(p[0].x, p[0].y, drawCtx.lineWidth / 2, 0, Math.PI * 2);
      drawCtx.fill();
      drawCtx.restore();
      return;
    }
    drawCtx.beginPath();
    drawCtx.moveTo(p[0].x, p[0].y);
    for (var i = 1; i < p.length - 1; i++) {
      drawCtx.quadraticCurveTo(p[i].x, p[i].y, (p[i].x + p[i + 1].x) / 2, (p[i].y + p[i + 1].y) / 2);
    }
    drawCtx.lineTo(p[p.length - 1].x, p[p.length - 1].y);
    drawCtx.stroke();
    drawCtx.restore();
  }
  function paintImageBg(img) {
    var scale = Math.min(DRAW_W / img.width, DRAW_H / img.height);
    var w = img.width * scale, h = img.height * scale;
    drawCtx.drawImage(img, (DRAW_W - w) / 2, (DRAW_H - h) / 2, w, h);
  }

  /* 下地テキストをキャンバス幅に収まる最大サイズで折り返しレイアウトする */
  function layoutCanvasText(segments) {
    var chars = [];
    (segments || []).forEach(function (s) {
      String(s.text).split('').forEach(function (ch) { chars.push({ ch: ch, mark: s.mark }); });
    });
    if (!chars.length) return null;
    var maxW = DRAW_W - DRAW_PAD * 2, maxH = DRAW_H - DRAW_PAD * 2;
    function tryFs(fs) {
      drawCtx.font = '900 ' + fs + 'px ' + DRAW_FONT;
      var lines = [[]], widths = [], w = 0;
      for (var i = 0; i < chars.length; i++) {
        var c = chars[i];
        if (c.ch === '\n') { widths.push(w); lines.push([]); w = 0; continue; }
        var cw = drawCtx.measureText(c.ch).width;
        if (w + cw > maxW && lines[lines.length - 1].length) { widths.push(w); lines.push([]); w = 0; }
        lines[lines.length - 1].push({ ch: c.ch, mark: c.mark, w: cw });
        w += cw;
      }
      widths.push(w);
      var lh = fs * 1.3;
      if (lines.length * lh > maxH) return null;
      for (var j = 0; j < widths.length; j++) { if (widths[j] > maxW) return null; }
      return { lines: lines, widths: widths, fs: fs, lh: lh };
    }
    var lo = 16, hi = 320, best = null;
    for (var k = 0; k < 10; k++) {
      var mid = Math.floor((lo + hi) / 2);
      var r = tryFs(mid);
      if (r) { best = r; lo = mid + 1; } else { hi = mid - 1; }
    }
    return best || tryFs(16);
  }

  function paintTextBg(segments) {
    var l = layoutCanvasText(segments);
    if (!l) return;
    drawCtx.save();
    drawCtx.font = '900 ' + l.fs + 'px ' + DRAW_FONT;
    drawCtx.textBaseline = 'middle';
    var y0 = (DRAW_H - l.lines.length * l.lh) / 2;
    l.lines.forEach(function (line, i) {
      var x0 = (DRAW_W - l.widths[i]) / 2;
      var yTop = y0 + i * l.lh;
      var yMid = yTop + l.lh / 2;
      var x = x0;
      line.forEach(function (c) {
        if (c.mark) {
          drawCtx.fillStyle = '#fde047';
          drawCtx.fillRect(x - 2, yTop + l.lh * 0.06, c.w + 4, l.lh * 0.88);
        }
        x += c.w;
      });
      x = x0;
      drawCtx.fillStyle = '#171a20';
      line.forEach(function (c) {
        drawCtx.fillText(c.ch, x, yMid);
        x += c.w;
      });
    });
    drawCtx.restore();
  }

  function repaintDraw() {
    drawCtx.save();
    drawCtx.globalCompositeOperation = 'source-over';
    drawCtx.fillStyle = '#ffffff';
    drawCtx.fillRect(0, 0, DRAW_W, DRAW_H);
    drawCtx.restore();
    if (drawBg && drawBg.type === 'image') paintImageBg(drawBg.img);
    if (drawBg && drawBg.type === 'text') paintTextBg(drawBg.segments);
    drawStrokes.forEach(paintStroke);
  }
  function updatePenButtons() {
    $all('.pen-btn[data-pen]').forEach(function (b) {
      var key = b.dataset.pen;
      var sel = drawPen.marker ? key === 'marker' : PEN_COLORS[key] === drawPen.color;
      b.classList.toggle('selected', sel);
    });
    $all('.pen-btn[data-penw]').forEach(function (b) {
      b.classList.toggle('selected', b.dataset.penw === drawPen.size);
    });
  }
  function openDraw(bg, source, title) {
    drawBg = bg || null;
    drawSource = source || 'blank';
    drawStrokes = [];
    drawCur = null;
    $('#draw-title').textContent = title || '手書きで送る';
    repaintDraw();
    updatePenButtons();
    openModal('draw-modal');
  }
  function sendDrawing() {
    if (!drawStrokes.length && !drawBg) return;
    var ex = document.createElement('canvas');
    ex.width = DRAW_W;
    ex.height = DRAW_H;
    ex.getContext('2d').drawImage(drawCv, 0, 0);
    var dataUrl = ex.toDataURL('image/jpeg', 0.85);
    var label = '✍️ 手書き';
    if (drawBg && drawBg.type === 'text' && drawBg.text) label = drawBg.text;
    if (drawBg && drawBg.type === 'image') label = '📷 写真＋書き込み';
    if (drawSource === 'compose') { composeEl.textContent = ''; stopEditing(); }
    if (drawSource === 'pending') { pendingImage = null; $('#img-pending').hidden = true; }
    closeAllModals();
    transport.uploadImage(dataUrl, DRAW_W, DRAW_H).then(function (imgId) {
      imgSrcCache[imgId] = dataUrl;
      dispatch({ t: 'cue', cue: baseCue({ imgId: imgId, imgW: DRAW_W, imgH: DRAW_H, text: label, color: selectedColor() }) });
    }).catch(function () {
      alert('送れませんでした。通信を確認してもう一度お試しください。');
    });
  }

  /* ---------- 描画 ---------- */
  function renderAll() {
    if (!joined) return;
    renderPresence();
    renderCue();
    renderTalentMsg();
    buildHistory($('#history-list'), me.role === 'director');
    if (me.role === 'talent' && !$('#talent-history-modal').hidden) buildHistory($('#talent-history-list'), false);
    renderPresets();
    renderCountControls();
  }

  function renderPresence() {
    var wrap = $('#presence');
    wrap.textContent = '';
    var now = serverNow();
    var members = Object.keys(roomState.members).map(function (k) { return roomState.members[k]; })
      .filter(function (m) { return m.id !== me.id; });

    var otherRole = me.role === 'director' ? 'talent' : 'director';
    var otherLabel = otherRole === 'talent' ? '現地' : '東京';
    var otherOnline = members.some(function (m) { return m.role === otherRole && m.online; });
    if (!otherOnline) wrap.appendChild(chipEl('⚠ ' + otherLabel + 'が未接続', 'chip-warn'));

    members
      .filter(function (m) { return m.online || (now - (m.lastSeen || 0)) < 5 * 60 * 1000; })
      .sort(function (a, b) { return (a.role > b.role ? 1 : -1); })
      .forEach(function (m) {
        var c = document.createElement('span');
        c.className = 'chip member ' + (m.online ? 'on' : 'off');
        var dot = document.createElement('span');
        dot.className = 'dot';
        c.appendChild(dot);
        c.appendChild(document.createTextNode((m.role === 'director' ? '東京・' : '現地・') + (m.name || '')));
        wrap.appendChild(c);
      });
  }

  function appendAckChips(box, cue) {
    if (cue.canceled) { box.appendChild(chipEl('取消', 'chip-muted')); return; }
    var acks = cue.acks ? Object.keys(cue.acks).map(function (k) { return cue.acks[k]; }) : [];
    if (!acks.length) {
      var age = serverNow() - cue.ts;
      box.appendChild(chipEl(age > 15000 ? '⚠ 未確認' : '確認待ち…', age > 15000 ? 'chip-warn' : 'chip-muted'));
      return;
    }
    acks.sort(function (a, b) { return a.ts - b.ts; }).forEach(function (a) {
      box.appendChild(chipEl((a.stamp === 'ok' ? '👍 ' : '✋ ') + (a.name || ''), a.stamp === 'ok' ? 'chip-ok' : 'chip-ng'));
    });
  }

  function cueSegs(c) { return c.segments && c.segments.length ? c.segments : segsFromText(c.text); }

  function renderCue() {
    var lc = latestCue();
    var active = latestActiveCue();

    /* 現地の大画面 */
    var cueBox = $('#cue-box'), cueText = $('#cue-text'), cueImg = $('#cue-img'), cueUrl = $('#cue-url'), meta = $('#cue-meta');
    cueBox.classList.remove('c-normal', 'c-warn', 'c-urgent', 'canceled', 'empty');
    cueText.hidden = false; cueImg.hidden = true; cueUrl.hidden = true;
    var cueSave = $('#cue-save');
    cueSave.hidden = true;
    var kind = lc ? cueKind(lc) : 'text';
    if (!lc) {
      cueText.textContent = '指示待ち';
      cueBox.classList.add('empty');
      meta.textContent = '';
    } else {
      cueBox.classList.add('c-' + (lc.color || 'normal'));
      if (kind === 'image') {
        cueText.hidden = true;
        cueImg.hidden = false;
        loadImageInto(cueImg, lc.imgId);
        cueSave.hidden = false;
        cueSave.onclick = function () { downloadImage(lc.imgId, lc.ts); };
      } else if (kind === 'url' && !lc.canceled) {
        cueText.hidden = true;
        cueUrl.hidden = false;
        $('#cue-url-domain').textContent = domainOf(lc.url);
        $('#cue-url-open').href = lc.url;
        $('#cue-url-full').textContent = lc.url;
      } else {
        renderSegmentsInto(cueText, cueSegs(lc), true);
      }
      if (lc.canceled) {
        cueBox.classList.add('canceled');
        meta.textContent = 'この指示は取り消されました（' + fmtTime(lc.ts) + '）';
      } else {
        var mine = lc.acks && lc.acks[me.id];
        meta.textContent = fmtTime(lc.ts) + '　' + ((lc.from && lc.from.name) || '') + '　' + colorLabel(lc.color) + (kind === 'image' ? '　' + (lc.text || '画像') : '') + (mine ? '　✓スタンプ送信済み' : '');
      }
    }
    /* 1つ前の指示バー（現地側）: 前の指示を確認しつつ、タップで履歴を開ける */
    var list = directorCues();
    var prev = list.length > 1 ? list[list.length - 2] : null;
    var pcue = $('#prev-cue');
    if (!prev) {
      pcue.hidden = true;
    } else {
      pcue.hidden = false;
      pcue.className = 'prev-cue c-' + (prev.color || 'normal') + (prev.canceled ? ' canceled' : '');
      $('#prev-time').textContent = fmtTime(prev.ts);
      var pvt = $('#prev-text');
      if (prev.imgId) pvt.textContent = prev.text || '📷 画像';
      else renderSegmentsInto(pvt, cueSegs(prev), false);
    }

    if (me.role === 'talent' && (!lc || lc.canceled || kind === 'text')) fitText();

    /* スタンプボタン（画面に出ている指示が有効なときだけ押せる） */
    var okB = $('#stamp-ok'), ngB = $('#stamp-ng');
    var can = !!active && !!lc && active.id === lc.id && me.role === 'talent';
    okB.disabled = !can;
    ngB.disabled = !can;
    var myAck = can && active.acks ? active.acks[me.id] : null;
    okB.classList.toggle('sent', !!(myAck && myAck.stamp === 'ok'));
    ngB.classList.toggle('sent', !!(myAck && myAck.stamp === 'ng'));

    /* 東京側のプレビュー */
    var pt = $('#d-preview-text'), pimg = $('#d-preview-img'), pa = $('#d-preview-acks'), pc = $('#d-preview-cancel'), pe = $('#d-preview-edit'), pd = $('#d-preview-draw'), ps = $('#d-preview-save');
    pt.classList.remove('c-normal', 'c-warn', 'c-urgent', 'canceled', 'muted');
    pa.textContent = '';
    pimg.hidden = true;
    if (!lc) {
      pt.textContent = 'まだ指示はありません';
      pt.classList.add('muted');
      pc.hidden = true;
      pe.hidden = true;
      pd.hidden = true;
      ps.hidden = true;
    } else {
      if (kind === 'image') {
        pt.textContent = '📷 画像';
        pimg.hidden = false;
        loadImageInto(pimg, lc.imgId);
      } else {
        renderSegmentsInto(pt, cueSegs(lc), false);
      }
      pt.classList.add('c-' + (lc.color || 'normal'));
      if (lc.canceled) {
        pt.classList.add('canceled');
        pc.hidden = true;
        pe.hidden = true;
        pd.hidden = true;
        ps.hidden = kind !== 'image';
        if (kind === 'image') ps.onclick = function () { downloadImage(lc.imgId, lc.ts); };
      } else {
        pc.hidden = false;
        pc.onclick = function () { dispatch({ t: 'cancelCue', id: lc.id }); };
        pe.hidden = (kind === 'image');
        pe.onclick = function () { startEditing(lc); };
        ps.hidden = kind !== 'image';
        if (kind === 'image') ps.onclick = function () { downloadImage(lc.imgId, lc.ts); };
        pd.hidden = false;
        pd.onclick = function () {
          if (kind === 'image') {
            transport.imageSrc(lc.imgId).then(function (src) {
              var img = new Image();
              img.onload = function () { openDraw({ type: 'image', img: img }, 'cue', '写真に書き込んで送る'); };
              img.src = src;
            }).catch(function () {});
          } else {
            openDraw({ type: 'text', segments: cueSegs(lc), text: lc.text }, 'cue', 'テキストに書き込んで送る');
          }
        };
      }
      appendAckChips(pa, lc);
    }
  }

  /* 東京側: 現地からの最新メッセージ表示 */
  function renderTalentMsg() {
    var box = $('#d-talent-msg');
    if (!box) return;
    var msgs = cueList().filter(isTalentMsg);
    var m = msgs.length ? msgs[msgs.length - 1] : null;
    if (!m) { box.hidden = true; return; }
    box.hidden = false;
    $('#d-talent-msg-time').textContent = fmtTime(m.ts) + '　' + ((m.from && m.from.name) || '');
    $('#d-talent-msg-text').textContent = m.text;
  }

  function buildHistory(listEl, isDirector) {
    if (!listEl) return;
    listEl.textContent = '';
    var list = cueList().slice().reverse();
    if (!list.length) {
      var e = document.createElement('li');
      e.className = 'h-empty';
      e.textContent = 'まだ指示はありません';
      listEl.appendChild(e);
      return;
    }
    list.forEach(function (c) {
      var li = document.createElement('li');
      li.className = 'h-item c-' + (c.color || 'normal') + (c.canceled ? ' canceled' : '') + (isTalentMsg(c) ? ' from-talent' : '');
      var t = document.createElement('span');
      t.className = 'h-time';
      t.textContent = fmtTime(c.ts);
      var body = document.createElement('div');
      body.className = 'h-body';
      var tx = document.createElement('div');
      tx.className = 'h-text';
      if (c.imgId) {
        var th = document.createElement('img');
        th.className = 'h-thumb';
        th.alt = '画像';
        loadImageInto(th, c.imgId);
        tx.appendChild(th);
        if (c.text && !/^(📷|✍️)/.test(c.text)) {
          var cap = document.createElement('div');
          cap.className = 'h-caption';
          cap.textContent = c.text;
          tx.appendChild(cap);
        }
      } else {
        renderSegmentsInto(tx, cueSegs(c), true);
      }
      var chips = document.createElement('div');
      chips.className = 'h-chips';
      if (isTalentMsg(c)) {
        chips.appendChild(chipEl('現地 ' + ((c.from && c.from.name) || ''), 'chip-ok'));
      } else {
        appendAckChips(chips, c);
      }
      body.appendChild(tx);
      body.appendChild(chips);
      li.appendChild(t);
      li.appendChild(body);
      var actions = document.createElement('div');
      actions.className = 'h-actions';
      if (isDirector && !isTalentMsg(c)) {
        if (!c.canceled) {
          var cb = document.createElement('button');
          cb.type = 'button';
          cb.className = 'ghost small';
          cb.textContent = '取消';
          cb.onclick = function () { dispatch({ t: 'cancelCue', id: c.id }); };
          actions.appendChild(cb);
        }
        var rb = document.createElement('button');
        rb.type = 'button';
        rb.className = 'ghost small';
        rb.textContent = '↺ 再送';
        rb.onclick = function () {
          dispatch({ t: 'cue', cue: baseCue({ segments: c.segments || null, text: c.text, url: c.url || null, imgId: c.imgId || null, imgW: c.imgW || 0, imgH: c.imgH || 0, color: c.color }) });
        };
        actions.appendChild(rb);
      }
      if (c.imgId) {
        var sb = document.createElement('button');
        sb.type = 'button';
        sb.className = 'ghost small';
        sb.textContent = '💾 保存';
        sb.onclick = function () { downloadImage(c.imgId, c.ts); };
        actions.appendChild(sb);
      }
      if (actions.childNodes.length) li.appendChild(actions);
      listEl.appendChild(li);
    });
  }

  function renderPresets() {
    var grid = $('#preset-grid');
    grid.textContent = '';
    (roomState.presets || []).forEach(function (p) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'preset c-' + (p.color || 'normal');
      renderSegmentsInto(b, parseMarkSyntax(p.text), false);
      b.onclick = function () {
        var segs = parseMarkSyntax(p.text);
        var text = segsText(segs);
        dispatch({ t: 'cue', cue: baseCue({ segments: segs, text: text, url: firstUrl(text), color: p.color }) });
      };
      grid.appendChild(b);
    });
  }

  function renderCountControls() {
    var act = activeCountdown();
    $all('.count-btn').forEach(function (b) { b.disabled = !!act; });
    $('#btn-cd-cancel').disabled = !act;
  }

  /* 文字を枠いっぱいのサイズに自動調整する */
  function fitText() {
    var box = $('#cue-fit'), el = $('#cue-text');
    if (!box || !box.clientHeight || el.hidden) return;
    var maxH = box.clientHeight, maxW = box.clientWidth;
    var lo = 14, hi = Math.max(40, Math.min(maxH, maxW * 2));
    for (var i = 0; i < 11; i++) {
      var mid = (lo + hi) / 2;
      el.style.fontSize = mid + 'px';
      if (el.scrollHeight <= maxH && el.scrollWidth <= maxW) lo = mid; else hi = mid;
    }
    el.style.fontSize = (lo * fontScale) + 'px';
  }

  function flashCueArea() {
    var box = $('#cue-box');
    box.classList.remove('flash');
    void box.offsetWidth;
    box.classList.add('flash');
  }

  /* ---------- カウントダウン表示（毎フレーム時計を見て描く） ---------- */
  /* タイムバーの刻み線とラベル（構え｜5｜4…｜1｜GO）を秒数に合わせて組む */
  function buildCdBar(c) {
    var units = c.seconds + 1; /* 構え1秒 + 秒数 */
    var ticks = $('#cd-bar-ticks');
    ticks.textContent = '';
    for (var i = 1; i < units; i++) {
      var t = document.createElement('div');
      t.className = 'cd-tick';
      t.style.left = (i / units * 100) + '%';
      ticks.appendChild(t);
    }
    var labels = $('#cd-bar-labels');
    labels.textContent = '';
    var segs = ['構え'];
    for (var n = c.seconds; n >= 1; n--) segs.push(String(n));
    segs.forEach(function (s, idx) {
      var d = document.createElement('span');
      d.className = 'cd-seg' + (idx === 0 ? ' standby-seg' : '');
      d.textContent = s;
      labels.appendChild(d);
    });
    var go = document.createElement('span');
    go.className = 'cd-seg go-seg';
    go.textContent = 'GO';
    labels.appendChild(go);
  }

  function renderCountdownFrame() {
    var overlay = $('#cd-overlay'), numEl = $('#cd-num');
    var now = serverNow();
    var c = roomState.countdown;
    var show = false, text = '', cls = '';
    var barActive = false, barIdx = 0;

    if (c && !c.canceled) {
      var end = c.startAt + c.seconds * 1000;
      var remain = end - now;
      if (remain > -1200 && now > c.startAt - 3000) {
        show = true;
        if (now < c.startAt) {
          /* 開始前の「構え」: 数字を薄く出すだけ。音も鳴らさない */
          text = String(c.seconds);
          cls = 'count standby';
          barActive = true;
          barIdx = 0;
          if (cdView.id !== c.id) { cdView.id = c.id; cdView.lastNum = null; }
        } else if (remain > 0) {
          var num = Math.min(c.seconds, Math.ceil(remain / 1000));
          text = String(num);
          cls = 'count';
          barActive = true;
          barIdx = c.seconds - num + 1;
          if (cdView.id !== c.id || cdView.lastNum !== num) {
            cdView.id = c.id;
            cdView.lastNum = num;
            pip();
            pulse(numEl);
          }
        } else {
          text = 'GO';
          cls = 'go';
          barActive = true;
          barIdx = c.seconds + 1;
          if (cdView.id === c.id && cdView.lastNum !== 0) {
            cdView.lastNum = 0;
            goSound();
            vibrate([300]);
            pulse(numEl);
          } else if (cdView.id !== c.id) {
            cdView.id = c.id;
            cdView.lastNum = 0;
          }
        }
      } else if (cdView.id === c.id && remain <= -1200) {
        cdView.id = null;
        cdView.lastNum = null;
      }
    } else if (c && c.canceled && cdView.id === c.id) {
      cdView.flashUntil = now + 900;
      cdView.id = null;
      cdView.lastNum = null;
    }

    if (!show && cdView.flashUntil > now) { show = true; text = '中止'; cls = 'stopped'; }

    if (overlay.hidden === show) overlay.hidden = !show;
    if (show) {
      if (numEl.textContent !== text) numEl.textContent = text;
      numEl.className = 'cd-num ' + cls + (numEl.classList.contains('pulse') ? ' pulse' : '');
    }

    /* GOまでのタイムバー（構え1秒も含めた全体を左→右に進む） */
    var bar = $('#cd-bar');
    if (barActive && c) {
      if (cdBarId !== c.id) { buildCdBar(c); cdBarId = c.id; }
      var total = (c.seconds + 1) * 1000;
      var pct = Math.max(0, Math.min(100, (now - (c.startAt - 1000)) / total * 100));
      $('#cd-bar-fill').style.width = pct + '%';
      var labels = $('#cd-bar-labels').children;
      for (var li = 0; li < labels.length; li++) labels[li].classList.toggle('on', li === barIdx);
      bar.hidden = false;
    } else {
      bar.hidden = true;
    }
  }
  function pulse(el) {
    el.classList.remove('pulse');
    void el.offsetWidth;
    el.classList.add('pulse');
  }

  function startLoops() {
    (function frame() { renderCountdownFrame(); requestAnimationFrame(frame); })();
    /* 非表示タブや省電力で requestAnimationFrame が止まる環境向けの保険 */
    setInterval(renderCountdownFrame, 200);
    setInterval(function () {
      if (!joined) return;
      buildHistory($('#history-list'), me.role === 'director');
      renderPresence();
      renderCountControls();
    }, 1000);
  }

  /* ---------- モーダル ---------- */
  function openModal(id) { $('#' + id).hidden = false; }
  function closeAllModals() { $all('.modal-backdrop').forEach(function (m) { m.hidden = true; }); }

  function openLink() {
    var base = location.origin + location.pathname;
    /* PCの「localhost」はそのPC専用の住所なので、QRにはLAN内から届くアドレスを入れる */
    if (!window.FIREBASE_CONFIG && serverInfo && serverInfo.urls && serverInfo.urls.length &&
        (location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      base = serverInfo.urls[0] + '/';
    }
    var url = base + '?room=' + encodeURIComponent(me.room) + '&role=talent';
    $('#link-url').textContent = url;
    var qbox = $('#link-qr');
    qbox.innerHTML = '';
    if (window.qrcode) {
      try {
        var qr = window.qrcode(0, 'M');
        qr.addData(url);
        qr.make();
        qbox.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 2 });
      } catch (e) {}
    }
    openModal('link-modal');
  }

  function copyLink() {
    var url = $('#link-url').textContent;
    var done = function () {
      var b = $('#link-copy');
      b.textContent = 'コピーしました ✓';
      setTimeout(function () { b.textContent = 'URLをコピー'; }, 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done).catch(function () { fallbackCopy(url); done(); });
    } else {
      fallbackCopy(url);
      done();
    }
  }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    ta.remove();
  }

  function presetRow(text, color) {
    var row = document.createElement('div');
    row.className = 'pe-row';
    var inp = document.createElement('input');
    inp.type = 'text';
    inp.value = text || '';
    inp.placeholder = '指示の文言（==囲み==でマーカー）';
    var sel = document.createElement('select');
    [['normal', '通常'], ['warn', '注意'], ['urgent', '緊急']].forEach(function (o) {
      var op = document.createElement('option');
      op.value = o[0];
      op.textContent = o[1];
      if (o[0] === (color || 'normal')) op.selected = true;
      sel.appendChild(op);
    });
    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'ghost small';
    del.textContent = '削除';
    del.onclick = function () { row.remove(); };
    row.appendChild(inp);
    row.appendChild(sel);
    row.appendChild(del);
    return row;
  }
  function buildPresetEditor(presets) {
    var box = $('#preset-editor');
    box.textContent = '';
    presets.forEach(function (p) { box.appendChild(presetRow(p.text, p.color)); });
  }
  function openSettings() {
    buildPresetEditor(roomState.presets || []);
    openModal('settings-modal');
  }
  function savePresets() {
    var presets = [];
    $all('#preset-editor .pe-row').forEach(function (row) {
      var text = row.querySelector('input').value.trim();
      var color = row.querySelector('select').value;
      if (text) presets.push({ text: text, color: color });
    });
    if (!presets.length) { alert('定型指示が空です。1つ以上入れてください。'); return; }
    dispatch({ t: 'presets', presets: presets });
    closeAllModals();
  }

  /* ---------- 起動 ---------- */
  function showModeInfo() {
    var el = $('#mode-info');
    if (window.FIREBASE_CONFIG) {
      el.hidden = true; /* 本番では余計な説明を出さない */
      return;
    }
    fetch('/api/info').then(function (r) { return r.json(); }).then(function (info) {
      serverInfo = info;
      var t = 'テストモード：同じWi-Fi内の端末どうしで使えます';
      if (info.urls && info.urls.length) t += '\nタブレット・スマホからは → ' + info.urls.join('  /  ');
      el.textContent = t;
    }).catch(function () {
      el.textContent = 'サーバーが動いていません。README.md の手順でサーバーを起動してください。';
    });
  }

  function setSound(on) {
    soundOn = on;
    localStorage.setItem('kanpe-sound', on ? '1' : '0');
    var b = $('#btn-sound');
    b.textContent = on ? '🔔' : '🔕';
    b.classList.toggle('off', !on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  function setFontScale(v) {
    fontScale = Math.min(1, Math.max(0.5, v));
    localStorage.setItem('kanpe-font-scale', String(fontScale));
    fitText();
  }

  function boot() {
    composeEl = $('#compose');

    var params = new URLSearchParams(location.search);
    $('#join-room').value = params.get('room') || localStorage.getItem('kanpe-room') || '';
    $('#join-name').value = params.get('name') || localStorage.getItem('kanpe-name') || '';
    var role = params.get('role') || localStorage.getItem('kanpe-role') || '';
    if (role === 'director' || role === 'talent') selectRole(role);

    $('#role-director').addEventListener('click', function () { selectRole('director'); });
    $('#role-talent').addEventListener('click', function () { selectRole('talent'); });
    $('#join-form').addEventListener('submit', function (e) { e.preventDefault(); join(); });

    setSound(soundOn);
    $('#btn-sound').addEventListener('click', function () { setSound(!soundOn); initAudio(); });
    $('#btn-fullscreen').addEventListener('click', toggleFullscreen);
    document.addEventListener('fullscreenchange', updateFsBtn);
    document.addEventListener('webkitfullscreenchange', updateFsBtn);
    /* ホーム画面から起動した場合はもともと全画面なのでボタンを隠す */
    if ((window.matchMedia && matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone) {
      $('#btn-fullscreen').hidden = true;
    }
    $('#btn-font-minus').addEventListener('click', function () { setFontScale(fontScale - 0.15); });
    $('#btn-font-plus').addEventListener('click', function () { setFontScale(fontScale + 0.15); });
    $('#btn-link').addEventListener('click', openLink);
    $('#btn-settings').addEventListener('click', openSettings);
    $('#btn-history').addEventListener('click', function () {
      buildHistory($('#talent-history-list'), false);
      openModal('talent-history-modal');
    });
    $('#prev-cue').addEventListener('click', function () {
      buildHistory($('#talent-history-list'), false);
      openModal('talent-history-modal');
    });
    $('#reply-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var inp = $('#reply-text');
      var text = inp.value.trim();
      if (!text) return;
      dispatch({ t: 'cue', cue: baseCue({ text: text, url: firstUrl(text), color: 'normal' }) });
      inp.value = '';
      var b = $('#reply-send-btn');
      b.textContent = '✓';
      setTimeout(function () { b.textContent = '送信'; }, 1200);
    });
    $('#btn-exit').addEventListener('click', function () {
      if (!confirm('退室しますか？')) return;
      if (transport) transport.leave();
      location.href = location.pathname;
    });

    $all('.count-btn').forEach(function (b) {
      b.addEventListener('click', function () { startCountdown(parseInt(b.dataset.sec, 10)); });
    });
    $('#btn-cd-cancel').addEventListener('click', cancelCountdown);
    $('#cd-overlay-cancel').addEventListener('click', cancelCountdown);

    /* 自由入力（マーカー対応） */
    $('#btn-send').addEventListener('click', sendCompose);
    $('#btn-mark').addEventListener('click', applyMark);
    $('#btn-unmark').addEventListener('click', clearMarks);
    $('#edit-cancel').addEventListener('click', function () { stopEditing(); composeEl.textContent = ''; });
    composeEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCompose(); }
    });
    composeEl.addEventListener('paste', function (e) {
      var items = (e.clipboardData && e.clipboardData.items) || [];
      for (var i = 0; i < items.length; i++) {
        if (/^image\//.test(items[i].type)) {
          e.preventDefault();
          onImageChosen(items[i].getAsFile());
          return;
        }
      }
      e.preventDefault();
      var text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
      if (text) insertPlainText(text);
    });

    /* 画像 */
    $('#btn-image').addEventListener('click', function () { $('#image-input').click(); });
    $('#image-input').addEventListener('change', function () {
      onImageChosen(this.files && this.files[0]);
      this.value = '';
    });
    $('#img-send').addEventListener('click', sendPendingImage);
    $('#img-discard').addEventListener('click', function () {
      pendingImage = null;
      $('#img-pending').hidden = true;
    });

    /* 手書き */
    drawCv = $('#draw-canvas');
    drawCtx = drawCv.getContext('2d');
    $('#btn-draw').addEventListener('click', function () {
      var segs = composeSegments();
      var text = segsText(segs);
      if (text.trim()) openDraw({ type: 'text', segments: segs, text: text }, 'compose', 'テキストに書き込んで送る');
      else openDraw(null, 'blank', '手書きで送る');
    });
    $('#img-annotate').addEventListener('click', function () {
      if (!pendingImage) return;
      var img = new Image();
      img.onload = function () { openDraw({ type: 'image', img: img }, 'pending', '写真に書き込んで送る'); };
      img.src = pendingImage.dataUrl;
    });
    $('#draw-send').addEventListener('click', sendDrawing);
    $('#draw-undo').addEventListener('click', function () { drawStrokes.pop(); repaintDraw(); });
    $('#draw-clear').addEventListener('click', function () { drawStrokes = []; repaintDraw(); });
    $all('.pen-btn[data-pen]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (b.dataset.pen === 'marker') { drawPen.marker = true; }
        else { drawPen.marker = false; drawPen.color = PEN_COLORS[b.dataset.pen]; }
        updatePenButtons();
      });
    });
    $all('.pen-btn[data-penw]').forEach(function (b) {
      b.addEventListener('click', function () { drawPen.size = b.dataset.penw; updatePenButtons(); });
    });
    drawCv.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      try { drawCv.setPointerCapture(e.pointerId); } catch (err) {}
      drawCur = { points: [drawPos(e)], color: drawPen.color, marker: drawPen.marker, size: drawPen.size };
      drawStrokes.push(drawCur);
      repaintDraw();
    });
    drawCv.addEventListener('pointermove', function (e) {
      if (!drawCur) return;
      e.preventDefault();
      drawCur.points.push(drawPos(e));
      repaintDraw();
    });
    ['pointerup', 'pointercancel'].forEach(function (ev) {
      drawCv.addEventListener(ev, function () { drawCur = null; });
    });

    $('#stamp-ok').addEventListener('click', function () { sendStamp('ok'); });
    $('#stamp-ng').addEventListener('click', function () { sendStamp('ng'); });

    $('#link-copy').addEventListener('click', copyLink);
    $('#preset-add').addEventListener('click', function () { $('#preset-editor').appendChild(presetRow('', 'normal')); });
    $('#preset-default').addEventListener('click', function () { buildPresetEditor(Store.DEFAULT_PRESETS); });
    $('#preset-save').addEventListener('click', savePresets);
    $('#btn-clear').addEventListener('click', function () {
      if (!confirm('履歴（指示・画像・カウント）を全部消します。全員の画面から消えます。よろしいですか？')) return;
      dispatch({ t: 'clearCues' });
      imgSrcCache = {};
      closeAllModals();
    });

    document.addEventListener('click', function (e) {
      if (e.target.classList && e.target.classList.contains('modal-backdrop')) e.target.hidden = true;
      var closer = e.target.closest ? e.target.closest('[data-close]') : null;
      if (closer) {
        var back = closer.closest('.modal-backdrop');
        if (back) back.hidden = true;
      }
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeAllModals(); });

    if (window.ResizeObserver) {
      new ResizeObserver(function () { fitText(); }).observe($('#cue-fit'));
    }
    window.addEventListener('resize', fitText);

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') {
        if (joined) requestWakeLock();
        if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
      }
    });
    document.addEventListener('pointerdown', function () {
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    }, { passive: true });
    window.addEventListener('beforeunload', function () { if (transport) transport.leave(); });

    showModeInfo();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
