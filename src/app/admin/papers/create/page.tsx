"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { collection, getDocs } from "firebase/firestore";
import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

import { ClientErrorBoundary } from "@/components/client-error-boundary";
import { getClientDb } from "@/lib/firebase/client";
import {
  PNG_PAGE_HEIGHT,
  PNG_PAGE_WIDTH,
  REVIEW_STATUSES,
  fetchExamQuestionCandidates,
  type PngRect,
  type QuestionCandidate,
  type ReviewStatus,
} from "@/lib/firebase/questions";

const A4_WIDTH_PT = 595.28;
const A4_HEIGHT_PT = 841.89;
const PAGE_MARGIN_X = 36;
const PAGE_MARGIN_TOP = 38;
const PAGE_MARGIN_BOTTOM = 36;
const SLOT_GAP_X_PT = 16;
const PAGE_NO_LABEL_PT = 9;
const PAGE_NO_GAP_PT = 6;
const KOREAN_FONT_PATH = "/fonts/NotoSansCJKkr-Regular.otf";

let koreanFontBytesPromise: Promise<Uint8Array> | null = null;

type ExamPageConfig = {
  sourcePageNo: number;
  category: string;
};

type ExamOption = {
  examId: string;
  subject: string;
  renderStatus: string;
  pageCount: number | null;
  renderedPageCount: number | null;
  pageConfigs: ExamPageConfig[];
  createdAtMs: number;
};

type DownloadItem = {
  url: string;
  fileName: string;
  questionCount: number;
  createdAtText: string;
  blob: Blob;
};

type RenderQuestionImage = {
  qNo: number;
  pageNo: number;
  category: string;
  pngBytes: Uint8Array;
};

type CategoryBucket = {
  category: string;
  candidates: QuestionCandidate[];
};

type SaveFilePicker = (options?: {
  suggestedName?: string;
  types?: Array<{
    description?: string;
    accept: Record<string, string[]>;
  }>;
}) => Promise<{
  createWritable: () => Promise<{
    write: (data: Blob) => Promise<void>;
    close: () => Promise<void>;
  }>;
}>;

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

function normalizeExamPageConfig(value: unknown): ExamPageConfig | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const sourcePageNo = toPositiveInt(raw.sourcePageNo);
  if (!sourcePageNo) {
    return null;
  }
  return {
    sourcePageNo,
    category: typeof raw.category === "string" ? raw.category.trim() : "",
  };
}

function resolveExamPageConfigs(raw: unknown, fallbackPageCount: number): ExamPageConfig[] {
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
  return Array.from({ length: fallbackPageCount }, (_, index) => ({
    sourcePageNo: index + 1,
    category: "",
  }));
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

function getDateTag(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function getDateTimeText(now: Date): string {
  return now.toLocaleString();
}

async function getKoreanFontBytes(): Promise<Uint8Array> {
  if (!koreanFontBytesPromise) {
    koreanFontBytesPromise = (async () => {
      const response = await fetch(KOREAN_FONT_PATH, { cache: "force-cache" });
      if (!response.ok) {
        throw new Error("한글 폰트 파일을 불러오지 못했습니다.");
      }
      return new Uint8Array(await response.arrayBuffer());
    })();
  }
  return koreanFontBytesPromise;
}

function sanitizeFileNamePart(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "paper";
  }
  return trimmed
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 80);
}

function normalizeCategoryName(value: string): string {
  const trimmed = value.trim();
  return trimmed || "미분류";
}

function resolveCandidateCategory(pageConfigs: ExamPageConfig[], pageNo: number): string {
  const rawCategory = pageConfigs[pageNo - 1]?.category ?? "";
  return normalizeCategoryName(rawCategory);
}

function isLifeScienceExam(exam: ExamOption | null): boolean {
  if (!exam) {
    return false;
  }
  const subject = exam.subject.trim();
  const subjectLower = subject.toLowerCase();
  const examIdLower = exam.examId.trim().toLowerCase();
  return (
    subject.includes("생명") ||
    subjectLower.includes("bio") ||
    examIdLower.includes("bio")
  );
}

function findGeneticsCategory(categories: string[]): string | null {
  const exact = categories.find((item) => item === "유전");
  if (exact) {
    return exact;
  }
  return categories.find((item) => item.includes("유전")) ?? null;
}

function buildDefaultCategoryRatios(
  categories: string[],
  selectedExam: ExamOption | null,
): Record<string, number> {
  const normalized = Array.from(new Set(categories.map((item) => normalizeCategoryName(item))));
  if (normalized.length < 1) {
    return {};
  }

  const next: Record<string, number> = {};
  const defaultRatio = 100 / normalized.length;
  for (const category of normalized) {
    next[category] = defaultRatio;
  }

  if (!isLifeScienceExam(selectedExam)) {
    return next;
  }

  const geneticsCategory = findGeneticsCategory(normalized);
  if (!geneticsCategory) {
    return next;
  }
  if (normalized.length === 1) {
    next[geneticsCategory] = 100;
    return next;
  }

  next[geneticsCategory] = 60;
  const others = normalized.filter((item) => item !== geneticsCategory);
  const otherRatio = 40 / others.length;
  for (const category of others) {
    next[category] = otherRatio;
  }
  return next;
}

