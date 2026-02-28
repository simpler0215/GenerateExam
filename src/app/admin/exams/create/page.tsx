"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { collection, getDocs, query, where } from "firebase/firestore";

import { ClientErrorBoundary } from "@/components/client-error-boundary";
import { getClientDb } from "@/lib/firebase/client";
import { createExamFromExistingPdf, createExamWithPdf } from "@/lib/firebase/exams";

type ExamListItem = {
  examId: string;
  subject: string;
  problemPdfPath: string;
  renderStatus: string;
  pageCount: number | null;
  questionCount: number | null;
  createdAtText: string;
  createdAtMs: number;
};

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "예상하지 못한 오류가 발생했습니다.";
}

function toPositiveInt(value: unknown): number | null {
  const numericValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numericValue)) {
    return null;
  }
  const intValue = Math.floor(numericValue);
  return intValue > 0 ? intValue : null;
}

function getTimestampMillis(value: unknown): number {
  if (!value || typeof value !== "object") {
    return 0;
  }
  const maybeTimestamp = value as {
    toMillis?: () => number;
    toDate?: () => Date;
  };
  if (typeof maybeTimestamp.toMillis === "function") {
    const ms = maybeTimestamp.toMillis();
    if (Number.isFinite(ms)) {
      return ms;
    }
  }
  if (typeof maybeTimestamp.toDate === "function") {
    const date = maybeTimestamp.toDate();
    if (date instanceof Date && Number.isFinite(date.getTime())) {
      return date.getTime();
    }
  }
  return 0;
}

function getTimestampText(value: unknown): string {
  const ms = getTimestampMillis(value);
  if (!ms) {
    return "-";
  }
  return new Date(ms).toLocaleString();
}

function getRenderStatusText(status: string): string {
  if (status === "queued") {
    return "대기 중";
  }
  if (status === "running") {
    return "렌더링 중";
  }
  if (status === "ready") {
    return "완료";
  }
  if (status === "failed") {
    return "실패";
  }
  return status || "-";
}

