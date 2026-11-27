/* ============================================================
   민감정보 안심마스커 · 화면 (v2)
   파일 열기 → 탐지 → 문맥 확인 → 전후 비교 → _masked.hwpx 저장
   무거운 ZIP·XML 작업은 assets/worker.js 에 맡기고,
   이 파일은 화면과 판단만 담당합니다.
   ============================================================ */
(function () {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const M = window.Masker;
  const CATS = M.CATEGORIES;
  const CAT_NAME = Object.fromEntries(CATS.map((c) => [c.id, c.name]));
  const KIND_NAME = { name: '성명', dept: '부서', org: '기관·업체', custom: '직접 지정' };
  const PRESET_KEY = 'masker-presets-v1';
  const PHASE_TEXT = {
    unzip: '압축을 푸는 중', parse: '문서를 읽는 중',
    replace: '민감정보를 가리는 중', metadata: '메타데이터를 지우는 중', zip: '파일을 다시 압축하는 중'
  };

  const state = {
    doc: null,
    items: [],
    catOn: Object.fromEntries(CATS.map((c) => [c.id, true])),
    cleanTrace: true,
    resetMetadata: true,
    view: 'masked',
    pending: null,
    presets: [],
    busy: false,
    usedWorker: false,
    workerBroken: false,
    lastBuild: null
  };

  const debug = { state, progressLog: [], usedWorker: false, workerAvailable: false };
  window.__maskerDebug = debug;

  let toastTimer = null;

  /* ═════════════════════════ 워커 다리 ═════════════════════════ */
  const calls = new Map();
  let callSeq = 1;
  let worker = null;

  function workerAllowed() {
    if (typeof Worker === 'undefined') return false;
    if (/[?&]noworker=1/.test(location.search)) return false;
    return !state.workerBroken;
  }

  function ensureWorker() {
    if (worker) return worker;
    if (!workerAllowed()) return null;
    try {
      worker = new Worker('./assets/worker.js');
      worker.onmessage = (e) => {
        const msg = e.data || {};
        if (msg.type === 'progress') {
          const cb = calls.get(msg.id);
          if (cb && cb.onProgress) cb.onProgress(msg.phase, msg.percent);
          debug.progressLog.push({ phase: msg.phase, percent: msg.percent });
          return;
        }
        const entry = calls.get(msg.id);
        if (!entry) return;
        calls.delete(msg.id);
        if (msg.type === 'error' || !msg.ok) {
          const err = new Error(msg.message || 'worker error');
          err.code = msg.code;
          entry.reject(err);
        } else if (msg.type === 'opened') entry.resolve(msg.model);
        else if (msg.type === 'built') entry.resolve(msg);
        else entry.resolve(msg);
      };
      worker.onerror = (e) => {
        state.workerBroken = true;
        for (const [, entry] of calls) entry.reject(Object.assign(new Error('worker ' + (e.message || 'error')), { code: 'WORKER' }));
        calls.clear();
      };
      debug.workerAvailable = true;
      return worker;
    } catch (err) {
      state.workerBroken = true;
      return null;
    }
  }

  function callWorker(type, payload, onProgress) {
    const w = ensureWorker();
    if (!w) return null;
    const id = callSeq++;
    return new Promise((resolve, reject) => {
      calls.set(id, { resolve, reject, onProgress });
      const msg = Object.assign({ id, type }, payload);
      const transfer = payload && payload.buffer instanceof ArrayBuffer ? [payload.buffer] : [];
      w.postMessage(msg, transfer);
    });
  }

  async function engineOpen(buffer, fileName, onProgress) {
    const w = ensureWorker();
    if (w) {
      state.usedWorker = true;
      debug.usedWorker = true;
      try {
        return await callWorker('open', { buffer, fileName }, onProgress);
      } catch (err) {
        if (err && err.code === 'WORKER') {
          /* 워커가 죽으면 같은 파일로 메인 스레드에서 다시 시도한다. */
          state.workerBroken = true;
          state.usedWorker = false;
          return M.Hwpx.open(new Uint8Array(buffer), fileName, onProgress);
        }
        throw err;
      }
    }
    state.usedWorker = false;
    return M.Hwpx.open(new Uint8Array(buffer), fileName, onProgress);
  }

  async function engineBuild(items, opts, onProgress) {
    const w = ensureWorker();
    if (w && state.usedWorker) {
      const res = await callWorker('build', { items, opts }, onProgress);
      return res;
    }
    return M.Hwpx.build(items, opts, onProgress);
  }

  /* ═════════════════════════ 시작 ═════════════════════════ */
  document.addEventListener('DOMContentLoaded', init);

  function init() {
    initTheme();
    bindDropzone();
    bindActions();
    loadPresets();
    renderPresets();
    $('#busy').hidden = true;
  }

  /* ── 테마 ───────────────────────────────────────── */
  function initTheme() {
    let saved = null;
    try { saved = localStorage.getItem('masker-theme'); } catch (e) { /* 저장 차단 */ }
    const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    applyTheme(saved || (prefersLight ? 'light' : 'dark'));
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
    showBusy('문서를 여는 중…', 0);
    try {
      const buf = await file.arrayBuffer();
      const model = await engineOpen(buf, file.name, (phase, pct) => setBusyProgress(pct, phase));
      startSession(model);
    } catch (err) {
      handleOpenError(err);
    } finally {
      hideBusy();
    }
  }

  async function loadSample() {
    const data = window.HWPX_SAMPLE;
    if (!data || !data.b64) {
      toast('샘플 파일을 불러오지 못했습니다. 직접 .hwpx 파일을 올려 주세요.', 'err', 6000);
      return;
    }
    showBusy('샘플 문서를 준비하는 중…', 0);
    try {
      const bin = atob(data.b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      const model = await engineOpen(bytes.buffer, data.name || 'sample.hwpx', (phase, pct) => setBusyProgress(pct, phase));
      startSession(model);
      toast('샘플 문서를 열었습니다. 실제 문서처럼 자유롭게 시험해 보세요.', 'ok', 4000);
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
    } else if (code === 'NO_JSZIP') {
      toast('압축 해제 모듈(JSZip)을 불러오지 못했습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.', 'err', 8000);
    } else if (code === 'BAD_XML') {
      toast('문서 내부 XML을 읽는 중 문제가 생겼습니다. 이 파일은 처리하지 않았습니다.', 'err', 8000);
    } else {
      toast('파일을 여는 중 알 수 없는 문제가 생겼습니다. 잠시 후 다시 시도해 주세요.', 'err', 8000);
      if (window.console) console.warn(err);
    }
  }

  /* ═════════════════════════ 세션 ═════════════════════════ */
  function startSession(model) {
    state.doc = model;
    state.items = [];
    for (const c of CATS) state.catOn[c.id] = true;

    for (const cand of model.labelCandidates || []) {
      if (!cand.original || cand.original.length < 2) continue;
      state.items.push({
        id: 'lb' + state.items.length,
        kind: 'label', category: cand.category, labelName: cand.label,
        original: cand.original, masked: cand.masked, enabled: true, hits: 0, matchMode: 'partial'
      });
    }
    rebuildAutoItems();

    $('#landing').hidden = true;
    $('#workspace').hidden = false;
    $('#fileName').textContent = model.fileName;
    const s = model.stats;
    const regionTxt = s.regionContainers
      ? ` · 본문 외 ${s.regionContainers}개(머리말·각주 등)`
      : '';
    $('#fileMeta').textContent =
      `${fmtBytes(model.fileSize)} · 문단 ${s.paras}개 · 표 ${s.tables}개 · 구역 ${s.sections}개${regionTxt}` +
      (state.usedWorker ? ' · ⚡ Web Worker' : '');
    document.title = model.fileName + ' — 민감정보 안심마스커';
    setView('masked');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    refresh();
  }

  function rebuildAutoItems() {
    if (!state.doc) return;
    const manual = state.items.filter((it) => it.kind !== 'auto');
    const found = M.detect(state.doc.paras, state.catOn);
    const map = new Map();
    for (const m of found) {
      const key = m.category + '|' + m.original + '|' + m.masked;
      if (!map.has(key)) {
        map.set(key, {
          id: 'au' + map.size,
          kind: 'auto', category: m.category,
          original: m.original, masked: m.masked,
          enabled: true, hits: 0, matchMode: 'partial',
          occ: []
        });
      }
      map.get(key).occ.push({ p: m.paraId, start: m.start });
    }
    state.items = manual.concat(Array.from(map.values()));
  }

  /* ═════════════════════════ 화면 갱신 ═════════════════════════ */
  function refresh() {
    if (!state.doc) return;
    M.plan(state.doc.paras, state.items);
    renderPreview();
    renderCategories();
    renderLabels();
    renderItems();
    renderRegions();
    renderSummary();
    $('#downloadBtn').disabled = false;
  }

  function paraById() {
    const map = {};
    for (const p of state.doc.paras) map[p.id] = p;
    return map;
  }

  function renderSummary() {
    const byId = paraById();
    const hits = state.items.reduce((n, it) => n + it.hits, 0);
    const hitItems = state.items.filter((it) => it.hits > 0);
    let excluded = 0;
    for (const it of state.items) {
      if (!it.exclude) continue;
      excluded += (typeof it.exclude.size === 'number' ? it.exclude.size : Array.from(it.exclude).length);
    }
    const disabled = state.items.filter((it) => !it.enabled && it.original).length;
    $('#statItems').textContent = hitItems.filter((it) => it.enabled).length;
    $('#statHits').textContent = hits;
    $('#statOff').textContent = excluded;

    const msg = $('#summaryMsg');
    msg.classList.remove('warn');
    if (hits === 0) {
      msg.textContent = '탐지된 민감정보가 없습니다. 필요하면 미리보기에서 단어를 직접 골라 추가하세요.';
    } else {
      const catsOff = CATS.filter((c) => !state.catOn[c.id]).length;
      const regionHits = state.doc.paras.filter((p) => p.region && p.ranges && p.ranges.length)
        .reduce((n, p) => n + p.ranges.length, 0);
      msg.textContent = `${hits}곳을 가립니다.` +
        (regionHits ? ` (본문 외 ${regionHits}곳 포함)` : '') +
        (catsOff ? ` · 자동 탐지 ${catsOff}종 꺼짐` : '');
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
    const allOn = CATS.every((c) => state.catOn[c.id]);
    $('#catAllBtn').textContent = allOn ? '전체 끄기' : '전체 켜기';
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
      right.textContent = it.masked + (it.hits ? ` (${it.hits})` : '');
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
      row.dataset.kind = it.kind;

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
          it.masked = inp.value || M.customMask(it.original, 'all');
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
      meta.className = 'item-meta';
      const tag = document.createElement('span');
      tag.className = 'item-tag';
      tag.textContent = it.kind === 'auto'
        ? (CAT_NAME[it.category] || '자동')
        : (KIND_NAME[it.category] || CAT_NAME[it.category] || '맞춤');
      const hits = document.createElement('span');
      hits.className = 'item-hits';
      hits.textContent = it.hits ? `${it.hits}곳` : '없음';
      meta.append(tag, hits);

      if (it.kind === 'custom') {
        const mode = document.createElement('span');
        mode.className = 'item-mode';
        mode.textContent = it.matchMode === 'partial' ? '부분' : '단어';
        mode.title = it.matchMode === 'partial' ? '부분 일치로 찾습니다' : '단어 경계에서만 찾습니다';
        meta.appendChild(mode);

        const scope = document.createElement('button');
        scope.className = 'item-scope';
        scope.type = 'button';
        scope.textContent = '범위';
        scope.title = '영향을 받는 문맥 보기·제외';
        scope.addEventListener('click', () => openAffectPanel(it.original, { style: 'keep', item: it }));
        meta.appendChild(scope);

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

  /* ── 본문 외 영역 카드 ─────────────────────────── */
  function renderRegions() {
    const regions = [];
    const byId = paraById();
    for (const sec of state.doc.sections) {
      for (const ex of sec.extras || []) {
        const ids = ex.paraIds;
        const hits = ids.reduce((n, id) => n + ((byId[id] && byId[id].ranges ? byId[id].ranges.length : 0)), 0);
        const text = ids.map((id) => byId[id].text).join(' ').trim();
        regions.push({ kind: ex.kind, label: ex.label, hits, text });
      }
    }
    const card = $('#regionCard');
    card.hidden = !regions.length;
    $('#regionCount').textContent = String(regions.length);
    const host = $('#regionList');
    host.textContent = '';
    for (const r of regions) {
      const li = document.createElement('li');
      li.className = 'region-item';
      const kind = document.createElement('span');
      kind.className = 'region-kind';
      kind.textContent = r.label;
      const txt = document.createElement('span');
      txt.className = 'region-text';
      txt.textContent = r.text.slice(0, 42) + (r.text.length > 42 ? '…' : '');
      const badge = document.createElement('span');
      badge.className = 'region-hits' + (r.hits ? '' : ' is-zero');
      badge.textContent = r.hits ? `${r.hits}곳` : '민감정보 없음';
      li.append(kind, txt, badge);
      host.appendChild(li);
    }
  }

  /* ── 미리보기 ──────────────────────────────────── */
  let lastViewRender = 0;

  function setView(view) {
    state.view = view;
    $$('.view-seg .seg-btn').forEach((b) => {
      const on = b.dataset.view === view;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    const hint = $('#previewHint');
    if (view === 'compare') {
      hint.textContent = '바뀌는 문단만 모아 원문과 마스킹 후를 나란히 보여 줍니다 · 노란색이 원문, 초록색이 가린 결과입니다';
    } else if (view === 'original') {
      hint.textContent = '가리기 전 원문입니다 · 아무것도 바뀌지 않은 상태를 그대로 보여 줍니다';
    } else {
      hint.textContent = '가려질 곳은 이렇게 표시됩니다 · 단어를 더블클릭하거나 드래그하면 맞춤 치환에 추가됩니다';
    }
    if (state.doc) renderPreview();
  }

  const PREVIEW_MAX_BLOCKS = 500;
  const COMPARE_MAX_ROWS = 240;

  function renderPreview() {
    const host = $('#preview');
    host.textContent = '';
    $('#previewNote').hidden = true;
    if (!state.doc) return;
    if (state.view === 'compare') { renderCompare(host); return; }

    const masked = state.view === 'masked';
    const byId = paraById();
    const huge = state.doc.stats.paras > PREVIEW_MAX_BLOCKS * 3;
    let budget = huge ? PREVIEW_MAX_BLOCKS : Infinity;
    for (const sec of state.doc.sections) {
      const paper = document.createElement('div');
      paper.className = 'paper';
      paper.dataset.section = String(sec.index);
      for (const block of sec.blocks) {
        if (budget <= 0) break;
        if (block.type === 'p') {
          const p = byId[block.paraId];
          if (p) { paper.appendChild(renderPara(p, masked)); budget -= 1; }
        } else {
          paper.appendChild(renderTable(block.rows, masked, byId));
          budget -= block.rows.reduce((n, row) => n + row.reduce((m, c) => m + c.paraIds.length, 0), 0) || 1;
        }
      }
      if (!paper.children.length) {
        const p = document.createElement('p');
        p.className = 'preview-empty';
        p.textContent = '이 구역에서 읽을 수 있는 본문이 없습니다.';
        paper.appendChild(p);
      }
      host.appendChild(paper);
      if (sec.extras && sec.extras.length) host.appendChild(renderExtras(sec.extras, masked, byId));
      if (budget <= 0) break;
    }
    if (budget <= 0) showPreviewNote(`문서가 커서 미리보기는 앞부분 ${PREVIEW_MAX_BLOCKS}문단만 보여 줍니다. 탐지·치환은 문서 전체에 적용됩니다.`);
  }

  function showPreviewNote(text) {
    const note = $('#previewNote');
    note.textContent = text;
    note.hidden = false;
  }

  function renderPara(para, masked) {
    const d = document.createElement('div');
    d.className = 'para' + (para.text.trim() ? '' : ' is-empty');
    d.dataset.para = String(para.id);
    if (!masked) {
      d.textContent = para.text;
      return d;
    }
    let pos = 0;
    for (const r of para.ranges || []) {
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

  function renderTable(rows, masked, byId) {
    const tbl = document.createElement('table');
    tbl.className = 'doc-table';
    const tbody = document.createElement('tbody');
    for (const row of rows) {
      const tr = document.createElement('tr');
      for (const cell of row) {
        const td = document.createElement('td');
        if (cell.colSpan > 1) td.colSpan = cell.colSpan;
        if (cell.rowSpan > 1) td.rowSpan = cell.rowSpan;
        if (cell.paraIds.length) {
          for (const id of cell.paraIds) {
            const p = byId[id];
            if (p) td.appendChild(renderPara(p, masked));
          }
        } else {
          td.appendChild(document.createTextNode(cell.text || ''));
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    tbl.appendChild(tbody);
    return tbl;
  }

  function renderExtras(extras, masked, byId) {
    const wrap = document.createElement('div');
    wrap.className = 'extras-block';
    const head = document.createElement('p');
    head.className = 'extras-head';
    head.textContent = '본문 외 영역';
    const sub = document.createElement('span');
    sub.textContent = '머리말·꼬리말·각주 등도 같은 규칙으로 가립니다';
    head.appendChild(sub);
    wrap.appendChild(head);
    const grid = document.createElement('div');
    grid.className = 'extras-grid';
    for (const ex of extras) {
      const card = document.createElement('div');
      card.className = 'extra-card';
      const kind = document.createElement('span');
      kind.className = 'extra-kind';
      kind.textContent = ex.label;
      card.appendChild(kind);
      for (const id of ex.paraIds) {
        const p = byId[id];
        if (!p) continue;
        const row = renderPara(p, masked);
        row.classList.add('extra-para');
        card.appendChild(row);
      }
      grid.appendChild(card);
    }
    wrap.appendChild(grid);
    return wrap;
  }

  function locationLabels() {
    const map = {};
    let pIdx = 0;
    for (const sec of state.doc.sections) {
      let tIdx = 0;
      for (const block of sec.blocks) {
        if (block.type === 'p') {
          pIdx += 1;
          map[block.paraId] = `본문 ${pIdx}번째 문단`;
        } else {
          tIdx += 1;
          block.rows.forEach((row, ri) => row.forEach((cell, ci) => cell.paraIds.forEach((id) => {
            map[id] = `표 ${tIdx} · ${ri + 1}행 ${ci + 1}열`;
          })));
        }
      }
      for (const ex of sec.extras || []) {
        ex.paraIds.forEach((id, i) => {
          map[id] = ex.label + (ex.paraIds.length > 1 ? ' ' + (i + 1) : '');
        });
      }
    }
    return map;
  }

  function renderCompare(host) {
    const loc = locationLabels();
    const allRows = state.doc.paras.filter((p) => p.ranges && p.ranges.length);
    const rows = allRows.slice(0, COMPARE_MAX_ROWS);
    if (allRows.length > COMPARE_MAX_ROWS) {
      showPreviewNote(`변경된 문단이 ${allRows.length}개입니다. 비교 화면은 앞 ${COMPARE_MAX_ROWS}개만 보여 줍니다(저장 파일에는 전부 반영).`);
    }
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'paper compare-empty';
      empty.textContent = '아직 가릴 곳이 없습니다. 자동 탐지를 켜거나 미리보기에서 단어를 골라 추가해 보세요.';
      host.appendChild(empty);
      return;
    }
    const paper = document.createElement('div');
    paper.className = 'paper compare-paper';
    const head = document.createElement('div');
    head.className = 'compare-head';
    head.innerHTML = '<span class="cmp-count"></span>';
    head.querySelector('.cmp-count').textContent = `${allRows.length}개 문단 · ${allRows.reduce((n, p) => n + p.ranges.length, 0)}곳 변경`;
    paper.appendChild(head);

    const list = document.createElement('ul');
    list.className = 'diff-list';
    for (const p of rows) {
      const li = document.createElement('li');
      li.className = 'diff-row';
      const l = document.createElement('p');
      l.className = 'diff-loc';
      l.textContent = (loc[p.id] || '본문') + ' · ' + p.ranges.length + '곳';
      li.appendChild(l);

      const origLine = document.createElement('p');
      origLine.className = 'diff-line diff-before';
      const tagA = document.createElement('span');
      tagA.className = 'diff-tag';
      tagA.textContent = '원문';
      origLine.appendChild(tagA);
      let pos = 0;
      for (const r of p.ranges) {
        if (r.start > pos) origLine.appendChild(document.createTextNode(p.text.slice(pos, r.start)));
        const del = document.createElement('mark');
        del.className = 'diff-del';
        del.textContent = p.text.slice(r.start, r.end);
        origLine.appendChild(del);
        pos = r.end;
      }
      if (pos < p.text.length) origLine.appendChild(document.createTextNode(p.text.slice(pos)));
      li.appendChild(origLine);

      const afterLine = document.createElement('p');
      afterLine.className = 'diff-line diff-after';
      const tagB = document.createElement('span');
      tagB.className = 'diff-tag';
      tagB.textContent = '이후';
      afterLine.appendChild(tagB);
      let pos2 = 0;
      for (const r of p.ranges) {
        if (r.start > pos2) afterLine.appendChild(document.createTextNode(p.text.slice(pos2, r.start)));
        const add = document.createElement('mark');
        add.className = 'diff-add';
        add.textContent = r.text;
        add.title = '원본: ' + r.original;
        afterLine.appendChild(add);
        pos2 = r.end;
      }
      if (pos2 < p.text.length) afterLine.appendChild(document.createTextNode(p.text.slice(pos2)));
      li.appendChild(afterLine);
      list.appendChild(li);
    }
    paper.appendChild(list);
    host.appendChild(paper);
    lastViewRender = Date.now();
  }

  /* ═════════════════════════ 맞춤 치환 ═════════════════════════ */
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
    $('#cleanTrace').addEventListener('change', (e) => { state.cleanTrace = e.target.checked; });
    $('#resetMeta').addEventListener('change', (e) => { state.resetMetadata = e.target.checked; });
    $$('.view-seg .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => setView(btn.dataset.view));
    });

    $('#affectCancel').addEventListener('click', closeAffectPanel);
    $('#affectApply').addEventListener('click', applyAffectPanel);
    $$('input[name="affectMode"]').forEach((r) => {
      r.addEventListener('change', () => {
        if (!state.pending) return;
        state.pending.mode = r.value;
        state.pending.exclude = new Set();
        renderAffectList();
      });
    });

    $('#presetForm').addEventListener('submit', (e) => {
      e.preventDefault();
      savePreset($('#presetName').value);
    });
    $('#presetClear').addEventListener('click', clearPresets);
    bindPreviewSelection();
  }

  function bindPreviewSelection() {
    const preview = $('#preview');
    const handle = () => {
      if (state.view === 'compare') return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return;
      if (!preview.contains(sel.anchorNode) || !preview.contains(sel.focusNode)) return;
      const text = cleanWord(sel.toString());
      if (!text) return;
      sel.removeAllRanges();
      addCustom(text, 'auto');
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
    const exists = state.items.find((it) => it.kind === 'custom' && it.original === word);
    openAffectPanel(word, { style: style || 'auto', item: exists || null });
    return true;
  }

  /* ── 영향 범위 패널 ────────────────────────────── */
  function openAffectPanel(word, opts) {
    const style = opts && opts.style ? opts.style : 'auto';
    const item = opts && opts.item ? opts.item : null;
    const wordOcc = M.occurrences(state.doc, word, 'word');
    const partOcc = M.occurrences(state.doc, word, 'partial');
    let mode = item ? (item.matchMode || 'word') : 'word';
    if (!item && wordOcc.length === 0 && partOcc.length > 0) mode = 'partial';
    state.pending = {
      word, style, item, mode,
      exclude: item && item.exclude ? new Set(item.exclude) : new Set(),
      wordCount: wordOcc.length, partCount: partOcc.length
    };
    $('#affectWord').textContent = word;
    $('#affectWordCount').textContent = wordOcc.length + '곳';
    $('#affectPartialCount').textContent = partOcc.length + '곳';
    $$('input[name="affectMode"]').forEach((r) => { r.checked = r.value === mode; });
    $('#affectPanel').hidden = false;
    renderAffectList();
    $('#affectPanel').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function closeAffectPanel() {
    state.pending = null;
    $('#affectPanel').hidden = true;
    $('#affectList').textContent = '';
  }

  function affectCounts() {
    const st = state.pending;
    if (!st) return { total: 0, checked: 0 };
    const list = M.occurrences(state.doc, st.word, st.mode);
    let checked = 0;
    for (const occ of list) if (!st.exclude.has(occ.paraId + ':' + occ.start)) checked += 1;
    return { total: list.length, checked };
  }

  function renderAffectList() {
    const st = state.pending;
    if (!st) return;
    const list = M.occurrences(state.doc, st.word, st.mode);
    const loc = locationLabels();
    const host = $('#affectList');
    host.textContent = '';
    list.slice(0, 120).forEach((occ) => {
      const key = occ.paraId + ':' + occ.start;
      const li = document.createElement('li');
      li.className = 'affect-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !st.exclude.has(key);
      cb.addEventListener('change', () => {
        if (cb.checked) st.exclude.delete(key); else st.exclude.add(key);
        updateAffectSum();
      });
      const body = document.createElement('div');
      body.className = 'affect-body';
      const where = document.createElement('span');
      where.className = 'affect-where';
      where.textContent = loc[occ.paraId] || '본문';
      const ctx = document.createElement('span');
      ctx.className = 'affect-ctx';
      if (occ.context.before) ctx.appendChild(document.createTextNode(occ.context.before));
      const mk = document.createElement('mark');
      mk.textContent = st.word;
      ctx.appendChild(mk);
      if (occ.context.after) ctx.appendChild(document.createTextNode(occ.context.after));
      body.append(where, ctx);
      li.append(cb, body);
      host.appendChild(li);
    });
    if (list.length > 120) {
      const more = document.createElement('li');
      more.className = 'affect-more';
      more.textContent = `그 외 ${list.length - 120}곳은 모두 가립니다.`;
      host.appendChild(more);
    }
    const note = $('#affectNote');
    if (!list.length) {
      note.textContent = st.mode === 'word'
        ? '단어 그대로는 찾지 못했습니다. 「부분 일치」를 고르면 다른 단어 안의 글자까지 바꿉니다.'
        : '이 글자는 문서에 없습니다.';
      note.className = 'affect-note err';
    } else if (st.mode === 'word') {
      note.textContent = '단어 경계에서만 찾습니다. 「피감사인」 속 「감사」처럼 다른 단어에 붙은 글자는 건드리지 않습니다.';
      note.className = 'affect-note';
    } else {
      note.textContent = '부분 일치입니다. 다른 단어 안에 들어 있는 글자까지 모두 바뀌니 결과를 꼭 확인하세요.';
      note.className = 'affect-note warn';
    }
    updateAffectSum();
  }

  function updateAffectSum() {
    const { total, checked } = affectCounts();
    $('#affectSum').textContent = `${checked}곳을 가립니다` + (total > checked ? ` (${total - checked}곳 제외)` : '');
    $('#affectApply').disabled = checked === 0;
    $('#affectList').dataset.checked = String(checked);
  }

  function applyAffectPanel() {
    const st = state.pending;
    if (!st) return;
    const checked = affectCounts().checked;
    if (!checked) { toast('가릴 곳을 하나 이상 골라 주세요.', 'err', 3000); return; }
    const masked = st.item ? st.item.masked : M.customMask(st.word, st.style);
    if (st.item) {
      st.item.matchMode = st.mode;
      st.item.exclude = new Set(st.exclude);
      st.item.enabled = true;
    } else {
      state.items.unshift({
        id: M.newItemId(), kind: 'custom', category: 'custom',
        original: st.word, masked, enabled: true, hits: 0,
        matchMode: st.mode, exclude: new Set(st.exclude)
      });
    }
    closeAffectPanel();
    refresh();
    const item = state.items.find((it) => it.kind === 'custom' && it.original === st.word);
    const hint = $('#addHint');
    const msg = `「${st.word}」 → ${item ? item.masked : masked} · ${item ? item.hits : checked}곳을 가립니다.`;
    if (hint) { hint.textContent = msg; hint.className = 'form-hint ok'; }
    toast(msg, 'ok', 3200);
  }

  /* ═════════════════════════ 프리셋 ═════════════════════════ */
  function loadPresets() {
    try {
      const raw = localStorage.getItem(PRESET_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      state.presets = Array.isArray(parsed) ? parsed.filter((p) => p && p.id && p.name) : [];
    } catch (e) {
      state.presets = [];
    }
  }

  function persistPresets() {
    try {
      localStorage.setItem(PRESET_KEY, JSON.stringify(state.presets));
      return true;
    } catch (e) {
      toast('이 브라우저에서는 프리셋을 저장할 수 없습니다(저장 공간 차단).', 'err', 5000);
      return false;
    }
  }

  function savePreset(name) {
    const clean = String(name || '').trim();
    const hint = $('#presetHint');
    if (!state.doc) { setPresetHint('문서를 연 뒤에 저장할 수 있습니다.', true); return; }
    if (!clean) { setPresetHint('세트 이름을 입력해 주세요.', true); return; }
    const rules = state.items
      .filter((it) => it.kind === 'custom' && it.original)
      .map((it) => ({
        original: it.original, masked: it.masked,
        matchMode: it.matchMode || 'word'
      }));
    if (!rules.length) { setPresetHint('먼저 맞춤 치환 규칙을 하나 이상 추가해 주세요.', true); return; }
    const preset = {
      id: 'ps' + Date.now(),
      name: clean.slice(0, 24),
      savedAt: new Date().toISOString(),
      categories: Object.assign({}, state.catOn),
      rules
    };
    state.presets = [preset].concat(state.presets.filter((p) => p.name !== preset.name));
    if (!persistPresets()) return;
    $('#presetName').value = '';
    renderPresets();
    setPresetHint(`「${preset.name}」 저장됨 · 규칙 ${rules.length}개`, false);
    toast(`마스킹 세트 「${preset.name}」을(를) 저장했습니다.`, 'ok', 3200);
  }

  function setPresetHint(text, isErr) {
    const hint = $('#presetHint');
    hint.textContent = text;
    hint.className = 'form-hint ' + (isErr ? 'err' : 'ok');
  }

  function applyPreset(id) {
    const preset = state.presets.find((p) => p.id === id);
    if (!preset) return;
    for (const c of CATS) {
      state.catOn[c.id] = preset.categories && preset.categories[c.id] !== undefined ? !!preset.categories[c.id] : true;
    }
    state.items = state.items.filter((it) => it.kind !== 'custom');
    let applied = 0;
    for (const rule of preset.rules || []) {
      state.items.unshift({
        id: M.newItemId(), kind: 'custom', category: 'custom',
        original: rule.original, masked: rule.masked || M.customMask(rule.original, 'auto'),
        enabled: true, hits: 0, matchMode: rule.matchMode === 'partial' ? 'partial' : 'word'
      });
      applied += 1;
    }
    rebuildAutoItems();
    refresh();
    const found = state.items.filter((it) => it.kind === 'custom' && it.hits > 0).length;
    setPresetHint(`「${preset.name}」 불러옴 · 규칙 ${applied}개 중 ${found}개가 이 문서에서 발견됨`, false);
    toast(`「${preset.name}」 세트를 불러왔습니다.`, 'ok', 3200);
  }

  function deletePreset(id) {
    const preset = state.presets.find((p) => p.id === id);
    if (!preset) return;
    if (!preset.confirmDelete) {
      preset.confirmDelete = true;
      renderPresets();
      setPresetHint('한 번 더 누르면 삭제됩니다.', true);
      setTimeout(() => { preset.confirmDelete = false; if (state.doc) renderPresets(); }, 4000);
      return;
    }
    state.presets = state.presets.filter((p) => p.id !== id);
    persistPresets();
    renderPresets();
    setPresetHint(`「${preset.name}」 삭제됨`, false);
  }

  function clearPresets() {
    const btn = $('#presetClear');
    if (!state.presets.length) return;
    if (btn.dataset.confirm !== '1') {
      btn.dataset.confirm = '1';
      btn.textContent = '정말 모두 지울까요? 한 번 더 누르세요';
      setTimeout(() => {
        btn.dataset.confirm = '';
        btn.textContent = '저장된 프리셋 모두 지우기';
      }, 4000);
      return;
    }
    state.presets = [];
    try { localStorage.removeItem(PRESET_KEY); } catch (e) { /* 무시 */ }
    btn.dataset.confirm = '';
    btn.textContent = '저장된 프리셋 모두 지우기';
    renderPresets();
    setPresetHint('저장된 프리셋을 모두 지웠습니다.', false);
  }

  function renderPresets() {
    $('#presetCount').textContent = String(state.presets.length);
    const host = $('#presetList');
    host.textContent = '';
    if (!state.presets.length) {
      const p = document.createElement('li');
      p.className = 'preset-empty';
      p.textContent = '저장된 세트가 없습니다. 지금 설정을 이름 붙여 저장해 보세요.';
      host.appendChild(p);
      $('#presetClear').disabled = true;
      return;
    }
    $('#presetClear').disabled = false;
    for (const preset of state.presets) {
      const li = document.createElement('li');
      li.className = 'preset-item';
      const info = document.createElement('div');
      info.className = 'preset-info';
      const nm = document.createElement('span');
      nm.className = 'preset-name';
      nm.textContent = preset.name;
      const meta = document.createElement('span');
      meta.className = 'preset-meta';
      meta.textContent = `규칙 ${(preset.rules || []).length}개 · ` + shortDate(preset.savedAt);
      info.append(nm, meta);
      const acts = document.createElement('div');
      acts.className = 'preset-acts';
      const load = document.createElement('button');
      load.type = 'button';
      load.className = 'btn small ghost';
      load.textContent = '불러오기';
      load.addEventListener('click', () => applyPreset(preset.id));
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'link-btn danger';
      del.textContent = preset.confirmDelete ? '삭제 확정' : '삭제';
      del.addEventListener('click', () => deletePreset(preset.id));
      acts.append(load, del);
      li.append(info, acts);
      host.appendChild(li);
    }
  }

  function shortDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }

  /* ═════════════════════════ 내보내기 ═════════════════════════ */
  function itemSnapshot() {
    return state.items
      .filter((it) => it.enabled && it.original)
      .map((it) => ({
        id: it.id, kind: it.kind, original: it.original, masked: it.masked,
        matchMode: it.matchMode || 'word', enabled: true,
        occ: it.occ || null,
        exclude: it.exclude ? Array.from(it.exclude) : []
      }));
  }

  async function download() {
    if (!state.doc || state.busy) return;
    showBusy('마스킹한 문서를 만드는 중…', 0);
    try {
      const { buffer, fileName, size, stats } = await engineBuild(
        itemSnapshot(),
        { cleanTrace: state.cleanTrace, resetMetadata: state.resetMetadata },
        (phase, pct) => setBusyProgress(pct, phase)
      );
      const blob = new Blob([buffer], { type: 'application/vnd.hancom.hwpx' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      state.lastBuild = { size: size || blob.size, stats, fileName };
      const metaTxt = stats && stats.metadata && stats.metadata.changed
        ? ` · 메타데이터 ${stats.metadata.changed}항목 초기화` : '';
      toast(`저장했습니다 · ${fileName} (${fmtBytes(blob.size)})${metaTxt}`, 'ok', 5200);
    } catch (err) {
      toast('문서를 저장하는 중 문제가 생겼습니다. 다시 시도해 주세요.', 'err', 6000);
      if (window.console) console.warn(err);
    } finally {
      hideBusy();
    }
  }

  async function copyText() {
    if (!state.doc) return;
    const text = M.maskedText(state.doc);
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

  /* ═════════════════════════ 잔심부름 ═════════════════════════ */
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

  function showBusy(text, pct) {
    state.busy = true;
    $('#busyText').textContent = text || '처리 중…';
    $('#busy').hidden = false;
    setBusyProgress(pct || 0);
  }

  function setBusyProgress(pct, phase) {
    const p = Math.max(0, Math.min(100, Math.round(pct || 0)));
    $('#busyBar').style.width = p + '%';
    $('#busyPct').textContent = p + '%';
    const bar = $('.progress');
    if (bar) bar.setAttribute('aria-valuenow', String(p));
    if (phase && PHASE_TEXT[phase] && state.busy) $('#busyText').textContent = PHASE_TEXT[phase] + '…';
  }

  function hideBusy() {
    state.busy = false;
    $('#busy').hidden = true;
  }

  /* 테스트/검증용 (화면에는 영향 없음) */
  debug.setState = (patch) => Object.assign(state, patch);
  debug.openAffectPanel = openAffectPanel;
  debug.closeAffectPanel = closeAffectPanel;
  debug.refresh = refresh;
})();