function formatRatioValue(value: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }
  return String(Number(value.toFixed(1)));
}

function parseRatioInputValue(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.max(0, Math.min(100, numeric));
}

function allocateQuestionCountsByCategory(
  buckets: CategoryBucket[],
  requestedCount: number,
  ratioInputs: Record<string, string>,
): Record<string, number> {
  const categoryOrder = buckets.map((bucket) => bucket.category);
  const availableByCategory = new Map(
    buckets.map((bucket) => [bucket.category, bucket.candidates.length]),
  );

  const requestedWeightByCategory = new Map<string, number>();
  let totalWeight = 0;
  for (const category of categoryOrder) {
    const weight = parseRatioInputValue(ratioInputs[category]);
    requestedWeightByCategory.set(category, weight);
    totalWeight += weight;
  }

  if (totalWeight <= 0) {
    throw new Error("카테고리 비율 합계는 0보다 커야 합니다.");
  }

  const idealByCategory = new Map<string, number>();
  for (const category of categoryOrder) {
    const weight = requestedWeightByCategory.get(category) ?? 0;
    idealByCategory.set(category, (requestedCount * weight) / totalWeight);
  }

  const allocatedByCategory = new Map<string, number>();
  for (const category of categoryOrder) {
    const ideal = idealByCategory.get(category) ?? 0;
    const available = availableByCategory.get(category) ?? 0;
    allocatedByCategory.set(category, Math.min(available, Math.floor(ideal)));
  }

  const totalAllocated = categoryOrder.reduce(
    (sum, category) => sum + (allocatedByCategory.get(category) ?? 0),
    0,
  );
  let remaining = requestedCount - totalAllocated;

  while (remaining > 0) {
    let selectedCategory: string | null = null;
    let bestScore = -Infinity;

    for (const category of categoryOrder) {
      const allocated = allocatedByCategory.get(category) ?? 0;
      const available = availableByCategory.get(category) ?? 0;
      if (allocated >= available) {
        continue;
      }
      const ideal = idealByCategory.get(category) ?? 0;
      const score = ideal - allocated;
      if (score > bestScore) {
        bestScore = score;
        selectedCategory = category;
      }
    }

    if (!selectedCategory) {
      break;
    }
    allocatedByCategory.set(
      selectedCategory,
      (allocatedByCategory.get(selectedCategory) ?? 0) + 1,
    );
    remaining -= 1;
  }

  if (remaining > 0) {
    for (const category of categoryOrder) {
      if (remaining <= 0) {
        break;
      }
      const available = availableByCategory.get(category) ?? 0;
      let allocated = allocatedByCategory.get(category) ?? 0;
      while (remaining > 0 && allocated < available) {
        allocated += 1;
        remaining -= 1;
      }
      allocatedByCategory.set(category, allocated);
    }
  }

  if (remaining > 0) {
    throw new Error("카테고리별 가용 문항 수가 부족해 요청 수량을 채울 수 없습니다.");
  }

  return categoryOrder.reduce<Record<string, number>>((acc, category) => {
    acc[category] = allocatedByCategory.get(category) ?? 0;
    return acc;
  }, {});
}

function getSaveFilePicker(): SaveFilePicker | null {
  const maybePicker = (window as Window & { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
  return typeof maybePicker === "function" ? maybePicker : null;
}

function triggerBrowserDownload(url: string, fileName: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function shuffleInPlace<T>(items: T[]): T[] {
  const next = [...items];
  for (let i = next.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = next[i];
    next[i] = next[j];
    next[j] = temp;
  }
  return next;
}

function resolveSourcePageNo(pageConfigs: ExamPageConfig[], pageNo: number): number {
  if (pageConfigs.length < 1) {
    return pageNo;
  }
  return pageConfigs[pageNo - 1]?.sourcePageNo ?? pageNo;
}

function clampRectToPngBounds(rect: PngRect): PngRect {
  const x = Math.min(Math.max(0, rect.x), PNG_PAGE_WIDTH - 1);
  const y = Math.min(Math.max(0, rect.y), PNG_PAGE_HEIGHT - 1);
  const width = Math.min(Math.max(1, rect.width), PNG_PAGE_WIDTH - x);
  const height = Math.min(Math.max(1, rect.height), PNG_PAGE_HEIGHT - y);
  return { x, y, width, height };
}

function getNextSerial(examId: string, dateTag: string): number {
  const key = `paper_serial:${examId}:${dateTag}`;
  const prevRaw = window.localStorage.getItem(key);
  const prev = Number(prevRaw);
  const next = Number.isFinite(prev) && prev > 0 ? Math.floor(prev) + 1 : 1;
  window.localStorage.setItem(key, String(next));
  return next;
}

async function cropPngRectFromBitmap(bitmap: ImageBitmap, rect: PngRect): Promise<Uint8Array> {
  const clamped = clampRectToPngBounds(rect);
  const x = Math.min(clamped.x, Math.max(0, bitmap.width - 1));
  const y = Math.min(clamped.y, Math.max(0, bitmap.height - 1));
  const width = Math.min(clamped.width, bitmap.width - x);
  const height = Math.min(clamped.height, bitmap.height - y);

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("캔버스 컨텍스트를 가져오지 못했습니다.");
  }
  ctx.drawImage(bitmap, x, y, width, height, 0, 0, width, height);

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((nextBlob) => resolve(nextBlob), "image/png");
  });
  if (!blob) {
    throw new Error("문항 이미지를 생성하지 못했습니다.");
  }
  return new Uint8Array(await blob.arrayBuffer());
}

