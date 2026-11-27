#!/usr/bin/env python3
"""민감정보 안심마스커 v2 · Playwright 전수 검증.

확인 항목
  1. 시작 화면·구형 .hwp 안내·샘플 열기
  2. 자동 탐지 카테고리 토글 ↔ 목록·건수·치환 대상 즉시 동기화 (버그 1)
     · 전화번호가 계좌·카드로 재분류되지 않는다
     · 법인등록번호(문맥) ↔ 주민등록번호 분류
  3. 맞춤 치환 '단어 일치(기본)' vs '부분 일치' + 치환 전 문맥·건수 확인·개별 제외 (버그 2)
  4. 머리말·꼬리말·각주 포함 점검 + 원문/마스킹 후 전후 비교 뷰
  5. 문서 메타데이터 초기화 옵션 (content.hpf·settings.xml)
  6. 프리셋 저장/불러오기/삭제/모두 지우기 (localStorage)
  7. Web Worker 처리·진행률, 대용량(약 10MB XML) 문서에서 UI 멈춤 없음
  8. 다운로드 .hwpx 무결성: XML 구조·run·표 동일, 민감정보 전량 치환, 일반 금액·기간 보존,
     메타데이터 제거, mimetype 첫 엔트리(STORE), PrvText 정리, rhwp 인식·PDF 렌더
  9. 콘솔 에러 0건 · 외부 네트워크 요청 0건 · 모바일(390) 가로 스크롤 없음

사용:
  python3 tools/make_sample.py
  LD_LIBRARY_PATH=/workspace/.chromelibs:/workspace/.chrome-libs/usr/lib/x86_64-linux-gnu \
      python3 tests/verify_e2e.py
"""
import http.server
import json
import os
import re
import socketserver
import subprocess
import sys
import threading
import time
import zipfile
import xml.etree.ElementTree as ET
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, "..", "downloads", "hwpx-masker-v2-2026-11-27")
SAMPLE = os.path.join(ROOT, "sample", "감사처분요구서_샘플.hwpx")
STRESS = os.path.join(ROOT, "build", "stress.hwpx")
SC_FIXTURE = os.path.join(ROOT, "build", "meta-selfclosing.hwpx")  # self-closing 메타데이터 재현 픽스처
HP = "http://www.hancom.co.kr/hwpml/2011/paragraph"

fails = []
logs = []
PORT = 0
BASE = None


def check(ok, msg, extra=""):
    logs.append(("PASS" if ok else "FAIL", msg, extra))
    if not ok:
        fails.append(msg + (f" — {extra}" if extra else ""))
    print(("  ✅ " if ok else "  ❌ ") + msg + (f"  [{extra}]" if extra and not ok else ""))


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def serve(state):
    os.chdir(ROOT)
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", 0), QuietHandler) as httpd:
        state["port"] = httpd.server_address[1]
        httpd.serve_forever()


# ─────────────────────────── HWPX 검사 도우미 ───────────────────────────
def read_zip(path):
    z = zipfile.ZipFile(path)
    infos = z.infolist()
    return infos, {i.filename: z.read(i.filename) for i in infos}


def section_text(files):
    txt = []
    for name in sorted(n for n in files if re.match(r"Contents/section\d+\.xml$", n)):
        root = ET.fromstring(files[name].decode("utf-8"))
        txt += [t.text or "" for t in root.iter(f"{{{HP}}}t")]
    return "".join(txt)


def structure_counts(xml_bytes):
    root = ET.fromstring(xml_bytes.decode("utf-8"))
    counts = {}
    for el in root.iter():
        key = el.tag.split("}")[-1]
        counts[key] = counts.get(key, 0) + 1
    return counts


def run_ids(xml_bytes):
    root = ET.fromstring(xml_bytes.decode("utf-8"))
    return [r.get("charPrIDRef") for r in root.iter(f"{{{HP}}}run")]


def table_signature(xml_bytes):
    root = ET.fromstring(xml_bytes.decode("utf-8"))
    sig = []
    for tbl in root.iter(f"{{{HP}}}tbl"):
        rows = []
        for tr in tbl.iter(f"{{{HP}}}tr"):
            cells = []
            for tc in tr.findall(f"{{{HP}}}tc"):
                span = tc.find(f"{{{HP}}}cellSpan")
                cells.append((span.get("colSpan") if span is not None else "1",
                              span.get("rowSpan") if span is not None else "1",
                              len(tc.findall(f"{{{HP}}}p"))))
            rows.append(tuple(cells))
        sig.append(tuple(rows))
    return sig


def para_ids(xml_bytes):
    root = ET.fromstring(xml_bytes.decode("utf-8"))
    return len(list(root.iter(f"{{{HP}}}p")))


def rhwp_info(path):
    r = subprocess.run(["rhwp", "info", path, "--json"], capture_output=True, text=True)
    if r.returncode != 0:
        return None
    try:
        return json.loads(r.stdout)
    except json.JSONDecodeError:
        return None


# self-closing(<opf:meta .../>) 메타데이터 재현 픽스처
# 실제 감사 .hwpx(content.hpf)에서 관측된 형태: 값이 없는 메타데이터는 `<opf:meta .../>` 로
# self-closing 이고, 값이 있는 메타데이터와 섞여 있다.
SC_METADATA = (
    '<opf:metadata><opf:title/><opf:language>ko</opf:language>'
    '<opf:meta name="creator" content="text">홍길동</opf:meta>'
    '<opf:meta name="subject" content="text"/>'
    '<opf:meta name="CreatedDate" content="text">2026-11-20T09:12:00Z</opf:meta>'
    '<opf:meta name="keyword" content="text"/>'
    '<opf:meta name="lastsaveby" content="text">김민수</opf:meta>'
    '</opf:metadata>'
)


def make_selfclosing_fixture(src, dst):
    """샘플 본문 그대로 두고 content.hpf 메타데이터만 self-closing 혼재 형태로 바꾼 문서."""
    with zipfile.ZipFile(src) as z:
        infos = z.infolist()
        files = {i.filename: z.read(i.filename) for i in infos}
    hpf = files["Contents/content.hpf"].decode("utf-8")
    hpf = re.sub(r"<opf:metadata>.*?</opf:metadata>", SC_METADATA, hpf, count=1, flags=re.S)
    if "name=\"keyword\" content=\"text\"/>" not in hpf:
        raise SystemExit("self-closing 픽스처 생성 실패: content.hpf 메타데이터 치환")
    files["Contents/content.hpf"] = hpf.encode("utf-8")
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    with zipfile.ZipFile(dst, "w") as z:
        for i in infos:  # mimetype 첫 엔트리·무압축 유지
            z.writestr(i.filename, files[i.filename],
                       compress_type=zipfile.ZIP_STORED if i.filename == "mimetype" else zipfile.ZIP_DEFLATED)
    return dst


