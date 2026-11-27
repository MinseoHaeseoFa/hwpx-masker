#!/usr/bin/env python3
"""「감사 처분요구서(가상)」 샘플 .hwpx 생성기.

민감정보 안심마스커의 '샘플 체험'과 E2E 검증에 쓰는 실제 HWPX 파일을 만든다.
- rhwp scaffold 로 유효한 HWPX 생성(자체 header.xml 사용, 외부 서식 파일 미사용)
- 표 셀 병합(rhwp edit merge-cells)과 여러 <hp:t> 로 쪼개진 run(split) 재현
- 머리말·꼬리말·각주에 연락처를 넣어 '본문 외 영역' 점검을 검증할 수 있게 한다
- content.hpf / settings.xml 에 작성자·최종수정자·요약·경로 메타데이터를 넣어
  '메타데이터 초기화' 기능을 실측 검증할 수 있게 한다
- assets/sample-data.js(샘플 체험용 base64)까지 함께 갱신
- build/stress.hwpx : 수만 문단 규모 대용량 문서(워커·진행률 검증용)

사용: python3 tools/make_sample.py            # 샘플 + sample-data.js + stress
      python3 tools/make_sample.py --no-stress
"""
import base64
import json
import os
import random
import re
import subprocess
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, "build")
SAMPLE_DIR = os.path.join(ROOT, "sample")
ASSETS = os.path.join(ROOT, "assets")
OUT_NAME = "감사처분요구서_샘플.hwpx"

TITLE = "감사 처분요구서(가상 샘플)"
SUBHEAD_TEXTS = ["1. 감사 개요", "2. 피감사인 인적사항", "3. 지적사항"]

HEADER_TEXT = "대외비 · 담당 010-8990-0543"
FOOTER_TEXT = "문의 hong@kitech.re.kr"
FOOTNOTE_TEXT = "문의: 010-8990-0543 / 041-589-8000"

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
SPLITS = [
    ("○ 피감사인 성명은 홍길동(스마트제조혁신실)이며, 연락처는 010-8990-0543, 이메일 hong@kitech.re.kr 이다.",
     [("○ 피감사인 성명은 ", "0"), ("홍", "0"), ("길", "0"), ("동", "0"),
      ("(스마트제조혁신실)이며, 연락처는 ", "0"), ("010-", "0"), ("8990", "0"), ("-0543", "0"),
      (", 이메일 ", "0"), ("hong@kitech.re.kr", "0"), (" 이다.", "0")]),
    ("○ 주민등록번호 700223-1234567, 생년월일 1970.02.23 확인.",
     [("○ 주민등록번호 ", "0"), ("700223-", "0"), ("1234567", "0"), (", 생년월일 1970.02.23 확인.", "0")]),
]

# 가상의 작성자 메타데이터(초기화 기능 검증용)
META_CREATOR = "홍길동"
META_LASTSAVE = "김민수"
META_PATH = "C:\\Users\\홍길동\\Desktop\\감사자료\\처분요구서.hwpx"
META_SUBJECT = "2026년 내부감사 처분"


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
        return re.compile(r'<hp:run charPrIDRef="0"><hp:t>' + re.escape(esc(text)) + r"</hp:t></hp:run>")
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
        pattern = re.compile(r'<hp:run charPrIDRef="\d+"><hp:t>' + re.escape(esc(text)) + r"</hp:t></hp:run>")
        m = pattern.search(xml)
        if not m:
            raise SystemExit(f"문단을 찾지 못했습니다: {text[:40]}")
        new_runs = "".join(
            f'<hp:run charPrIDRef="{cp}"><hp:t>{esc(piece)}</hp:t></hp:run>' for piece, cp in parts
        )
        xml = xml[: m.start()] + new_runs + xml[m.end():]
    return xml


def read_zip(path):
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        return names, {n: z.read(n) for n in names}


def write_zip(path, names, data):
    order = ["mimetype"] + [n for n in names if n != "mimetype"]
    with zipfile.ZipFile(path, "w") as z:
        for n in order:
            comp = zipfile.ZIP_STORED if n == "mimetype" else zipfile.ZIP_DEFLATED
            z.writestr(n, data[n], compress_type=comp)


