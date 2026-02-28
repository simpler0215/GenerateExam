"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";

import { ClientErrorBoundary } from "@/components/client-error-boundary";
import { getClientDb } from "@/lib/firebase/client";
import {
  deleteQuestionsByPageAndShift,
  fetchExamQuestionStatsByPage,
  type QuestionPageStats,
} from "@/lib/firebase/questions";

type ReviewStatus = "draft" | "reviewed" | "done";
type PageReviewStatus = ReviewStatus | "none";

type ExamPageConfig = {
  sourcePageNo: number;
  category: string;
};

type PageRow = {
  pageNo: number;
  sourcePageNo: number;
  category: string;
  questionCount: number;
  reviewStatus: PageReviewStatus;
};

type ExamInfo = {
  subject: string | null;
  pageCount: number | null;
  renderedPageCount: number | null;
  renderStatus: string | null;
  lastRenderError: string | null;
  problemPdfPath: string | null;
  exists: boolean;
  pageConfigs: ExamPageConfig[];
};

const GENETICS_START_PAGE_NO = 159;
const GENETICS_END_PAGE_NO = 254;
const GENETICS_CATEGORY = "유전";
const GENERAL_BIOLOGY_CATEGORY = "일반생명";

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "페이지 리스트를 불러오지 못했습니다.";
}

function toPositiveInt(value: unknown): number | null {
  const numericValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numericValue)) {
    return null;
  }
  const intValue = Math.floor(numericValue);
  return intValue > 0 ? intValue : null;
}

function normalizeExamPageConfig(value: unknown): ExamPageConfig | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const sourcePageNo = toPositiveInt(raw.sourcePageNo);
  if (!sourcePageNo) {
    return null;
  }
  const category = typeof raw.category === "string" ? raw.category.trim() : "";
  return {
    sourcePageNo,
    category,
  };
}

function resolvePageConfigs(raw: unknown, fallbackPageCount: number): ExamPageConfig[] {
  const parsed = Array.isArray(raw)
    ? raw
        .map((item) => normalizeExamPageConfig(item))
        .filter((item): item is ExamPageConfig => item !== null)
    : [];

  if (parsed.length > 0) {
    return parsed;
  }
  if (fallbackPageCount < 1) {
    return [];
  }
  return Array.from({ length: fallbackPageCount }, (_, i) => ({
    sourcePageNo: i + 1,
    category: resolveCategoryByPageNo(i + 1),
  }));
}

function resolveCategoryByPageNo(pageNo: number): string {
  if (pageNo >= GENETICS_START_PAGE_NO && pageNo <= GENETICS_END_PAGE_NO) {
    return GENETICS_CATEGORY;
  }
  return GENERAL_BIOLOGY_CATEGORY;
}

function applyCategoryPolicyToPageConfigs(pageConfigs: ExamPageConfig[]): ExamPageConfig[] {
  return pageConfigs.map((config, index) => ({
    ...config,
    category: resolveCategoryByPageNo(index + 1),
  }));
}

function hasCategoryMismatchWithPolicy(pageConfigs: ExamPageConfig[]): boolean {
  return pageConfigs.some((config, index) => config.category !== resolveCategoryByPageNo(index + 1));
}

function getPageCountText(examInfo: ExamInfo): string {
  const displayPageCount =
    examInfo.pageConfigs.length > 0
      ? examInfo.pageConfigs.length
      : examInfo.pageCount ?? examInfo.renderedPageCount ?? 0;
  if (displayPageCount > 0) {
    return String(displayPageCount);
  }
  if (examInfo.renderStatus === "failed") {
    return "실패";
  }
  if (examInfo.renderStatus === "queued" || examInfo.renderStatus === "running") {
    return "렌더링 중...";
  }
  return "준비되지 않음";
}

function getRenderStatusText(status: string | null): string {
  if (status === "queued") {
    return "대기 중";
  }
  if (status === "running") {
    return "실행 중";
  }
  if (status === "ready") {
    return "완료";
  }
  if (status === "failed") {
    return "실패";
  }
  return status ?? "-";
}

function getPageReviewStatusText(status: PageReviewStatus): string {
  if (status === "done") {
    return "최종 완료";
  }
  if (status === "reviewed") {
    return "검수 완료";
  }
  if (status === "draft") {
    return "초안";
  }
  return "미작성";
}