async function renderQuestionsToA4Pdf(images: RenderQuestionImage[]): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  let font: PDFFont;
  let canRenderUnicode = true;
  try {
    pdfDoc.registerFontkit(fontkit);
    const koreanFontBytes = await getKoreanFontBytes();
    font = await pdfDoc.embedFont(koreanFontBytes, { subset: true });
  } catch {
    canRenderUnicode = false;
    font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  }

  for (let i = 0; i < images.length; i += 1) {
    const slotIndex = i % 2;
    const isNewPage = slotIndex === 0;
    const page = isNewPage
      ? pdfDoc.addPage([A4_WIDTH_PT, A4_HEIGHT_PT])
      : pdfDoc.getPages()[pdfDoc.getPageCount() - 1];

    const slotWidth = (A4_WIDTH_PT - PAGE_MARGIN_X * 2 - SLOT_GAP_X_PT) / 2;
    const slotX = PAGE_MARGIN_X + slotIndex * (slotWidth + SLOT_GAP_X_PT);
    const slotTopY = A4_HEIGHT_PT - PAGE_MARGIN_TOP;
    const imageAreaTopY = slotTopY - PAGE_NO_LABEL_PT - PAGE_NO_GAP_PT;
    const imageAreaBottomY = PAGE_MARGIN_BOTTOM;
    const imageAreaHeight = Math.max(1, imageAreaTopY - imageAreaBottomY);

    const image = await pdfDoc.embedPng(images[i].pngBytes);
    const scale = Math.min(
      slotWidth / Math.max(1, image.width),
      imageAreaHeight / Math.max(1, image.height),
    );
    const drawWidth = image.width * scale;
    const drawHeight = image.height * scale;
    const drawX = slotX + (slotWidth - drawWidth) / 2;
    const drawY = imageAreaBottomY + (imageAreaHeight - drawHeight) / 2;

    if (slotIndex === 1) {
      page.drawLine({
        start: { x: slotX - SLOT_GAP_X_PT / 2, y: PAGE_MARGIN_BOTTOM },
        end: { x: slotX - SLOT_GAP_X_PT / 2, y: A4_HEIGHT_PT - PAGE_MARGIN_TOP },
        color: rgb(0.88, 0.88, 0.88),
        thickness: 0.5,
      });
    }

    const labelText = canRenderUnicode
      ? `p.${images[i].pageNo} | ${images[i].category}`
      : `p.${images[i].pageNo}`;
    page.drawText(labelText, {
      x: slotX + 1,
      y: slotTopY - PAGE_NO_LABEL_PT,
      size: 8,
      font,
      color: rgb(0.35, 0.35, 0.35),
    });

    page.drawImage(image, {
      x: drawX,
      y: drawY,
      width: drawWidth,
      height: drawHeight,
    });
  }

  return pdfDoc.save();
}

