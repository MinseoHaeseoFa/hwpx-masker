#!/usr/bin/env python3
"""배포본(https://hwpx-masker.vercel.app/) 라이브 검증.

- 콘솔 에러 0건 / 사이트 밖으로 나가는 네트워크 요청 0건
- 샘플 열기 → 탐지·미리보기·본문 외 영역·Worker 표시
- 전화 카테고리 토글 시 건수·목록 동기화(전화→계좌 재분류 없음)
- 전후 비교 뷰 / 단어 일치 치환(과잉 치환 방지)
- 다운로드 파일이 _masked.hwpx 이고 원본 개인정보가 없다
- 데스크톱·모바일 스크린샷 저장

사용:
  LD_LIBRARY_PATH=/workspace/.chromelibs:/workspace/.chrome-libs/usr/lib/x86_64-linux-gnu \
      python3 tests/verify_live.py
"""
import os
import sys
import zipfile
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

LIVE = "https://hwpx-masker.vercel.app/"
SHOTS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                     "..", "downloads", "hwpx-masker-v2-2026-11-27")
fails = []
logs = []
ALLOWED = {"hwpx-masker.vercel.app"}


def check(ok, msg, extra=""):
    logs.append((ok, msg, extra))
    if not ok:
        fails.append(msg + (f" — {extra}" if extra else ""))
    print(("  ✅ " if ok else "  ❌ ") + msg + (f"  [{extra}]" if extra and not ok else ""))


def main():
    os.makedirs(SHOTS, exist_ok=True)
    errors = []
    external = []
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--no-sandbox"])
        ctx = browser.new_context(viewport={"width": 1280, "height": 800}, accept_downloads=True)
        page = ctx.new_page()
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("request", lambda r: external.append(r.url)
                if urlparse(r.url).netloc and urlparse(r.url).netloc not in ALLOWED else None)

        page.goto(LIVE, wait_until="load")
        page.wait_for_timeout(600)
        check("민감정보 안심마스커" in page.title(), "라이브 타이틀", page.title())
        page.screenshot(path=os.path.join(SHOTS, "live-1280-01-시작화면.png"), full_page=True)

        page.click("#sampleBtn")
        page.wait_for_selector("#workspace:not([hidden])", timeout=60000)
        page.wait_for_timeout(800)
        hits = int(page.locator("#statHits").inner_text())
        check(hits >= 30, f"라이브 자동 탐지 (hits={hits})", str(hits))
        check(page.locator(".extra-card").count() == 3, "라이브 본문 외 영역(머리말·꼬리말·각주) 표시")
        check(page.locator("#regionList .region-item").count() == 3, "라이브 본문 외 영역 점검 카드")
        check(page.evaluate("() => window.__maskerDebug.usedWorker") is True, "라이브 Web Worker 처리")
        badges = page.eval_on_selector_all("#catList .cat-hits", "els => els.map(e => +e.textContent)")
        phone = badges[1]
        page.uncheck("#cat-phone")
        page.wait_for_timeout(350)
        hits2 = int(page.locator("#statHits").inner_text())
        badges2 = page.eval_on_selector_all("#catList .cat-hits", "els => els.map(e => +e.textContent)")
        check(badges2[1] == 0 and hits2 == hits - phone,
              f"라이브 토글 동기화 ({hits} → {hits2}, phone={phone})", str(badges2))
        check(badges2[3] == badges[3], "라이브에서 전화번호가 계좌로 재분류되지 않는다", str(badges2[3]))
        page.check("#cat-phone")
        page.wait_for_timeout(300)

        page.click('.view-seg .seg-btn[data-view="compare"]')
        page.wait_for_timeout(400)
        check(page.locator(".diff-row").count() >= 8, "라이브 전후 비교 뷰")
        page.screenshot(path=os.path.join(SHOTS, "live-1280-02-전후비교.png"), full_page=True)

        page.click('.view-seg .seg-btn[data-view="masked"]')
        page.fill("#addInput", "감사")
        page.click("#addForm button[type=submit]")
        page.wait_for_timeout(400)
        check(page.locator("#affectPanel").is_visible(), "라이브 치환 전 영향 범위 패널")
        page.click("#affectApply")
        page.wait_for_timeout(400)
        txt = page.locator("#preview").inner_text()
        check("감O 처분요구서" in txt and "피감사인" in txt, "라이브 단어 일치 치환(과잉 치환 없음)")

        with page.expect_download(timeout=60000) as dl:
            page.click("#downloadBtn")
        out = os.path.join(SHOTS, "live_masked.hwpx")
        dl.value.save_as(out)
        page.wait_for_timeout(300)
        check(dl.value.suggested_filename.endswith("_masked.hwpx"), "라이브 다운로드 파일명", dl.value.suggested_filename)

        mctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2,
                                   is_mobile=True, has_touch=True)
        mp = mctx.new_page()
        m_errors = []
        mp.on("console", lambda m: m_errors.append(m.text) if m.type == "error" else None)
        mp.on("pageerror", lambda e: m_errors.append(str(e)))
        mp.goto(LIVE, wait_until="load")
        mp.click("#sampleBtn")
        mp.wait_for_selector("#workspace:not([hidden])", timeout=60000)
        mp.wait_for_timeout(700)
        ov = mp.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth")
        check(ov <= 1, f"라이브 모바일 가로 스크롤 없음 (overflow={ov})", str(ov))
        mp.screenshot(path=os.path.join(SHOTS, "live-390-01-마스킹.png"), full_page=True)
        check(not m_errors, "라이브 모바일 콘솔 에러 0건", "; ".join(m_errors[:3]))
        mctx.close()

        check(not errors, "라이브 콘솔 에러 0건", "; ".join(errors[:3]))
        check(not external, "라이브 외부(사이트 밖) 네트워크 요청 0건", ", ".join(sorted(set(external))[:3]))
        browser.close()

    z = zipfile.ZipFile(out)
    text = ""
    for n in z.namelist():
        if n.startswith("Contents/section") and n.endswith(".xml"):
            text += z.read(n).decode("utf-8", "ignore")
    check("700223-1234567" not in text and "010-8990-0543" not in text,
          "라이브 다운로드본에 원본 개인정보 없음")
    check("700223-1******" in text and "010-****-0543" in text, "라이브 다운로드본에 마스킹 결과 있음")
    check(z.infolist()[0].filename == "mimetype", "라이브 다운로드본 mimetype 첫 엔트리")

    print(f"\n=== 라이브 결과: {len(logs) - len(fails)} / {len(logs)} 통과 ===")
    if fails:
        for f in fails:
            print(" -", f)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