def inject_footnote_text(xml: str) -> str:
    """rhwp 가 만든 빈 각주 문단(<hp:t> </hp:t>)에 실제 연락처를 넣는다."""
    i = xml.find("<hp:footNote")
    if i < 0:
        raise SystemExit("각주를 찾지 못했습니다")
    j = xml.find("<hp:t> </hp:t>", i)
    if j < 0:
        raise SystemExit("각주 문단 텍스트를 찾지 못했습니다")
    return xml[:j] + f"<hp:t>{esc(FOOTNOTE_TEXT)}</hp:t>" + xml[j + len("<hp:t> </hp:t>"):]


def inject_metadata(names, data):
    hpf = data["Contents/content.hpf"].decode("utf-8")
    hpf = hpf.replace("<opf:title/>", "<opf:title>감사 처분요구서</opf:title>")
    hpf = hpf.replace(
        '<opf:meta name="creator" content="text">rhwp</opf:meta>',
        f'<opf:meta name="creator" content="text">{META_CREATOR}</opf:meta>'
        f'<opf:meta name="lastsaveby" content="text">{META_LASTSAVE}</opf:meta>'
        f'<opf:meta name="subject" content="text">{META_SUBJECT}</opf:meta>'
        f'<opf:meta name="description" content="text">{esc(META_PATH)}</opf:meta>'
    )
    hpf = hpf.replace('<opf:meta name="CreatedDate" content="text"/>',
                      '<opf:meta name="CreatedDate" content="text">2026-11-20T09:12:00Z</opf:meta>')
    hpf = hpf.replace('<opf:meta name="ModifiedDate" content="text"/>',
                      '<opf:meta name="ModifiedDate" content="text">2026-11-26T22:41:00Z</opf:meta>')
    if META_CREATOR not in hpf:
        raise SystemExit("content.hpf 메타데이터 주입 실패")
    data["Contents/content.hpf"] = hpf.encode("utf-8")

    st = data["settings.xml"].decode("utf-8")
    extra = (
        '<ha:config>'
        f'<config:config-item config:name="RecentFilePath" config:type="string">{esc(META_PATH)}</config:config-item>'
        f'<config:config-item config:name="UserName" config:type="string">{META_LASTSAVE}</config:config-item>'
        '</ha:config>'
    )
    st = st.replace("</ha:HWPApplicationSetting>", extra + "</ha:HWPApplicationSetting>")
    if META_LASTSAVE not in st:
        raise SystemExit("settings.xml 메타데이터 주입 실패")
    data["settings.xml"] = st.encode("utf-8")
    return names, data