export default function CreateExamPage() {
  const router = useRouter();

  const [subject, setSubject] = useState("");
  const [examId, setExamId] = useState("");
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [examList, setExamList] = useState<ExamListItem[]>([]);
  const [isLoadingList, setIsLoadingList] = useState(true);
  const [isRefreshingList, setIsRefreshingList] = useState(false);
  const [listErrorMessage, setListErrorMessage] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);

  const enrichQuestionCounts = useCallback(async (examIds: string[]) => {
    const normalizedIds = Array.from(new Set(examIds.map((id) => id.trim()).filter(Boolean)));
    if (normalizedIds.length === 0) {
      return;
    }

    try {
      const db = getClientDb();
      const countsByExamId = new Map<string, number>();
      const chunkSize = 10;

      for (let index = 0; index < normalizedIds.length; index += chunkSize) {
        const chunkIds = normalizedIds.slice(index, index + chunkSize);
        const questionQuery = query(collection(db, "questions"), where("examId", "in", chunkIds));
        const questionSnap = await getDocs(questionQuery);
        for (const questionDoc of questionSnap.docs) {
          const questionData = questionDoc.data() as Record<string, unknown>;
          const questionExamId =
            typeof questionData.examId === "string" ? questionData.examId : "";
          if (!questionExamId) {
            continue;
          }
          countsByExamId.set(questionExamId, (countsByExamId.get(questionExamId) ?? 0) + 1);
        }
      }

      setExamList((prev) =>
        prev.map((item) => ({
          ...item,
          questionCount: countsByExamId.has(item.examId)
            ? (countsByExamId.get(item.examId) ?? 0)
            : item.questionCount,
        })),
      );
    } catch {
      // do not block exam list rendering when question-count query fails
    }
  }, []);

  const loadExamList = useCallback(async () => {
    setListErrorMessage(null);
    setIsRefreshingList(true);

    try {
      const db = getClientDb();
      const examSnap = await getDocs(collection(db, "exams"));

      const items = examSnap.docs
        .map((docSnap): ExamListItem => {
          const data = docSnap.data() as Record<string, unknown>;
          const resolvedExamId =
            typeof data.examId === "string" && data.examId ? data.examId : docSnap.id;
          const createdAtMs = getTimestampMillis(data.createdAt);
          return {
            examId: resolvedExamId,
            subject: typeof data.subject === "string" ? data.subject : "-",
            problemPdfPath: typeof data.problemPdfPath === "string" ? data.problemPdfPath : "-",
            renderStatus: typeof data.renderStatus === "string" ? data.renderStatus : "-",
            pageCount: toPositiveInt(data.pageCount),
            questionCount: toPositiveInt(data.questionCount),
            createdAtText: getTimestampText(data.createdAt),
            createdAtMs,
          };
        })
        .sort((a, b) => {
          if (a.createdAtMs !== b.createdAtMs) {
            return b.createdAtMs - a.createdAtMs;
          }
          return a.examId.localeCompare(b.examId);
        });

      setExamList(items);
      void enrichQuestionCounts(items.map((item) => item.examId));
    } catch (error) {
      setListErrorMessage(getErrorMessage(error));
    } finally {
      setIsRefreshingList(false);
      setIsLoadingList(false);
    }
  }, [enrichQuestionCounts]);

  useEffect(() => {
    void loadExamList();
  }, [loadExamList]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    setErrorMessage(null);

    const trimmedSubject = subject.trim();
    const trimmedExamId = examId.trim();

    setIsSubmitting(true);
    setUploadProgress(0);

    try {
      if (pdfFile) {
        await createExamWithPdf({
          subject: trimmedSubject,
          examId: trimmedExamId,
          pdfFile,
          onUploadProgress: (progressPercent) => setUploadProgress(progressPercent),
        });
      } else {
        await createExamFromExistingPdf({
          subject: trimmedSubject,
          examId: trimmedExamId,
        });
      }

      await loadExamList();
      router.push(`/admin/exams/${encodeURIComponent(trimmedExamId)}/pages`);
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <ClientErrorBoundary title="시험 생성 오류">
      <main className="aq-page aq-page-wide">
        <header className="aq-hero">
          <p className="aq-kicker">AUTOQUIZ MANAGER</p>
          <h1 className="aq-title">시험 관리</h1>
          <p className="aq-desc">시험 목록 확인, 신규 시험 생성, 편집 화면 진입을 한 곳에서 진행합니다.</p>
          <Link className="aq-link-chip" href="/admin/papers/create">
            문제지 생성 페이지로 이동
          </Link>
        </header>

        <section
          className="aq-panel"
          style={{
            marginBottom: 16,
          }}
        >
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
            <h2 style={{ margin: 0, fontSize: 18 }}>기존 시험 목록</h2>
            <button
              type="button"
              className="aq-btn-primary"
              onClick={() => void loadExamList()}
              disabled={isRefreshingList}
              style={{ marginLeft: "auto" }}
            >
              {isRefreshingList ? "새로고침 중..." : "목록 새로고침"}
            </button>
          </div>

          {isLoadingList ? <p style={{ margin: 0 }}>목록을 불러오는 중...</p> : null}
          {listErrorMessage ? <p className="aq-status aq-status-error" style={{ margin: "8px 0 0" }}>{listErrorMessage}</p> : null}

          {!isLoadingList && !listErrorMessage && examList.length === 0 ? (
            <p style={{ margin: 0, color: "#555" }}>등록된 시험이 없습니다.</p>
          ) : null}

          {!isLoadingList && !listErrorMessage && examList.length > 0 ? (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 900 }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "8px 6px" }}>시험 ID</th>
                    <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "8px 6px" }}>과목</th>
                    <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "8px 6px" }}>렌더 상태</th>
                    <th style={{ textAlign: "right", borderBottom: "1px solid #ddd", padding: "8px 6px" }}>페이지 수</th>
                    <th style={{ textAlign: "right", borderBottom: "1px solid #ddd", padding: "8px 6px" }}>문제 수</th>
                    <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "8px 6px" }}>PDF 경로</th>
                    <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "8px 6px" }}>생성 시각</th>
                    <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "8px 6px" }}>바로가기</th>
                  </tr>
                </thead>
                <tbody>
                  {examList.map((item) => (
                    <tr key={item.examId}>
                      <td style={{ borderBottom: "1px solid #eee", padding: "8px 6px", fontWeight: 600 }}>{item.examId}</td>
                      <td style={{ borderBottom: "1px solid #eee", padding: "8px 6px" }}>{item.subject}</td>
                      <td style={{ borderBottom: "1px solid #eee", padding: "8px 6px" }}>{getRenderStatusText(item.renderStatus)}</td>
                      <td style={{ borderBottom: "1px solid #eee", padding: "8px 6px", textAlign: "right" }}>
                        {item.pageCount ?? "-"}
                      </td>
                      <td style={{ borderBottom: "1px solid #eee", padding: "8px 6px", textAlign: "right" }}>
                        {item.questionCount ?? "-"}
                      </td>
                      <td style={{ borderBottom: "1px solid #eee", padding: "8px 6px", color: "#555" }}>{item.problemPdfPath}</td>
                      <td style={{ borderBottom: "1px solid #eee", padding: "8px 6px", color: "#555" }}>{item.createdAtText}</td>
                      <td style={{ borderBottom: "1px solid #eee", padding: "8px 6px" }}>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          <Link href={`/admin/exams/${encodeURIComponent(item.examId)}/pages`}>페이지</Link>
                          <Link href={`/admin/exams/${encodeURIComponent(item.examId)}/edit?pageNo=1`}>편집</Link>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>

        <div style={{ marginBottom: 12 }}>
          <button type="button" className="aq-btn-primary" onClick={() => setShowCreateForm((prev) => !prev)}>
            {showCreateForm ? "신규 생성 닫기" : "신규 시험 생성"}
          </button>
        </div>

        {showCreateForm ? (
          <section
            className="aq-panel"
            style={{
              padding: 16,
            }}
          >
            <h2 style={{ marginTop: 0, marginBottom: 14, fontSize: 20 }}>신규 시험 생성</h2>

            <form onSubmit={onSubmit} style={{ display: "grid", gap: 16 }}>
              <label style={{ display: "grid", gap: 8 }}>
                <span>과목</span>
                <input
                  type="text"
                  value={subject}
                  onChange={(event) => setSubject(event.target.value)}
                  placeholder="예: biology"
                  required
                  disabled={isSubmitting}
                />
              </label>

              <label style={{ display: "grid", gap: 8 }}>
                <span>시험 ID</span>
                <input
                  type="text"
                  value={examId}
                  onChange={(event) => setExamId(event.target.value)}
                  placeholder="예: 2026-bio-01"
                  required
                  disabled={isSubmitting}
                />
              </label>

              <label style={{ display: "grid", gap: 8 }}>
                <span>문제 PDF</span>
                <input
                  type="file"
                  accept="application/pdf,.pdf"
                  onChange={(event) => setPdfFile(event.target.files?.[0] ?? null)}
                  disabled={isSubmitting}
                />
              </label>

              <p style={{ margin: 0, color: "#555" }}>
                파일을 선택하지 않으면 기존 업로드 경로{" "}
                <code>GeneratePDF/{"{subject}"}/{"{examId}"}.pdf</code>를 사용합니다.
              </p>

              {isSubmitting && pdfFile ? <p>업로드 중: {uploadProgress.toFixed(1)}%</p> : null}

              {errorMessage ? <p className="aq-status aq-status-error" style={{ margin: 0 }}>{errorMessage}</p> : null}

              <button type="submit" className="aq-btn-primary" disabled={isSubmitting}>
                {isSubmitting
                  ? pdfFile
                    ? "업로드 중..."
                    : "준비 중..."
                  : pdfFile
                    ? "PDF 업로드 후 생성"
                    : "기존 업로드 PDF 사용"}
              </button>
            </form>
          </section>
        ) : null}
      </main>
    </ClientErrorBoundary>
  );
}
