#!/usr/bin/env python3
"""「감사 처분요구서(가상)」 샘플 .hwpx 생성기.

민감정보 안심마스커의 '샘플 체험'과 E2E 검증에 쓰는 실제 HWPX 파일을 만든다.
- rhwp scaffold 로 유효한 HWPX 를 만들고(자체 생성 header.xml 사용, 외부 서식 파일 미사용)
- 표 셀 병합(rhwp edit merge-cells)과 여러 <hp:t> 로 쪼개진 run(split)을 넣어
  실무 문서에서 흔한 구조를 재현한다.
- 결과물은 sample/ 에 저장하고 무결성을 검사한다.

사용: python3 tools/make_sample.py
"""
import json
import os
import re
import subprocess
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, "build")
SAMPLE_DIR = os.path.join(ROOT, "sample")
OUT_NAME = "감사처분요구서_샘플.hwpx"

TITLE = "감사 처분요구서(가상 샘플)"
SUBHEAD_TEXTS = ["1. 감사 개요", "2. 피감사인 인적사항", "3. 지적사항"]

# 일반 감사 기간·일반 금액은 '마스킹되면 안 되는' 대조군으로 일부러 넣었다.
SPEC = {
    "version": "1",
    "title": "",
    "blocks": [
        {"type": "paragraph", "text": TITLE},
        {"type": "paragraph", "text": "문서번호: KITECH-감사-2026-117    시행일자: 2026.11.26."},
        {"type": "paragraph", "text": "수신: 스마트제조혁신실장"},
        {"type": "paragraph", "text": ""},
        {"type": "paragraph", "text": "1. 감사 개요"},
        {"type": "paragraph", "text": "○ 감사기간: 2026.01.01. ~ 2026.12.31."},
        {"type": "paragraph", "text": "○ 감사대상: 스마트제조혁신실, 경영지원실"},
        {"type": "paragraph", "text": "○ 감사범위: 계약·회계·인사 분야 (총 집행액 12,345,000원)"},
        {"type": "paragraph", "text": ""},
        {"type": "paragraph", "text": "2. 피감사인 인적사항"},
        {"type": "table", "rows": [
            ["성명", "홍길동"],
            ["소속", "스마트제조혁신실"],
            ["생년월일", "1970.02.23"],
            ["주민등록번호", "700223-1234567"],
            ["휴대전화", "010-8990-0543"],
            ["이메일", "hong@kitech.re.kr"],
        ]},
        {"type": "table", "rows": [
            ["주소", "충청남도 천안시 동남구 대흥로 123, 4층 402호"],
            ["차량번호", "12가 3456"],
            ["입금계좌", "123-456-789012"],
            ["사업자등록번호", "123-45-67890"],
            ["법인등록번호", "110111-1234567"],
        ]},
        {"type": "paragraph", "text": ""},
        {"type": "paragraph", "text": "3. 지적사항"},
        {"type": "paragraph", "text": "○ 피감사인 성명은 홍길동(스마트제조혁신실)이며, 연락처는 010-8990-0543, 이메일 hong@kitech.re.kr 이다."},
        {"type": "paragraph", "text": "○ 주민등록번호 700223-1234567, 생년월일 1970.02.23 확인."},
        {"type": "paragraph", "text": "○ 유선전화 041-589-8000, 사업자등록번호 123-45-67890, 법인등록번호 110111-1234567, 차량번호 12가 3456."},
        {"type": "paragraph", "text": "○ 입금계좌 123-456-789012, 카드번호 1234-5678-9012-3456."},
        {"type": "paragraph", "text": "○ 주소 충청남도 천안시 동남구 대흥로 123, 4층 402호 로 우편물 발송."},
        {"type": "paragraph", "text": "○ 지적금액은 3,250,000원이며, 전체 집행액 12,345,000원의 26.3%에 해당한다."},
        {"type": "paragraph", "text": "○ 담당 부서: 스마트제조혁신실, 업체명: 대한계약 주식회사, 회신기한 2026.12.10."},
        {"type": "table", "rows": [
            ["구분", "지적건수", "금액"],
            ["계약", "3", "1,250,000원"],
            ["회계", "2", "2,000,000원"],
            ["합계", "5", "3,250,000원"],
        ]},
        {"type": "paragraph", "text": ""},
        {"type": "paragraph", "text": "위와 같이 처분을 요구합니다."},
        {"type": "paragraph", "text": "2026.11.26."},
        {"type": "paragraph", "text": "한국생산기술연구원 감사실"},
    ],
}

# 여러 <hp:t> 로 쪼갤 문단: (문단 전체 텍스트, [(조각, charPrIDRef), ...])
# charPr 0 = 본문(10pt), charPr 2 = 강조(12pt) — 조각마다 다른 글자 모양을 유지하는지 확인용
SPLITS = [
    ("○ 피감사인 성명은 홍길동(스마트제조혁신실)이며, 연락처는 010-8990-0543, 이메일 hong@kitech.re.kr 이다.",
     [("○ 피감사인 성명은 ", "0"), ("홍", "0"), ("길", "0"), ("동", "0"),
      ("(스마트제조혁신실)이며, 연락처는 ", "0"), ("010-", "0"), ("8990", "0"), ("-0543", "0"),
      (", 이메일 ", "0"), ("hong@kitech.re.kr", "0"), (" 이다.", "0")]),
    ("○ 주민등록번호 700223-1234567, 생년월일 1970.02.23 확인.",
     [("○ 주민등록번호 ", "0"), ("700223-", "0"), ("1234567", "0"), (", 생년월일 1970.02.23 확인.", "0")]),
]


