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
  var serverInfo = null;
  var editingCueId = null;
  var pendingImage = null;
  var imgSrcCache = {};
  var composeEl = null;

  function serverNow() { return transport ? transport.serverNow() : Date.now(); }

  function cueList() {
    return Object.keys(roomState.cues).map(function (k) { return roomState.cues[k]; })
      .sort(function (a, b) { return a.ts - b.ts; });
  }
  function latestCue() {
    var l = cueList();
    return l.length ? l[l.length - 1] : null;
  }
  function latestActiveCue() {
    var l = cueList().filter(function (c) { return !c.canceled; });
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
    var lc = latestCue();
    var isFirst = !gotFirstState;
    gotFirstState = true;
    var isNew = lc && lc.id !== latestSeenCueId;
    if (lc) latestSeenCueId = lc.id;
    var sig = lc ? (lc.id + '|' + (lc.text || '') + '|' + JSON.stringify(lc.segments || null)) : '';
    renderAll();
    if (!isFirst && lc && lc.from && lc.from.id !== me.id && !lc.canceled) {
      if (isNew) {
        playCueSound(lc.color);
        vibrate(lc.color === 'urgent' ? [120, 80, 120, 80, 240] : [160]);
        flashCueArea();
      } else if (lastCueSig && sig !== lastCueSig) {
        /* 同じ指示の文言・マーカーが書き換わった（マーカー編集） */
        pip();
        flashCueArea();
      }
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
    transport.sendOp({ t: 'countdown', cd: { id: uid(), seconds: sec, startAt: serverNow() + 700, canceled: false } });
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

  /* ---------- 描画 ---------- */
  function renderAll() {
    if (!joined) return;
    renderPresence();
    renderCue();
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
        meta.textContent = fmtTime(lc.ts) + '　' + ((lc.from && lc.from.name) || '') + '　' + colorLabel(lc.color) + (kind === 'image' ? '　画像' : '') + (mine ? '　✓スタンプ送信済み' : '');
      }
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
    var pt = $('#d-preview-text'), pimg = $('#d-preview-img'), pa = $('#d-preview-acks'), pc = $('#d-preview-cancel'), pe = $('#d-preview-edit');
    pt.classList.remove('c-normal', 'c-warn', 'c-urgent', 'canceled', 'muted');
    pa.textContent = '';
    pimg.hidden = true;
    if (!lc) {
      pt.textContent = 'まだ指示はありません';
      pt.classList.add('muted');
      pc.hidden = true;
      pe.hidden = true;
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
      } else {
        pc.hidden = false;
        pc.onclick = function () { dispatch({ t: 'cancelCue', id: lc.id }); };
        pe.hidden = (kind === 'image');
        pe.onclick = function () { startEditing(lc); };
      }
      appendAckChips(pa, lc);
    }
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
      li.className = 'h-item c-' + (c.color || 'normal') + (c.canceled ? ' canceled' : '');
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
      } else {
        renderSegmentsInto(tx, cueSegs(c), true);
      }
      var chips = document.createElement('div');
      chips.className = 'h-chips';
      appendAckChips(chips, c);
      body.appendChild(tx);
      body.appendChild(chips);
      li.appendChild(t);
      li.appendChild(body);
      if (isDirector) {
        var actions = document.createElement('div');
        actions.className = 'h-actions';
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
        li.appendChild(actions);
      }
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
  function renderCountdownFrame() {
    var overlay = $('#cd-overlay'), numEl = $('#cd-num');
    var now = serverNow();
    var c = roomState.countdown;
    var show = false, text = '', cls = '';

    if (c && !c.canceled) {
      var end = c.startAt + c.seconds * 1000;
      var remain = end - now;
      if (remain > -1200 && now > c.startAt - 3000) {
        show = true;
        if (remain > 0) {
          var num = Math.min(c.seconds, Math.ceil(remain / 1000));
          text = String(num);
          cls = 'count';
          if (cdView.id !== c.id || cdView.lastNum !== num) {
            cdView.id = c.id;
            cdView.lastNum = num;
            pip();
            pulse(numEl);
          }
        } else {
          text = 'GO';
          cls = 'go';
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
      el.textContent = '本番モード：インターネット越しに使えます';
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
    $('#btn-font-minus').addEventListener('click', function () { setFontScale(fontScale - 0.15); });
    $('#btn-font-plus').addEventListener('click', function () { setFontScale(fontScale + 0.15); });
    $('#btn-link').addEventListener('click', openLink);
    $('#btn-settings').addEventListener('click', openSettings);
    $('#btn-history').addEventListener('click', function () {
      buildHistory($('#talent-history-list'), false);
      openModal('talent-history-modal');
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