def embed_sample_data(sample_path):
    with open(sample_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    out = (
        "/* 「감사 처분요구서(가상)」 샘플 — tools/make_sample.py 가 생성. 직접 수정하지 마세요. */\n"
        "window.HWPX_SAMPLE = {\n"
        f'  name: "{OUT_NAME}",\n'
        f'  b64: "{b64}"\n'
        "};\n"
    )
    with open(os.path.join(ASSETS, "sample-data.js"), "w", encoding="utf-8") as f:
        f.write(out)
    print("샘플 데이터:", os.path.join(ASSETS, "sample-data.js"), len(b64), "chars")


def make_stress(count=22000):
    """수만 문단 규모 문서 — 워커 처리·진행률 검증용(브라우저에 내장하지 않음)."""
    random.seed(20261127)
    words = "감사 결과 보고서 내용 계약 회계 인사 분야 점검 지적 사항 처리 기한 회신 요구 기관 부서 담당자 예산 집행".split()
    blocks = []
    for i in range(count):
        if i % 40 == 0:
            blocks.append({"type": "paragraph",
                           "text": f"{i} 피감사인 홍길동 연락처는 010-8990-0543, 이메일 hong@kitech.re.kr 이다."})
        elif i % 211 == 0:
            blocks.append({"type": "table", "rows": [
                ["성명", "홍길동"], ["소속", "스마트제조혁신실"],
                ["연락처", "010-8990-0543"], ["이메일", "hong@kitech.re.kr"]]})
        else:
            s = " ".join(random.choice(words) for _ in range(14))
            blocks.append({"type": "paragraph", "text": f"{i} {s} ({2026 if i % 2 else 2025}년 자료)"})
    spec = {"version": "1", "title": "", "blocks": blocks}
    spec_path = os.path.join(BUILD, "spec-stress.json")
    with open(spec_path, "w", encoding="utf-8") as f:
        json.dump(spec, f, ensure_ascii=False)
    out = os.path.join(BUILD, "stress.hwpx")
    run(["rhwp", "scaffold", spec_path, "--format", "hwpx", "-o", out, "--json"])
    with zipfile.ZipFile(out) as z:
        section = z.getinfo("Contents/section0.xml").file_size
    print(f"대용량 검증용: {out} ({os.path.getsize(out)} bytes, section XML {section:,} bytes)")
    return out


def main():
    no_stress = "--no-stress" in sys.argv
    os.makedirs(BUILD, exist_ok=True)
    os.makedirs(SAMPLE_DIR, exist_ok=True)

    spec_path = os.path.join(BUILD, "spec-sample.json")
    with open(spec_path, "w", encoding="utf-8") as f:
        json.dump(SPEC, f, ensure_ascii=False, indent=2)

    raw = os.path.join(BUILD, "sample-raw.hwpx")
    run(["rhwp", "scaffold", spec_path, "--format", "hwpx", "-o", raw, "--json"])

    # 표 3(지적 내역) 머리행을 3열 병합 → 병합 셀 구조 재현
    merged = os.path.join(BUILD, "sample-merged.hwpx")
    run(["rhwp", "edit", "merge-cells", raw, "--table", "2", "--row", "0",
         "--col", "0", "--end-row", "0", "--end-col", "2", "-o", merged, "--json"])

    names, data = read_zip(merged)
    xml = data["Contents/section0.xml"].decode("utf-8")
    xml = emphasize(xml)
    xml = split_runs(xml)
    data["Contents/section0.xml"] = xml.encode("utf-8")
    staged = os.path.join(BUILD, "sample-staged.hwpx")
    write_zip(staged, names, data)

    # 머리말·꼬리말·각주(본문 외 영역) 추가
    hf1 = os.path.join(BUILD, "hf1.hwpx")
    run(["rhwp", "edit", "insert-header-footer", staged, "--header", "-o", hf1, "--json"])
    hf2 = os.path.join(BUILD, "hf2.hwpx")
    run(["rhwp", "edit", "insert-header-footer-text", hf1, "--header",
         "--text", HEADER_TEXT, "-o", hf2, "--json"])
    hf3 = os.path.join(BUILD, "hf3.hwpx")
    run(["rhwp", "edit", "insert-header-footer", hf2, "--footer", "-o", hf3, "--json"])
    hf4 = os.path.join(BUILD, "hf4.hwpx")
    run(["rhwp", "edit", "insert-header-footer-text", hf3, "--footer",
         "--text", FOOTER_TEXT, "-o", hf4, "--json"])
    fn = os.path.join(BUILD, "sample-with-note.hwpx")
    run(["rhwp", "edit", "insert-footnote", hf4, "--section", "0", "--para", "6",
         "--offset", "2", "-o", fn, "--json"])

    names, data = read_zip(fn)
    xml = data["Contents/section0.xml"].decode("utf-8")
    xml = inject_footnote_text(xml)
    data["Contents/section0.xml"] = xml.encode("utf-8")
    names, data = inject_metadata(names, data)

    out_path = os.path.join(SAMPLE_DIR, OUT_NAME)
    write_zip(out_path, names, data)

    # ---- 무결성 확인
    info = json.loads(run(["rhwp", "info", out_path, "--json"]))
    print("info:", {k: info.get(k) for k in ("format", "pageCount", "paraCount", "sections", "title")})
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
        section = z.getinfo("Contents/section0.xml").file_size
        all_text = "\n".join(z.read(n).decode("utf-8", "ignore") for n in z.namelist()
                             if n.endswith((".xml", ".hpf", ".rdf", ".txt")))
        print("첫 엔트리:", first.filename, "compress_type", first.compress_type)
        print("section XML:", f"{section:,} bytes")
    for token in (HEADER_TEXT, FOOTER_TEXT, FOOTNOTE_TEXT, META_CREATOR, META_LASTSAVE, META_PATH):
        print(f"  포함 확인: {token[:24]} →", token in all_text)
    print("완료:", out_path, os.path.getsize(out_path), "bytes")

    embed_sample_data(out_path)
    if not no_stress:
        make_stress()


if __name__ == "__main__":
    main()