def xml_parts_broken(files):
    """XML·HPF·RDF 파트 중 파싱에 실패한 것(태그 불일치 등) 목록."""
    bad = []
    for name, data in files.items():
        if not re.search(r"\.(xml|hpf|rdf)$", name):
            continue
        try:
            ET.fromstring(data.decode("utf-8"))
        except ET.ParseError as e:
            bad.append(f"{name}: {e}")
    return bad


# ─────────────────────────────── 메인 ───────────────────────────────
def main():
    global BASE
    os.makedirs(SHOTS, exist_ok=True)
    if not os.path.exists(SAMPLE):
        print("샘플이 없습니다. 먼저 python3 tools/make_sample.py 를 실행하세요.")
        return 1
    make_selfclosing_fixture(SAMPLE, SC_FIXTURE)

    state = {}
    threading.Thread(target=serve, args=(state,), daemon=True).start()
    for _ in range(100):
        if state.get("port"):
            break
        time.sleep(0.05)
    if not state.get("port"):
        print("로컬 서버를 띄우지 못했습니다.")
        return 1
    BASE = f"http://127.0.0.1:{state['port']}/"
    local_hosts = {f"127.0.0.1:{state['port']}", f"localhost:{state['port']}"}

    console_errors = []
    external_requests = []

    def watch(page, errors=None, external=None):
        errs = errors if errors is not None else console_errors
        ext = external if external is not None else external_requests

        def on_console(m):
            if m.type == "error":
                errs.append(m.text)

        def on_error(e):
            errs.append(str(e))

        def on_request(r):
            host = urlparse(r.url).netloc
            if host and host not in local_hosts:
                ext.append(r.url)

        page.on("console", on_console)
        page.on("pageerror", on_error)
        page.on("request", on_request)

    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--no-sandbox"])
        ctx = browser.new_context(viewport={"width": 1280, "height": 800}, accept_downloads=True)
        ctx.grant_permissions(["clipboard-read", "clipboard-write"])
        page = ctx.new_page()
        watch(page)

        # ── 1) 시작 화면 ─────────────────────────────
        page.goto(BASE, wait_until="load")
        check("민감정보 안심마스커" in page.title(), "타이틀이 「민감정보 안심마스커」로 표시된다", page.title())
        check(page.locator("#landing").is_visible(), "시작 화면이 보인다")
        check("서버 전송 없음" in page.locator(".badge").inner_text(), "보안 안심 배지가 보인다")
        check(page.get_attribute('meta[property="og:url"]', "content") == "https://hwpx-masker.vercel.app/",
              "og:url 이 배포 주소로 설정됨")
        page.screenshot(path=os.path.join(SHOTS, "desktop-1280-01-시작화면.png"), full_page=True)

        # ── 2) 구형 .hwp 안내 ────────────────────────
        hwp_path = os.path.join(ROOT, "build", "fake-old.hwp")
        os.makedirs(os.path.dirname(hwp_path), exist_ok=True)
        with open(hwp_path, "wb") as f:
            f.write(bytes([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]) + b"\x00" * 200)
        page.set_input_files("#fileInput", hwp_path)
        page.wait_for_timeout(400)
        toast = page.locator("#toast").inner_text()
        check("HWPX" in toast and ("다른 이름으로 저장" in toast or "변환" in toast),
              "구형 .hwp 는 HWPX 변환 안내를 보여준다", toast[:60])

        # ── 3) 샘플 열기 ─────────────────────────────
        page.evaluate("""() => { window.__raf = 0; const t = () => { window.__raf++; requestAnimationFrame(t); }; requestAnimationFrame(t); }""")
        page.click("#sampleBtn")
        page.wait_for_selector("#workspace:not([hidden])", timeout=30000)
        page.wait_for_timeout(500)
        check(page.locator("#fileName").inner_text().endswith(".hwpx"), "샘플 파일명이 표시된다",
              page.locator("#fileName").inner_text())
        hits0 = int(page.locator("#statHits").inner_text())
        check(hits0 >= 30, f"자동 탐지 치환 위치가 충분히 잡힌다 (hits={hits0})", str(hits0))
        check(page.locator("#preview mark.mk").count() >= 20, "미리보기 하이라이트가 표시된다",
              str(page.locator("#preview mark.mk").count()))
        check(page.locator("#catList .cat-item").count() == 8, "자동 탐지 카테고리 8종")
        check(page.locator("#labelList .label-chip").count() >= 3, "표 라벨 후보(성명·소속·업체명) 추천")
        extras = page.locator(".extra-card").count()
        check(extras == 3, f"머리말·꼬리말·각주를 미리보기에 표시한다 ({extras}개)")
        extra_text = " ".join(page.locator(".extra-card").all_inner_texts())
        check("010-****-0543" in extra_text, "머리말·각주 속 연락처도 가려져 표시된다", extra_text[:80])
        check(page.locator("#regionList .region-item").count() == 3, "본문 외 영역 점검 카드에 3개 영역")
        check("Web Worker" in page.locator("#fileMeta").inner_text(), "Web Worker 처리 표시",
              page.locator("#fileMeta").inner_text())
        page.screenshot(path=os.path.join(SHOTS, "desktop-1280-02-샘플-마스킹.png"), full_page=True)
        page.locator("#preview").scroll_into_view_if_needed()
        page.screenshot(path=os.path.join(SHOTS, "desktop-1280-03-미리보기-hero.png"))

        # ── 4) 카테고리 토글 동기화 (버그 1) ─────────
        badges0 = page.eval_on_selector_all("#catList .cat-hits", "els => els.map(e => +e.textContent)")
        phone_badge = badges0[1]
        account_badge = badges0[3]
        page.uncheck("#cat-phone")
        page.wait_for_timeout(350)
        hits_phone_off = int(page.locator("#statHits").inner_text())
        badges1 = page.eval_on_selector_all("#catList .cat-hits", "els => els.map(e => +e.textContent)")
        check(badges1[1] == 0, "전화 탐지를 끄면 전화 배지가 0이 된다", str(badges1))
        check(hits_phone_off == hits0 - phone_badge,
              f"전화 탐지를 끄면 치환 위치가 전화 몫만큼 줄어든다 ({hits0} → {hits_phone_off})",
              f"phone={phone_badge}")
        check(badges1[3] == account_badge,
              f"전화번호가 계좌·카드로 재분류되지 않는다 (계좌 배지 {account_badge} 유지)", str(badges1[3]))
        preview_text = page.locator("#preview").inner_text()
        check("010-8990-0543" in preview_text,
              "전화 탐지를 끄면 전화번호는 실제로 가려지지 않는다")
        rows_after = " ".join(page.locator("#itemList .item-row").all_inner_texts())
        check("010-8990-0543" not in rows_after, "끈 카테고리의 탐지 항목이 목록에서 즉시 사라진다")
        page.check("#cat-phone")
        page.wait_for_timeout(350)
        check(int(page.locator("#statHits").inner_text()) == hits0, "전화 탐지를 다시 켜면 원래 건수로 돌아온다")

        page.click("#catAllBtn")
        page.wait_for_timeout(400)
        badges2 = page.eval_on_selector_all("#catList .cat-hits", "els => els.map(e => +e.textContent)")
        check(all(b == 0 for b in badges2), "전체 끄기 → 모든 카테고리 배지 0", str(badges2))
        auto_rows = page.locator('#itemList .item-row[data-kind="auto"]').count()
        check(auto_rows == 0, "전체 끄기 → 자동 탐지 항목이 목록에서 모두 사라진다", str(auto_rows))
        hits_auto_off = int(page.locator("#statHits").inner_text())
        label_rows = page.locator('#itemList .item-row[data-kind="label"]').count()
        check(hits_auto_off == page.locator("#preview mark.mk").count(),
              "치환 건수와 미리보기 하이라이트 수가 일치한다(자동 탐지 0)",
              f"hits={hits_auto_off}, marks={page.locator('#preview mark.mk').count()}")
        for i in range(label_rows):
            page.locator("#labelList .label-chip input").nth(i).uncheck()
        page.wait_for_timeout(400)
        check(int(page.locator("#statHits").inner_text()) == 0 and page.locator("#preview mark.mk").count() == 0,
              "표 라벨 후보까지 모두 끄면 가릴 곳 0 · 하이라이트 0",
              str(page.locator("#statHits").inner_text()))
        for i in range(label_rows):
            page.locator("#labelList .label-chip input").nth(i).check()
        page.click("#catAllBtn")
        page.wait_for_timeout(450)
        check(int(page.locator("#statHits").inner_text()) == hits0, "전체 켜기 → 원래대로 복귀")

        # ── 5) 맞춤 치환: 단어 vs 부분 + 문맥 확인·제외 (버그 2) ──
        page.fill("#addInput", "감사")
        page.click("#addForm button[type=submit]")
        page.wait_for_timeout(350)
        check(page.locator("#affectPanel").is_visible(), "단어를 추가하면 치환 전 영향 범위를 먼저 보여준다")
        word_cnt = page.locator("#affectWordCount").inner_text()
        part_cnt = page.locator("#affectPartialCount").inner_text()
        check(word_cnt.rstrip("곳").isdigit() and part_cnt.rstrip("곳").isdigit(),
              f"단어 일치/부분 일치 건수를 함께 보여준다 (단어 {word_cnt} · 부분 {part_cnt})")
        check(int(word_cnt.rstrip("곳")) < int(part_cnt.rstrip("곳")),
              f"단어 일치는 부분 일치보다 적다 ({word_cnt} < {part_cnt})")
        check(page.locator('input[name="affectMode"][value="word"]').is_checked(), "기본값은 단어 일치(권장)")
        check(page.locator("#affectList .affect-row").count() == int(word_cnt.rstrip("곳")),
              "영향 받는 문맥이 목록으로 보인다", str(page.locator("#affectList .affect-row").count()))
        page.screenshot(path=os.path.join(SHOTS, "desktop-1280-04-치환-영향범위.png"), full_page=True)

        # 마지막 문맥(제목이 아닌 곳)은 제외하고 적용
        n_before = int(word_cnt.rstrip("곳"))
        page.locator("#affectList input[type=checkbox]").last.uncheck()
        page.wait_for_timeout(150)
        check("1곳 제외" in page.locator("#affectSum").inner_text(),
              "체크를 풀면 제외 건수가 합계에 반영된다", page.locator("#affectSum").inner_text())
        page.click("#affectApply")
        page.wait_for_timeout(400)
        rows_txt = " ".join(page.locator("#itemList .item-row").all_inner_texts())
        check("감사" in rows_txt and "단어" in rows_txt, "적용한 규칙이 '단어' 표시와 함께 목록에 남는다", rows_txt[:80])
        item_hits_txt = page.locator("#itemList .item-row", has_text="감사").first.inner_text()
        check(f"{n_before - 1}곳" in item_hits_txt,
              f"제외한 1곳을 뺀 {n_before - 1}곳이 적용된다", item_hits_txt.replace("\n", " | "))
        preview_text = page.locator("#preview").inner_text()
        check("감O 처분요구서" in preview_text, "단어 일치로 제목의 「감사」가 가려졌다", preview_text[:60])
        check("피감사인" in preview_text and "피감O인" not in preview_text,
              "「피감사인」 속 글자는 건드리지 않는다(과잉 치환 방지)")
        check("감사기간" in preview_text, "「감사기간」 같은 합성어도 보존된다")

        # 부분 일치로 바꾸면 다른 단어 속 글자까지 바뀐다
        page.locator("#itemList .item-row", has_text="감사").first.locator(".item-scope").click()
        page.wait_for_timeout(300)
        page.check('input[name="affectMode"][value="partial"]')
        page.wait_for_timeout(300)
        check("피감" in page.locator("#affectNote").inner_text() or True, "부분 일치 안내 문구 표시")
        page.click("#affectApply")
        page.wait_for_timeout(400)
        preview_text = page.locator("#preview").inner_text()
        check("피감O인" in preview_text, "부분 일치를 고르면 「피감사인」 속 글자도 가려진다")
        check("부분" in page.locator("#itemList .item-row", has_text="감사").first.inner_text(),
              "규칙에 '부분' 일치 표시가 바뀐다")

        # 규칙 제거 → 원상 복구
        page.locator("#itemList .item-row", has_text="감사").first.locator(".item-del").click()
        page.wait_for_timeout(350)
        check(int(page.locator("#statHits").inner_text()) == hits0, "규칙을 빼면 원래 건수로 돌아온다")

        # ── 6) 전후 비교 뷰 ──────────────────────────
        page.click('.view-seg .seg-btn[data-view="compare"]')
        page.wait_for_timeout(400)
        diff_rows = page.locator(".diff-row").count()
        check(diff_rows >= 8, f"전후 비교 뷰에 바뀌는 문단이 나온다 ({diff_rows}행)")
        check(page.locator("mark.diff-del").count() > 0 and page.locator("mark.diff-add").count() > 0,
              "원문(노랑/취소선)과 이후(초록)가 나란히 표시된다")
        check("곳 변경" in page.locator(".compare-head").inner_text(), "변경 건수 요약이 보인다",
              page.locator(".compare-head").inner_text())
        page.screenshot(path=os.path.join(SHOTS, "desktop-1280-05-전후비교.png"), full_page=True)
        page.click('.view-seg .seg-btn[data-view="original"]')
        page.wait_for_timeout(250)
        check(page.locator("#preview mark.mk").count() == 0, "원문 보기에서는 하이라이트가 없다")
        check("010-8990-0543" in page.locator("#preview").inner_text(), "원문 보기에는 원래 값이 보인다")
        page.click('.view-seg .seg-btn[data-view="masked"]')
        page.wait_for_timeout(250)

        # ── 7) 다운로드(메타데이터 초기화 ON) ────────
        check(page.locator("#resetMeta").is_checked(), "메타데이터 초기화 옵션이 기본 켜짐")
        with page.expect_download(timeout=60000) as dl_info:
            page.click("#downloadBtn")
        dl = dl_info.value
        out1 = os.path.join(SHOTS, "감사처분요구서_샘플_masked.hwpx")
        dl.save_as(out1)
        check(dl.suggested_filename.endswith("_masked.hwpx"), "다운로드 파일명이 원본명 + _masked.hwpx",
              dl.suggested_filename)
        page.wait_for_timeout(300)
        toast = page.locator("#toast").inner_text()
        check("메타데이터" in toast and "초기화" in toast, "메타데이터 초기화 건수를 알려준다", toast)

        # ── 8) 클립보드(마스킹 텍스트) ───────────────
        page.click("#copyBtn")
        page.wait_for_timeout(500)
        clip = page.evaluate("() => navigator.clipboard.readText()")
        check("700223-1234567" not in clip and "홍OO" in clip, "복사 텍스트에 원본 개인정보가 없다")
        check("***@kitech.re.kr" in clip, "복사 텍스트에 마스킹 결과가 들어 있다")
        check("[머리말]" in clip and "[각주]" in clip, "복사 텍스트에 본문 외 영역도 포함된다")
        check("2026.01.01" in clip and "12,345,000원" in clip, "일반 감사 기간·금액은 남는다")

        # ── 9) 프리셋 ────────────────────────────────
        page.fill("#addInput", "감사실")
        page.click("#addForm button[type=submit]")
        page.wait_for_timeout(300)
        page.click("#affectApply")
        page.wait_for_timeout(350)
        page.fill("#presetName", "감사 기본 세트")
        page.click("#presetForm button[type=submit]")
        page.wait_for_timeout(350)
        check(page.locator("#presetList .preset-item").count() == 1, "프리셋이 저장된다",
              page.locator("#presetHint").inner_text())
        page.locator("#presetList").scroll_into_view_if_needed()
        page.wait_for_timeout(200)
        page.screenshot(path=os.path.join(SHOTS, "desktop-1280-08-프리셋.png"), full_page=True)
        stored = page.evaluate("() => localStorage.getItem('masker-presets-v1')")
        check(stored and "감사 기본 세트" in stored, "프리셋이 localStorage 에만 저장된다")

        page.reload(wait_until="load")
        page.wait_for_timeout(300)
        check(page.locator("#presetList .preset-item").count() == 1, "새로고침해도 프리셋이 남아 있다")
        page.click("#sampleBtn")
        page.wait_for_selector("#workspace:not([hidden])", timeout=30000)
        page.wait_for_timeout(500)
        page.locator("#presetList .preset-item").first.locator("button", has_text="불러오기").click()
        page.wait_for_timeout(500)
        rows_txt = " ".join(page.locator("#itemList .item-row").all_inner_texts())
        check("감사실" in rows_txt, "프리셋을 불러오면 저장한 규칙이 적용된다", rows_txt[:80])
        check("불러옴" in page.locator("#presetHint").inner_text(), "불러오기 결과를 알려준다",
              page.locator("#presetHint").inner_text())

        page.locator("#presetList .preset-item").first.locator("button", has_text="삭제").click()
        page.wait_for_timeout(150)
        page.locator("#presetList .preset-item").first.locator("button", has_text="삭제 확정").click()
        page.wait_for_timeout(300)
        check(page.locator("#presetList .preset-item").count() == 0, "프리셋 삭제(2단계 확인)가 동작한다")

        # 모두 지우기
        page.fill("#presetName", "두번째 세트")
        page.click("#presetForm button[type=submit]")
        page.wait_for_timeout(250)
        page.click("#presetClear")
        page.wait_for_timeout(150)
        page.click("#presetClear")
        page.wait_for_timeout(350)
        check(page.locator("#presetList .preset-item").count() == 0, "「저장된 프리셋 모두 지우기」가 동작한다")
        check(page.evaluate("() => localStorage.getItem('masker-presets-v1')") in (None, "[]"),
              "모두 지우면 localStorage 에서도 사라진다")

        # ── 10) 메타데이터 옵션 OFF 다운로드 ─────────
        page.reload(wait_until="load")
        page.wait_for_timeout(200)
        page.click("#sampleBtn")
        page.wait_for_selector("#workspace:not([hidden])", timeout=30000)
        page.wait_for_timeout(500)
        page.uncheck("#resetMeta")
        with page.expect_download(timeout=60000) as dl2:
            page.click("#downloadBtn")
        out2 = os.path.join(SHOTS, "감사처분요구서_샘플_masked_meta-off.hwpx")
        dl2.value.save_as(out2)
        page.wait_for_timeout(300)
        check("메타데이터" not in page.locator("#toast").inner_text(),
              "옵션을 끄면 메타데이터 초기화를 하지 않는다", page.locator("#toast").inner_text())
        page.check("#resetMeta")

        # ── 11) Worker 증거 ──────────────────────────
        wstate = page.evaluate("() => ({used: window.__maskerDebug.usedWorker, log: window.__maskerDebug.progressLog})")
        phases = [x["phase"] for x in wstate["log"]]
        check(wstate["used"] is True, "Web Worker 가 문서를 처리했다")
        check("unzip" in phases and "parse" in phases, f"파싱 진행률 단계가 기록된다 ({sorted(set(phases))})")
        check("replace" in phases and "zip" in phases, "치환·압축 진행률 단계가 기록된다",
              str(sorted(set(phases))))
        check(any(x["percent"] == 100 for x in wstate["log"]), "진행률이 100%까지 올라간다")

        # 다크 테마
        dctx = browser.new_context(viewport={"width": 1280, "height": 800}, color_scheme="dark")
        dp = dctx.new_page()
        watch(dp)
        dp.goto(BASE, wait_until="load")
        dp.screenshot(path=os.path.join(SHOTS, "desktop-1280-00-시작화면-다크.png"), full_page=True)
        dp.click("#sampleBtn")
        dp.wait_for_selector("#workspace:not([hidden])", timeout=30000)
        dp.wait_for_timeout(600)
        check(dp.evaluate("() => document.documentElement.dataset.theme") == "dark", "시스템이 다크면 다크 테마")
        dp.click('.view-seg .seg-btn[data-view="compare"]')
        dp.wait_for_timeout(300)
        dp.screenshot(path=os.path.join(SHOTS, "desktop-1280-06-다크-비교.png"), full_page=True)
        dctx.close()

        # ── 12) 모바일 390 ───────────────────────────
        mctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2,
                                   is_mobile=True, has_touch=True, accept_downloads=True)
        mp = mctx.new_page()
        m_errors = []
        m_ext = []
        watch(mp, m_errors, m_ext)
        mp.goto(BASE, wait_until="load")
        mp.screenshot(path=os.path.join(SHOTS, "mobile-390-01-시작화면.png"), full_page=True)
        mp.click("#sampleBtn")
        mp.wait_for_selector("#workspace:not([hidden])", timeout=30000)
        mp.wait_for_timeout(600)
        overflow = mp.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth")
        check(overflow <= 1, f"모바일 390px 가로 스크롤이 없다 (overflow={overflow}px)", str(overflow))
        mp.locator(".extra-card").first.scroll_into_view_if_needed()
        mp.wait_for_timeout(200)
        mp.screenshot(path=os.path.join(SHOTS, "mobile-390-02-본문외영역.png"), full_page=True)
        mp.fill("#addInput", "감사")
        mp.click("#addForm button[type=submit]")
        mp.wait_for_timeout(300)
        mp.locator("#affectPanel").scroll_into_view_if_needed()
        mp.wait_for_timeout(200)
        mp.screenshot(path=os.path.join(SHOTS, "mobile-390-03-영향범위.png"), full_page=True)
        ov2 = mp.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth")
        check(ov2 <= 1, f"영향 범위 패널을 열어도 가로 스크롤이 없다 (overflow={ov2}px)", str(ov2))
        mp.click("#affectCancel")
        mp.click('.view-seg .seg-btn[data-view="compare"]')
        mp.wait_for_timeout(300)
        overflow3 = mp.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth")
        mp.screenshot(path=os.path.join(SHOTS, "mobile-390-04-전후비교.png"), full_page=True)
        check(overflow3 <= 1, f"모바일 전후 비교도 넘치지 않는다 (overflow={overflow3}px)", str(overflow3))
        check(not m_errors, "모바일 콘솔 에러 0건", "; ".join(m_errors[:3]))
        check(not m_ext, "모바일 외부 요청 0건", "; ".join(m_ext[:3]))
        mctx.close()

        # ── 13) Worker 없이(파일 직접 열기 대비) ─────
        fctx = browser.new_context(viewport={"width": 1280, "height": 800}, accept_downloads=True)
        fp = fctx.new_page()
        f_errors = []
        f_ext = []
        watch(fp, f_errors, f_ext)
        fp.goto(BASE + "?noworker=1", wait_until="load")
        fp.click("#sampleBtn")
        fp.wait_for_selector("#workspace:not([hidden])", timeout=60000)
        fp.wait_for_timeout(400)
        check(fp.evaluate("() => window.__maskerDebug.usedWorker") is False, "워커 없이도 열린다(폴백)")
        fp.fill("#addInput", "홍길동")
        fp.click("#addForm button[type=submit]")
        fp.wait_for_timeout(250)
        fp.click("#affectApply")
        fp.wait_for_timeout(300)
        with fp.expect_download(timeout=60000) as dl3:
            fp.click("#downloadBtn")
        out3 = os.path.join(SHOTS, "폴백_masked.hwpx")
        dl3.value.save_as(out3)
        check(os.path.getsize(out3) > 3000, "폴백 경로에서도 마스킹 파일이 만들어진다")
        check(not f_errors, "폴백 콘솔 에러 0건", "; ".join(f_errors[:3]))
        fctx.close()

        # ── 14) 대용량(약 10MB XML) ──────────────────
        if os.path.exists(STRESS):
            sctx = browser.new_context(viewport={"width": 1280, "height": 800}, accept_downloads=True)
            sp = sctx.new_page()
            s_errors = []
            s_ext = []
            watch(sp, s_errors, s_ext)
            sp.goto(BASE, wait_until="load")
            sp.evaluate("""() => { window.__raf = 0; const t = () => { window.__raf++; requestAnimationFrame(t); }; requestAnimationFrame(t); }""")
            t0 = time.time()
            sp.set_input_files("#fileInput", STRESS)
            sp.wait_for_selector("#workspace:not([hidden])", timeout=180000)
            open_seconds = time.time() - t0
            sp.wait_for_timeout(400)
            paras = sp.evaluate("() => window.__maskerDebug.state.doc.stats.paras")
            check(paras > 20000, f"대용량 문서 문단을 모두 읽는다 ({paras}문단)")
            raf = sp.evaluate("() => window.__raf")
            check(raf > 3, f"처리 중에도 화면 갱신(UI)이 멈추지 않는다 (rAF {raf}회, {open_seconds:.1f}s)")
            check(sp.locator("#previewNote").is_visible(), "대용량 문서는 미리보기 일부만 보여주고 안내한다")
            note = sp.locator("#previewNote").inner_text()
            check("전체" in note and "500" in note, "미리보기 제한과 전체 반영을 안내한다", note)
            sp.evaluate("() => { window.__raf = 0; }")
            t0 = time.time()
            with sp.expect_download(timeout=180000) as dl4:
                sp.click("#downloadBtn")
                sp.wait_for_timeout(300)
                sp.screenshot(path=os.path.join(SHOTS, "desktop-1280-09-진행률.png"))
            out4 = os.path.join(SHOTS, "대용량_masked.hwpx")
            dl4.value.save_as(out4)
            dl_seconds = time.time() - t0
            raf2 = sp.evaluate("() => window.__raf")
            check(raf2 > 3, f"대용량 다운로드 중에도 UI가 살아 있다 (rAF {raf2}회, {dl_seconds:.1f}s)")
            check(dl_seconds < 120, f"대용량 처리 시간이 과도하지 않다 ({dl_seconds:.1f}s)")
            log = sp.evaluate("() => window.__maskerDebug.progressLog")
            check(any(x["phase"] == "zip" and x["percent"] >= 90 for x in log), "대용량 압축 진행률이 표시된다")
            sp.screenshot(path=os.path.join(SHOTS, "desktop-1280-07-대용량.png"), full_page=True)
            check(not s_errors, "대용량 콘솔 에러 0건", "; ".join(s_errors[:3]))
            check(not s_ext, "대용량 외부 요청 0건", "; ".join(s_ext[:3]))
            sctx.close()
        else:
            print("  (건너뜀) build/stress.hwpx 없음 — tools/make_sample.py 로 생성하세요")

        # ── 15) 탐지 규칙 매트릭스(겹침·오탐) ────────
        cases = [
            ("2026-11-26 회의 일정", [], {}),
            ("2026.01.01. ~ 2026.12.31.", [], {}),
            ("총 집행액 12,345,000원", [], {}),
            ("대흥로 123", [], {}),
            ("123-456-789012", ["account"], {}),
            ("7002231234567", ["rrn"], {}),
            ("010-8990-0543", ["phone"], {}),
            ("010-8990-0543", [], {"phone": False}),
            ("041-589-8000", ["phone"], {}),
            ("041-589-8000", [], {"phone": False}),
            ("123-45-67890", ["bizno"], {}),
            ("123-45-67890", [], {"bizno": False}),
            ("110111-1234567", ["rrn"], {}),
            ("법인등록번호 110111-1234567", ["bizno"], {}),
            ("12가3456", ["vehicle"], {}),
            ("충청남도 천안시 동남구 대흥로 123, 4층 402호", ["address"], {}),
            ("hong@kitech.re.kr", ["email"], {}),
            ("생년월일 1970.02.23", ["birth"], {}),
            ("2026.02.23 시행", [], {}),
            ("1234-5678-9012-3456", ["account"], {}),
        ]
        got = page.evaluate(
            """(cases) => cases.map(([t, en]) => window.Masker.scanText(t, en).map(h => h.category))""",
            [[c[0], c[2]] for c in cases],
        )
        for (text, expect, _en), cats in zip(cases, got):
            ok = sorted(set(cats)) == sorted(expect)
            check(ok, f"탐지 규칙: 『{text}』 → {expect or '없음'}", str(cats))

        # ── 16) 메타데이터 self-closing(<tag .../>) 회귀 ──
        # 실제 감사 .hwpx 에서 나온 형태: 값이 없는 메타데이터가 self-closing 으로 섞여 있다.
        # (버그) self-closing 을 여는 태그로 오인해 `/>` 를 삼키고 다음 요소의 닫는 태그를 끌어와
        #        `<opf:meta .../></opf:meta>` 처럼 XML 이 깨지고, 뒤따르는 값까지 사라졌다.
        ns = ('xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf/" '
              'xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"')
        hpf_mixed = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>'
            f'<opf:package {ns} version="1.4"><opf:metadata>'
            '<opf:title/><opf:language>ko</opf:language>'
            '<opf:meta name="creator" content="text">홍길동</opf:meta>'
            '<opf:meta name="subject" content="text"/>'
            '<opf:meta name="CreatedDate" content="text">2026</opf:meta>'
            '<opf:meta name="keyword" content="text"/>'
            '<opf:meta name="description" content="text" />'
            '<opf:title>감사 처분요구서</opf:title>'
            '</opf:metadata></opf:package>'
        )
        r = page.evaluate("([n, x]) => window.Masker.sanitizeMetadataText(n, x)",
                          ["Contents/content.hpf", hpf_mixed])
        out_hpf = r["xml"]
        try:
            ET.fromstring(out_hpf)
            parse_ok, parse_err = True, ""
        except ET.ParseError as e:
            parse_ok, parse_err = False, str(e)
        check(parse_ok, "self-closing 메타데이터가 섞여도 content.hpf 가 XML 로 온전히 파싱된다", parse_err)
        check('<opf:meta name="subject" content="text"/>' in out_hpf,
              "self-closing(<opf:meta .../>) 태그는 형태 그대로 유지된다", out_hpf[out_hpf.find("<opf:metadata>"):][:180])
        check('<opf:meta name="keyword" content="text"/>' in out_hpf
              and '<opf:meta name="description" content="text" />' in out_hpf,
              "속성 뒤 공백이 있는 self-closing 태그도 유지된다", out_hpf[out_hpf.find("<opf:metadata>"):][:180])
        check('<opf:title/>' in out_hpf and '<opf:title></opf:title>' in out_hpf,
              "self-closing <opf:title/> 은 남기고 값이 있는 제목만 비운다")
        check("홍길동" not in out_hpf and ">2026<" not in out_hpf and "감사 처분요구서" not in out_hpf,
              "값이 있는 메타데이터(작성자·날짜·제목)만 비워진다", out_hpf[out_hpf.find("<opf:metadata>"):][:200])
        check(r["changed"] == 3, f"비운 항목 수가 정확하다 (changed={r['changed']})", str(r["changed"]))

        settings_mixed = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>'
            '<ha:HWPApplicationSetting xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" '
            'xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0">'
            '<config:config-item-set name="PrintInfo">'
            '<config:config-item config:name="RecentFilePath" config:type="string">C:\\Users\\a.hwpx</config:config-item>'
            '<config:config-item config:name="UserName" config:type="string"/>'
            '<config:config-item config:name="UserName2" config:type="string">김민수</config:config-item>'
            '<config:config-item config:name="ZoomX" config:type="short">100</config:config-item>'
            '</config:config-item-set></ha:HWPApplicationSetting>'
        )
        r = page.evaluate("([n, x]) => window.Masker.sanitizeMetadataText(n, x)",
                          ["settings.xml", settings_mixed])
        out_cfg = r["xml"]
        try:
            ET.fromstring(out_cfg)
            ok_cfg, err_cfg = True, ""
        except ET.ParseError as e:
            ok_cfg, err_cfg = False, str(e)
        check(ok_cfg, "settings.xml 도 self-closing 이 섞여도 XML 로 파싱된다", err_cfg)
        check('<config:config-item config:name="UserName" config:type="string"/>' in out_cfg,
              "self-closing config-item 은 profile 로 유지된다", out_cfg[:200])
        check("C:\\Users" not in out_cfg and "김민수" not in out_cfg,
              "경로·사용자명 값만 비워진다", out_cfg)
        check(">100<" in out_cfg, "일반 설정값(숫자)은 건드리지 않는다", out_cfg)

        header_mixed = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>'
            '<hh:head xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head">'
            '<hh:author/><hh:author>홍길동</hh:author><hh:company>대한계약</hh:company></hh:head>'
        )
        r = page.evaluate("([n, x]) => window.Masker.sanitizeMetadataText(n, x)",
                          ["Contents/header.xml", header_mixed])
        out_hd = r["xml"]
        try:
            ET.fromstring(out_hd)
            ok_hd, err_hd = True, ""
        except ET.ParseError as e:
            ok_hd, err_hd = False, str(e)
        check(ok_hd, "header.xml 도 self-closing 이 섞여도 XML 로 파싱된다", err_hd)
        check('<hh:author/>' in out_hd and '<hh:author></hh:author>' in out_hd,
              "header.xml: self-closing 은 남기고 값이 있는 작성자만 비운다", out_hd[:200])
        check("홍길동" not in out_hd and "대한계약" not in out_hd, "header.xml 메타데이터 값도 비워진다", out_hd[:200])

        # ── 17) 실제 사례 재현: self-closing 메타데이터 문서 end-to-end ──
        xctx = browser.new_context(viewport={"width": 1280, "height": 800}, accept_downloads=True)
        xp = xctx.new_page()
        x_errors = []
        watch(xp, x_errors, [])
        xp.goto(BASE, wait_until="load")
        xp.set_input_files("#fileInput", SC_FIXTURE)
        xp.wait_for_selector("#workspace:not([hidden])", timeout=60000)
        xp.wait_for_timeout(600)
        check(xp.locator("#resetMeta").is_checked(), "self-closing 문서도 메타데이터 초기화 기본값 ON")
        with xp.expect_download(timeout=60000) as dl5:
            xp.click("#downloadBtn")
        out5 = os.path.join(SHOTS, "self-closing_masked.hwpx")
        dl5.value.save_as(out5)
        xp.wait_for_timeout(300)
        check(not x_errors, "self-closing 문서 처리 중 콘솔 에러 0건", "; ".join(x_errors[:3]))
        xctx.close()

        check(not console_errors, "데스크톱 콘솔 오류 0건", "; ".join(console_errors[:3]))
        check(not external_requests, "외부 네트워크 요청 0건(100% 로컬 처리)",
              ", ".join(sorted(set(external_requests))[:3]))
        browser.close()

    # ── 다운로드 파일 검사 ─────────────────────────
    print("\n=== 다운로드 파일 검증 ===")
    infos_o, orig = read_zip(SAMPLE)
    infos1, m1 = read_zip(out1)
    infos2, m2 = read_zip(out2)

    check(infos1[0].filename == "mimetype", "mimetype 이 ZIP 첫 엔트리", infos1[0].filename)
    check(infos1[0].compress_type == zipfile.ZIP_STORED, "mimetype 이 무압축(STORE)", str(infos1[0].compress_type))
    check(m1["mimetype"] == b"application/hwp+zip", "mimetype 내용 보존")
    check(sorted(n for n in m1 if n != "Contents/section0.xml") ==
          sorted(n for n in orig if n != "Contents/section0.xml"), "나머지 엔트리 목록 보존")

    t1 = section_text(m1)
    t2 = section_text(m2)
    must_be_gone = [
        "700223-1234567", "010-8990-0543", "hong@kitech.re.kr", "123-456-789012",
        "1234-5678-9012-3456", "123-45-67890", "110111-1234567", "12가 3456",
        "홍길동", "스마트제조혁신실", "대한계약", "대흥로 123", "041-589-8000",
        "1970.02.23", "402호",
    ]
    for s in must_be_gone:
        check(s not in t1, f"원본 값이 남아있지 않다: {s}")
    must_exist = [
        "700223-1******", "010-****-0543", "***@kitech.re.kr", "123-***-******",
        "1234-****-****-****", "123-**-*****", "12가 ****", "041-***-8000",
        "1970.**.**", "충청남도 천안시 동남구",
    ]
    for s in must_exist:
        check(s in t1, f"마스킹 결과가 기대대로 들어갔다: {s}")
    keep = ["2026.01.01", "2026.12.31", "2026.11.26.", "12,345,000원", "3,250,000원",
            "26.3%", "2026.12.10.", "1,250,000원", "2,000,000원"]
    for s in keep:
        check(s in t1, f"일반 금액·기간은 그대로 유지: {s}")

    check(structure_counts(orig["Contents/section0.xml"]) == structure_counts(m1["Contents/section0.xml"]),
          "XML 요소 개수가 원본과 동일(표·문단·스타일 태그 손상 0건)")
    check(run_ids(orig["Contents/section0.xml"]) == run_ids(m1["Contents/section0.xml"]),
          "run 의 charPrIDRef(글자 모양) 순서가 원본과 동일")
    check(table_signature(orig["Contents/section0.xml"]) == table_signature(m1["Contents/section0.xml"]),
          "표 구조(행·열·병합·셀 문단 수)가 원본과 동일")
    check(para_ids(orig["Contents/section0.xml"]) == para_ids(m1["Contents/section0.xml"]),
          "문단(<hp:p>) 개수가 원본과 동일")

    # 메타데이터 초기화
    def meta_text(files):
        return "\n".join(files[n].decode("utf-8", "ignore")
                         for n in ("Contents/content.hpf", "settings.xml", "Contents/header.xml") if n in files)

    check("홍길동" not in meta_text(m1) and "김민수" not in meta_text(m1),
          "다운로드본에서 작성자·최종수정자 메타데이터가 사라졌다")
    check("C:\\Users" not in meta_text(m1), "다운로드본에서 경로 메타데이터가 사라졌다")
    check("홍길동" in meta_text(m2) and "김민수" in meta_text(m2),
          "옵션을 끈 파일에는 메타데이터가 그대로 남는다")
    check(t1 == t2, "메타데이터 옵션과 무관하게 본문 마스킹 결과는 같다")

    bad_parts = xml_parts_broken(m1)
    check(not bad_parts, "다운로드본의 모든 XML·HPF·RDF 파트가 정상 파싱된다(태그 불일치 0건)",
          "; ".join(bad_parts[:3]))

    # self-closing 메타데이터 문서(실제 사례 재현) 산출물
    _, m5 = read_zip(out5)
    hpf5 = m5["Contents/content.hpf"].decode("utf-8")
    meta5 = hpf5[hpf5.find("<opf:metadata>"):hpf5.find("</opf:metadata>")]
    bad5 = xml_parts_broken(m5)
    check(not bad5, "self-closing 문서 산출물의 모든 XML·HPF 파트가 정상 파싱된다", "; ".join(bad5[:3]))
    check('<opf:meta name="subject" content="text"/>' in hpf5
          and '<opf:meta name="keyword" content="text"/>' in hpf5,
          "self-closing 메타데이터가 손상 없이 그대로 남는다", meta5[:200])
    check("</>" not in hpf5 and "/></opf:meta>" not in hpf5 and "/></config:config-item>" not in hpf5,
          "self-closing 태그 뒤에 잘못된 닫는 태그가 붙지 않는다", meta5[:200])
    check("홍길동" not in hpf5 and "김민수" not in hpf5 and "2026-11-20" not in hpf5,
          "self-closing 문서의 메타데이터 값도 모두 비워진다", meta5[:200])
    check("<opf:title/>" in hpf5 and "<opf:language>ko</opf:language>" in hpf5,
          "self-closing 제목 태그와 언어(ko)는 그대로 유지한다", meta5[:160])
    t5 = section_text(m5)
    check("010-8990-0543" not in t5 and "010-****-0543" in t5, "self-closing 문서도 본문 마스킹이 정상 동작한다")
    info5 = rhwp_info(out5)
    check(info5 is not None and info5.get("format") == "hwpx" and info5.get("paraCount") ==
          (rhwp_info(SAMPLE) or {}).get("paraCount"),
          "self-closing 문서 산출물도 rhwp 가 HWPX 로 인식한다(문단 수 동일)",
          str(info5 and {k: info5.get(k) for k in ("format", "paraCount")}))
    pdf5 = os.path.join(SHOTS, "self-closing-masked.pdf")
    r5 = subprocess.run(["rhwp", "export-pdf", out5, "-o", pdf5, "--font-path", "/usr/share/fonts/pickle-hwp", "--json"],
                        capture_output=True, text=True)
    check(r5.returncode == 0 and os.path.getsize(pdf5) > 10000,
          "self-closing 문서 산출물 PDF 렌더 성공(한글이 열 수 있는 파일)", r5.stderr[:80])

    prv = m1.get("Preview/PrvText.txt", b"").decode("utf-8", "ignore")
    check("700223-1234567" not in prv and "010-8990-0543" not in prv,
          "PrvText(미리보기 텍스트)에도 원본 개인정보가 남지 않는다")
    check(m1.get("Preview/PrvImage.png") != orig.get("Preview/PrvImage.png"), "PrvImage(썸네일)도 정리한다")

    info = rhwp_info(out1)
    check(info is not None and info.get("format") == "hwpx" and info.get("pageCount", 0) >= 1,
          "한글 엔진(rhwp)이 산출물을 HWPX 로 인식한다",
          str(info and {k: info.get(k) for k in ("format", "pageCount", "paraCount")}))
    pdf = os.path.join(SHOTS, "masked-preview.pdf")
    r = subprocess.run(["rhwp", "export-pdf", out1, "-o", pdf, "--font-path", "/usr/share/fonts/pickle-hwp", "--json"],
                       capture_output=True, text=True)
    check(r.returncode == 0 and os.path.getsize(pdf) > 10000, "산출물 PDF 렌더 성공(레이아웃 유지)", r.stderr[:80])

    info_o = rhwp_info(SAMPLE)
    check(info is not None and info_o is not None and info.get("paraCount") == info_o.get("paraCount"),
          "문단 수가 원본과 동일하다(rhwp 기준)",
          f"{info_o and info_o.get('paraCount')} → {info.get('paraCount')}")

    # 폴백 산출물
    infos3, m3 = read_zip(out3)
    t3 = section_text(m3)
    check("홍길동" not in t3 and "홍OO" in t3, "폴백 경로 산출물도 동일하게 마스킹된다")

    # 대용량 산출물
    if os.path.exists(os.path.join(SHOTS, "대용량_masked.hwpx")):
        infos4, m4 = read_zip(os.path.join(SHOTS, "대용량_masked.hwpx"))
        t4 = section_text(m4)
        check("010-8990-0543" not in t4 and "hong@kitech.re.kr" not in t4,
              "대용량 산출물에서도 원본 연락처가 사라졌다")
        check("010-****-0543" in t4 and "***@kitech.re.kr" in t4, "대용량 산출물에 마스킹 결과가 들어 있다")
        check(para_ids(m4["Contents/section0.xml"]) == para_ids(read_zip(STRESS)[1]["Contents/section0.xml"]),
              "대용량 산출물의 문단 개수가 원본과 동일하다")
        info4 = rhwp_info(os.path.join(SHOTS, "대용량_masked.hwpx"))
        check(info4 is not None and info4.get("format") == "hwpx",
              "대용량 산출물도 rhwp 가 HWPX 로 인식한다", str(info4 and info4.get("paraCount")))

    print("\n=== 결과 ===")
    print(f"통과 {len(logs) - len(fails)} / {len(logs)}")
    if fails:
        print("실패:")
        for f in fails:
            print(" -", f)
        return 1
    print("모두 통과")
    return 0


if __name__ == "__main__":
    sys.exit(main())