def run(cmd, **kw):
    print("$", " ".join(cmd))
    p = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if p.returncode != 0:
        print(p.stdout)
        print(p.stderr, file=sys.stderr)
        raise SystemExit(f"명령 실패: {cmd[0]} (exit {p.returncode})")
    return p.stdout


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def emphasize(xml: str) -> str:
    """제목·소제목 문단의 글자 크기를 키운다(개요 번호 자동 매김 없이)."""
    def bump(text, char_pr):
        pattern = re.compile(
            r'<hp:run charPrIDRef="0"><hp:t>' + re.escape(esc(text)) + r"</hp:t></hp:run>"
        )
        return pattern
    for text, cp in [(TITLE, "1")] + [(t, "2") for t in SUBHEAD_TEXTS]:
        p = bump(text, cp)
        if not p.search(xml):
            raise SystemExit(f"문단을 찾지 못했습니다: {text}")
        xml = p.sub(f'<hp:run charPrIDRef="{cp}"><hp:t>{esc(text)}</hp:t></hp:run>', xml, count=1)
    return xml


def split_runs(xml: str) -> str:
    """한 문단의 단일 run/hp:t 를 여러 run 으로 쪼갠다(실무 문서의 run split 재현)."""
    for text, parts in SPLITS:
        assert "".join(p for p, _ in parts) == text, "조각 합이 원문과 다릅니다"
        pattern = re.compile(
            r'<hp:run charPrIDRef="\d+"><hp:t>' + re.escape(esc(text)) + r"</hp:t></hp:run>"
        )
        m = pattern.search(xml)
        if not m:
            raise SystemExit(f"문단을 찾지 못했습니다: {text[:40]}")
        new_runs = "".join(
            f'<hp:run charPrIDRef="{cp}"><hp:t>{esc(piece)}</hp:t></hp:run>' for piece, cp in parts
        )
        xml = xml[: m.start()] + new_runs + xml[m.end():]
    return xml


def main():
    os.makedirs(BUILD, exist_ok=True)
    os.makedirs(SAMPLE_DIR, exist_ok=True)

    spec_path = os.path.join(BUILD, "spec-sample.json")
    with open(spec_path, "w", encoding="utf-8") as f:
        json.dump(SPEC, f, ensure_ascii=False, indent=2)

    raw = os.path.join(BUILD, "sample-raw.hwpx")
    run(["rhwp", "scaffold", spec_path, "--format", "hwpx", "-o", raw])

    # 표 3(지적 내역) 머리행을 3열 병합 → 병합 셀 구조 재현
    merged = os.path.join(BUILD, "sample-merged.hwpx")
    run(["rhwp", "edit", "merge-cells", raw, "--table", "2", "--row", "0",
         "--col", "0", "--end-row", "0", "--end-col", "2", "-o", merged])

    with zipfile.ZipFile(merged) as z:
        names = z.namelist()
        data = {n: z.read(n) for n in names}
    xml = data["Contents/section0.xml"].decode("utf-8")
    xml = emphasize(xml)
    xml = split_runs(xml)
    data["Contents/section0.xml"] = xml.encode("utf-8")

    out_path = os.path.join(SAMPLE_DIR, OUT_NAME)
    order = ["mimetype"] + [n for n in names if n != "mimetype"]
    with zipfile.ZipFile(out_path, "w") as z:
        for n in order:
            comp = zipfile.ZIP_STORED if n == "mimetype" else zipfile.ZIP_DEFLATED
            z.writestr(n, data[n], compress_type=comp)

    # ---- 무결성 확인
    info = json.loads(run(["rhwp", "info", out_path, "--json"]))
    print("info:", {k: info.get(k) for k in ("format", "pageCount", "paraCount", "sections")})
    tables = json.loads(run(["rhwp", "export-tables", out_path, "--json"]))
    for t in tables["tables"]:
        span = [c for c in t["cells"] if c["colSpan"] > 1 or c["rowSpan"] > 1]
        print(f"표{t['index']}: {t['rows']}x{t['cols']} 셀 {t['cellCount']}개, 병합 {len(span)}건")
    pdf = os.path.join(BUILD, "sample-preview.pdf")
    run(["rhwp", "export-pdf", out_path, "-o", pdf,
         "--font-path", "/usr/share/fonts/pickle-hwp", "--json"])
    print("PDF:", pdf, os.path.getsize(pdf), "bytes")
    with zipfile.ZipFile(out_path) as z:
        first = z.infolist()[0]
        print("첫 엔트리:", first.filename, "compress_type", first.compress_type)
    print("완료:", out_path, os.path.getsize(out_path), "bytes")


if __name__ == "__main__":
    main()
