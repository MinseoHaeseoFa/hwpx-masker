/* ============================================================
   민감정보 안심마스커 · HWPX 마스킹 엔진
   ------------------------------------------------------------
   · 모든 처리는 브라우저 메모리에서만 이뤄집니다. 네트워크 요청 없음.
   · .hwpx(ZIP) 안의 Contents/section*.xml 에서 <hp:t> 텍스트만 바꾸고
     나머지 엔트리(mimetype·META-INF·BinData·스타일)는 그대로 다시 담습니다.
   · 하나의 단어가 여러 <hp:t> 로 쪼개진 경우(run split)도 문단 단위로
     이어 붙여 찾은 뒤, 걸친 구간만 정확히 치환합니다.
   ============================================================ */
(function (global) {
  'use strict';

  const HP = 'http://www.hancom.co.kr/hwpml/2011/paragraph';
  const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const BLANK_PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  /* ── 작은 도우미 ─────────────────────────────────── */
  const ln = (el) => el.localName || String(el.nodeName || '').split(':').pop();
  const isEl = (n) => n && n.nodeType === 1;

  function nearest(el, names) {
    let cur = el.parentNode;
    while (isEl(cur)) {
      if (names.indexOf(ln(cur)) !== -1) return cur;
      cur = cur.parentNode;
    }
    return null;
  }

  function cellOf(el) { return nearest(el, ['tc']); }

  function stars(n) { return '*'.repeat(n); }

  /* ── 탐지 카테고리 ──────────────────────────────── */
  const CATEGORIES = [
    { id: 'rrn',     name: '주민등록번호·외국인등록번호', sample: '700223-1******' },
    { id: 'phone',   name: '휴대전화·유선전화',           sample: '010-****-0543' },
    { id: 'email',   name: '이메일',                      sample: '***@kitech.re.kr' },
    { id: 'account', name: '계좌번호·카드번호',           sample: '123-***-******' },
    { id: 'bizno',   name: '사업자등록번호·법인등록번호', sample: '123-**-*****' },
    { id: 'vehicle', name: '차량번호',                    sample: '12가 ****' },
    { id: 'address', name: '상세 주소',                   sample: '충청남도 천안시 동남구 ***' },
    { id: 'birth',   name: '생년월일',                    sample: '생년월일 1970.**.**' }
  ];
  const CATEGORY_ORDER = CATEGORIES.map((c) => c.id);

  /* ── 마스킹 규칙 ────────────────────────────────── */
  const MASKS = {
    rrn(s) {
      let n = 0;
      return s.replace(/\d/g, (d) => (n++ < 7 ? d : '*'));
    },
    phone(s) {
      const total = (s.match(/\d/g) || []).length;
      const sep = s.search(/[^\d]/);
      const keepHead = sep === -1 ? 3 : sep;
      let i = 0;
      return s.replace(/\d/g, (d) => {
        const idx = i++;
        return idx < keepHead || idx >= total - 4 ? d : '*';
      });
    },
    email(s) {
      const at = s.indexOf('@');
      return at < 0 ? '***' : '***' + s.slice(at);
    },
    account(s) {
      const sep = s.search(/[^\d]/);
      const keepHead = sep === -1 ? 3 : sep;
      let i = 0;
      return s.replace(/\d/g, (d) => (i++ < keepHead ? d : '*'));
    },
    card(s) {
      let i = 0;
      return s.replace(/\d/g, (d) => (i++ < 4 ? d : '*'));
    },
    bizno(s) {
      const sep = s.search(/[^\d]/);
      const keepHead = sep === -1 ? 3 : sep;
      let i = 0;
      return s.replace(/\d/g, (d) => (i++ < keepHead ? d : '*'));
    },
    vehicle(s) {
      // 뒤쪽 4자리(일련번호)만 가린다
      return s.replace(/(\d{4})(?![\s\S]*\d)/, '****');
    },
    birth(s, m) {
      // m: year/month/day 조각 위치
      return s.slice(0, m.monthStart) + stars(m.monthLen) + s.slice(m.monthStart + m.monthLen, m.dayStart) +
        stars(m.dayLen) + s.slice(m.dayStart + m.dayLen);
    },
    amount(s) { return s.replace(/\d/g, '*'); },
    all(s) { return s.replace(/[^\s]/g, '*'); },
    center(s) {
      const chars = Array.from(s);
      return chars.map((c, i) => (i === 0 || /\s/.test(c) ? c : 'O')).join('');
    },
    tail(s) {
      const chars = Array.from(s);
      return chars.map((c, i) => (i === chars.length - 1 || /\s/.test(c) ? c : 'O')).join('');
    },
    org(s) {
      return s.replace(/[가-힣A-Za-z0-9]+/g, (tok) =>
        Array.from(tok).map((c, i) => (i === 0 ? c : 'O')).join(''));
    }
  };

  // 주소는 '시·군·구까지 남기고' 나머지를 가린다.
  function maskAddress(s) { return s.replace(/[^\s]/g, '*'); }

  /* ── 자동 탐지기 ────────────────────────────────── */
  const RRN_RE = /(?<!\d)\d{6}[-–—]?[1-8]\d{6}(?!\d)/g;
  const PHONE_MOBILE_RE = /(?<!\d)01[016789][-.\s]?\d{3,4}[-.\s]?\d{4}(?!\d)/g;
  const PHONE_LAND_RE = /(?<!\d)0\d{1,2}[-.\s]\d{3,4}[-.\s]\d{4}(?!\d)/g;
  const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
  const CARD_RE = /(?<!\d)\d{4}[-.\s]\d{4}[-.\s]\d{4}[-.\s]\d{4}(?!\d)/g;
  const BIZ_RE = /(?<!\d)\d{3}-\d{2}-\d{5}(?!\d)/g;
  const CORP_RE = /(?<!\d)\d{6}-\d{7}(?!\d)/g;
  const ACCOUNT_RE = /(?<!\d)\d{2,6}[-.\s]\d{2,6}[-.\s]\d{2,8}(?:[-.\s]\d{1,4})?(?!\d)/g;
  const CAR_RE = /(?<![\d가-힣])(\d{2,3}[가-힣])(\s?)(\d{4})(?!\d)/g;
  const DATE_RE = /^(19|20)\d{2}[.\-/]\d{1,2}[.\-/]\d{1,2}$/;

  function collect(re, text, fn) {
    const out = [];
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (!m[0]) { re.lastIndex += 1; continue; }
      const r = fn(m, text);
      if (r) out.push(Object.assign({ start: m.index }, r));
    }
    return out;
  }

  function looksLikeDate(s) { return DATE_RE.test(s.trim()); }

  function detectRrn(text) {
    return collect(RRN_RE, text, (m) => ({
      category: 'rrn', original: m[0], masked: MASKS.rrn(m[0])
    }));
  }

  function detectPhone(text) {
    const out = collect(PHONE_MOBILE_RE, text, (m) => ({
      category: 'phone', original: m[0], masked: MASKS.phone(m[0])
    }));
    for (const m of collect(PHONE_LAND_RE, text, (mm) => ({
      category: 'phone', original: mm[0], masked: MASKS.phone(mm[0])
    }))) {
      if (out.some((o) => m.start < o.start + o.original.length && m.start + m.original.length > o.start)) continue;
      out.push(m);
    }
    return out.sort((a, b) => a.start - b.start);
  }

  function detectEmail(text) {
    return collect(EMAIL_RE, text, (m) => ({ category: 'email', original: m[0], masked: MASKS.email(m[0]) }));
  }

  function detectCard(text) {
    return collect(CARD_RE, text, (m) => ({ category: 'account', original: m[0], masked: MASKS.card(m[0]) }));
  }

  function detectBizNo(text) {
    const out = collect(BIZ_RE, text, (m) => ({
      category: 'bizno', original: m[0], masked: MASKS.bizno(m[0])
    }));
    for (const m of collect(CORP_RE, text, (mm) => ({
      category: 'bizno', original: mm[0], masked: MASKS.bizno(mm[0])
    }))) {
      if (out.some((o) => m.start < o.start + o.original.length && m.start + m.original.length > o.start)) continue;
      out.push(m);
    }
    return out.sort((a, b) => a.start - b.start);
  }

  function detectAccount(text) {
    return collect(ACCOUNT_RE, text, (m) => {
      const raw = m[0];
      if (looksLikeDate(raw)) return null;               // 2026.01.01 같은 날짜 제외
      if ((raw.match(/\d/g) || []).length < 8) return null;
      return { category: 'account', original: raw, masked: MASKS.account(raw) };
    });
  }

  function detectVehicle(text) {
    return collect(CAR_RE, text, (m) => ({
      category: 'vehicle', original: m[0], masked: m[1] + m[2] + stars(m[3].length)
    }));
  }

  /* ── 주소 ───────────────────────────────────────── */
  const REGION_TOKEN = /^(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)[가-힣]*(?:특별시|광역시|특별자치시|특별자치도|도)$|^(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)[가-힣]*(?:도|시)$/;
  const SUBREGION_TOKEN = /^[가-힣]{1,8}(?:시|군|구)$/;
  const ROAD_TOKEN = /^[가-힣]{1,12}(?:로|길)$/;
  const ROAD_WITH_NUM = /^([가-힣]{1,12}(?:로|길))(\d+(?:-\d+)?)$/;
  const TAIL_TOKEN = /^\d+(?:-\d+)?[,]?$|^\d+(?:동|호|층|호수)$|^[가-힣]*\d*(?:동|호|층|호수|빌딩|빌라|아파트|타워|오피스텔|상가)$/;

  function tokenize(text) {
    const out = [];
    const re = /\S+/g;
    let m;
    while ((m = re.exec(text)) !== null) out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
    return out;
  }

  function detectAddress(text) {
    const toks = tokenize(text);
    const hits = [];
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      let roadStartTok = i;
      let hasNumAfter = false;
      if (ROAD_TOKEN.test(t.text)) {
        hasNumAfter = i + 1 < toks.length && /^\d/.test(toks[i + 1].text);
      } else if (ROAD_WITH_NUM.test(t.text)) {
        hasNumAfter = true;
      } else {
        continue;
      }
      if (!hasNumAfter) continue;

      // 앞쪽 시·군·구 / 시·도 접두부 찾기
      let p = i - 1;
      let prefixTok = null;
      while (p >= 0) {
        const pt = toks[p].text.replace(/[,]$/, '');
        if (SUBREGION_TOKEN.test(pt) || REGION_TOKEN.test(pt)) { prefixTok = p; p -= 1; } else break;
      }
      // 접두부가 전혀 없으면 주소로 보지 않는다(도로명만 있는 문장 오탐 방지)
      if (prefixTok === null) continue;

      const start = t.start;
      let end = t.end;
      let j = i + 1;
      while (j < toks.length && TAIL_TOKEN.test(toks[j].text)) { end = toks[j].end; j += 1; }
      const chunk = text.slice(start, end);
      if (!/\d/.test(chunk)) continue;
      if (hits.some((h) => start < h.end && end > h.start)) continue;
      hits.push({ category: 'address', original: chunk, masked: maskAddress(chunk), start, end });
    }
    return hits;
  }

  /* ── 생년월일 ───────────────────────────────────── */
  const BIRTH_LABEL_RE = /(생년월일|생일|생\s*[:：])/;
  const DATE_IN_TEXT_RE = /(?<!\d)((?:19|20)\d{2})(\s*[.\-/년]\s*)(\d{1,2})(\s*[.\-/월]\s*)(\d{1,2})일?/g;

  function addBirthFrom(text, from, to, out) {
    DATE_IN_TEXT_RE.lastIndex = 0;
    let m;
    while ((m = DATE_IN_TEXT_RE.exec(text)) !== null) {
      if (m.index < from || m.index + m[0].length > to) continue;
      out.push({
        category: 'birth', original: m[0], start: m.index,
        masked: MASKS.birth(m[0], {
          monthStart: m[1].length + m[2].length,
          monthLen: m[3].length,
          dayStart: m[1].length + m[2].length + m[3].length + m[4].length,
          dayLen: m[5].length
        })
      });
    }
    return out;
  }

  function detectBirth(text, contextLabel) {
    const out = [];
    const label = BIRTH_LABEL_RE.exec(text);
    if (label) {
      addBirthFrom(text, label.index + label[0].length, label.index + label[0].length + 20, out);
    }
    if (!out.length && contextLabel && /생년월일|생일/.test(contextLabel)) {
      addBirthFrom(text, 0, text.length, out);
    }
    return out;
  }

  const DETECTORS = {
    address: (t) => detectAddress(t),
    phone: (t) => detectPhone(t),
    rrn: (t) => detectRrn(t),
    email: (t) => detectEmail(t),
    card: (t) => detectCard(t),
    bizno: (t) => detectBizNo(t),
    account: (t) => detectAccount(t),
    vehicle: (t) => detectVehicle(t),
    birth: (t, ctx) => detectBirth(t, ctx)
  };
  // 겹칠 때의 우선순위(앞에 있을수록 문서 구조를 더 잘 아는 규칙)
  const DETECT_ORDER = ['address', 'phone', 'rrn', 'email', 'card', 'bizno', 'account', 'vehicle', 'birth'];

  /* ── 표 라벨 후보 ───────────────────────────────── */
  const LABEL_KINDS = {
    성명: 'name', 대상자: 'name', 피감사인: 'name', 이름: 'name', 성함: 'name',
    부서: 'dept', 소속: 'dept', 담당부서: 'dept', 소속부서: 'dept',
    기관명: 'org', 업체명: 'org', 회사명: 'org', 기관: 'org', 업체: 'org',
    생년월일: 'birth', 생일: 'birth'
  };
  const normalizeLabel = (s) => String(s || '').replace(/\s+/g, '').replace(/[:：]$/, '');

  function maskForKind(value, kind) {
    if (kind === 'name') return MASKS.center(value);
    if (kind === 'dept') return MASKS.tail(value);
    if (kind === 'org') return MASKS.org(value);
    return MASKS.all(value);
  }

  /* ── HWPX 열기 ──────────────────────────────────── */
  async function open(buffer, fileName) {
    if (typeof JSZip === 'undefined') {
      const e = new Error('JSZip 없음');
      e.code = 'NO_JSZIP';
      throw e;
    }
    const bytes = new Uint8Array(buffer);
    // 구형 .hwp(OLE/CFB) 는 ZIP 이 아니다.
    if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
      const e = new Error('HWP');
      e.code = 'HWP';
      throw e;
    }
    if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) {
      const e = new Error('ZIP');
      e.code = 'NOT_ZIP';
      throw e;
    }
    let zip;
    try {
      zip = await JSZip.loadAsync(bytes);
    } catch (err) {
      const e = new Error('ZIP');
      e.code = 'NOT_ZIP';
      throw e;
    }

    const order = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
    const files = {};
    for (const n of order) files[n] = await zip.file(n).async('uint8array');

    const mimeBytes = files['mimetype'];
    const mimeText = mimeBytes ? new TextDecoder('utf-8').decode(mimeBytes).trim() : '';
    if (!/hwp\+zip/i.test(mimeText)) {
      const e = new Error('HWPX 미확인');
      e.code = 'NOT_HWPX';
      throw e;
    }

    const sectionNames = order.filter((n) => /^Contents\/section\d+\.xml$/i.test(n)).sort();
    if (!sectionNames.length) {
      const e = new Error('섹션 없음');
      e.code = 'NO_SECTION';
      throw e;
    }

    const parser = new DOMParser();
    const sections = sectionNames.map((name) => {
      const xml = new TextDecoder('utf-8').decode(files[name]);
      const doc = parser.parseFromString(xml, 'application/xml');
      if (doc.getElementsByTagName('parsererror').length) {
        const e = new Error('XML 오류: ' + name);
        e.code = 'BAD_XML';
        throw e;
      }
      return { name, xml, doc };
    });

    const document = {
      fileName: fileName || 'document.hwpx',
      fileSize: bytes.length,
      files, order, sections,
      paras: [], blocks: [], itemMap: new Map()
    };
    buildParas(document);
    buildBlocks(document);
    annotateLabels(document);
    return document;
  }

  function collectParasOf(docOrRoot, si) {
    const out = [];
    const ps = docOrRoot.getElementsByTagNameNS(HP, 'p');
    for (const p of Array.from(ps)) {
      const ts = Array.from(p.getElementsByTagNameNS(HP, 't'))
        .filter((t) => nearest(t, ['p']) === p);
      const nodes = [];
      let pos = 0;
      for (const t of ts) {
        const len = (t.textContent || '').length;
        nodes.push({ t, start: pos, len });
        pos += len;
      }
      out.push({
        section: si, el: p, nodes,
        text: nodes.map((n) => n.t.textContent || '').join(''),
        ranges: [], contextLabel: ''
      });
    }
    return out;
  }

  function buildParas(document) {
    let id = 0;
    document.sections.forEach((sec, si) => {
      const list = collectParasOf(sec.doc, si);
      for (const para of list) {
        para.id = id++;
        document.paras.push(para);
        document.itemMap.set(para.el, para);
      }
      sec.paras = list;
    });
  }

  function buildBlocks(document) {
    document.sections.forEach((sec) => {
      const blocks = [];
      const root = sec.doc.documentElement;
      for (const child of Array.from(root.children)) {
        if (ln(child) !== 'p') continue;
        const para = document.itemMap.get(child);
        const tables = Array.from(child.getElementsByTagNameNS(HP, 'tbl'))
          .filter((t) => nearest(t, ['p']) === child);
        if (tables.length) {
          for (const tbl of tables) blocks.push({ type: 'table', rows: tableRows(tbl, document) });
        } else if (para) {
          blocks.push({ type: 'p', para });
        }
      }
      sec.blocks = blocks;
      document.blocks.push(...blocks);
    });
  }

  function tableRows(tbl, document) {
    const rows = [];
    const trs = Array.from(tbl.getElementsByTagNameNS(HP, 'tr'))
      .filter((tr) => nearest(tr, ['tbl']) === tbl);
    for (const tr of trs) {
      const cells = [];
      const tcs = Array.from(tr.getElementsByTagNameNS(HP, 'tc'))
        .filter((tc) => nearest(tc, ['tc']) === null && nearest(tc, ['tr']) === tr);
      for (const tc of tcs) {
        const spanEl = tc.getElementsByTagNameNS(HP, 'cellSpan')[0];
        const colSpan = spanEl ? Math.max(1, parseInt(spanEl.getAttribute('colSpan') || '1', 10) || 1) : 1;
        const rowSpan = spanEl ? Math.max(1, parseInt(spanEl.getAttribute('rowSpan') || '1', 10) || 1) : 1;
        const paras = Array.from(tc.getElementsByTagNameNS(HP, 'p'))
          .filter((p) => nearest(p, ['tc']) === tc)
          .map((p) => document.itemMap.get(p))
          .filter(Boolean);
        cells.push({ colSpan, rowSpan, paras, text: paras.map((p) => p.text).join(' ').trim() });
      }
      rows.push(cells);
    }
    return rows;
  }

  /** 표 라벨 옆 값 → 문단에 contextLabel 을 달고, 후보 목록을 만든다. */
  function annotateLabels(document) {
    const candidates = [];
    const seen = new Set();
    for (const sec of document.sections) {
      for (const block of sec.blocks) {
        if (block.type !== 'table') continue;
        for (const row of block.rows) {
          for (let i = 0; i < row.length - 1; i++) {
            const kind = LABEL_KINDS[normalizeLabel(row[i].text)];
            if (!kind) continue;
            const valueCell = row[i + 1];
            const value = valueCell.text.replace(/\s+/g, ' ').trim();
            if (!value) continue;
            valueCell.paras.forEach((p) => { if (!p.contextLabel) p.contextLabel = normalizeLabel(row[i].text); });
            if (kind === 'birth') continue;  // 생년월일은 자동 탐지가 처리
            if (value.length > 40) continue;
            const key = kind + '|' + value;
            if (seen.has(key)) continue;
            seen.add(key);
            candidates.push({
              kind: 'label', category: kind, label: normalizeLabel(row[i].text),
              original: value, masked: maskForKind(value, kind)
            });
          }
        }
      }
    }
    // 본문 안의 "부서: 값" 형태
    const INLINE_LABEL_RE = /(성명|대상자|피감사인|부서|소속|담당부서|소속부서|기관명|업체명|회사명)\s*[:：]\s*([^\s,，、;；()]{1,30}(?:\s*(?:주식회사|㈜|유한회사|유한책임회사))?)/g;
    for (const para of document.paras) {
      INLINE_LABEL_RE.lastIndex = 0;
      let m;
      while ((m = INLINE_LABEL_RE.exec(para.text)) !== null) {
        const kind = LABEL_KINDS[normalizeLabel(m[1])];
        if (!kind) continue;
        const value = m[2].trim();
        if (!value || value.length > 30) continue;
        const key = kind + '|' + value;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({
          kind: 'label', category: kind, label: normalizeLabel(m[1]),
          original: value, masked: maskForKind(value, kind)
        });
      }
    }
    document.labelCandidates = candidates;
  }

  /* ── 탐지 실행 ──────────────────────────────────── */
  function detect(document, enabled) {
    const found = [];
    for (const per of DETECT_ORDER) {
      // 카드번호와 계좌번호는 같은 체크박스(account)를 쓴다
      if (per === 'card' ? !enabled.account : !enabled[per]) continue;
      for (const para of document.paras) {
        if (!para.text) continue;
        const hits = DETECTORS[per](para.text, para.contextLabel);
        for (const h of hits) found.push({ paraId: para.id, start: h.start, original: h.original, masked: h.masked, category: h.category });
      }
    }
    // 겹침 정리: 카테고리 우선순위 → 시작 위치 순
    found.sort((a, b) => {
      const pa = DETECT_ORDER.indexOf(a.category === 'card' ? 'card' : a.category);
      const pb = DETECT_ORDER.indexOf(b.category === 'card' ? 'card' : b.category);
      return (pa - pb) || (a.start - b.start);
    });
    const taken = new Map();
    const accepted = [];
    for (const h of found) {
      const list = taken.get(h.paraId) || [];
      if (list.some((r) => h.start < r.end && h.start + h.original.length > r.start)) continue;
      list.push({ start: h.start, end: h.start + h.original.length });
      taken.set(h.paraId, list);
      accepted.push(h);
    }
    return accepted;
  }

  /* ── 항목 만들기 ────────────────────────────────── */
  let itemSeq = 1;
  function newItemId() { return 'it' + (itemSeq++); }

  function itemFromMatch(m, enabled = true) {
    return {
      id: newItemId(), kind: 'auto', category: m.category,
      original: m.original, masked: m.masked, enabled, hits: 0
    };
  }

  function customMask(original, style) {
    switch (style) {
      case 'amount': return MASKS.amount(original);
      case 'center': return MASKS.center(original);
      case 'tail': return MASKS.tail(original);
      case 'all': return MASKS.all(original);
      case 'auto':
      default: {
        if (/^[\d,]*\d\s*원$/.test(original)) return MASKS.amount(original);
        if (/^[\d][\d\-\s]*$/.test(original)) return MASKS.account(original);
        if (/^[가-힣]{2,5}$/.test(original)) return MASKS.center(original);
        if (/^[가-힣A-Za-z0-9]{2,}$/.test(original) && /\d/.test(original)) return MASKS.all(original);
        return MASKS.all(original);
      }
    }
  }

  /* ── 계획 수립(치환 위치 계산) ─────────────────── */
  function plan(document, items) {
    const active = items.filter((it) => it.enabled && it.original);
    // 구체 항목(맞춤/라벨)을 먼저, 그 다음 자동. 같은 순위면 긴 문자열 먼저.
    active.sort((a, b) => {
      const ka = a.kind === 'auto' ? 1 : 0;
      const kb = b.kind === 'auto' ? 1 : 0;
      if (ka !== kb) return ka - kb;
      return b.original.length - a.original.length;
    });

    for (const para of document.paras) para.ranges = [];
    const counts = new Map(items.map((it) => [it.id, 0]));

    for (const it of active) {
      for (const para of document.paras) {
        const text = para.text;
        if (!text) continue;
        let from = 0;
        let idx;
        while ((idx = text.indexOf(it.original, from)) !== -1) {
          const start = idx;
          const end = idx + it.original.length;
          from = end;
          if (para.ranges.some((r) => start < r.end && end > r.start)) continue;
          para.ranges.push({ start, end, text: it.masked, itemId: it.id, original: it.original });
          counts.set(it.id, (counts.get(it.id) || 0) + 1);
        }
      }
    }
    for (const para of document.paras) para.ranges.sort((a, b) => a.start - b.start);
    for (const it of items) it.hits = counts.get(it.id) || 0;
    return items;
  }

  /* ── XML 치환 ───────────────────────────────────── */
  function textNodesOf(tEl) {
    const items = [];
    let pos = 0;
    for (const ch of Array.from(tEl.childNodes)) {
      if (ch.nodeType === 3) {
        const len = ch.nodeValue.length;
        items.push({ node: ch, start: pos, len, isText: true });
        pos += len;
      } else if (ch.nodeType === 1) {
        const len = (ch.textContent || '').length;
        items.push({ node: ch, start: pos, len, isText: false });
        pos += len;
      }
    }
    return items;
  }

  function replaceInT(tEl, s, e, repl) {
    const items = textNodesOf(tEl);
    const hits = items.filter((it) => Math.max(s, it.start) < Math.min(e, it.start + it.len) ||
      (it.len === 0 && it.start > s && it.start < e));
    if (!hits.length) return;
    const first = hits[0];
    if (!first.isText) {
      const tn = tEl.ownerDocument.createTextNode(repl);
      tEl.insertBefore(tn, first.node);
    }
    for (let i = hits.length - 1; i >= 0; i--) {
      const it = hits[i];
      const a = Math.max(s, it.start);
      const b = Math.min(e, it.start + it.len);
      if (it.isText) {
        const v = it.node.nodeValue;
        const ls = a - it.start;
        const le = b - it.start;
        const rep = it === first ? repl : '';
        it.node.nodeValue = v.slice(0, ls) + rep + v.slice(le);
      } else if (it.start >= s && it.start + it.len <= e) {
        it.node.parentNode.removeChild(it.node);
      }
    }
  }

  function applyPara(para) {
    // 뒤에서부터 바꿔야 앞쪽 좌표가 흔들리지 않는다.
    for (let i = para.ranges.length - 1; i >= 0; i--) {
      const r = para.ranges[i];
      for (const n of para.nodes) {
        const a = Math.max(r.start, n.start);
        const b = Math.min(r.end, n.start + n.len);
        if (a >= b) continue;
        replaceInT(n.t, a - n.start, b - n.start, a === r.start ? r.text : '');
      }
    }
  }

  function serializeSection(sec) {
    let out = new XMLSerializer().serializeToString(sec.doc);
    out = out.replace(/^<\?xml[^>]*\?>\s*/, '');
    return XML_DECL + out;
  }

  /* ── 마스킹된 텍스트 만들기 ─────────────────────── */
  function maskedParaText(para) {
    if (!para.ranges.length) return para.text;
    let out = '';
    let pos = 0;
    for (const r of para.ranges) {
      out += para.text.slice(pos, r.start) + r.text;
      pos = r.end;
    }
    return out + para.text.slice(pos);
  }

  function maskedLines(document) {
    const lines = [];
    for (const sec of document.sections) {
      for (const block of sec.blocks) {
        if (block.type === 'p') {
          lines.push(maskedParaText(block.para));
        } else {
          for (const row of block.rows) {
            const cells = row.map((c) => c.paras.map(maskedParaText).join(' ').trim());
            lines.push(cells.join(' | '));
          }
          lines.push('');
        }
      }
    }
    return lines;
  }

  function maskedText(document) {
    return maskedLines(document).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  /* ── 저장 ───────────────────────────────────────── */
  function blankPngBytes() {
    const bin = atob(BLANK_PNG_B64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function buildMaskedHwpx(document, opts = {}) {
    // 원본 바이트에서 매번 새로 파싱 → 여러 번 내려받아도 안전하다.
    const parser = new DOMParser();
    const updated = {};
    document.sections.forEach((sec) => {
      const fresh = parser.parseFromString(sec.xml, 'application/xml');
      const freshParas = collectParasOf(fresh, sec.paras ? sec.paras[0]?.section ?? 0 : 0);
      const src = sec.paras || [];
      freshParas.forEach((p, i) => {
        if (src[i]) p.ranges = src[i].ranges;
      });
      for (const p of freshParas) if (p.ranges && p.ranges.length) applyPara(p);
      const out = new XMLSerializer().serializeToString(fresh)
        .replace(/^<\?xml[^>]*\?>\s*/, '');
      updated[sec.name] = new TextEncoder().encode(XML_DECL + out);
    });
    if (opts.cleanTrace !== false) {
      if (document.files['Preview/PrvText.txt']) {
        updated['Preview/PrvText.txt'] = new TextEncoder().encode(maskedLines(document).join('\n'));
      }
      if (document.files['Preview/PrvImage.png']) {
        updated['Preview/PrvImage.png'] = blankPngBytes();
      }
    }

    const zip = new JSZip();
    const order = document.order.slice();
    // mimetype 은 반드시 첫 엔트리 + 무압축(OCF 규격)
    const mimeFirst = order.indexOf('mimetype');
    if (mimeFirst > 0) {
      order.splice(mimeFirst, 1);
      order.unshift('mimetype');
    }
    for (const name of order) {
      const data = updated[name] || document.files[name];
      if (!data) continue;
      zip.file(name, data, {
        compression: name === 'mimetype' ? 'STORE' : 'DEFLATE',
        createFolders: false
      });
    }
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    const base = document.fileName.replace(/\.hwpx$/i, '');
    return { blob, fileName: base + '_masked.hwpx' };
  }

  /** 한 문자열에 대해 탐지 규칙만 돌려 보는 진단용 함수(테스트·디버깅). */
  function scanText(text, enabled) {
    const en = enabled || {};
    const on = (k) => (k === 'card' ? en.account !== false : en[k] !== false);
    const found = [];
    for (const per of DETECT_ORDER) {
      if (!on(per)) continue;
      for (const h of DETECTORS[per](text, '')) found.push(h);
    }
    found.sort((a, b) => (DETECT_ORDER.indexOf(a.category) - DETECT_ORDER.indexOf(b.category)) || (a.start - b.start));
    const taken = [];
    const out = [];
    for (const h of found) {
      const end = h.start + h.original.length;
      if (taken.some((r) => h.start < r.end && end > r.start)) continue;
      taken.push({ start: h.start, end });
      out.push(h);
    }
    return out;
  }

  global.Masker = {
    CATEGORIES, DETECT_ORDER, MASKS, customMask, newItemId, scanText,
    open, detect, plan, serializeSection,
    maskedText, maskedLines, maskedParaText, buildMaskedHwpx,
    itemFromMatch, maskForKind
  };
})(window);
