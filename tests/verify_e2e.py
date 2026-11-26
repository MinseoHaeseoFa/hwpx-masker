#!/usr/bin/env python3
"""민감정보 안심마스커 · Playwright 전수 검증.

확인 항목
  1. 샘플 .hwpx 열기 → 자동 탐지 → 미리보기 하이라이트
  2. _masked.hwpx 다운로드 → ZIP/XML 무결성, 민감정보 100% 치환, 일반 금액·기간 보존
  3. 구형 .hwp 안내 문구, 카테고리 토글, 맞춤 치환 추가, 두 번째 다운로드(멱등성)
  4. 콘솔 에러 0건 / 외부 네트워크 요청 0건
  5. 데스크톱(1280×800)·모바일(390×844) 스크린샷 저장

사용: python3 tests/verify_e2e.py
      (샌드박스에서 chromium 라이브러리 경로가 필요하면
       LD_LIBRARY_PATH=/workspace/.chromelibs:/workspace/.chrome-libs/usr/lib/x86_64-linux-gnu)
"""
import http.server
import json
import os
import re
import shutil
import socketserver
import sys
import threading
import zipfile
import xml.etree.ElementTree as ET
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, "..", "downloads", "hwpx-masker-2026-11-26")
SAMPLE = os.path.join(ROOT, "sample", "감사처분요구서_샘플.hwpx")
PORT = 0           # 0 = 사용 가능한 포트 자동 배정
BASE = None        # 서버가 뜨면서 결정된다.

fails = []
logs = []


def check(ok, msg, extra=""):
    logs.append(("PASS" if ok else "FAIL", msg, extra))
    if not ok:
        fails.append(msg + (f" — {extra}" if extra else ""))
    print(("  ✅ " if ok else "  ❌ ") + msg + (f"  [{extra}]" if extra and not ok else ""))


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def serve(state):
    os.chdir(ROOT)
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", PORT), QuietHandler) as httpd:
        state["port"] = httpd.server_address[1]
        httpd.serve_forever()


# ─────────────────────────── HWPX 검사 도우미 ───────────────────────────
HP = "http://www.hancom.co.kr/hwpml/2011/paragraph"
NS = {"hp": HP}


def read_zip(path):
    z = zipfile.ZipFile(path)
    infos = z.infolist()
    files = {i.filename: z.read(i.filename) for i in infos}
    return infos, files


def section_text(files):
    txt = ""
    for name in sorted(n for n in files if re.match(r"Contents/section\d+\.xml$", n)):
        root = ET.fromstring(files[name].decode("utf-8"))
        txt += "\n".join(t.text or "" for t in root.iter(f"{{{HP}}}t"))
        txt += "\n"
    return txt


def structure(xml_bytes):
    root = ET.fromstring(xml_bytes.decode("utf-8"))
    return [(el.tag, tuple(sorted(el.attrib.items()))) for el in root.iter()]


def structure_counts(xml_bytes):
    root = ET.fromstring(xml_bytes.decode("utf-8"))
    counts = {}
    for el in root.iter():
        counts[el.tag.split("}")[-1]] = counts.get(el.tag.split("}")[-1], 0) + 1
    return counts


def table_signature(xml_bytes):
    """표 구조(행·열·병합) 서명."""
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


def run_field_names(xml_bytes):
    root = ET.fromstring(xml_bytes.decode("utf-8"))
    out = []
    for run in root.iter(f"{{{HP}}}run"):
        out.append(run.get("charPrIDRef"))
    return out


