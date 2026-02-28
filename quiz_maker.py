import os
import time
import glob
import random
from datetime import datetime
from importlib.metadata import version

import google.generativeai as genai
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.utils import simpleSplit


# ==============================
# API KEY (환경변수에서 읽기)
# ==============================
API_KEY = os.getenv("GEMINI_FREE_API_KEY", "").strip()
if not API_KEY:
    raise RuntimeError(
        "❌ GEMINI_API_KEY 환경변수가 없습니다.\n"
        "API 키를 코드에 직접 쓰지 말고 환경변수로 설정하세요."
    )

# Gemini 초기화 (가장 먼저)
genai.configure(api_key=API_KEY)

print("내 라이브러리 버전:", version("google-generativeai"))
print("\n--- 사용 가능한 모델 목록 ---")
for m in genai.list_models():
    if getattr(m, "supported_generation_methods", None):
        if "generateContent" in m.supported_generation_methods:
            print(m.name)


# ==============================
# 경로 설정
# ==============================
BASE_DIR = (
    os.path.dirname(os.path.abspath(__file__))
    if "__file__" in globals()
    else os.getcwd()
)

SOURCE_FOLDER = os.path.join(BASE_DIR, "pdfs")
OUTPUT_FOLDER = os.path.join(BASE_DIR, "results")

FONT_PATH = "C:/Windows/Fonts/malgun.ttf"


# ==============================
# PDF 업로드
# ==============================
def upload_to_gemini(path):
    print(f"📄 파일 업로드 중: {os.path.basename(path)}")

    file = genai.upload_file(path, mime_type="application/pdf")

    # 처리 상태 안정적 체크
    while True:
        state = getattr(file, "state", None)
        state_name = getattr(state, "name", state)

        if state_name == "PROCESSING":
            print(".", end="", flush=True)
            time.sleep(2)
            file = genai.get_file(file.name)
            continue

        if state_name in ("FAILED", "ERROR"):
            raise RuntimeError(f"업로드 실패 상태: {state_name}")

        break

    print("\n✅ 업로드 완료")
    return file


# ==============================
# 문제 생성
# ==============================
def generate_quiz(file_obj):
    print("🤖 문제 생성 중...")

    model = genai.GenerativeModel("gemini-1.5-flash")

    prompt = """
이 문서의 핵심 내용을 기반으로 학습용 문제 5개를 만들어줘.

반드시 아래 형식 유지:

[문제 1]
(객관식 문제 내용)
(a) 보기 (b) 보기 (c) 보기 (d) 보기

[정답 및 해설]
정답: (정답)
해설: (설명)

---

위 형식을 총 5개 반복.
"""

    response = model.generate_content([file_obj, prompt])
    return response.text


# ==============================
# PDF 생성
# ==============================
def create_pdf(text, filename):
    c = canvas.Canvas(filename, pagesize=A4)
    width, height = A4

    margin = 50
    y = height - 50

    # 폰트 설정
    font_name = "Helvetica"
    if os.path.exists(FONT_PATH):
        try:
            pdfmetrics.registerFont(TTFont("Malgun", FONT_PATH))
            font_name = "Malgun"
        except Exception:
            pass

    # 제목
    c.setFont(font_name, 16)
    c.drawString(margin, y, f"Daily Quiz - {datetime.now():%Y-%m-%d}")
    y -= 40

    # 본문
    c.setFont(font_name, 11)
    for line in text.split("\n"):
        wrapped_lines = simpleSplit(line, font_name, 11, width - (margin * 2))

        for wrapped_line in wrapped_lines:
            if y < 50:
                c.showPage()
                c.setFont(font_name, 11)
                y = height - 50

            c.drawString(margin, y, wrapped_line)
            y -= 15

    c.save()


# ==============================
# 메인 실행
# ==============================
def main():
    os.makedirs(OUTPUT_FOLDER, exist_ok=True)

    pdf_files = glob.glob(os.path.join(SOURCE_FOLDER, "*.pdf"))

    if not pdf_files:
        print(f"❌ '{SOURCE_FOLDER}' 폴더에 PDF 없음")
        return

    target_pdf = random.choice(pdf_files)
    uploaded_file = None

    try:
        # 1 업로드
        uploaded_file = upload_to_gemini(target_pdf)

        # 2 문제 생성
        quiz_text = generate_quiz(uploaded_file)

        # 3 PDF 저장
        output_name = f"Quiz_{datetime.now():%Y%m%d_%H%M}.pdf"
        output_path = os.path.join(OUTPUT_FOLDER, output_name)

        create_pdf(quiz_text, output_path)

        print(f"\n🎉 생성 완료 → {output_name}")

    except Exception as e:
        print(f"\n❌ 오류 발생: {e}")

    finally:
        # 서버 업로드 파일 삭제
        if uploaded_file:
            try:
                genai.delete_file(uploaded_file.name)
                print("🧹 서버 파일 삭제 완료")
            except Exception:
                pass


if __name__ == "__main__":
    main()