function getPageReviewStatusStyle(status: PageReviewStatus): {
  border: string;
  background: string;
  color: string;
} {
  if (status === "done") {
    return {
      border: "1px solid #166534",
      background: "rgba(22, 101, 52, 0.08)",
      color: "#166534",
    };
  }
  if (status === "reviewed") {
    return {
      border: "1px solid #0f766e",
      background: "rgba(15, 118, 110, 0.08)",
      color: "#0f766e",
    };
  }
  if (status === "draft") {
    return {
      border: "1px solid #a16207",
      background: "rgba(161, 98, 7, 0.08)",
      color: "#854d0e",
    };
  }
  return {
    border: "1px solid #9ca3af",
    background: "#f3f4f6",
    color: "#4b5563",
  };
}

function toPageReviewStatus(stats: QuestionPageStats | undefined): PageReviewStatus {
  if (!stats || stats.questionCount < 1) {
    return "none";
  }
  if (stats.doneCount === stats.questionCount) {
    return "done";
  }
  if (stats.reviewedCount + stats.doneCount > 0) {
    return "reviewed";
  }
  return "draft";
}

export default function ExamPagesPage() {
  const params = useParams<{ examId: string }>();
  const examId = useMemo(() => {
    const raw = params?.examId;
    if (!raw) {
      return "";
    }
    return Array.isArray(raw) ? raw[0] : raw;
  }, [params]);

  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isRerendering, setIsRerendering] = useState(false);
  const [deletingPageNo, setDeletingPageNo] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [noticeMessage, setNoticeMessage] = useState<string | null>(null);
  const [examInfo, setExamInfo] = useState<ExamInfo>({
    subject: null,
    pageCount: null,
    renderedPageCount: null,
    renderStatus: null,
    lastRenderError: null,
    problemPdfPath: null,
    exists: false,
    pageConfigs: [],
  });
  const [pageRows, setPageRows] = useState<PageRow[]>([]);

  const autoRerenderTriggeredForExamId = useRef<string | null>(null);
  const rerenderEndpoint = useMemo(() => {
    if (process.env.NEXT_PUBLIC_RERENDER_ENDPOINT) {
      return process.env.NEXT_PUBLIC_RERENDER_ENDPOINT;
    }
    if (process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID) {
      return `https://us-central1-${process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID}.cloudfunctions.net/rerenderExamPages`;
    }
    return null;
  }, []);

  const loadExam = useCallback(async () => {
    if (!examId) {
      setErrorMessage("유효하지 않은 시험 ID입니다.");
      setIsLoading(false);
      return;
    }

    setErrorMessage(null);
    setNoticeMessage(null);
    setIsRefreshing(true);

    try {
      const db = getClientDb();
      const examRef = doc(db, "exams", examId);
      const examSnap = await getDoc(examRef);

      if (!examSnap.exists()) {
        setExamInfo({
          subject: null,
          pageCount: null,
          renderedPageCount: null,
          renderStatus: null,
          lastRenderError: null,
          problemPdfPath: null,
          exists: false,
          pageConfigs: [],
        });
        setPageRows([]);
        return;
      }

      const data = examSnap.data();
      const pageCount = toPositiveInt(data.pageCount);
      const renderedPageCount = toPositiveInt(data.renderedPageCount);
      const subject = typeof data.subject === "string" ? data.subject : null;
      const renderStatus = typeof data.renderStatus === "string" ? data.renderStatus : null;
      const lastRenderError =
        typeof data.lastRenderError === "string" ? data.lastRenderError : null;
      const problemPdfPath =
        typeof data.problemPdfPath === "string" ? data.problemPdfPath : null;

      const fallbackPageCount = pageCount ?? renderedPageCount ?? 0;
      const basePageConfigs = resolvePageConfigs(data.pageConfigs, fallbackPageCount);
      const pageConfigs = applyCategoryPolicyToPageConfigs(basePageConfigs);
      const displayPageCount =
        pageConfigs.length > 0 ? pageConfigs.length : pageCount ?? renderedPageCount ?? 0;

      const shouldPersistPageConfigs =
        pageConfigs.length > 0 &&
        (!Array.isArray(data.pageConfigs) ||
          data.pageConfigs.length !== pageConfigs.length ||
          hasCategoryMismatchWithPolicy(basePageConfigs));

      if (shouldPersistPageConfigs) {
        await setDoc(
          doc(db, "exams", examId),
          {
            pageConfigs,
            updatedAt: serverTimestamp(),
          },
          { merge: true },
        );
      }

      setExamInfo({
        subject,
        pageCount,
        renderedPageCount,
        renderStatus,
        lastRenderError,
        problemPdfPath,
        exists: true,
        pageConfigs,
      });

      if (displayPageCount < 1) {
        setPageRows([]);
        return;
      }

      const statsByPageNo = await fetchExamQuestionStatsByPage(examId);
      const rows: PageRow[] = Array.from({ length: displayPageCount }, (_, i) => {
        const pageNo = i + 1;
        const config = pageConfigs[i] ?? { sourcePageNo: pageNo, category: "" };
        const stats = statsByPageNo.get(pageNo);
        return {
          pageNo,
          sourcePageNo: config.sourcePageNo,
          category: config.category,
          questionCount: stats?.questionCount ?? 0,
          reviewStatus: toPageReviewStatus(stats),
        };
      });

      setPageRows(rows);
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setIsRefreshing(false);
      setIsLoading(false);
    }
  }, [examId]);

  useEffect(() => {
    void loadExam();
  }, [loadExam]);

  useEffect(() => {
    if (examInfo.renderStatus !== "queued" && examInfo.renderStatus !== "running") {
      return;
    }

    const timer = setInterval(() => {
      if (!isRefreshing && !isRerendering && !deletingPageNo) {
        void loadExam();
      }
    }, 4000);

    return () => clearInterval(timer);
  }, [
    deletingPageNo,
    examInfo.renderStatus,
    isRefreshing,
    isRerendering,
    loadExam,
  ]);

  const rerenderFromUploadedPdf = useCallback(async () => {
    if (!examId) {
      setErrorMessage("유효하지 않은 시험 ID입니다.");
      return;
    }
    if (!rerenderEndpoint) {
      setErrorMessage("리렌더링 엔드포인트가 설정되지 않았습니다.");
      return;
    }

    setErrorMessage(null);
    setNoticeMessage(null);
    setIsRerendering(true);

    try {
      const response = await fetch(rerenderEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ examId }),
      });

      if (!response.ok) {
        const responseBody = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(responseBody?.error ?? "리렌더링 시작에 실패했습니다.");
      }

      await loadExam();
      setNoticeMessage("페이지 이미지 재렌더링을 요청했습니다.");
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setIsRerendering(false);
    }
  }, [examId, loadExam, rerenderEndpoint]);

  const deletePage = useCallback(
    async (pageNo: number) => {
      if (!examId || pageNo < 1) {
        return;
      }
      const confirmed = window.confirm(
        `${pageNo}페이지를 정말 삭제하시겠습니까?\n삭제 후에는 뒤 페이지가 자동으로 당겨집니다.`,
      );
      if (!confirmed) {
        return;
      }

      const targetConfig = examInfo.pageConfigs[pageNo - 1];
      if (!targetConfig) {
        return;
      }

      setDeletingPageNo(pageNo);
      setErrorMessage(null);
      setNoticeMessage(null);

      try {
        const questionResult = await deleteQuestionsByPageAndShift(examId, pageNo);
        const nextConfigs = examInfo.pageConfigs.filter((_, index) => index !== pageNo - 1);
        const db = getClientDb();
        await setDoc(
          doc(db, "exams", examId),
          {
            pageConfigs: nextConfigs,
            pageCount: nextConfigs.length,
            renderedPageCount: nextConfigs.length,
            updatedAt: serverTimestamp(),
          },
          { merge: true },
        );

        await loadExam();
        setNoticeMessage(
          `${pageNo}페이지를 삭제했습니다. 문항 ${questionResult.deletedCount}개 삭제, ${questionResult.shiftedCount}개 페이지 번호를 당겼습니다.`,
        );
      } catch (error) {
        setErrorMessage(getErrorMessage(error));
      } finally {
        setDeletingPageNo(null);
      }
    },
    [examId, examInfo.pageConfigs, loadExam],
  );

  useEffect(() => {
    autoRerenderTriggeredForExamId.current = null;
  }, [examId]);

  useEffect(() => {
    if (!examId || !examInfo.exists || !examInfo.problemPdfPath || examInfo.pageCount) {
      return;
    }
    if (!rerenderEndpoint || isLoading || isRefreshing || isRerendering) {
      return;
    }
    if (examInfo.renderStatus === "running") {
      return;
    }
    if (autoRerenderTriggeredForExamId.current === examId) {
      return;
    }

    autoRerenderTriggeredForExamId.current = examId;
    void rerenderFromUploadedPdf();
  }, [
    examId,
    examInfo.exists,
    examInfo.pageCount,
    examInfo.problemPdfPath,
    examInfo.renderStatus,
    isLoading,
    isRefreshing,
    isRerendering,
    rerenderEndpoint,
    rerenderFromUploadedPdf,
  ]);

  const displayPageCount = pageRows.length;

  return (
    <ClientErrorBoundary title="페이지 리스트 오류">
      <main style={{ maxWidth: 1120, margin: "32px auto", padding: "0 16px" }}>
        <h1 style={{ marginBottom: 10 }}>페이지 리스트</h1>
        <p style={{ marginTop: 0, color: "#555" }}>
          시험 ID: <b>{examId || "(유효하지 않음)"}</b>
        </p>

        <div style={{ display: "flex", gap: 12, marginBottom: 18, flexWrap: "wrap" }}>
          <button type="button" onClick={() => void loadExam()} disabled={isRefreshing}>
            {isRefreshing ? "새로고침 중..." : "새로고침"}
          </button>
          <button
            type="button"
            onClick={() => void rerenderFromUploadedPdf()}
            disabled={isRerendering}
          >
            {isRerendering ? "리렌더링 중..." : "이미지 다시 렌더링"}
          </button>
          <Link href="/admin/exams/create">시험 목록으로 돌아가기</Link>
        </div>

        {isLoading ? <p>불러오는 중...</p> : null}
        {errorMessage ? <p style={{ color: "crimson" }}>{errorMessage}</p> : null}
        {noticeMessage ? <p style={{ color: "#0f766e" }}>{noticeMessage}</p> : null}

        {!isLoading && !errorMessage && !examInfo.exists ? (
          <p>Firestore에 시험 문서가 없습니다.</p>
        ) : null}

        {!isLoading && !errorMessage && examInfo.exists ? (
          <section style={{ marginBottom: 18 }}>
            <p style={{ margin: "4px 0" }}>
              과목: <b>{examInfo.subject ?? "-"}</b>
            </p>
            <p style={{ margin: "4px 0" }}>
              렌더 상태: <b>{getRenderStatusText(examInfo.renderStatus)}</b>
            </p>
            <p style={{ margin: "4px 0" }}>
              페이지 수: <b>{getPageCountText(examInfo)}</b>
            </p>
            <p style={{ margin: "4px 0" }}>
              리스트 페이지 수: <b>{displayPageCount}</b>
            </p>
            {examInfo.lastRenderError ? (
              <p style={{ margin: "6px 0", color: "crimson" }}>
                마지막 렌더 오류: {examInfo.lastRenderError}
              </p>
            ) : null}
          </section>
        ) : null}

        {!isLoading && examInfo.exists && pageRows.length > 0 ? (
          <section style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 900 }}>
              <thead>
                <tr>
                  <th
                    style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "8px 6px" }}
                  >
                    페이지번호
                  </th>
                  <th
                    style={{
                      textAlign: "right",
                      borderBottom: "1px solid #ddd",
                      padding: "8px 6px",
                    }}
                  >
                    문제수
                  </th>
                  <th
                    style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "8px 6px" }}
                  >
                    검수상태
                  </th>
                  <th
                    style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "8px 6px" }}
                  >
                    문제편집
                  </th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((row) => {
                  const badgeStyle = getPageReviewStatusStyle(row.reviewStatus);
                  const isDeleting = deletingPageNo === row.pageNo;
                  return (
                    <tr key={row.pageNo}>
                      <td
                        style={{
                          borderBottom: "1px solid #eee",
                          padding: "8px 6px",
                          fontWeight: 600,
                          minWidth: 280,
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span>{row.pageNo}</span>
                          <span
                            style={{
                              border: "1px solid #d1d5db",
                              borderRadius: 999,
                              padding: "2px 10px",
                              fontSize: 12,
                              fontWeight: 600,
                              color: "#1f2937",
                              background: "#f9fafb",
                            }}
                          >
                            {row.category}
                          </span>
                        </div>
                      </td>
                      <td style={{ borderBottom: "1px solid #eee", padding: "8px 6px", textAlign: "right" }}>
                        {row.questionCount}
                      </td>
                      <td style={{ borderBottom: "1px solid #eee", padding: "8px 6px" }}>
                        <span
                          style={{
                            ...badgeStyle,
                            borderRadius: 999,
                            padding: "2px 10px",
                            fontSize: 12,
                            fontWeight: 600,
                          }}
                        >
                          {getPageReviewStatusText(row.reviewStatus)}
                        </span>
                      </td>
                      <td style={{ borderBottom: "1px solid #eee", padding: "8px 6px" }}>
                        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                          <Link href={`/admin/exams/${encodeURIComponent(examId)}/edit?pageNo=${row.pageNo}`}>
                            편집
                          </Link>
                          <button
                            type="button"
                            onClick={() => void deletePage(row.pageNo)}
                            disabled={Boolean(deletingPageNo)}
                          >
                            {isDeleting ? "삭제 중..." : "페이지 삭제"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        ) : null}

        {!isLoading && examInfo.exists && pageRows.length === 0 ? (
          <p style={{ color: "#555" }}>표시할 페이지가 없습니다. 렌더 상태를 확인해 주세요.</p>
        ) : null}
      </main>
    </ClientErrorBoundary>
  );
}