# ─────────────────────────────── 메인 ───────────────────────────────
def main():
    global BASE, PORT
    os.makedirs(SHOTS, exist_ok=True)
    state = {}
    t = threading.Thread(target=serve, args=(state,), daemon=True)
    t.start()
    for _ in range(100):
        if state.get("port"):
            break
        import time
        time.sleep(0.05)
    if not state.get("port"):
        print("로컬 서버를 띄우지 못했습니다.")
        return 1
    PORT = state["port"]
    BASE = f"http://127.0.0.1:{PORT}/"

    console_errors = []
    external_requests = []

    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--no-sandbox", "--allow-file-access-from-files"])
        ctx = browser.new_context(viewport={"width": 1280, "height": 800}, accept_downloads=True)
        ctx.grant_permissions(["clipboard-read", "clipboard-write"])
        page = ctx.new_page()
        page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: console_errors.append(str(e)))
        page.on(
            "request",
            lambda r: external_requests.append(r.url)
            if urlparse(r.url).netloc not in ("127.0.0.1:%d" % PORT, "localhost:%d" % PORT, "")
            else None,
        )

        # 1) 시작 화면
        page.goto(BASE, wait_until="load")
        check("민감정보 안심마스커" in page.title(), "타이틀이 「민감정보 안심마스커」로 표시된다", page.title())
        check(page.locator("#landing").is_visible(), "시작 화면이 보인다")
        check("서버 전송 없음" in page.locator(".badge").inner_text(), "보안 안심 배지가 보인다")
        og_url = page.get_attribute('meta[property="og:url"]', "content")
        og_img = page.get_attribute('meta[property="og:image"]', "content")
        tw_img = page.get_attribute('meta[name="twitter:image"]', "content")
        check(og_url == "https://hwpx-masker.vercel.app/", "og:url 이 배포 주소로 설정됨", str(og_url))
        check(og_img == "https://hwpx-masker.vercel.app/assets/og-image.png", "og:image 절대 경로", str(og_img))
        check(tw_img == og_img, "twitter:image 절대 경로", str(tw_img))
        page.screenshot(path=os.path.join(SHOTS, "desktop-1280-01-시작화면.png"), full_page=True)

        # 2) 구형 .hwp 안내
        hwp_path = os.path.join(ROOT, "build", "fake-old.hwp")
        os.makedirs(os.path.dirname(hwp_path), exist_ok=True)
        with open(hwp_path, "wb") as f:
            f.write(bytes([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]) + b"\x00" * 200)
        page.set_input_files("#fileInput", hwp_path)
        page.wait_for_timeout(400)
        toast = page.locator("#toast").inner_text()
        check("HWPX" in toast and ("다른 이름으로 저장" in toast or "변환" in toast),
              "구형 .hwp 는 HWPX 변환 안내를 보여준다", toast[:60])
        page.wait_for_timeout(100)

        # 3) 샘플 열기
        page.click("#sampleBtn")
        page.wait_for_selector("#workspace:not([hidden])", timeout=15000)
        page.wait_for_timeout(500)
        check(page.locator("#fileName").inner_text().endswith(".hwpx"), "샘플 파일명이 표시된다",
              page.locator("#fileName").inner_text())
        hits = int(page.locator("#statHits").inner_text())
        check(hits >= 20, f"자동 탐지 치환 위치가 충분히 잡힌다 (hits={hits})", str(hits))
        marks = page.locator("#preview mark.mk").count()
        check(marks >= 15, f"미리보기 하이라이트가 표시된다 (mark={marks})", str(marks))

        cat_rows = page.locator("#catList .cat-item").count()
        check(cat_rows == 8, "자동 탐지 카테고리 8종이 모두 보인다", str(cat_rows))
        label_chips = page.locator("#labelList .label-chip").count()
        check(label_chips >= 3, f"표 라벨 후보(성명·소속·업체명 등)가 추천된다 ({label_chips}건)", str(label_chips))
        item_rows = page.locator("#itemList .item-row").count()
        check(item_rows >= 10, f"가릴 항목 목록이 채워진다 ({item_rows}행)", str(item_rows))
        page.screenshot(path=os.path.join(SHOTS, "desktop-1280-02-샘플-마스킹.png"), full_page=True)

        # 4) 다운로드
        with page.expect_download(timeout=30000) as dl_info:
            page.click("#downloadBtn")
        dl = dl_info.value
        out1 = os.path.join(SHOTS, "감사처분요구서_샘플_masked.hwpx")
        dl.save_as(out1)
        check(dl.suggested_filename.endswith("_masked.hwpx"),
              "다운로드 파일명이 원본명 + _masked.hwpx", dl.suggested_filename)
        page.wait_for_timeout(300)

        # 5) 카테고리 토글 (이메일은 다른 규칙과 겹치지 않아 효과가 바로 드러난다)
        before = int(page.locator("#statHits").inner_text())
        page.uncheck("#cat-email")
        page.wait_for_timeout(250)
        after = int(page.locator("#statHits").inner_text())
        check(after < before, f"이메일 탐지를 끄면 치환 수가 줄어든다 ({before} → {after})")
        page.check("#cat-email")
        page.wait_for_timeout(250)

        # 6) 맞춤 치환 추가(금액) + 두 번째 다운로드
        page.fill("#addInput", "3,250,000원")
        page.select_option("#addStyle", "amount")
        page.click("#addForm button[type=submit]")
        page.wait_for_timeout(400)
        hint = page.locator("#addHint").inner_text()
        check("3,250,000원" in hint and "곳" in hint, "직접 입력한 금액이 문서 전체에 적용된다", hint)
        with page.expect_download(timeout=30000) as dl2:
            page.click("#downloadBtn")
        out2 = os.path.join(SHOTS, "감사처분요구서_샘플_masked2.hwpx")
        dl2.value.save_as(out2)

        # 7) 클립보드 복사
        page.click("#copyBtn")
        page.wait_for_timeout(500)
        toast2 = page.locator("#toast").inner_text()
        clip_ok = "복사" in toast2
        check(clip_ok, "AI 입력용 텍스트 복사가 동작한다", toast2[:60])
        if clip_ok:
            clip = page.evaluate("() => navigator.clipboard.readText()")
            check("700223-1234567" not in clip and "홍OO" in clip,
                  "복사된 텍스트에는 원본 개인정보가 없다", clip[:40].replace("\n", " "))
            check("2026.01.01" in clip, "복사 텍스트에 일반 감사 기간은 남는다")

        # 8) 다크 테마 화면
        dctx = browser.new_context(viewport={"width": 1280, "height": 800}, color_scheme="dark")
        dp = dctx.new_page()
        dp.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
        dp.goto(BASE, wait_until="load")
        dp.screenshot(path=os.path.join(SHOTS, "desktop-1280-00-시작화면-다크.png"), full_page=True)
        dp.click("#sampleBtn")
        dp.wait_for_selector("#workspace:not([hidden])", timeout=15000)
        dp.wait_for_timeout(600)
        check(dp.evaluate("() => document.documentElement.dataset.theme") == "dark",
              "시스템이 다크면 다크 테마로 시작한다")
        dp.screenshot(path=os.path.join(SHOTS, "desktop-1280-03-다크테마.png"), full_page=True)
        dctx.close()

        # 9) 모바일
        mctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2,
                                   is_mobile=True, has_touch=True, accept_downloads=True)
        mp = mctx.new_page()
        m_errors = []
        mp.on("console", lambda m: m_errors.append(m.text) if m.type == "error" else None)
        mp.on("pageerror", lambda e: m_errors.append(str(e)))
        mp.goto(BASE, wait_until="load")
        mp.click("#sampleBtn")
        mp.wait_for_selector("#workspace:not([hidden])", timeout=15000)
        mp.wait_for_timeout(600)
        overflow = mp.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth")
        check(overflow <= 1, f"모바일 390px 가로 스크롤이 없다 (overflow={overflow}px)", str(overflow))
        mp.screenshot(path=os.path.join(SHOTS, "mobile-390-01-시작화면.png"), full_page=True)
        mp.locator("#preview").scroll_into_view_if_needed()
        mp.wait_for_timeout(200)
        mp.screenshot(path=os.path.join(SHOTS, "mobile-390-02-미리보기.png"), full_page=True)
        mp.locator("#itemCard" if mp.locator("#itemCard").count() else "#itemList").scroll_into_view_if_needed()
        mp.wait_for_timeout(200)
        mp.screenshot(path=os.path.join(SHOTS, "mobile-390-03-목록.png"), full_page=True)
        check(not m_errors, "모바일 콘솔 에러 0건", "; ".join(m_errors[:3]))
        mctx.close()

        # 10) 탐지 규칙 매트릭스(오탐 방지)
        cases = [
            ("2026-11-26 회의 일정", []),
            ("2026.01.01. ~ 2026.12.31.", []),
            ("총 집행액 12,345,000원", []),
            ("3,250,000원", []),
            ("대흥로 123", []),
            ("123-456-789012", ["account"]),
            ("7002231234567", ["rrn"]),
            ("010-8990-0543", ["phone"]),
            ("02-123-4567", ["phone"]),
            ("12가3456", ["vehicle"]),
            ("충청남도 천안시 동남구 대흥로 123, 4층 402호", ["address"]),
            ("hong@kitech.re.kr", ["email"]),
            ("사업자 123-45-67890", ["bizno"]),
            ("생년월일 1970.02.23", ["birth"]),
            ("2026.02.23 시행", []),
            ("1234-5678-9012-3456", ["account"]),
        ]
        got = page.evaluate(
            """(cases) => cases.map(([t]) => window.Masker.scanText(t).map(h => h.category))""",
            [[c[0]] for c in cases],
        )
        for (text, expect), cats in zip(cases, got):
            ok = sorted(set(cats)) == sorted(expect)
            check(ok, f"탐지 규칙: 『{text}』 → {expect or '없음'}", str(cats))

        check(not console_errors, "데스크톱 콘솔 에러 0건", "; ".join(console_errors[:3]))
        check(not external_requests, "외부 네트워크 요청 0건(100% 로컬 처리)",
              ", ".join(sorted(set(external_requests))[:3]))
        browser.close()

    # ── 다운로드 파일 검사 ─────────────────────────────
    infos, orig = read_zip(SAMPLE)
    infos2, masked = read_zip(out1)
    infos3, masked2 = read_zip(out2)

    check(infos2[0].filename == "mimetype", "mimetype 이 ZIP 첫 엔트리", infos2[0].filename)
    check(infos2[0].compress_type == zipfile.ZIP_STORED, "mimetype 이 무압축(STORE)",
          str(infos2[0].compress_type))
    check(masked["mimetype"] == b"application/hwp+zip", "mimetype 내용 보존")
    check(sorted(n for n in masked if n != "Contents/section0.xml") ==
          sorted(n for n in orig if n != "Contents/section0.xml"),
          "mimetype·META-INF·설정 등 나머지 엔트리 목록 보존")

    text = section_text(masked)
    text2 = section_text(masked2)

    must_be_gone = [
        "700223-1234567", "010-8990-0543", "hong@kitech.re.kr", "123-456-789012",
        "1234-5678-9012-3456", "123-45-67890", "110111-1234567", "12가 3456",
        "홍길동", "스마트제조혁신실", "대한계약", "대흥로 123", "041-589-8000",
        "1970.02.23", "402호",
    ]
    for s in must_be_gone:
        check(s not in text, f"원본 값이 남아있지 않다: {s}")

    must_exist = [
        "700223-1******", "010-****-0543", "***@kitech.re.kr", "123-***-******",
        "1234-****-****-****", "123-**-*****", "12가 ****", "041-***-8000",
        "1970.**.**", "충청남도 천안시 동남구",
    ]
    for s in must_exist:
        check(s in text, f"마스킹 결과가 기대대로 들어갔다: {s}")

    # 일반 감사 금액·기간은 손대지 않는다
    keep = ["2026.01.01", "2026.12.31", "2026.11.26.", "12,345,000원", "3,250,000원",
            "26.3%", "2026.12.10.", "1,250,000원", "2,000,000원"]
    for s in keep:
        check(s in text, f"일반 금액·기간은 그대로 유지: {s}")

    # 구조 무손상
    check(structure_counts(orig["Contents/section0.xml"]) == structure_counts(masked["Contents/section0.xml"]),
          "XML 요소 개수가 원본과 동일(표·문단·스타일 태그 손상 0건)")
    check(run_field_names(orig["Contents/section0.xml"]) == run_field_names(masked["Contents/section0.xml"]),
          "run 의 charPrIDRef(글자 모양) 순서가 원본과 동일")
    check(table_signature(orig["Contents/section0.xml"]) == table_signature(masked["Contents/section0.xml"]),
          "표 구조(행·열·병합·셀 문단 수)가 원본과 동일")

    # 두 번째 다운로드(맞춤 금액 포함)는 첫 결과를 훼손하지 않는다
    check("3,250,000원" in text and "3,250,000원" not in text2, "두 번째 다운로드에서만 금액이 가려진다")
    check(text2.count("***@kitech.re.kr") == text.count("***@kitech.re.kr"),
          "여러 번 내려받아도 치환이 중복·훼손되지 않는다")

    # 미리보기 흔적 정리
    prv = masked.get("Preview/PrvText.txt", b"").decode("utf-8", "ignore")
    check("700223-1234567" not in prv and "홍길동" not in prv,
          "PrvText(미리보기 텍스트)에도 원본 개인정보가 남지 않는다", prv[:40].replace("\n", " "))
    check(masked.get("Preview/PrvImage.png") != orig.get("Preview/PrvImage.png"),
          "PrvImage(썸네일)도 원본 그대로 두지 않는다")

    # rhwp 로 실제로 열리는지
    import subprocess
    info = subprocess.run(["rhwp", "info", out1, "--json"], capture_output=True, text=True)
    ok = info.returncode == 0
    detail = ""
    if ok:
        j = json.loads(info.stdout)
        detail = f"{j.get('format')} · {j.get('pageCount')}쪽 · 문단 {j.get('paraCount')}"
        ok = j.get("format") == "hwpx" and j.get("pageCount", 0) >= 1
    check(ok, "한글 엔진(rhwp)이 산출물을 HWPX 로 인식한다", detail or info.stderr[:80])
    pdf = os.path.join(SHOTS, "masked-preview.pdf")
    r = subprocess.run(["rhwp", "export-pdf", out1, "-o", pdf,
                        "--font-path", "/usr/share/fonts/pickle-hwp", "--json"],
                       capture_output=True, text=True)
    check(r.returncode == 0, "산출물 PDF 렌더 성공(레이아웃 유지)", r.stderr[:80])

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
