/* ============================================================
   민감정보 안심마스커 · HWPX 마스킹 엔진 v2
   ------------------------------------------------------------
   · 이 파일은 메인 스레드와 Web Worker 양쪽에서 그대로 실행됩니다.
     (DOM API 를 쓰지 않고, XML 은 문자열 단위로만 다룹니다.)
   · .hwpx(ZIP) 안에서 바꾸는 것은 <hp:t> 안의 글자뿐입니다.
     나머지 바이트(mimetype·META-INF·스타일·표 태그)는 원본 그대로 둡니다.
   · 하나의 단어가 여러 <hp:t> 로 쪼개진 경우(run split)도 문단 단위로
     이어 붙여 찾은 뒤, 걸친 구간만 정확히 치환합니다.
   ============================================================ */
(function (root) {
  'use strict';

  const BLANK_PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  /* ── 탐지 카테고리 ───────────────────────────────── */
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

  const REGION_LABEL = {
    header: '머리말', footer: '꼬리말', footnote: '각주',
    endnote: '미주', textbox: '글상자', caption: '캡션'
  };

  /* ── 가리는 방식 ─────────────────────────────────── */
  const stars = (n) => '*'.repeat(n);

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
      return s.replace(/(\d{4})(?![\s\S]*\d)/, '****');
    },
    birth(s, m) {
      return s.slice(0, m.monthStart) + stars(m.monthLen) +
        s.slice(m.monthStart + m.monthLen, m.dayStart) +
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

  const maskAddress = (s) => s.replace(/[^\s]/g, '*');

  /* ── 정규식 ─────────────────────────────────────── */
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
      const r = fn ? fn(m, text) : { original: m[0] };
      if (r) out.push(Object.assign({ start: m.index }, r));
    }
    return out;
  }

  /* ── 도형 판별(겹침 방지용) ─────────────────────── */
  const looksLikeDate = (s) => DATE_RE.test(s.trim());
  const looksLikePhone = (s) => /^0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}$/.test(s);
  const looksLikeRrn = (s) => /^\d{6}[-–—]?[1-8]\d{6}$/.test(s);
  const looksLikeBiz = (s) => /^\d{3}-\d{2}-\d{5}$/.test(s) || /^\d{6}-\d{7}$/.test(s);
  const looksLikeCard = (s) => /^\d{4}[-.\s]\d{4}[-.\s]\d{4}[-.\s]\d{4}$/.test(s);
  const digitsOf = (s) => (s.match(/\d/g) || []).length;

  /* ── 개별 탐지기 ─────────────────────────────────── */
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

  function detectAccount(text) {
    return collect(ACCOUNT_RE, text, (m) => {
      const raw = m[0];
      if (looksLikeDate(raw)) return null;          // 2026.01.01
      if (looksLikePhone(raw)) return null;         // 010-8990-0543 → 전화 규칙의 몫
      if (looksLikeRrn(raw)) return null;           // 700223-1234567 → 주민번호 규칙의 몫
      if (looksLikeBiz(raw)) return null;           // 123-45-67890 → 사업자/법인 규칙의 몫
      if (looksLikeCard(raw)) return null;          // 카드 규칙(같은 카테고리)이 먼저 잡는다
      if (digitsOf(raw) < 8) return null;
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
      let hasNumAfter = false;
      if (ROAD_TOKEN.test(t.text)) {
        hasNumAfter = i + 1 < toks.length && /^\d/.test(toks[i + 1].text);
      } else if (ROAD_WITH_NUM.test(t.text)) {
        hasNumAfter = true;
      } else {
        continue;
      }
      if (!hasNumAfter) continue;
      let p = i - 1;
      let prefixTok = null;
      while (p >= 0) {
        const pt = toks[p].text.replace(/[,]$/, '');
        if (SUBREGION_TOKEN.test(pt) || REGION_TOKEN.test(pt)) { prefixTok = p; p -= 1; } else break;
      }
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

  /* ── 생년월일 ────────────────────────────────────── */
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
    if (label) addBirthFrom(text, label.index + label[0].length, label.index + label[0].length + 20, out);
    if (!out.length && contextLabel && /생년월일|생일/.test(contextLabel)) addBirthFrom(text, 0, text.length, out);
    return out;
  }

  /* ── 문단 하나 탐지(겹침 우선순위 정리 포함) ────── */
  const PRIO = {
    address: 95, phone: 90, rrn: 85, email: 80, card: 75,
    bizno: 70, vehicle: 60, account: 40, birth: 30
  };

  function nearText(text, start, contextLabel) {
    return text.slice(Math.max(0, start - 18), start) + '|' + (contextLabel || '');
  }

  function detectPara(text, enabled, contextLabel) {
    if (!text) return [];
    const en = enabled || {};
    const on = (k) => en[k] !== false;
    const cands = [];
    const push = (category, start, original, masked, prio) => {
      if (original) cands.push({ category, start, original, masked, prio: prio || PRIO[category] || 0 });
    };

    if (on('address')) for (const h of detectAddress(text)) push('address', h.start, h.original, h.masked);
    if (on('phone')) for (const h of detectPhone(text)) push('phone', h.start, h.original, h.masked);
    if (on('email')) for (const h of detectEmail(text)) push('email', h.start, h.original, h.masked);
    if (on('account')) for (const h of detectCard(text)) push('account', h.start, h.original, h.masked, 75);
    if (on('account')) for (const h of detectAccount(text)) push('account', h.start, h.original, h.masked);
    if (on('vehicle')) for (const h of detectVehicle(text)) push('vehicle', h.start, h.original, h.masked);
    if (on('birth')) for (const h of detectBirth(text, contextLabel)) push('birth', h.start, h.original, h.masked);

    // 주민등록번호(6-7) ↔ 법인등록번호(6-7) 는 문맥(표 라벨·앞 단어)으로 갈라낸다.
    if (on('rrn') || on('bizno')) {
      for (const m of collect(RRN_RE, text)) {
        const corp = /법인/.test(nearText(text, m.start, contextLabel));
        if (corp) { if (on('bizno')) push('bizno', m.start, m.original, MASKS.bizno(m.original)); }
        else if (on('rrn')) push('rrn', m.start, m.original, MASKS.rrn(m.original));
      }
      for (const m of collect(CORP_RE, text)) {
        if (on('rrn') && /^[1-8]$/.test(m.original.slice(7, 8)) && !/법인/.test(nearText(text, m.start, contextLabel))) continue; // RRN 규칙이 처리
        if (!on('bizno')) continue;
        push('bizno', m.start, m.original, MASKS.bizno(m.original));
      }
    }
    if (on('bizno')) for (const m of collect(BIZ_RE, text)) push('bizno', m.start, m.original, MASKS.bizno(m.original));

    // 우선순위 → 시작 위치 → 긴 문자열 순으로 받아들이고, 겹치는 후보는 버린다.
    cands.sort((a, b) => (b.prio - a.prio) || (a.start - b.start) ||
      (b.original.length - a.original.length));
    const taken = [];
    const out = [];
    for (const c of cands) {
      const end = c.start + c.original.length;
      if (taken.some((r) => c.start < r.end && end > r.start)) continue;
      taken.push({ start: c.start, end });
      out.push({ category: c.category, start: c.start, original: c.original, masked: c.masked });
    }
    return out.sort((a, b) => a.start - b.start);
  }

  /* ── 표 라벨 후보 ───────────────────────────────── */
  const LABEL_KINDS = {
    성명: 'name', 대상자: 'name', 피감사인: 'name', 이름: 'name', 성함: 'name',
    부서: 'dept', 소속: 'dept', 담당부서: 'dept', 소속부서: 'dept',
    기관명: 'org', 업체명: 'org', 회사명: 'org', 기관: 'org', 업체: 'org',
    생년월일: 'birth', 생일: 'birth'
  };
  const normalizeLabel = (s) => String(s || '').replace(/\s+/g, '').replace(/[:：]$/, '');
  /* 표 라벨은 아니지만 "값의 성격"을 알려 주는 머리글 — 분류(주민번호↔법인번호)에만 쓴다. */
  const CONTEXT_LABELS = [
    '주민등록번호', '외국인등록번호', '법인등록번호', '사업자등록번호',
    '휴대전화', '전화번호', '유선전화', '연락처', '이메일', '입금계좌', '계좌번호',
    '카드번호', '차량번호', '주소', '생년월일', '생일'
  ];

  function maskForKind(value, kind) {
    if (kind === 'name') return MASKS.center(value);
    if (kind === 'dept') return MASKS.tail(value);
    if (kind === 'org') return MASKS.org(value);
    return MASKS.all(value);
  }

  /* ── 문자열 도우미 ──────────────────────────────── */
  const escXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const wordChar = (ch) => !!ch && /[0-9A-Za-z가-힣ㄱ-ㅎㅏ-ㅣ]/.test(ch);

  function occurrencesInText(text, word, mode) {
    const out = [];
    if (!text || !word) return out;
    let from = 0;
    let idx;
    while ((idx = text.indexOf(word, from)) !== -1) {
      from = idx + word.length;
      if (mode === 'word') {
        if (wordChar(text[idx - 1]) || wordChar(text[idx + word.length])) continue;
      }
      out.push(idx);
    }
    return out;
  }

  /* ── XML 텍스트 디코딩(치환 좌표 계산용) ────────── */
  const ENTITY_RE = /&(#[0-9]+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g;
  const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

  function decodeSegments(raw) {
    if (raw.indexOf('&') === -1) return { text: raw, segs: null };
    let text = '';
    const segs = [];
    let last = 0;
    ENTITY_RE.lastIndex = 0;
    let m;
    while ((m = ENTITY_RE.exec(raw)) !== null) {
      if (m.index > last) text += raw.slice(last, m.index);
      const d0 = text.length;
      const ent = m[1];
      let ch;
      if (ent[0] === '#') {
        const cp = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
        ch = Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : raw.slice(m.index, m.index + m[0].length);
      } else if (NAMED[ent] !== undefined) {
        ch = NAMED[ent];
      } else {
        ch = raw.slice(m.index, m.index + m[0].length);
        text += ch;
        last = m.index + m[0].length;
        continue;
      }
      text += ch;
      segs.push({ d0, d1: text.length, r0: m.index, r1: m.index + m[0].length });
      last = m.index + m[0].length;
    }
    if (last < raw.length) text += raw.slice(last);
    return { text, segs };
  }

  function runRawPos(run, dpos) {
    if (!run.segs) return run.rawStart + dpos;
    let delta = 0;
    for (const s of run.segs) {
      if (dpos <= s.d0) break;
      if (dpos < s.d1) return run.rawStart + s.r0;
      delta += (s.r1 - s.r0) - (s.d1 - s.d0);
    }
    return run.rawStart + dpos + delta;
  }

  function runRawEnd(run, dpos) {
    if (!run.segs) return run.rawStart + dpos;
    for (const s of run.segs) {
      if (dpos > s.d0 && dpos < s.d1) return run.rawStart + s.r1;
    }
    return runRawPos(run, dpos);
  }

  /* ── HWPX 파서(문자열 단위) ─────────────────────── */
  function findTagEnd(xml, lt) {
    let quote = 0;
    for (let i = lt + 1; i < xml.length; i += 1) {
      const c = xml.charCodeAt(i);
      if (quote) {
        if (c === quote) quote = 0;
      } else if (c === 34) quote = 34;
      else if (c === 39) quote = 39;
      else if (c === 62) return i;      // '>'
    }
    return -1;
  }

  function parseSection(xml, sectionIndex, state) {
    const paras = state.paras;
    const paraStack = [];
    const tblStack = [];
    const trStack = [];
    const tcStack = [];
    const regionStack = [];
    const blocks = [];
    const extras = [];
    const attrOf = (body, name) => {
      const m = new RegExp('\\b' + name + '="([^"]*)"').exec(body);
      return m ? m[1] : null;
    };

    let i = 0;
    while (i < xml.length) {
      const lt = xml.indexOf('<', i);
      if (lt < 0) break;
      if (xml.startsWith('<!--', lt)) { const e = xml.indexOf('-->', lt + 4); i = e < 0 ? xml.length : e + 3; continue; }
      if (xml.startsWith('<![CDATA[', lt)) { const e = xml.indexOf(']]>', lt + 9); i = e < 0 ? xml.length : e + 3; continue; }
      if (xml.startsWith('<?', lt)) { const e = xml.indexOf('?>', lt + 2); i = e < 0 ? xml.length : e + 2; continue; }
      if (xml.startsWith('<!', lt)) { const e = xml.indexOf('>', lt + 2); i = e < 0 ? xml.length : e + 1; continue; }
      const gt = findTagEnd(xml, lt);
      if (gt < 0) break;
      const rawTag = xml.slice(lt + 1, gt);
      const closing = rawTag.charAt(0) === '/';
      let body = closing ? rawTag.slice(1) : rawTag;
      const selfClose = /\/\s*$/.test(body);
      if (selfClose) body = body.replace(/\/\s*$/, '');
      const nm = /^([A-Za-z_][\w.:-]*)/.exec(body);
      if (!nm) { i = gt + 1; continue; }
      const tagName = nm[1];
      const local = tagName.split(':').pop().toLowerCase();

      if (!closing && !selfClose && local === 't') {
        const closeTag = '</' + tagName + '>';
        let ce = xml.indexOf(closeTag, gt + 1);
        if (ce < 0) ce = xml.indexOf('</' + 't>', gt + 1);
        if (ce < 0) { i = gt + 1; continue; }
        const rawInner = xml.slice(gt + 1, ce);
        const para = paraStack[paraStack.length - 1];
        if (para && rawInner) {
          const { text, segs } = decodeSegments(rawInner);
          if (text) {
            para.runs.push({
              start: para.text.length, len: text.length,
              rawStart: gt + 1, rawEnd: ce, segs
            });
            para.text += text;
          }
        }
        i = ce + closeTag.length;
        continue;
      }

      if (closing) {
        if (local === 'p') {
          const para = paraStack.pop();
          if (para && para.topLevel) {
            if (para.text.trim()) blocks.push({ type: 'p', paraId: para.id });
            for (const t of para.tables) blocks.push({ type: 'table', tbl: t });
          }
        } else if (local === 'tbl') tblStack.pop();
        else if (local === 'tr') trStack.pop();
        else if (local === 'tc') tcStack.pop();
        else if (local === 'header' || local === 'footer' || local === 'footnote' ||
                 local === 'endnote' || local === 'drawtext' || local === 'caption') {
          const reg = regionStack.pop();
          if (reg && reg.paraIds.length) extras.push(reg);
        }
        i = gt + 1;
        continue;
      }

      switch (local) {
        case 'p': {
          const region = regionStack[regionStack.length - 1];
          const para = {
            id: state.nextId++, text: '', runs: [], tables: [],
            topLevel: paraStack.length === 0,
            region: region ? region.kind : null,
            section: sectionIndex,
            contextLabel: ''
          };
          paras.push(para);
          if (region) region.paraIds.push(para.id);
          if (tcStack.length) tcStack[tcStack.length - 1].paraIds.push(para.id);
          paraStack.push(para);
          break;
        }
        case 'tbl': {
          const owner = paraStack[paraStack.length - 1];
          const tbl = { rows: [] };
          if (owner) owner.tables.push(tbl);
          tblStack.push(tbl);
          break;
        }
        case 'tr': {
          const tr = { cells: [] };
          if (tblStack.length) tblStack[tblStack.length - 1].rows.push(tr);
          trStack.push(tr);
          break;
        }
        case 'tc': {
          const tc = { colSpan: 1, rowSpan: 1, paraIds: [] };
          if (trStack.length) trStack[trStack.length - 1].cells.push(tc);
          tcStack.push(tc);
          break;
        }
        case 'cellspan': {
          const tc = tcStack[tcStack.length - 1];
          if (tc) {
            tc.colSpan = Math.max(1, parseInt(attrOf(body, 'colSpan') || '1', 10) || 1);
            tc.rowSpan = Math.max(1, parseInt(attrOf(body, 'rowSpan') || '1', 10) || 1);
          }
          break;
        }
        case 'header': case 'footer': case 'footnote': case 'endnote': case 'drawtext': case 'caption': {
          const kind = local === 'drawtext' ? 'textbox' : local;
          regionStack.push({ kind, label: REGION_LABEL[kind] || kind, paraIds: [] });
          break;
        }
        default: break;
      }
      i = gt + 1;
    }
    return { blocks, extras };
  }

  /* ── 라벨 후보 계산 ─────────────────────────────── */
  const INLINE_LABEL_RE = /(성명|대상자|피감사인|부서|소속|담당부서|소속부서|기관명|업체명|회사명|법인등록번호|사업자등록번호|주민등록번호|휴대전화|전화번호|이메일|입금계좌|계좌번호|주소|차량번호)\s*[:：]\s*([^\s,，、;；()]{1,40}(?:\s*(?:주식회사|㈜|유한회사|유한책임회사))?)/g;

  function buildLabelCandidates(state) {
    const out = [];
    const seen = new Set();
    const byId = state.byId;
    const add = (kind, label, value) => {
      const key = kind + '|' + value;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ kind: 'label', category: kind, label, original: value, masked: maskForKind(value, kind) });
    };

    for (const sec of state.sections) {
      for (const block of sec.blocks) {
        if (block.type !== 'table') continue;
        for (const tr of block.tbl.rows) {
          for (let c = 0; c < tr.cells.length - 1; c += 1) {
            const labelText = tr.cells[c].paraIds.map((id) => byId[id].text).join(' ').trim();
            const norm = normalizeLabel(labelText);
            const kind = LABEL_KINDS[norm];
            const isContext = !kind && CONTEXT_LABELS.indexOf(norm) !== -1;
            if (!kind && !isContext) continue;
            const valueCell = tr.cells[c + 1];
            const value = valueCell.paraIds.map((id) => byId[id].text).join(' ').replace(/\s+/g, ' ').trim();
            if (!value) continue;
            for (const id of valueCell.paraIds) {
              if (!byId[id].contextLabel) byId[id].contextLabel = norm;
            }
            if (!kind || kind === 'birth') continue;     // 생년월일·유형 머리글은 자동 탐지가 처리
            if (value.length > 40) continue;
            add(kind, norm, value);
          }
        }
      }
    }

    for (const para of state.paras) {
      INLINE_LABEL_RE.lastIndex = 0;
      let m;
      while ((m = INLINE_LABEL_RE.exec(para.text)) !== null) {
        const kind = LABEL_KINDS[normalizeLabel(m[1])];
        if (!kind || kind === 'birth') continue;
        const value = m[2].trim();
        if (!value || value.length > 30) continue;
        if (/^(성명|부서|소속|기관명|업체명|회사명|기관|업체)$/.test(value)) continue;
        add(kind, normalizeLabel(m[1]), value);
      }
    }
    return out;
  }

  /* ── HWPX 열기 ──────────────────────────────────── */
  let current = null;   // 마지막으로 연 문서(내부 구조) — build() 가 사용

  function jszip() {
    const Z = root.JSZip;
    if (typeof Z === 'undefined') {
      const e = new Error('JSZip 없음');
      e.code = 'NO_JSZIP';
      throw e;
    }
    return Z;
  }

  const tick = (fn) => { if (typeof fn === 'function') fn(); };

  async function open(bytes, fileName, onProgress) {
    const JSZip = jszip();
    const progress = (phase, pct) => { if (onProgress) onProgress(phase, Math.max(0, Math.min(100, Math.round(pct)))); };

    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (data[0] === 0xd0 && data[1] === 0xcf && data[2] === 0x11 && data[3] === 0xe0) {
      const e = new Error('HWP'); e.code = 'HWP'; throw e;
    }
    if (!(data[0] === 0x50 && data[1] === 0x4b)) {
      const e = new Error('ZIP'); e.code = 'NOT_ZIP'; throw e;
    }
    progress('unzip', 2);
    let zip;
    try {
      zip = await JSZip.loadAsync(data);
    } catch (err) {
      const e = new Error('ZIP'); e.code = 'NOT_ZIP'; throw e;
    }
    const order = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
    const files = {};
    const decoder = new TextDecoder('utf-8');
    for (let k = 0; k < order.length; k += 1) {
      const name = order[k];
      const buf = await zip.file(name).async('uint8array');
      files[name] = buf;
      // 압축 해제 2~45% 구간을 파일 수 기준으로 나눈다.
      if (k % 3 === 2 || k === order.length - 1) progress('unzip', 2 + 43 * ((k + 1) / order.length));
      tick(null);
    }

    const mime = files['mimetype'] ? decoder.decode(files['mimetype']).trim() : '';
    if (!/hwp\+zip/i.test(mime)) {
      const e = new Error('HWPX 미확인'); e.code = 'NOT_HWPX'; throw e;
    }
    const sectionNames = order.filter((n) => /^Contents\/section\d+\.xml$/i.test(n)).sort();
    if (!sectionNames.length) {
      const e = new Error('섹션 없음'); e.code = 'NO_SECTION'; throw e;
    }

    progress('parse', 48);
    const state = { paras: [], sections: [], nextId: 0, byId: {} };
    const sections = [];
    for (let si = 0; si < sectionNames.length; si += 1) {
      const name = sectionNames[si];
      const xml = decoder.decode(files[name]);
      if (!/<[A-Za-z_][\w:.-]*:sec\b|<sec\b/.test(xml)) {
        const e = new Error('XML 오류: ' + name); e.code = 'BAD_XML'; throw e;
      }
      const parsed = parseSection(xml, si, state);
      const sec = { index: si, name, xml, blocks: parsed.blocks, extras: parsed.extras };
      sections.push(sec);
      state.sections.push(sec);
      progress('parse', 48 + (40 * (si + 1)) / sectionNames.length);
    }
    for (const p of state.paras) state.byId[p.id] = p;

    const labels = buildLabelCandidates(state);
    progress('parse', 92);

    /* 문서 모델(화면에서 쓰는 가벼운 사본) */
    const regions = {};
    let regionContainers = 0;
    const viewSections = sections.map((sec) => {
      const extras = sec.extras.map((reg) => {
        regions[reg.kind] = (regions[reg.kind] || 0) + 1;
        regionContainers += 1;
        return { kind: reg.kind, label: reg.label, paraIds: reg.paraIds.slice() };
      });
      return {
        index: sec.index,
        blocks: sec.blocks.map((b) => (b.type === 'p'
          ? { type: 'p', paraId: b.paraId }
          : {
            type: 'table',
            rows: b.tbl.rows.map((tr) => tr.cells.map((tc) => ({
              colSpan: tc.colSpan, rowSpan: tc.rowSpan,
              text: tc.paraIds.map((id) => state.byId[id].text).join(' ').trim(),
              paraIds: tc.paraIds.slice()
            })))
          })),
        extras
      };
    });

    const viewParas = state.paras.map((p) => ({
      id: p.id, text: p.text, contextLabel: p.contextLabel,
      region: p.region, section: p.section
    }));

    const tableCount = sections.reduce((n, s) => n + s.blocks.filter((b) => b.type === 'table').length, 0);
    const model = {
      fileName: fileName || 'document.hwpx',
      fileSize: data.length,
      sections: viewSections,
      paras: viewParas,
      labelCandidates: labels,
      stats: {
        paras: state.paras.length, tables: tableCount, sections: sections.length,
        regions, regionContainers, entries: order.length
      },
      meta: {
        hasPreviewText: !!files['Preview/PrvText.txt'],
        hasPreviewImage: !!files['Preview/PrvImage.png'],
        entries: order.slice()
      }
    };

    current = { files, order, sections, paras: state.paras, model, fileName: model.fileName };
    progress('parse', 100);
    return model;
  }

  /* ── 계획 수립(치환 위치) ───────────────────────── */
  function plan(paras, items) {
    const active = items.filter((it) => it.enabled && it.original);
    active.sort((a, b) => {
      const ka = a.kind === 'auto' ? 1 : 0;
      const kb = b.kind === 'auto' ? 1 : 0;
      if (ka !== kb) return ka - kb;
      return b.original.length - a.original.length;
    });
    for (const p of paras) p.ranges = [];
    const byId = new Map();
    for (const p of paras) byId.set(p.id, p);
    const counts = new Map(items.map((it) => [it.id, 0]));
    const excluded = (it, pid, start) => {
      const ex = it.exclude;
      if (!ex) return false;
      const key = pid + ':' + start;
      if (typeof ex.has === 'function') return ex.has(key);
      if (Array.isArray(ex)) return ex.indexOf(key) !== -1;
      return !!(ex && ex[key]);
    };
    const place = (it, p, start) => {
      const end = start + it.original.length;
      if (p.text.slice(start, end) !== it.original) return false;
      if (excluded(it, p.id, start)) return false;
      if (p.ranges.some((r) => start < r.end && end > r.start)) return false;
      p.ranges.push({ start, end, text: it.masked, itemId: it.id, original: it.original });
      counts.set(it.id, (counts.get(it.id) || 0) + 1);
      return true;
    };

    for (const it of active) {
      // 자동 탐지 항목은 '어디서 찾았는지'를 그대로 따른다 → 카테고리별 분류가 뒤섞이지 않는다.
      if (it.kind === 'auto' && it.occ && it.occ.length) {
        for (const o of it.occ) {
          const p = byId.get(o.p);
          if (p) place(it, p, o.start);
        }
        continue;
      }
      const mode = it.matchMode === 'partial' ? 'partial' : (it.kind === 'auto' ? 'partial' : 'word');
      for (const p of paras) {
        if (!p.text) continue;
        for (const start of occurrencesInText(p.text, it.original, mode)) place(it, p, start);
      }
    }
    for (const p of paras) p.ranges.sort((a, b) => a.start - b.start);
    for (const it of items) it.hits = counts.get(it.id) || 0;
    return items;
  }

  /* ── 미리보기·복사용 텍스트 ─────────────────────── */
  function maskedParaText(para) {
    if (!para || !para.ranges || !para.ranges.length) return para ? para.text : '';
    let out = '';
    let pos = 0;
    for (const r of para.ranges) {
      out += para.text.slice(pos, r.start) + r.text;
      pos = r.end;
    }
    return out + para.text.slice(pos);
  }

  function maskedLines(model) {
    const byId = {};
    for (const p of model.paras) byId[p.id] = p;
    const lines = [];
    for (const sec of model.sections) {
      for (const block of sec.blocks) {
        if (block.type === 'p') {
          const t = maskedParaText(byId[block.paraId]);
          if (t.trim()) lines.push(t);
        } else {
          for (const row of block.rows) {
            const cells = row.map((c) => c.paraIds.map((id) => maskedParaText(byId[id])).join(' ').trim());
            lines.push(cells.join(' | '));
          }
          lines.push('');
        }
      }
      for (const ex of sec.extras || []) {
        const txt = ex.paraIds.map((id) => maskedParaText(byId[id])).join(' ').trim();
        if (txt) lines.push('[' + ex.label + '] ' + txt);
      }
    }
    return lines;
  }

  function maskedText(model) {
    return maskedLines(model).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  /* ── 메타데이터 초기화 ──────────────────────────── */
  function sanitizeMetadataText(name, xml) {
    let out = xml;
    let changed = 0;
    const blank = (re) => {
      out = out.replace(re, (m, open, inner, close) => {
        if (inner && inner.trim()) changed += 1;
        return open + close;
      });
    };
    if (/content\.hpf$/i.test(name)) {
      blank(/(<opf:title\b[^>]*>)([\s\S]*?)(<\/opf:title>)/g);
      blank(/(<dc:[A-Za-z]+\b[^>]*>)([\s\S]*?)(<\/dc:[A-Za-z]+>)/g);
      out = out.replace(/(<opf:meta\b[^>]*\bname="([^"]+)"[^>]*>)([\s\S]*?)(<\/opf:meta>)/g,
        (m, open, metaName, inner, close) => {
          if (/^language$/i.test(metaName)) return m;
          if (inner && inner.trim()) changed += 1;
          return open + close;
        });
    } else if (/settings\.xml$/i.test(name)) {
      out = out.replace(/(<config:config-item\b[^>]*\bconfig:name="([^"]+)"[^>]*>)([\s\S]*?)(<\/config:config-item>)/g,
        (m, open, cfgName, inner, close) => {
          if (!/(path|folder|dir|recent|file|url|user|author|writer|company|template|title)/i.test(cfgName)) return m;
          if (inner && inner.trim()) changed += 1;
          return open + close;
        });
    } else if (/header\.xml$/i.test(name)) {
      blank(/(<(?:[A-Za-z0-9]+:)?(author|creator|writer|lastsaveby|lastmodifiedby|username|company|description|subject|keyword|title|contributor|publisher|source|rights|coverage)\b[^>]*>)([\s\S]*?)(<\/(?:[A-Za-z0-9]+:)?\1>)/gi);
    }
    return { xml: out, changed };
  }

  function resetMetadata(files) {
    let changed = 0;
    const touched = [];
    for (const name of Object.keys(files)) {
      if (!/(^Contents\/(content\.hpf|header\.xml)$|(^|\/)settings\.xml$)/i.test(name)) continue;
      const txt = new TextDecoder('utf-8').decode(files[name]);
      const r = sanitizeMetadataText(name, txt);
      if (r.changed) {
        files[name] = new TextEncoder().encode(r.xml);
        changed += r.changed;
        touched.push(name);
      }
    }
    return { changed, files: touched };
  }

  /* ── 저장 ───────────────────────────────────────── */
  function blankPngBytes() {
    const bin = atob(BLANK_PNG_B64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  }

  function applyEdits(xml, edits) {
    if (!edits.length) return xml;
    edits.sort((a, b) => a.start - b.start);
    const parts = [];
    let pos = 0;
    for (const e of edits) {
      if (e.start < pos) continue;          // 겹치는 수정은 건너뜀(사전에 방지되지만 안전장치)
      parts.push(xml.slice(pos, e.start), e.text);
      pos = e.end;
    }
    parts.push(xml.slice(pos));
    return parts.join('');
  }

  /**
   * 마스킹된 .hwpx 생성.
   * @param {object} items  현재 항목 목록(치환 규칙)
   * @param {object} opts   {cleanTrace, resetMetadata}
   * @param {function} onProgress (phase, percent)
   */
  async function build(items, opts, onProgress) {
    if (!current) {
      const e = new Error('열린 문서가 없습니다'); e.code = 'NO_DOC'; throw e;
    }
    const JSZip = jszip();
    const options = opts || {};
    const progress = (phase, pct) => {
      if (onProgress) onProgress(phase, Math.max(0, Math.min(100, Math.round(pct))));
    };
    const doc = current;
    plan(doc.paras, items);
    const viewById = {};
    for (const vp of doc.model.paras) viewById[vp.id] = vp;
    for (const p of doc.paras) if (viewById[p.id]) viewById[p.id].ranges = p.ranges;

    const updated = {};
    const stats = { hits: 0, paragraphs: 0, files: 0, metadata: null, regions: {} };
    for (let si = 0; si < doc.sections.length; si += 1) {
      const sec = doc.sections[si];
      let hits = 0;
      for (const p of doc.paras) {
        if (p.section !== sec.index) continue;
        if (p.ranges && p.ranges.length) { hits += p.ranges.length; stats.paragraphs += 1; }
      }
      stats.hits += hits;
      const edits = sectionEditsFor(doc.paras, sec.index);
      const out = applyEdits(sec.xml, edits);
      updated[sec.name] = new TextEncoder().encode(out);
      progress('replace', 8 + (34 * (si + 1)) / doc.sections.length);
    }

    const files = Object.assign({}, doc.files);
    for (const name of Object.keys(updated)) files[name] = updated[name];

    if (options.cleanTrace !== false) {
      if (files['Preview/PrvText.txt']) {
        const text = maskedText(doc.model);
        files['Preview/PrvText.txt'] = new TextEncoder().encode(text);
      }
      if (files['Preview/PrvImage.png']) files['Preview/PrvImage.png'] = blankPngBytes();
    }
    progress('metadata', 45);
    if (options.resetMetadata) {
      stats.metadata = resetMetadata(files);
    }

    const zip = new JSZip();
    const order = doc.order.slice();
    const mimeFirst = order.indexOf('mimetype');
    if (mimeFirst > 0) { order.splice(mimeFirst, 1); order.unshift('mimetype'); }
    for (const name of order) {
      const data = files[name];
      if (!data) continue;
      zip.file(name, data, {
        compression: name === 'mimetype' ? 'STORE' : 'DEFLATE',
        createFolders: false
      });
      stats.files += 1;
    }
    progress('zip', 50);
    const out = await zip.generateAsync(
      { type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } },
      (meta) => progress('zip', 50 + meta.percent * 0.5)
    );
    const base = doc.fileName.replace(/\.hwpx$/i, '');
    progress('zip', 100);
    return { buffer: out, fileName: base + '_masked.hwpx', size: out.length, stats };
  }

  function sectionEditsFor(paras, sectionIndex) {
    const edits = [];
    for (const para of paras) {
      if (para.section !== sectionIndex) continue;
      if (!para.ranges || !para.ranges.length) continue;
      for (let ri = para.ranges.length - 1; ri >= 0; ri -= 1) {
        const r = para.ranges[ri];
        let first = true;
        for (const run of para.runs) {
          const a = Math.max(r.start, run.start);
          const b = Math.min(r.end, run.start + run.len);
          if (a >= b) continue;
          const rawA = runRawPos(run, a - run.start);
          const rawB = runRawEnd(run, b - run.start);
          edits.push({ start: rawA, end: rawB, text: first ? escXml(r.text) : '' });
          first = false;
        }
      }
    }
    return edits;
  }

  /* ── 맞춤 치환 문자 ─────────────────────────────── */
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

  let itemSeq = 1;
  const newItemId = () => 'it' + (itemSeq++);

  /* ── 진단용: 문자열 하나 탐지 ───────────────────── */
  function scanText(text, enabled) {
    return detectPara(text, enabled || {}, '');
  }

  /* ── 문서 문단에 탐지 적용 ──────────────────────── */
  function detect(paras, enabled) {
    const found = [];
    for (const p of paras) {
      if (!p.text) continue;
      for (const h of detectPara(p.text, enabled, p.contextLabel)) {
        found.push({
          paraId: p.id, start: h.start, original: h.original,
          masked: h.masked, category: h.category, region: p.region
        });
      }
    }
    return found;
  }

  /* ── 특정 단어의 문서 내 출현 위치 ──────────────── */
  function occurrences(model, word, mode) {
    const out = [];
    if (!word) return out;
    for (const p of model.paras) {
      for (const start of occurrencesInText(p.text, word, mode)) {
        const before = p.text.slice(Math.max(0, start - 18), start);
        const after = p.text.slice(start + word.length, start + word.length + 18);
        out.push({
          paraId: p.id, start, context: { before, after },
          region: p.region, section: p.section
        });
      }
    }
    return out;
  }

  root.Masker = {
    version: '2.0.0',
    CATEGORIES, CATEGORY_ORDER, REGION_LABEL, MASKS,
    customMask, maskForKind, newItemId, scanText,
    detect, plan, occurrences, occurrencesInText, wordChar,
    maskedText, maskedLines, maskedParaText,
    open, build, sanitizeMetadataText,
    Hwpx: {
      open,
      build,
      get current() { return current; }
    }
  };
})(typeof self !== 'undefined' ? self : this);
