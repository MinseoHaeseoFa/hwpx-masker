/* ============================================================
   민감정보 안심마스커 · 화면
   파일 열기 → 탐지 → 미리보기에서 확인 → _masked.hwpx 저장
   ============================================================ */
(function () {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const CATS = window.Masker.CATEGORIES;
  const CAT_NAME = Object.fromEntries(CATS.map((c) => [c.id, c.name]));
  const KIND_NAME = { name: '성명', dept: '부서', org: '기관·업체', custom: '직접 지정' };

  const state = {
    doc: null,
    items: [],
    catOn: Object.fromEntries(CATS.map((c) => [c.id, true])),
    cleanTrace: true,
    busy: false
  };

  let toastTimer = null;

  /* ── 시작 ───────────────────────────────────────── */
  document.addEventListener('DOMContentLoaded', init);

  function init() {
    initTheme();
    bindDropzone();
    bindActions();
    $('#busy').hidden = true;
  }

  /* ── 테마 ───────────────────────────────────────── */
  function initTheme() {
    let saved = null;
    try { saved = localStorage.getItem('masker-theme'); } catch (e) { /* 저장 차단된 환경 */ }
    const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    const theme = saved || (prefersLight ? 'light' : 'dark');
    applyTheme(theme);
    $('#themeBtn').addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
      applyTheme(next);
      try { localStorage.setItem('masker-theme', next); } catch (e) { /* 무시 */ }
    });
  }

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    const icon = $('#themeIcon');
    if (icon) icon.textContent = theme === 'light' ? '☀' : '☾';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'light' ? '#eef1f6' : '#0a1120');
  }

  /* ── 파일 받기 ──────────────────────────────────── */
  function bindDropzone() {
    const dz = $('#dropzone');
    const input = $('#fileInput');
    dz.addEventListener('click', () => input.click());
    dz.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
    });
    input.addEventListener('change', () => {
      const f = input.files && input.files[0];
      input.value = '';
      if (f) loadFile(f);
    });

    let depth = 0;
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth += 1;
      $('#dropOverlay').hidden = false;
    });
    window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) $('#dropOverlay').hidden = true;
    });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      $('#dropOverlay').hidden = true;
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) loadFile(f);
    });
  }

  function hasFiles(e) {
    const t = e.dataTransfer;
    return !!(t && Array.from(t.types || []).indexOf('Files') !== -1);
  }

  async function loadFile(file) {
    if (/\.hwp$/i.test(file.name)) {
      toast('구형 .hwp 파일은 바로 열 수 없습니다. 한글에서 [다른 이름으로 저장 → HWPX 문서]로 변환한 뒤 올려주세요.', 'err', 9000);
      return;
    }
    if (file.size > 60 * 1024 * 1024) {
      toast('파일이 60MB를 넘습니다. 한글에서 문서를 나눈 뒤 다시 시도해 주세요.', 'err', 7000);
      return;
    }
    showBusy('문서를 여는 중…');
    try {
      const buf = await file.arrayBuffer();
      const doc = await window.Masker.open(buf, file.name);
      startSession(doc);
    } catch (err) {
      handleOpenError(err);
    } finally {
      hideBusy();
    }
  }

  function handleOpenError(err) {
    const code = err && err.code;
    if (code === 'HWP') {
      toast('이 파일은 구형 .hwp 형식입니다. 한글에서 [다른 이름으로 저장 → HWPX 문서]로 변환 후 올려주세요.', 'err', 9000);
    } else if (code === 'NOT_ZIP' || code === 'NOT_HWPX') {
      toast('HWPX 문서가 아닙니다. 한글에서 HWPX 문서로 저장한 파일인지 확인해 주세요.', 'err', 8000);
    } else if (code === 'NO_SECTION') {
      toast('문서 본문(Contents/section*.xml)을 찾지 못했습니다. 다른 HWPX 파일로 시도해 주세요.', 'err', 8000);
    } else if (code === 'BAD_XML') {
      toast('문서 내부 XML을 읽는 중 문제가 생겼습니다. 이 파일은 처리하지 않았습니다.', 'err', 8000);
    } else {
      toast('파일을 여는 중 알 수 없는 문제가 생겼습니다. 잠시 후 다시 시도해 주세요.', 'err', 8000);
      if (window.console) console.warn(err);
    }
  }

  function startSession(doc) {
    state.doc = doc;
    state.items = [];
    for (const c of CATS) state.catOn[c.id] = true;

    // 표 라벨 후보(성명·부서·기관명)는 기본으로 켜 둔다.
    for (const cand of doc.labelCandidates || []) {
      if (!cand.original || cand.original.length < 2) continue;
      state.items.push({
        id: 'lb' + state.items.length + '-' + cand.original,
        kind: 'label', category: cand.category, labelName: cand.label,
        original: cand.original, masked: cand.masked, enabled: true, hits: 0
      });
    }
    rebuildAutoItems();

    $('#landing').hidden = true;
    $('#workspace').hidden = false;
    $('#fileName').textContent = doc.fileName;
    const tables = doc.sections.reduce((n, s) => n + s.blocks.filter((b) => b.type === 'table').length, 0);
    $('#fileMeta').textContent =
      `${fmtBytes(doc.fileSize)} · 문단 ${doc.paras.length}개 · 표 ${tables}개 · 구역 ${doc.sections.length}개`;
    document.title = doc.fileName + ' — 민감정보 안심마스커';
    window.scrollTo({ top: 0, behavior: 'smooth' });
    refresh();
  }

  function rebuildAutoItems() {
    const manual = state.items.filter((it) => it.kind !== 'auto');
    const found = window.Masker.detect(state.doc, state.catOn);
    const map = new Map();
    for (const m of found) {
      const key = m.category + '|' + m.original + '|' + m.masked;
      if (!map.has(key)) map.set(key, window.Masker.itemFromMatch(m));
    }
    state.items = manual.concat(Array.from(map.values()));
  }

  /* ── 화면 갱신 ──────────────────────────────────── */
  function refresh() {
    window.Masker.plan(state.doc, state.items);
    renderPreview();
    renderCategories();
    renderLabels();
    renderItems();
    renderSummary();
    const btn = $('#downloadBtn');
    btn.disabled = false;
  }

  function renderSummary() {
    const active = state.items.filter((it) => it.enabled);
    const hitItems = state.items.filter((it) => it.hits > 0);
    const hits = state.items.reduce((n, it) => n + it.hits, 0);
    const off = state.items.filter((it) => !it.enabled && it.hits > 0).length;
    $('#statItems').textContent = hitItems.filter((it) => it.enabled).length;
    $('#statHits').textContent = hits;
    $('#statOff').textContent = off;

    const msg = $('#summaryMsg');
    msg.classList.remove('warn');
    if (hits === 0) {
      msg.textContent = '탐지된 민감정보가 없습니다. 필요하면 미리보기에서 단어를 직접 골라 추가하세요.';
    } else {
      const catsOff = CATS.filter((c) => !state.catOn[c.id]).length;
      msg.textContent = `${hits}곳을 가립니다. 원본 파일은 그대로 두고 새 파일로 저장합니다.` +
        (catsOff ? ` (자동 탐지 ${catsOff}종 꺼짐)` : '');
      if (catsOff) msg.classList.add('warn');
    }
    $('#listCount').textContent = hitItems.length;
    $('#emptyItems').hidden = hitItems.length > 0;
  }

  function renderCategories() {
    const host = $('#catList');
    host.textContent = '';
    for (const cat of CATS) {
      const hits = state.items
        .filter((it) => it.kind === 'auto' && it.category === cat.id)
        .reduce((n, it) => n + it.hits, 0);
      const li = document.createElement('li');
      li.className = 'cat-item';
      li.dataset.hits = String(hits);

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!state.catOn[cat.id];
      cb.id = 'cat-' + cat.id;
      cb.addEventListener('change', () => {
        state.catOn[cat.id] = cb.checked;
        rebuildAutoItems();
        refresh();
      });

      const label = document.createElement('label');
      label.className = 'cat-name';
      label.htmlFor = 'cat-' + cat.id;
      label.textContent = cat.name;
      const sample = document.createElement('span');
      sample.className = 'cat-sample';
      sample.textContent = ' ' + cat.sample;
      label.appendChild(sample);

      const badge = document.createElement('span');
      badge.className = 'cat-hits';
      badge.textContent = String(hits);

      li.append(cb, label, badge);
      host.appendChild(li);
    }
  }

  function renderLabels() {
    const host = $('#labelList');
    host.textContent = '';
    const labels = state.items.filter((it) => it.kind === 'label');
    if (!labels.length) {
      const p = document.createElement('p');
      p.className = 'card-note';
      p.textContent = '표에서 「성명·소속」 같은 라벨을 찾지 못했습니다. 아래에 직접 추가할 수 있습니다.';
      host.appendChild(p);
      return;
    }
    for (const it of labels) {
      const chip = document.createElement('label');
      chip.className = 'label-chip';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = it.enabled;
      cb.addEventListener('change', () => {
        it.enabled = cb.checked;
        refresh();
      });
      const left = document.createElement('span');
      const kind = document.createElement('span');
      kind.className = 'lbl-kind';
      kind.textContent = (KIND_NAME[it.category] || '라벨') + ' · ';
      const val = document.createElement('span');
      val.className = 'lbl-val';
      val.textContent = it.original;
      left.append(kind, val);
      const right = document.createElement('span');
      right.className = 'lbl-mask';
      right.textContent = it.masked;
      chip.append(cb, left, right);
      host.appendChild(chip);
    }
  }

  function renderItems() {
    const host = $('#itemList');
    host.textContent = '';
    const rows = state.items
      .filter((it) => it.hits > 0 || it.kind !== 'auto')
      .sort((a, b) => {
        if ((b.hits > 0) !== (a.hits > 0)) return (b.hits > 0 ? 1 : 0) - (a.hits > 0 ? 1 : 0);
        if (a.kind !== b.kind) return a.kind === 'auto' ? 1 : -1;
        return b.hits - a.hits;
      });

    for (const it of rows) {
      const row = document.createElement('li');
      row.className = 'item-row' + (it.enabled ? '' : ' is-off');

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = it.enabled;
      cb.setAttribute('aria-label', it.original + ' 가리기');
      cb.addEventListener('change', () => {
        it.enabled = cb.checked;
        refresh();
      });

      const io = document.createElement('div');
      io.className = 'item-io';
      const orig = document.createElement('span');
      orig.className = 'item-orig';
      orig.textContent = it.original;
      const arrow = document.createElement('span');
      arrow.className = 'item-arrow';
      arrow.textContent = '→';
      const maskWrap = document.createElement('span');
      if (it.kind === 'custom') {
        const inp = document.createElement('input');
        inp.className = 'item-mask-edit';
        inp.value = it.masked;
        inp.setAttribute('aria-label', '가릴 글자 직접 수정');
        inp.addEventListener('change', () => {
          it.masked = inp.value || window.Masker.customMask(it.original, 'all');
          refresh();
        });
        maskWrap.appendChild(inp);
      } else {
        const mask = document.createElement('span');
        mask.className = 'item-mask';
        mask.textContent = it.masked;
        maskWrap.appendChild(mask);
      }
      io.append(orig, arrow, maskWrap);

      const meta = document.createElement('div');
      meta.style.display = 'flex';
      meta.style.alignItems = 'center';
      meta.style.gap = '6px';
      const tag = document.createElement('span');
      tag.className = 'item-tag';
      tag.textContent = it.kind === 'auto'
        ? (CAT_NAME[it.category] || '자동')
        : (KIND_NAME[it.category] || CAT_NAME[it.category] || '맞춤');
      const hits = document.createElement('span');
      hits.className = 'item-hits';
      hits.textContent = it.hits ? `${it.hits}곳` : '없음';
      meta.append(tag, hits);
      if (it.kind !== 'auto') {
        const del = document.createElement('button');
        del.className = 'item-del';
        del.type = 'button';
        del.textContent = '✕';
        del.title = '목록에서 빼기';
        del.setAttribute('aria-label', it.original + ' 항목 빼기');
        del.addEventListener('click', () => {
          state.items = state.items.filter((x) => x !== it);
          refresh();
        });
        meta.appendChild(del);
      }

      row.append(cb, io, meta);
      host.appendChild(row);
    }
  }

  function renderPreview() {
    const host = $('#preview');
    host.textContent = '';
    if (!state.doc) return;
    for (const sec of state.doc.sections) {
      const paper = document.createElement('div');
      paper.className = 'paper';
      for (const block of sec.blocks) {
        if (block.type === 'p') {
          paper.appendChild(renderPara(block.para));
        } else {
          paper.appendChild(renderTable(block.rows));
        }
      }
      if (!paper.children.length) {
        const p = document.createElement('p');
        p.className = 'preview-empty';
        p.textContent = '이 구역에서 읽을 수 있는 본문이 없습니다.';
        paper.appendChild(p);
      }
      host.appendChild(paper);
    }
  }

  function renderPara(para) {
    const d = document.createElement('div');
    d.className = 'para' + (para.text.trim() ? '' : ' is-empty');
    d.dataset.para = String(para.id);
    let pos = 0;
    for (const r of para.ranges) {
      if (r.start > pos) d.appendChild(document.createTextNode(para.text.slice(pos, r.start)));
      const mk = document.createElement('mark');
      mk.className = 'mk';
      mk.textContent = r.text;
      mk.title = '원본: ' + r.original;
      d.appendChild(mk);
      pos = r.end;
    }
    if (pos < para.text.length) d.appendChild(document.createTextNode(para.text.slice(pos)));
    return d;
  }

  function renderTable(rows) {
    const tbl = document.createElement('table');
    tbl.className = 'doc-table';
    const tbody = document.createElement('tbody');
    for (const row of rows) {
      const tr = document.createElement('tr');
      for (const cell of row) {
        const td = document.createElement('td');
        if (cell.colSpan > 1) td.colSpan = cell.colSpan;
        if (cell.rowSpan > 1) td.rowSpan = cell.rowSpan;
        if (cell.paras.length) {
          for (const p of cell.paras) td.appendChild(renderPara(p));
        } else {
          td.appendChild(document.createTextNode(cell.text));
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    tbl.appendChild(tbody);
    return tbl;
  }

  /* ── 맞춤 치환 추가 ─────────────────────────────── */
  function bindActions() {
    $('#sampleBtn').addEventListener('click', loadSample);
    $('#reloadBtn').addEventListener('click', () => {
      $('#landing').hidden = false;
      $('#workspace').hidden = true;
      document.title = '민감정보 안심마스커 — HWPX 개인정보 가리기';
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    $('#catAllBtn').addEventListener('click', () => {
      const allOn = CATS.every((c) => state.catOn[c.id]);
      for (const c of CATS) state.catOn[c.id] = !allOn;
      $('#catAllBtn').textContent = allOn ? '전체 켜기' : '전체 끄기';
      rebuildAutoItems();
      refresh();
    });
    $('#addForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('#addInput');
      const word = input.value.trim();
      if (addCustom(word, $('#addStyle').value)) input.value = '';
    });
    $('#downloadBtn').addEventListener('click', download);
    $('#copyBtn').addEventListener('click', copyText);
    $('#cleanTrace').addEventListener('change', (e) => {
      state.cleanTrace = e.target.checked;
    });
    bindPreviewSelection();
  }

  function bindPreviewSelection() {
    const preview = $('#preview');
    const handle = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return;
      if (!preview.contains(sel.anchorNode) || !preview.contains(sel.focusNode)) return;
      let text = sel.toString();
      text = cleanWord(text);
      if (!text) return;
      if (addCustom(text, 'auto')) sel.removeAllRanges();
    };
    preview.addEventListener('mouseup', () => setTimeout(handle, 0));
    preview.addEventListener('dblclick', () => setTimeout(handle, 0));
  }

  function cleanWord(raw) {
    let t = String(raw || '').replace(/\s+/g, ' ').trim();
    t = t.replace(/^[^0-9A-Za-z가-힣]+/, '').replace(/[^0-9A-Za-z가-힣%,원)~]+$/, '');
    if (t.length > 40) return '';
    return t;
  }

  function addCustom(word, style) {
    const hint = $('#addHint');
    if (!word || word.length < 2) {
      if (hint) { hint.textContent = '두 글자 이상 입력해 주세요.'; hint.className = 'form-hint err'; }
      return false;
    }
    if (!state.doc) return false;
    const exists = state.items.find((it) => it.original === word);
    if (exists) {
      if (!exists.enabled) { exists.enabled = true; refresh(); }
      if (hint) { hint.textContent = `「${word}」은(는) 이미 목록에 있습니다.`; hint.className = 'form-hint'; }
      else toast(`「${word}」은(는) 이미 목록에 있습니다.`, '', 2600);
      return false;
    }
    const item = {
      id: window.Masker.newItemId(),
      kind: 'custom', category: 'custom',
      original: word, masked: window.Masker.customMask(word, style || 'auto'),
      enabled: true, hits: 0
    };
    state.items.unshift(item);
    refresh();
    if (item.hits === 0) {
      state.items = state.items.filter((x) => x !== item);
      refresh();
      const msg = `문서 본문에서 「${word}」을(를) 찾지 못했습니다.`;
      if (hint) { hint.textContent = msg; hint.className = 'form-hint err'; }
      toast(msg, 'err', 3200);
      return false;
    }
    const msg = `「${word}」 → ${item.masked} · ${item.hits}곳을 가립니다.`;
    if (hint) { hint.textContent = msg; hint.className = 'form-hint ok'; }
    toast(msg, 'ok', 3000);
    return true;
  }

  /* ── 내보내기 ───────────────────────────────────── */
  async function download() {
    if (!state.doc || state.busy) return;
    showBusy('마스킹한 문서를 만드는 중…');
    try {
      const { blob, fileName } = await window.Masker.buildMaskedHwpx(state.doc, { cleanTrace: state.cleanTrace });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast(`저장했습니다 · ${fileName} (${fmtBytes(blob.size)})`, 'ok', 5000);
    } catch (err) {
      toast('문서를 저장하는 중 문제가 생겼습니다. 다시 시도해 주세요.', 'err', 6000);
      if (window.console) console.warn(err);
    } finally {
      hideBusy();
    }
  }

  async function copyText() {
    if (!state.doc) return;
    const text = window.Masker.maskedText(state.doc);
    if (!text) { toast('복사할 본문이 없습니다.', 'err', 3000); return; }
    try {
      await navigator.clipboard.writeText(text);
      toast(`가린 텍스트 ${text.length.toLocaleString()}자를 복사했습니다.`, 'ok', 4000);
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        toast('가린 텍스트를 복사했습니다.', 'ok', 4000);
      } catch (e2) {
        toast('복사가 차단되었습니다. 브라우저 권한을 확인해 주세요.', 'err', 5000);
      }
      ta.remove();
    }
  }

  /* ── 샘플 ───────────────────────────────────────── */
  async function loadSample() {
    const data = window.HWPX_SAMPLE;
    if (!data || !data.b64) {
      toast('샘플 파일을 불러오지 못했습니다. 직접 .hwpx 파일을 올려 주세요.', 'err', 6000);
      return;
    }
    showBusy('샘플 문서를 준비하는 중…');
    try {
      const bin = atob(data.b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const doc = await window.Masker.open(bytes.buffer, data.name || 'sample.hwpx');
      startSession(doc);
      toast('샘플 문서를 열었습니다. 실제 문서처럼 자유롭게 시험해 보세요.', 'ok', 4000);
    } catch (err) {
      toast('샘플을 여는 중 문제가 생겼습니다.', 'err', 5000);
      if (window.console) console.warn(err);
    } finally {
      hideBusy();
    }
  }

  /* ── 잔심부름 ───────────────────────────────────── */
  function fmtBytes(n) {
    if (n < 1024) return n + 'B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'KB';
    return (n / 1024 / 1024).toFixed(1) + 'MB';
  }

  function toast(text, kind, ms) {
    const el = $('#toast');
    el.textContent = text;
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms || 3600);
  }

  function showBusy(text) {
    state.busy = true;
    $('#busyText').textContent = text || '처리 중…';
    $('#busy').hidden = false;
  }
  function hideBusy() {
    state.busy = false;
    $('#busy').hidden = true;
  }
})();
