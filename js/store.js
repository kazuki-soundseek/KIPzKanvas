/* 部屋の状態（指示・カウント・参加者）と、それを書き換える操作の定義。
   ブラウザと dev-server.js の両方から同じロジックを使うため、両対応の書き方にしている。 */
(function (root) {
  'use strict';

  var DEFAULT_PRESETS = [
    { text: 'VTRふり お願いします', color: 'normal' },
    { text: 'インタビューふり お願いします', color: 'normal' },
    { text: 'この後 CMに入ります', color: 'warn' },
    { text: 'CM明け 実況からです', color: 'normal' },
    { text: '巻いてください', color: 'warn' },
    { text: '引き伸ばし お願いします', color: 'warn' },
    { text: 'そのままでOKです', color: 'normal' },
    { text: '音声チェック 一言ください', color: 'normal' }
  ];

  function initialState() {
    return {
      presets: DEFAULT_PRESETS.map(function (p) { return { text: p.text, color: p.color }; }),
      cues: {},
      countdown: null,
      call: null,
      members: {}
    };
  }

  function applyOp(state, op) {
    if (!op || !op.t) return state;
    switch (op.t) {
      case 'cue':
        if (op.cue && op.cue.id) state.cues[op.cue.id] = op.cue;
        break;
      case 'cancelCue': {
        var c = state.cues[op.id];
        if (c) c.canceled = true;
        break;
      }
      case 'cueUpdate': {
        /* 送信済みの指示の文言・マーカーを後から差し替える */
        var cu = state.cues[op.id];
        if (cu) {
          cu.segments = op.segments || null;
          cu.text = op.text || '';
          cu.url = op.url || null;
        }
        break;
      }
      case 'ack': {
        var cue = state.cues[op.cueId];
        if (cue) {
          if (!cue.acks) cue.acks = {};
          cue.acks[op.mid] = { name: op.name, stamp: op.stamp, ts: op.ts };
        }
        break;
      }
      case 'presets':
        if (Array.isArray(op.presets) && op.presets.length) state.presets = op.presets;
        break;
      case 'countdown':
        state.countdown = op.cd || null;
        break;
      case 'call':
        /* 東京→現場の呼び出し（現場側で光と音の合図になる） */
        state.call = op.call || null;
        break;
      case 'cancelCountdown':
        if (state.countdown && state.countdown.id === op.id) state.countdown.canceled = true;
        break;
      case 'member': {
        var m = op.member;
        if (m && m.id) state.members[m.id] = Object.assign({}, state.members[m.id] || {}, m);
        break;
      }
      case 'memberOffline': {
        var mm = state.members[op.mid];
        if (mm) { mm.online = false; mm.lastSeen = op.ts; }
        break;
      }
      case 'clearCues':
        state.cues = {};
        state.countdown = null;
        break;
    }
    return state;
  }

  var api = { DEFAULT_PRESETS: DEFAULT_PRESETS, initialState: initialState, applyOp: applyOp };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KanpeStore = api;
})(typeof self !== 'undefined' ? self : this);
