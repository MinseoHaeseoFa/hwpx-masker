/* ============================================================
   민감정보 안심마스커 · Web Worker
   ------------------------------------------------------------
   ZIP 해제 → XML 파싱 → 치환 → 재압축까지 무거운 작업을 전부
   이 워커에서 처리합니다. 메인 스레드는 화면만 그리므로
   수십 MB 문서에서도 스크롤·버튼이 멈추지 않습니다.
   ============================================================ */
/* global importScripts, self, Masker */
importScripts('./jszip.min.js', './engine.js');

let lastSend = 0;
let pendingJump = false;

function send(msg, transfer) {
  if (transfer) self.postMessage(msg, transfer);
  else self.postMessage(msg);
}

function progress(id, phase, percent) {
  const now = Date.now();
  if (now - lastSend < 60 && percent < 100) {
    pendingJump = true;
    return;
  }
  lastSend = now;
  pendingJump = false;
  send({ type: 'progress', id, phase, percent });
}

self.onmessage = async function (e) {
  const msg = e.data || {};
  const id = msg.id;
  try {
    if (msg.type === 'open') {
      const model = await Masker.open(msg.buffer, msg.fileName, (phase, percent) => progress(id, phase, percent));
      send({ type: 'opened', id, ok: true, model });
      return;
    }
    if (msg.type === 'build') {
      const out = await Masker.build(msg.items || [], msg.opts || {}, (phase, percent) => progress(id, phase, percent));
      const buffer = out.buffer;
      send(
        { type: 'built', id, ok: true, buffer, fileName: out.fileName, size: out.size, stats: out.stats },
        [buffer.buffer]
      );
      return;
    }
    if (msg.type === 'ping') {
      send({ type: 'pong', id, ok: true });
      return;
    }
    send({ type: 'error', id, ok: false, code: 'BAD_MESSAGE', message: '알 수 없는 요청' });
  } catch (err) {
    send({
      type: 'error', id, ok: false,
      code: (err && err.code) || 'ERR',
      message: (err && err.message) || String(err)
    });
  }
};
