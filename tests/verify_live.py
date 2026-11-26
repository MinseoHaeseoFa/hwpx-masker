#!/usr/bin/env python3
"""배포본(hwpx-masker.vercel.app) 실사용 검증.

로컬 검증과 같은 기준으로 라이브 사이트를 확인한다.
사용: python3 tests/verify_live.py
"""
import os
import sys
import zipfile

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from verify_e2e import read_zip, section_text, table_signature  # noqa: E402

URL = "https://hwpx-masker.vercel.app/"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, "..", "downloads", "hwpx-masker-2026-11-26")
fails = []


def check(ok, msg, extra=""):
    print(("  ✅ " if ok else "  ❌ ") + msg + (f"  [{extra}]" if extra and not ok else ""))
    if not ok:
        fails.append(msg)


def main():
    os.makedirs(SHOTS, exist_ok=True)
    console = []
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--no-sandbox"])
        ctx = b.new_context(viewport={"width": 1280, "height": 800}, accept_downloads=True)
        pg = ctx.new_page()
        pg.on("console", lambda m: console.append(m.text) if m.type == "error" else None)
        pg.on("pageerror", lambda e: console.append(str(e)))
        r = pg.goto(URL, wait_until="load")
        check(r.status == 200, "라이브 응답 200", str(r.status))
        check("민감정보 안심마스커" in pg.title(), "타이틀 노출", pg.title())
        check(pg.get_attribute('meta[property="og:url"]', "content") == URL, "og:url = 라이브 주소")
        check(pg.get_attribute('meta[property="og:image"]', "content") == URL + "assets/og-image.png",
              "og:image 절대 경로")
        pg.screenshot(path=os.path.join(SHOTS, "live-1280-01-시작화면.png"), full_page=True)

        pg.click("#sampleBtn")
        pg.wait_for_selector("#workspace:not([hidden])", timeout=20000)
        pg.wait_for_timeout(700)
        hits = int(pg.locator("#statHits").inner_text())
        check(hits >= 20, f"라이브에서 자동 탐지 동작 (hits={hits})")
        pg.screenshot(path=os.path.join(SHOTS, "live-1280-02-마스킹.png"), full_page=True)

        with pg.expect_download(timeout=40000) as dl:
            pg.click("#downloadBtn")
        out = os.path.join(SHOTS, "live_masked.hwpx")
        dl.value.save_as(out)
        check(os.path.getsize(out) > 3000, f"다운로드 성공 ({os.path.getsize(out)} bytes)")

        # 모바일
        mc = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True)
        mp = mc.new_page()
        mp.on("console", lambda m: console.append(m.text) if m.type == "error" else None)
        mp.goto(URL, wait_until="load")
        mp.click("#sampleBtn")
        mp.wait_for_selector("#workspace:not([hidden])", timeout=20000)
        mp.wait_for_timeout(600)
        ov = mp.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth")
        check(ov <= 1, f"모바일 가로 스크롤 없음 ({ov}px)")
        mp.screenshot(path=os.path.join(SHOTS, "live-390-01-마스킹.png"), full_page=True)
        mc.close()
        check(not console, "콘솔 에러 0건", "; ".join(console[:3]))
        b.close()

    _, files = read_zip(out)
    text = section_text(files)
    for gone in ["700223-1234567", "010-8990-0543", "홍길동", "hong@kitech.re.kr"]:
        check(gone not in text, f"라이브 산출물에서 원본 제거: {gone}")
    for keep in ["700223-1******", "2026.01.01", "12,345,000원"]:
        check(keep in text, f"라이브 산출물 마스킹/보존 확인: {keep}")
    check(zipfile.ZipFile(out).infolist()[0].filename == "mimetype", "mimetype 첫 엔트리 유지")

    print("\n=== 결과 ===")
    print(f"통과 {len(fails) == 0 and '모두' or '일부'} · 실패 {len(fails)}")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