export default function CreatePaperPage() {
  const [examOptions, setExamOptions] = useState<ExamOption[]>([]);
  const [selectedExamId, setSelectedExamId] = useState("");
  const [questionCountInput, setQuestionCountInput] = useState("20");
  const [includeDraft, setIncludeDraft] = useState(true);
  const [questionCandidates, setQuestionCandidates] = useState<QuestionCandidate[]>([]);
  const [categoryRatioInputs, setCategoryRatioInputs] = useState<Record<string, string>>({});
  const [isLoadingExams, setIsLoadingExams] = useState(true);
  const [isLoadingCandidates, setIsLoadingCandidates] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [noticeMessage, setNoticeMessage] = useState<string | null>(null);
  const [downloadItem, setDownloadItem] = useState<DownloadItem | null>(null);

  const downloadUrlRef = useRef<string | null>(null);
  const ratioPresetKeyRef = useRef<string>("");

  const selectedExam = useMemo(
    () => examOptions.find((exam) => exam.examId === selectedExamId) ?? null,
    [examOptions, selectedExamId],
  );
  const maxQuestionCount = questionCandidates.length;
  const candidateBuckets = useMemo(() => {
    const pageConfigs = selectedExam?.pageConfigs ?? [];
    const bucketsMap = new Map<string, QuestionCandidate[]>();
    for (const candidate of questionCandidates) {
      const category = resolveCandidateCategory(pageConfigs, candidate.pageNo);
      const existing = bucketsMap.get(category);
      if (existing) {
        existing.push(candidate);
      } else {
        bucketsMap.set(category, [candidate]);
      }
    }

    return [...bucketsMap.entries()]
      .map(([category, candidates]): CategoryBucket => ({
        category,
        candidates,
      }))
      .sort((a, b) => {
        if (a.category === "유전") {
          return -1;
        }
        if (b.category === "유전") {
          return 1;
        }
        return a.category.localeCompare(b.category);
      });
  }, [questionCandidates, selectedExam]);
  const categoryRatioTotal = useMemo(
    () =>
      candidateBuckets.reduce(
        (sum, bucket) => sum + parseRatioInputValue(categoryRatioInputs[bucket.category]),
        0,
      ),
    [candidateBuckets, categoryRatioInputs],
  );
  const requestedCountPreview = toPositiveInt(questionCountInput);
  const categoryAllocationPreview = useMemo(() => {
    if (!requestedCountPreview || candidateBuckets.length < 1) {
      return null;
    }
    try {
      return allocateQuestionCountsByCategory(
        candidateBuckets,
        requestedCountPreview,
        categoryRatioInputs,
      );
    } catch {
      return null;
    }
  }, [candidateBuckets, categoryRatioInputs, requestedCountPreview]);
  const ratioPresetKey = useMemo(
    () => `${selectedExamId}::${candidateBuckets.map((bucket) => bucket.category).join("|")}`,
    [candidateBuckets, selectedExamId],
  );

  const releaseDownloadUrl = useCallback(() => {
    if (downloadUrlRef.current) {
      URL.revokeObjectURL(downloadUrlRef.current);
      downloadUrlRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      releaseDownloadUrl();
    };
  }, [releaseDownloadUrl]);

  const loadExamOptions = useCallback(async () => {
    setIsLoadingExams(true);
    setErrorMessage(null);
    try {
      const db = getClientDb();
      const examSnap = await getDocs(collection(db, "exams"));
      const items = examSnap.docs
        .map((docSnap): ExamOption => {
          const data = docSnap.data() as Record<string, unknown>;
          const pageCount = toPositiveInt(data.pageCount);
          const renderedPageCount = toPositiveInt(data.renderedPageCount);
          const fallbackPageCount = pageCount ?? renderedPageCount ?? 0;
          return {
            examId:
              typeof data.examId === "string" && data.examId.trim()
                ? data.examId.trim()
                : docSnap.id,
            subject: typeof data.subject === "string" ? data.subject : "",
            renderStatus: typeof data.renderStatus === "string" ? data.renderStatus : "",
            pageCount,
            renderedPageCount,
            pageConfigs: resolveExamPageConfigs(data.pageConfigs, fallbackPageCount),
            createdAtMs: getTimestampMillis(data.createdAt),
          };
        })
        .filter((item) => item.renderStatus === "ready")
        .sort((a, b) => {
          if (a.createdAtMs !== b.createdAtMs) {
            return b.createdAtMs - a.createdAtMs;
          }
          return a.examId.localeCompare(b.examId);
        });

      setExamOptions(items);
      setSelectedExamId((prev) => {
        if (prev && items.some((item) => item.examId === prev)) {
          return prev;
        }
        return items[0]?.examId ?? "";
      });
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setIsLoadingExams(false);
    }
  }, []);

  useEffect(() => {
    void loadExamOptions();
  }, [loadExamOptions]);

  useEffect(() => {
    if (!selectedExamId) {
      setQuestionCandidates([]);
      return;
    }

    let cancelled = false;
    setIsLoadingCandidates(true);
    setErrorMessage(null);
    setNoticeMessage(null);

    const loadCandidates = async () => {
      try {
        const includeStatuses: ReviewStatus[] = includeDraft ? [...REVIEW_STATUSES] : ["reviewed", "done"];
        const candidates = await fetchExamQuestionCandidates(selectedExamId, { includeStatuses });
        if (cancelled) {
          return;
        }
        setQuestionCandidates(candidates);
      } catch (error) {
        if (cancelled) {
          return;
        }
        setErrorMessage(getErrorMessage(error));
        setQuestionCandidates([]);
      } finally {
        if (!cancelled) {
          setIsLoadingCandidates(false);
        }
      }
    };

    void loadCandidates();
    return () => {
      cancelled = true;
    };
  }, [includeDraft, selectedExamId]);

  useEffect(() => {
    if (!selectedExam || candidateBuckets.length < 1) {
      ratioPresetKeyRef.current = "";
      setCategoryRatioInputs({});
      return;
    }
    if (ratioPresetKeyRef.current === ratioPresetKey) {
      return;
    }

    const defaults = buildDefaultCategoryRatios(
      candidateBuckets.map((bucket) => bucket.category),
      selectedExam,
    );
    ratioPresetKeyRef.current = ratioPresetKey;
    setCategoryRatioInputs(
      candidateBuckets.reduce<Record<string, string>>((acc, bucket) => {
        acc[bucket.category] = formatRatioValue(defaults[bucket.category] ?? 0);
        return acc;
      }, {}),
    );
  }, [candidateBuckets, ratioPresetKey, selectedExam]);

  const generatePaper = useCallback(async () => {
    if (!selectedExam) {
      setErrorMessage("문제지를 먼저 선택해 주세요.");
      return;
    }
    const requestedCount = toPositiveInt(questionCountInput);
    if (!requestedCount) {
      setErrorMessage("문제 수는 1 이상이어야 합니다.");
      return;
    }
    if (requestedCount > questionCandidates.length) {
      setErrorMessage(
        `요청 문제 수(${requestedCount})가 사용 가능한 문제 수(${questionCandidates.length})보다 큽니다.`,
      );
      return;
    }
    if (candidateBuckets.length < 1) {
      setErrorMessage("카테고리별 문항 후보를 불러오지 못했습니다.");
      return;
    }

    setIsGenerating(true);
    setErrorMessage(null);
    setNoticeMessage(null);

    const bitmapCache = new Map<number, ImageBitmap>();

    try {
      const allocatedByCategory = allocateQuestionCountsByCategory(
        candidateBuckets,
        requestedCount,
        categoryRatioInputs,
      );
      const selectedCandidates = candidateBuckets.flatMap((bucket) => {
        const takeCount = allocatedByCategory[bucket.category] ?? 0;
        if (takeCount < 1) {
          return [];
        }
        return shuffleInPlace(bucket.candidates).slice(0, takeCount);
      });
      const randomizedSelectedCandidates = shuffleInPlace(selectedCandidates).slice(0, requestedCount);
      const categorySummaryText = candidateBuckets
        .map((bucket) => `${bucket.category} ${allocatedByCategory[bucket.category] ?? 0}문항`)
        .join(", ");

      const getBitmapBySourcePageNo = async (sourcePageNo: number): Promise<ImageBitmap> => {
        const cached = bitmapCache.get(sourcePageNo);
        if (cached) {
          return cached;
        }
        const path = `derived/${selectedExam.examId}/pages/${sourcePageNo}.png`;
        const response = await fetch(`/api/storage-file?path=${encodeURIComponent(path)}`, {
          cache: "no-store",
        });
        if (!response.ok) {
          throw new Error(`페이지 이미지 로드 실패 (sourcePageNo=${sourcePageNo})`);
        }
        const blob = await response.blob();
        const bitmap = await createImageBitmap(blob);
        bitmapCache.set(sourcePageNo, bitmap);
        return bitmap;
      };

      const renderedQuestions: RenderQuestionImage[] = [];
      for (const candidate of randomizedSelectedCandidates) {
        const sourcePageNo = resolveSourcePageNo(selectedExam.pageConfigs, candidate.pageNo);
        const bitmap = await getBitmapBySourcePageNo(sourcePageNo);
        const pngBytes = await cropPngRectFromBitmap(bitmap, candidate.part.rect);
        const category = resolveCandidateCategory(selectedExam.pageConfigs, candidate.pageNo);
        renderedQuestions.push({
          qNo: candidate.qNo,
          pageNo: candidate.pageNo,
          category,
          pngBytes,
        });
      }

      if (renderedQuestions.length < 1) {
        throw new Error("출제할 문제 이미지를 만들지 못했습니다.");
      }

      const pdfBytes = await renderQuestionsToA4Pdf(renderedQuestions);
      const now = new Date();
      const dateTag = getDateTag(now);
      const serial = String(getNextSerial(selectedExam.examId, dateTag)).padStart(3, "0");
      const examName = sanitizeFileNamePart(selectedExam.subject || selectedExam.examId);
      const fileName = `${examName}_${dateTag}_${serial}.pdf`;
      const pdfBinary = Uint8Array.from(pdfBytes);
      const blob = new Blob([pdfBinary], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);

      releaseDownloadUrl();
      downloadUrlRef.current = url;
      setDownloadItem({
        url,
        fileName,
        questionCount: renderedQuestions.length,
        createdAtText: getDateTimeText(now),
        blob,
      });
      setNoticeMessage(
        `문제지 PDF를 생성했습니다. (${renderedQuestions.length}문항, 파일명 ${fileName}, 카테고리 ${categorySummaryText})`,
      );
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      for (const bitmap of bitmapCache.values()) {
        bitmap.close();
      }
      setIsGenerating(false);
    }
  }, [
    candidateBuckets,
    categoryRatioInputs,
    questionCandidates,
    questionCountInput,
    releaseDownloadUrl,
    selectedExam,
  ]);

  const downloadPdf = useCallback(async () => {
    if (!downloadItem) {
      return;
    }

    const picker = getSaveFilePicker();
    if (picker) {
      try {
        const fileHandle = await picker({
          suggestedName: downloadItem.fileName,
          types: [
            {
              description: "PDF document",
              accept: { "application/pdf": [".pdf"] },
            },
          ],
        });
        const writable = await fileHandle.createWritable();
        await writable.write(downloadItem.blob);
        await writable.close();
        setErrorMessage(null);
        setNoticeMessage(`PDF 파일을 저장했습니다. (${downloadItem.fileName})`);
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          setErrorMessage(null);
          setNoticeMessage("PDF 저장이 취소되었습니다.");
          return;
        }
      }
    }

    triggerBrowserDownload(downloadItem.url, downloadItem.fileName);
    setErrorMessage(null);
    setNoticeMessage(`브라우저 다운로드를 시작했습니다. (${downloadItem.fileName})`);
  }, [downloadItem]);

  return (
    <ClientErrorBoundary title="문제지 생성 오류">
      <main className="paper-create-page">
        <div className="bg-orb orb-a" aria-hidden />
        <div className="bg-orb orb-b" aria-hidden />

        <header className="hero">
          <p className="hero-kicker">AUTOQUIZ BUILDER</p>
          <h1 className="hero-title">문제지 생성</h1>
          <p className="hero-desc">
            시험을 고르고 카테고리 비율을 조절해서, 원하는 스타일의 문제지를 빠르게 만들어 보세요.
          </p>
          <Link href="/admin/exams/create" className="hero-link">
            시험 관리로 이동
          </Link>
        </header>

        <section className="panel">
          <div className="form-grid">
            <label className="field">
              <span className="field-label">1) 문제지 선택</span>
              <select
                value={selectedExamId}
                onChange={(event) => setSelectedExamId(event.target.value)}
                disabled={isLoadingExams || isGenerating}
              >
                {examOptions.length < 1 ? <option value="">선택 가능한 문제지가 없습니다.</option> : null}
                {examOptions.map((exam) => (
                  <option key={exam.examId} value={exam.examId}>
                    {exam.subject || "(과목 미입력)"} / {exam.examId}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span className="field-label">2) 문제 수 선택</span>
              <input
                type="number"
                min={1}
                max={Math.max(1, maxQuestionCount)}
                value={questionCountInput}
                onChange={(event) => setQuestionCountInput(event.target.value)}
                disabled={!selectedExamId || isGenerating}
              />
            </label>

            <div className="field">
              <span className="field-label">3) 카테고리 비율 설정</span>
              {candidateBuckets.length < 1 ? (
                <div className="helper-text">카테고리 문항을 불러오는 중...</div>
              ) : (
                <div className="ratio-list">
                  {candidateBuckets.map((bucket) => {
                    const ratioInput = categoryRatioInputs[bucket.category] ?? "";
                    const previewCount = categoryAllocationPreview?.[bucket.category] ?? 0;
                    return (
                      <label key={bucket.category} className="ratio-item">
                        <span className="ratio-label">
                          {bucket.category} (가용 {bucket.candidates.length}문항, 예상 {previewCount}문항)
                        </span>
                        <input
                          type="number"
                          min={0}
                          max={100}
                          step={1}
                          value={ratioInput}
                          onChange={(event) =>
                            setCategoryRatioInputs((prev) => ({
                              ...prev,
                              [bucket.category]: event.target.value,
                            }))
                          }
                          disabled={!selectedExamId || isGenerating}
                        />
                      </label>
                    );
                  })}
                </div>
              )}
              <div className="meta-text">
                입력 비율 합계 <b>{Number(categoryRatioTotal.toFixed(1))}%</b>
                {isLifeScienceExam(selectedExam) ? " (생명과학 기본값: 유전 60%)" : ""}
              </div>
              <div className="sub-text">합계가 100%가 아니어도 입력값 비율대로 자동 정규화됩니다.</div>
            </div>

            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={includeDraft}
                onChange={(event) => setIncludeDraft(event.target.checked)}
                disabled={!selectedExamId || isGenerating}
              />
              <span>4) 초안(draft) 문항 포함</span>
            </label>

            <div className="chip-row">
              사용 가능한 문제 수 <b>{isLoadingCandidates ? "..." : maxQuestionCount}</b>
            </div>

            <div className="actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void generatePaper()}
                disabled={!selectedExamId || isLoadingCandidates || isGenerating || maxQuestionCount < 1}
              >
                {isGenerating ? "문제지 생성 중.." : "문제지 PDF 생성"}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void loadExamOptions()}
                disabled={isLoadingExams || isGenerating}
              >
                {isLoadingExams ? "목록 갱신 중.." : "문제지 목록 새로고침"}
              </button>
            </div>

            <p className="footnote">
              PDF는 A4 세로 기준으로 1페이지에 2문제를 좌/우로 배치해 생성됩니다.
              브라우저가 지원하면 저장 위치를 직접 선택할 수 있습니다.
              미지원 브라우저에서는 기본 다운로드 폴더로 저장됩니다.
            </p>
          </div>
        </section>

        {errorMessage ? <p className="status status-error">{errorMessage}</p> : null}
        {noticeMessage ? <p className="status status-ok">{noticeMessage}</p> : null}

        {downloadItem ? (
          <section className="panel panel-download">
            <p className="download-line">
              생성 시각: <b>{downloadItem.createdAtText}</b>
            </p>
            <p className="download-line">
              문항 수 <b>{downloadItem.questionCount}</b>
            </p>
            <p className="download-line">
              파일명 <code>{downloadItem.fileName}</code>
            </p>
            <div className="download-actions">
              <button type="button" className="btn btn-primary" onClick={() => void downloadPdf()}>
                PDF 다운로드
              </button>
              <a className="download-link" href={downloadItem.url} download={downloadItem.fileName}>
                기본 다운로드 링크
              </a>
            </div>
          </section>
        ) : null}

        <style jsx>{`
          .paper-create-page {
            --ink: #1f2a44;
            --muted: #55627a;
            --line: #d7e4ef;
            --panel: rgba(255, 255, 255, 0.88);
            --accent: #1f7a8c;
            --accent-strong: #135d6a;
            --accent-soft: #dff4f8;
            position: relative;
            max-width: 1024px;
            margin: 26px auto 40px;
            padding: 0 16px 20px;
            color: var(--ink);
            font-family:
              "Pretendard Variable",
              "SUIT",
              "Noto Sans KR",
              "Apple SD Gothic Neo",
              "Malgun Gothic",
              sans-serif;
          }

          .paper-create-page::before {
            content: "";
            position: fixed;
            inset: 0;
            z-index: -2;
            background: linear-gradient(145deg, #fff6e8 0%, #ffffff 36%, #e9f7ff 100%);
          }

          .bg-orb {
            position: absolute;
            border-radius: 999px;
            pointer-events: none;
            z-index: -1;
            opacity: 0.5;
          }

          .orb-a {
            top: -22px;
            right: 8px;
            width: 220px;
            height: 220px;
            background: radial-gradient(circle at 30% 30%, #ffd69b 0%, rgba(255, 214, 155, 0) 70%);
            animation: floaty 8s ease-in-out infinite;
          }

          .orb-b {
            left: -34px;
            top: 360px;
            width: 180px;
            height: 180px;
            background: radial-gradient(circle at 30% 30%, #b7e8ff 0%, rgba(183, 232, 255, 0) 72%);
            animation: floaty 9s ease-in-out infinite reverse;
          }

          .hero {
            border: 1px solid var(--line);
            border-radius: 18px;
            padding: 20px 22px;
            background: linear-gradient(135deg, #ffffff 0%, #f6fbff 56%, #fff5e6 100%);
            box-shadow: 0 16px 30px -24px rgba(15, 23, 42, 0.45);
            animation: rise 420ms ease-out both;
          }

          .hero-kicker {
            margin: 0 0 8px;
            font-size: 12px;
            letter-spacing: 0.14em;
            font-weight: 700;
            color: #5f7692;
          }

          .hero-title {
            margin: 0;
            font-size: clamp(28px, 4vw, 34px);
            line-height: 1.1;
          }

          .hero-desc {
            margin: 10px 0 14px;
            color: var(--muted);
            line-height: 1.55;
            font-size: 15px;
            max-width: 680px;
          }

          .hero-link {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            border-radius: 999px;
            border: 1px solid #c6d8ea;
            background: #ffffff;
            color: #244e72;
            text-decoration: none;
            font-size: 13px;
            font-weight: 700;
            padding: 8px 12px;
            transition: transform 120ms ease, box-shadow 120ms ease;
          }

          .hero-link:hover {
            transform: translateY(-1px);
            box-shadow: 0 8px 16px -14px rgba(36, 78, 114, 0.7);
          }

          .panel {
            margin-top: 14px;
            border: 1px solid var(--line);
            border-radius: 16px;
            padding: 16px;
            background: var(--panel);
            backdrop-filter: blur(5px);
            animation: rise 520ms ease-out both;
          }

          .form-grid {
            display: grid;
            gap: 12px;
          }

          .field {
            display: grid;
            gap: 7px;
          }

          .field-label {
            font-size: 14px;
            font-weight: 700;
            color: #2c3e58;
          }

          .field :global(select),
          .field :global(input),
          .ratio-item :global(input) {
            width: 100%;
            border: 1px solid #c7d7e5;
            border-radius: 10px;
            padding: 10px 11px;
            font-size: 14px;
            color: #1f2a44;
            background: #ffffff;
            transition: border-color 120ms ease, box-shadow 120ms ease;
          }

          .field :global(select:focus),
          .field :global(input:focus),
          .ratio-item :global(input:focus) {
            outline: none;
            border-color: #89b7d6;
            box-shadow: 0 0 0 3px rgba(137, 183, 214, 0.2);
          }

          .ratio-list {
            display: grid;
            gap: 8px;
            border: 1px dashed #c6d8ea;
            border-radius: 12px;
            background: #f8fbff;
            padding: 10px;
          }

          .ratio-item {
            display: grid;
            grid-template-columns: 1fr 120px;
            align-items: center;
            gap: 8px;
          }

          .ratio-label {
            font-size: 13px;
            color: #30445f;
          }

          .helper-text {
            color: var(--muted);
            font-size: 14px;
          }

          .meta-text {
            color: #3c4f67;
            font-size: 13px;
          }

          .sub-text,
          .footnote {
            margin: 0;
            color: var(--muted);
            font-size: 12px;
            line-height: 1.55;
          }

          .checkbox-field {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 14px;
            font-weight: 600;
            color: #2f3f56;
          }

          .chip-row {
            border: 1px solid #d2e4f1;
            border-radius: 999px;
            background: #f7fcff;
            padding: 9px 12px;
            font-size: 13px;
            color: #3b4e65;
            width: fit-content;
          }

          .actions {
            display: flex;
            gap: 10px;
            align-items: center;
            flex-wrap: wrap;
          }

          .btn {
            border-radius: 10px;
            border: none;
            font-size: 14px;
            font-weight: 700;
            padding: 10px 14px;
            cursor: pointer;
            transition: transform 120ms ease, box-shadow 120ms ease, opacity 120ms ease;
          }

          .btn:disabled {
            opacity: 0.56;
            cursor: not-allowed;
            transform: none;
            box-shadow: none;
          }

          .btn-primary {
            color: #ffffff;
            background: linear-gradient(135deg, var(--accent) 0%, var(--accent-strong) 100%);
            box-shadow: 0 10px 20px -14px rgba(19, 93, 106, 0.85);
          }

          .btn-primary:hover:not(:disabled) {
            transform: translateY(-1px);
          }

          .btn-secondary {
            color: #32506f;
            border: 1px solid #bfd3e4;
            background: #ffffff;
          }

          .btn-secondary:hover:not(:disabled) {
            transform: translateY(-1px);
          }

          .status {
            margin: 12px 2px 0;
            border-radius: 11px;
            padding: 10px 12px;
            border: 1px solid;
            font-size: 14px;
            animation: rise 280ms ease-out both;
          }

          .status-error {
            border-color: #f3c6c1;
            background: #fff4f2;
            color: #b42318;
          }

          .status-ok {
            border-color: #bce7dd;
            background: #ecfdf5;
            color: #0f766e;
          }

          .panel-download {
            border-color: #bce7dd;
            background: linear-gradient(145deg, #f3fff9 0%, #effbf7 100%);
          }

          .download-line {
            margin: 0 0 8px;
            color: #1e453c;
          }

          .download-line code {
            background: #ffffffcc;
            padding: 2px 6px;
            border-radius: 6px;
          }

          .download-actions {
            display: flex;
            gap: 10px;
            align-items: center;
            flex-wrap: wrap;
          }

          .download-link {
            color: #0c4a6e;
            font-size: 14px;
            font-weight: 700;
            text-decoration: none;
            border-bottom: 1px solid rgba(12, 74, 110, 0.3);
          }

          .download-link:hover {
            border-bottom-color: #0c4a6e;
          }

          @media (max-width: 760px) {
            .paper-create-page {
              margin-top: 16px;
              padding: 0 12px 16px;
            }

            .hero {
              padding: 16px;
            }

            .panel {
              padding: 12px;
            }

            .ratio-item {
              grid-template-columns: 1fr;
            }

            .actions,
            .download-actions {
              display: grid;
              gap: 8px;
            }

            .actions .btn,
            .download-actions .btn,
            .download-actions .download-link {
              width: 100%;
              text-align: center;
            }
          }

          @keyframes rise {
            from {
              opacity: 0;
              transform: translateY(8px);
            }
            to {
              opacity: 1;
              transform: translateY(0);
            }
          }

          @keyframes floaty {
            0%,
            100% {
              transform: translateY(0);
            }
            50% {
              transform: translateY(-10px);
            }
          }
        `}</style>
      </main>
    </ClientErrorBoundary>
  );
}
