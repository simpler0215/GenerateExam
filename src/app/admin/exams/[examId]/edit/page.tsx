"use client";

import dynamic from "next/dynamic";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { doc, getDoc } from "firebase/firestore";

import { ClientErrorBoundary } from "@/components/client-error-boundary";
import { getClientDb } from "@/lib/firebase/client";
import {
  deleteQuestionAndShift,
  fetchPageQuestionSummaries,
  PNG_PAGE_HEIGHT,
  PNG_PAGE_WIDTH,
  fetchQuestionRecord,
  restoreQuestionPreviousSnapshot,
  saveQuestionRecord,
  type PageQuestionSummary,
  type PngRect,
  type QuestionPart,
  type ReviewStatus,
} from "@/lib/firebase/questions";

const MIN_BOX_DISPLAY_SIZE = 20;
const AUTOSAVE_DEBOUNCE_MS = 500;
const SUGGESTION_INSERT_OFFSET_PX = 14;
const SUGGESTION_OVERLAP_WARN_IOU = 0.55;
const Rnd = dynamic(() => import("react-rnd").then((mod) => mod.Rnd), {
  ssr: false,
});

type DisplaySize = {
  width: number;
  height: number;
};

type DisplayRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type SaveState = "idle" | "saving" | "saved" | "error";
type SuggestedQuestionDraft = {
  qNo: number;
  part: QuestionPart;
};
type ExamPageConfig = {
  sourcePageNo: number;
  category: string;
};
type AllQuestionOverlayPart = {
  qNo: number;
  part: QuestionPart;
};

function toPositiveInt(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  const rounded = Math.floor(parsed);
  return rounded > 0 ? rounded : null;
}

function toPositiveIntFromUnknown(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  const integer = Math.floor(numeric);
  return integer > 0 ? integer : null;
}

function normalizeExamPageConfig(value: unknown): ExamPageConfig | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const sourcePageNo = toPositiveIntFromUnknown(raw.sourcePageNo);
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

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "예상하지 못한 오류";
}

function createPartId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `part-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function clampDisplayRect(
  rect: DisplayRect,
  size: DisplaySize,
  minSize = MIN_BOX_DISPLAY_SIZE,
): DisplayRect {
  if (
    !Number.isFinite(rect.x) ||
    !Number.isFinite(rect.y) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height)
  ) {
    return {
      x: 0,
      y: 0,
      width: Math.max(1, Math.min(minSize, size.width || 1)),
      height: Math.max(1, Math.min(minSize, size.height || 1)),
    };
  }

  const maxWidth = Math.max(1, size.width);
  const maxHeight = Math.max(1, size.height);
  const minWidth = Math.min(minSize, maxWidth);
  const minHeight = Math.min(minSize, maxHeight);

  const width = Math.min(maxWidth, Math.max(minWidth, rect.width));
  const height = Math.min(maxHeight, Math.max(minHeight, rect.height));
  const x = Math.min(maxWidth - width, Math.max(0, rect.x));
  const y = Math.min(maxHeight - height, Math.max(0, rect.y));

  return { x, y, width, height };
}

function createDefaultDisplayRect(size: DisplaySize): DisplayRect {
  return clampDisplayRect(
    {
      x: size.width * 0.25,
      y: size.height * 0.15,
      width: size.width * 0.5,
      height: size.height * 0.12,
    },
    size,
  );
}

function displayToPngRect(rect: DisplayRect, size: DisplaySize): PngRect {
  const scaleX = PNG_PAGE_WIDTH / size.width;
  const scaleY = PNG_PAGE_HEIGHT / size.height;

  const x = Math.round(rect.x * scaleX);
  const y = Math.round(rect.y * scaleY);
  const width = Math.round(rect.width * scaleX);
  const height = Math.round(rect.height * scaleY);
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height)
  ) {
    return {
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    };
  }
  const clampedX = Math.min(Math.max(0, x), PNG_PAGE_WIDTH - 1);
  const clampedY = Math.min(Math.max(0, y), PNG_PAGE_HEIGHT - 1);
  const clampedWidth = Math.min(Math.max(1, width), PNG_PAGE_WIDTH - clampedX);
  const clampedHeight = Math.min(Math.max(1, height), PNG_PAGE_HEIGHT - clampedY);

  return {
    x: clampedX,
    y: clampedY,
    width: clampedWidth,
    height: clampedHeight,
  };
}

function pngToDisplayRect(rect: PngRect, size: DisplaySize): DisplayRect {
  const scaleX = size.width / PNG_PAGE_WIDTH;
  const scaleY = size.height / PNG_PAGE_HEIGHT;
  return {
    x: rect.x * scaleX,
    y: rect.y * scaleY,
    width: rect.width * scaleX,
    height: rect.height * scaleY,
  };
}

function rectArea(rect: DisplayRect): number {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

function intersectionArea(a: DisplayRect, b: DisplayRect): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= left || bottom <= top) {
    return 0;
  }
  return (right - left) * (bottom - top);
}

function getIoU(a: DisplayRect, b: DisplayRect): number {
  const overlap = intersectionArea(a, b);
  if (overlap <= 0) {
    return 0;
  }
  const union = rectArea(a) + rectArea(b) - overlap;
  if (union <= 0) {
    return 0;
  }
  return overlap / union;
}

function expandRect(rect: DisplayRect, size: DisplaySize): DisplayRect {
  const xPad = size.width * 0.012;
  const yPadTop = size.height * 0.008;
  const yPadBottom = size.height * 0.016;
  return clampDisplayRect(
    {
      x: rect.x - xPad,
      y: rect.y - yPadTop,
      width: rect.width + xPad * 2,
      height: rect.height + yPadTop + yPadBottom,
    },
    size,
  );
}

function normalizeSuggestionRects(rects: DisplayRect[], size: DisplaySize): DisplayRect[] {
  const minWidth = size.width * 0.14;
  const minHeight = size.height * 0.035;
  const maxWidth = size.width * 0.97;
  const maxHeight = size.height * 0.82;

  const filtered = rects
    .map((rect) => clampDisplayRect(rect, size))
    .filter(
      (rect) =>
        rect.width >= minWidth &&
        rect.height >= minHeight &&
        rect.width <= maxWidth &&
        rect.height <= maxHeight,
    )
    .sort((a, b) => (Math.abs(a.y - b.y) < size.height * 0.015 ? a.x - b.x : a.y - b.y));

  const merged: DisplayRect[] = [];
  for (const rect of filtered) {
    let hasMerged = false;
    for (let i = 0; i < merged.length; i += 1) {
      const base = merged[i];
      const iou = getIoU(base, rect);
      const contains =
        rect.x >= base.x - 2 &&
        rect.y >= base.y - 2 &&
        rect.x + rect.width <= base.x + base.width + 2 &&
        rect.y + rect.height <= base.y + base.height + 2;
      if (iou > 0.32 || contains) {
        const left = Math.min(base.x, rect.x);
        const top = Math.min(base.y, rect.y);
        const right = Math.max(base.x + base.width, rect.x + rect.width);
        const bottom = Math.max(base.y + base.height, rect.y + rect.height);
        merged[i] = clampDisplayRect(
          {
            x: left,
            y: top,
            width: right - left,
            height: bottom - top,
          },
          size,
        );
        hasMerged = true;
        break;
      }
    }
    if (!hasMerged) {
      merged.push(rect);
    }
  }

  return merged
    .map((rect) => expandRect(rect, size))
    .sort((a, b) => (Math.abs(a.y - b.y) < size.height * 0.015 ? a.x - b.x : a.y - b.y))
    .slice(0, 40);
}

function detectSuggestionRects(
  image: HTMLImageElement,
  displaySize: DisplaySize,
): DisplayRect[] {
  const sourceWidth = Math.max(360, Math.min(1200, Math.round(displaySize.width)));
  const sourceHeight = Math.max(
    480,
    Math.round((displaySize.height / Math.max(1, displaySize.width)) * sourceWidth),
  );
  const canvas = document.createElement("canvas");
  canvas.width = sourceWidth;
  canvas.height = sourceHeight;

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    return [];
  }

  ctx.drawImage(image, 0, 0, sourceWidth, sourceHeight);
  let imageData: Uint8ClampedArray;
  try {
    imageData = ctx.getImageData(0, 0, sourceWidth, sourceHeight).data;
  } catch {
    return [];
  }
  const totalPixels = sourceWidth * sourceHeight;

  let graySum = 0;
  const sampleStep = 16;
  for (let i = 0; i < imageData.length; i += sampleStep * 4) {
    const r = imageData[i];
    const g = imageData[i + 1];
    const b = imageData[i + 2];
    graySum += (r * 299 + g * 587 + b * 114) / 1000;
  }
  const sampledPixels = Math.max(1, Math.floor(totalPixels / sampleStep));
  const meanGray = graySum / sampledPixels;
  const threshold = Math.max(80, Math.min(205, meanGray * 0.82));

  const cell = 8;
  const cols = Math.floor(sourceWidth / cell);
  const rows = Math.floor(sourceHeight / cell);
  const area = cols * rows;
  const mask = new Uint8Array(area);

  for (let cy = 0; cy < rows; cy += 1) {
    for (let cx = 0; cx < cols; cx += 1) {
      let dark = 0;
      let count = 0;

      for (let py = 0; py < cell; py += 1) {
        for (let px = 0; px < cell; px += 1) {
          const x = cx * cell + px;
          const y = cy * cell + py;
          const idx = (y * sourceWidth + x) * 4;
          const r = imageData[idx];
          const g = imageData[idx + 1];
          const b = imageData[idx + 2];
          const gray = (r * 299 + g * 587 + b * 114) / 1000;
          if (gray < threshold) {
            dark += 1;
          }
          count += 1;
        }
      }

      if (dark / Math.max(1, count) > 0.08) {
        mask[cy * cols + cx] = 1;
      }
    }
  }

  const dilated = new Uint8Array(area);
  for (let cy = 0; cy < rows; cy += 1) {
    for (let cx = 0; cx < cols; cx += 1) {
      if (mask[cy * cols + cx] !== 1) {
        continue;
      }
      for (let ny = cy - 1; ny <= cy + 1; ny += 1) {
        for (let nx = cx - 1; nx <= cx + 1; nx += 1) {
          if (nx >= 0 && ny >= 0 && nx < cols && ny < rows) {
            dilated[ny * cols + nx] = 1;
          }
        }
      }
    }
  }

  const visited = new Uint8Array(area);
  const queueX = new Int32Array(area);
  const queueY = new Int32Array(area);
  const boxes: DisplayRect[] = [];
  const scaleX = displaySize.width / sourceWidth;
  const scaleY = displaySize.height / sourceHeight;

  for (let sy = 0; sy < rows; sy += 1) {
    for (let sx = 0; sx < cols; sx += 1) {
      const startIndex = sy * cols + sx;
      if (visited[startIndex] || dilated[startIndex] !== 1) {
        continue;
      }

      let head = 0;
      let tail = 0;
      queueX[tail] = sx;
      queueY[tail] = sy;
      tail += 1;
      visited[startIndex] = 1;

      let minX = sx;
      let maxX = sx;
      let minY = sy;
      let maxY = sy;
      let cellCount = 0;

      while (head < tail) {
        const cx = queueX[head];
        const cy = queueY[head];
        head += 1;
        cellCount += 1;

        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        const neighbors = [
          [cx - 1, cy],
          [cx + 1, cy],
          [cx, cy - 1],
          [cx, cy + 1],
        ];

        for (const [nx, ny] of neighbors) {
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) {
            continue;
          }
          const nIndex = ny * cols + nx;
          if (visited[nIndex] || dilated[nIndex] !== 1) {
            continue;
          }
          visited[nIndex] = 1;
          queueX[tail] = nx;
          queueY[tail] = ny;
          tail += 1;
        }
      }

      const widthCells = maxX - minX + 1;
      const heightCells = maxY - minY + 1;
      if (cellCount < 8 || widthCells < 3 || heightCells < 3) {
        continue;
      }

      const pad = 1;
      const pixelX = Math.max(0, (minX - pad) * cell);
      const pixelY = Math.max(0, (minY - pad) * cell);
      const pixelWidth = Math.min(
        sourceWidth - pixelX,
        (widthCells + pad * 2) * cell,
      );
      const pixelHeight = Math.min(
        sourceHeight - pixelY,
        (heightCells + pad * 2) * cell,
      );

      const displayRect = clampDisplayRect(
        {
          x: pixelX * scaleX,
          y: pixelY * scaleY,
          width: pixelWidth * scaleX,
          height: pixelHeight * scaleY,
        },
        displaySize,
      );
      boxes.push(displayRect);
    }
  }

  return boxes
    .sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y))
    .slice(0, 40);
}

export default function ExamEditPage() {
  const params = useParams<{ examId: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const rawExamId = params?.examId;
  const examId = Array.isArray(rawExamId) ? rawExamId[0] : (rawExamId ?? "");
  const pageNo = toPositiveInt(searchParams.get("pageNo"));
  const imageRef = useRef<HTMLImageElement | null>(null);
  const skipNextAutosaveRef = useRef(false);

  const [pageImageUrl, setPageImageUrl] = useState<string | null>(null);
  const [isImageLoading, setIsImageLoading] = useState(false);
  const [pageImageError, setPageImageError] = useState<string | null>(null);
  const [displaySize, setDisplaySize] = useState<DisplaySize>({ width: 0, height: 0 });
  const [resolvedSourcePageNo, setResolvedSourcePageNo] = useState<number | null>(null);
  const [displayPageCount, setDisplayPageCount] = useState<number | null>(null);
  const [currentPageCategory, setCurrentPageCategory] = useState("");

  const [activeQNo, setActiveQNo] = useState(1);
  const [qNoInput, setQNoInput] = useState("1");
  const [reviewStatus, setReviewStatus] = useState<ReviewStatus>("draft");
  const [showAllQuestions, setShowAllQuestions] = useState(false);
  const [hasPreviousSnapshot, setHasPreviousSnapshot] = useState(false);
  const [parts, setParts] = useState<QuestionPart[]>([]);
  const [selectedPartId, setSelectedPartId] = useState<string | null>(null);
  const [suggestedDrafts, setSuggestedDrafts] = useState<SuggestedQuestionDraft[]>([]);
  const [selectedSuggestedPartId, setSelectedSuggestedPartId] = useState<string | null>(null);
  const [pageQuestionSummaries, setPageQuestionSummaries] = useState<PageQuestionSummary[]>([]);
  const [isPageQuestionSummaryLoading, setIsPageQuestionSummaryLoading] = useState(false);
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [isQuestionLoading, setIsQuestionLoading] = useState(false);
  const [questionError, setQuestionError] = useState<string | null>(null);
  const [noticeMessage, setNoticeMessage] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [questionInitialized, setQuestionInitialized] = useState(false);

  const partsOnCurrentPage = useMemo(
    () => (pageNo ? parts.filter((part) => part.pageNo === pageNo) : []),
    [pageNo, parts],
  );
  const allQuestionOverlayParts = useMemo<AllQuestionOverlayPart[]>(
    () =>
      pageQuestionSummaries.flatMap((summary) =>
        summary.parts.map((part) => ({
          qNo: summary.qNo,
          part,
        })),
      ),
    [pageQuestionSummaries],
  );
  const currentPageQuestionCount = pageQuestionSummaries.length;

  const clearSuggestedDrafts = useCallback(() => {
    setSuggestedDrafts([]);
    setSelectedSuggestedPartId(null);
  }, []);

  const loadQuestion = useCallback(
    async (targetQNo: number) => {
      if (!examId || !pageNo) {
        return;
      }

      setIsQuestionLoading(true);
      setQuestionError(null);
      setNoticeMessage(null);
      try {
        const loaded = await fetchQuestionRecord(examId, targetQNo, pageNo);
        if (loaded && loaded.pageNo !== pageNo) {
          skipNextAutosaveRef.current = true;
          setParts([]);
          setReviewStatus("draft");
          setHasPreviousSnapshot(Boolean(loaded.previousSnapshot));
          setSelectedPartId(null);
          clearSuggestedDrafts();
          setActiveQNo(targetQNo);
          setQNoInput(String(targetQNo));
          setQuestionInitialized(true);
          setQuestionError(
            `문항 ${targetQNo}번은 페이지 ${loaded.pageNo}에 있습니다. 현재 페이지(${pageNo})에서는 다른 번호를 사용해 주세요.`,
          );
          return;
        }
        const nextParts = (loaded?.parts ?? [])
          .filter((part) => part.pageNo === pageNo)
          .slice(0, 1)
          .map((part, index) => ({
            ...part,
            order: index + 1,
          }));
        const nextReviewStatus = loaded?.reviewStatus ?? "draft";
        skipNextAutosaveRef.current = true;
        setParts(nextParts);
        setReviewStatus(nextReviewStatus);
        setHasPreviousSnapshot(Boolean(loaded?.previousSnapshot));
        setSelectedPartId(nextParts[0]?.id ?? null);
        clearSuggestedDrafts();
        setActiveQNo(targetQNo);
        setQNoInput(String(targetQNo));
        setQuestionInitialized(true);
      } catch (error) {
        setQuestionError(getErrorMessage(error));
      } finally {
        setIsQuestionLoading(false);
      }
    },
    [clearSuggestedDrafts, examId, pageNo],
  );

  const loadExamPageMeta = useCallback(async () => {
    if (!examId || !pageNo) {
      return;
    }
    try {
      const db = getClientDb();
      const examSnap = await getDoc(doc(db, "exams", examId));
      if (!examSnap.exists()) {
        setResolvedSourcePageNo(pageNo);
        setDisplayPageCount(null);
        setCurrentPageCategory("");
        return;
      }

      const data = examSnap.data() as Record<string, unknown>;
      const pageCount = toPositiveIntFromUnknown(data.pageCount);
      const renderedPageCount = toPositiveIntFromUnknown(data.renderedPageCount);
      const fallbackPageCount = pageCount ?? renderedPageCount ?? 0;
      const pageConfigs = resolveExamPageConfigs(data.pageConfigs, fallbackPageCount);
      const nextDisplayPageCount =
        pageConfigs.length > 0 ? pageConfigs.length : pageCount ?? renderedPageCount ?? null;
      const currentConfig =
        pageConfigs.length > 0 ? pageConfigs[pageNo - 1] : { sourcePageNo: pageNo, category: "" };
      const sourcePageNo = currentConfig?.sourcePageNo ?? pageNo;

      setResolvedSourcePageNo(sourcePageNo);
      setDisplayPageCount(nextDisplayPageCount);
      setCurrentPageCategory(currentConfig?.category ?? "");
    } catch {
      setResolvedSourcePageNo(pageNo);
      setDisplayPageCount(null);
      setCurrentPageCategory("");
    }
  }, [examId, pageNo]);

  const loadPageQuestionSummary = useCallback(async () => {
    if (!examId || !pageNo) {
      return;
    }
    setIsPageQuestionSummaryLoading(true);
    try {
      const summaries = await fetchPageQuestionSummaries(examId, pageNo);
      setPageQuestionSummaries(summaries);
    } catch {
      setPageQuestionSummaries([]);
    } finally {
      setIsPageQuestionSummaryLoading(false);
    }
  }, [examId, pageNo]);

  const saveQuestion = useCallback(
    async (
      targetParts: QuestionPart[],
      targetQNo: number,
      targetReviewStatus: ReviewStatus,
    ): Promise<boolean> => {
      if (!examId || !pageNo) {
        return false;
      }

      setSaveState("saving");
      setSaveError(null);
      try {
        const normalizedParts = targetParts
          .filter((part) => part.pageNo === pageNo)
          .slice(0, 1)
          .map((part, index) => ({
            ...part,
            order: index + 1,
          }));
        const result = await saveQuestionRecord({
          examId,
          qNo: targetQNo,
          pageNo,
          parts: normalizedParts,
          reviewStatus: targetReviewStatus,
        });
        setHasPreviousSnapshot((prev) => prev || result.hasPreviousSnapshot);
        setSaveState("saved");
        setLastSavedAt(Date.now());
        return true;
      } catch (error) {
        const message = getErrorMessage(error);
        setSaveState("error");
        setSaveError(message);
        setQuestionError(message);
        return false;
      }
    },
    [examId, pageNo],
  );

  useEffect(() => {
    if (!examId || !pageNo) {
      return;
    }
    let cancelled = false;

    const initializePage = async () => {
      setShowAllQuestions(false);
      setQuestionInitialized(false);

      await loadExamPageMeta();

      let summaries: PageQuestionSummary[] = [];
      try {
        summaries = await fetchPageQuestionSummaries(examId, pageNo);
        if (!cancelled) {
          setPageQuestionSummaries(summaries);
          setShowAllQuestions(summaries.length > 0);
        }
      } catch {
        if (!cancelled) {
          setPageQuestionSummaries([]);
          setShowAllQuestions(false);
        }
      }

      if (cancelled) {
        return;
      }
      await loadQuestion(1);
    };

    void initializePage();
    return () => {
      cancelled = true;
    };
  }, [examId, loadExamPageMeta, loadQuestion, pageNo]);

  useEffect(() => {
    if (!questionInitialized) {
      return;
    }
    if (skipNextAutosaveRef.current) {
      skipNextAutosaveRef.current = false;
      return;
    }

    const timer = window.setTimeout(() => {
      void saveQuestion(parts, activeQNo, reviewStatus);
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [activeQNo, parts, questionInitialized, reviewStatus, saveQuestion]);

  useEffect(() => {
    if (!examId || !pageNo || !questionInitialized) {
      return;
    }
    const timer = window.setTimeout(() => {
      void loadPageQuestionSummary();
    }, 700);
    return () => window.clearTimeout(timer);
  }, [activeQNo, examId, loadPageQuestionSummary, pageNo, parts, questionInitialized, reviewStatus]);

  useEffect(() => {
    if (!examId || !pageNo) {
      return;
    }

    setIsImageLoading(true);
    setPageImageError(null);
    const sourcePageNo = resolvedSourcePageNo ?? pageNo;
    const encodedPath = encodeURIComponent(`derived/${examId}/pages/${sourcePageNo}.png`);
    setPageImageUrl(`/api/storage-file?path=${encodedPath}`);
  }, [examId, pageNo, resolvedSourcePageNo]);

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const imageEl = imageRef.current;
    if (!imageEl) {
      return;
    }

    const updateSize = () => {
      const rect = imageEl.getBoundingClientRect();
      setDisplaySize({
        width: Math.max(0, rect.width),
        height: Math.max(0, rect.height),
      });
    };

    updateSize();
    const observer = new ResizeObserver(() => updateSize());
    observer.observe(imageEl);
    return () => observer.disconnect();
  }, [pageImageUrl]);

  const updatePartFromDisplayRect = useCallback(
    (partId: string, rect: DisplayRect) => {
      if (!displaySize.width || !displaySize.height) {
        return;
      }
      const clamped = clampDisplayRect(rect, displaySize);
      const nextPngRect = displayToPngRect(clamped, displaySize);
      setParts((prev) =>
        prev.map((part) =>
          part.id === partId
            ? {
                ...part,
                rect: nextPngRect,
              }
            : part,
        ),
      );
    },
    [displaySize],
  );

  const createSinglePart = useCallback(() => {
    if (!pageNo || !displaySize.width || !displaySize.height || partsOnCurrentPage.length > 0) {
      return;
    }

    const baseRect = createDefaultDisplayRect(displaySize);
    const newPart: QuestionPart = {
      id: createPartId(),
      order: 1,
      pageNo,
      rect: displayToPngRect(baseRect, displaySize),
    };
    setParts([newPart]);
    setSelectedPartId(newPart.id);
    clearSuggestedDrafts();
  }, [clearSuggestedDrafts, displaySize, pageNo, partsOnCurrentPage.length]);

  const deleteSelectedPart = useCallback(() => {
    if (!selectedPartId) {
      return;
    }
    setParts((prev) => {
      const next = prev.filter((part) => part.id !== selectedPartId);
      setSelectedPartId(next[0]?.id ?? null);
      return next.map((part, index) => ({
        ...part,
        order: index + 1,
      }));
    });
    clearSuggestedDrafts();
  }, [clearSuggestedDrafts, selectedPartId]);

  const jumpQuestion = useCallback(
    async (targetQNo: number) => {
      const safeQNo = Math.max(1, targetQNo);
      const saved = await saveQuestion(parts, activeQNo, reviewStatus);
      if (!saved) {
        setQuestionError("저장 실패로 문항 이동을 중단했습니다. 오류를 확인해 주세요.");
        return;
      }
      await loadQuestion(safeQNo);
    },
    [activeQNo, loadQuestion, parts, reviewStatus, saveQuestion],
  );

  const goToNextPage = useCallback(async () => {
    if (!examId || !pageNo) {
      return;
    }
    if (displayPageCount && pageNo >= displayPageCount) {
      return;
    }

    const saved = await saveQuestion(parts, activeQNo, reviewStatus);
    if (!saved) {
      setQuestionError("저장 실패로 페이지 이동을 중단했습니다. 오류를 확인해 주세요.");
      return;
    }
    const targetPageNo = pageNo + 1;
    setShowAllQuestions(false);
    router.push(`/admin/exams/${encodeURIComponent(examId)}/edit?pageNo=${targetPageNo}`);
  }, [activeQNo, displayPageCount, examId, pageNo, parts, reviewStatus, router, saveQuestion]);

  const goToPreviousPage = useCallback(async () => {
    if (!examId || !pageNo || pageNo <= 1) {
      return;
    }

    const saved = await saveQuestion(parts, activeQNo, reviewStatus);
    if (!saved) {
      setQuestionError("저장 실패로 페이지 이동을 중단했습니다. 오류를 확인해 주세요.");
      return;
    }
    const targetPageNo = pageNo - 1;
    setShowAllQuestions(false);
    router.push(`/admin/exams/${encodeURIComponent(examId)}/edit?pageNo=${targetPageNo}`);
  }, [activeQNo, examId, pageNo, parts, reviewStatus, router, saveQuestion]);

  const goToPageList = useCallback(async () => {
    if (!examId) {
      return;
    }
    if (pageNo) {
      const saved = await saveQuestion(parts, activeQNo, reviewStatus);
      if (!saved) {
        setQuestionError("저장 실패로 페이지 리스트 이동을 중단했습니다. 오류를 확인해 주세요.");
        return;
      }
    }
    router.push(`/admin/exams/${encodeURIComponent(examId)}/pages`);
  }, [activeQNo, examId, pageNo, parts, reviewStatus, router, saveQuestion]);

  const runAutoSuggest = useCallback(async () => {
    if (!pageNo || !imageRef.current || !displaySize.width || !displaySize.height) {
      return;
    }

    setIsSuggesting(true);
    setNoticeMessage(null);
    try {
      const rawRects = detectSuggestionRects(imageRef.current, displaySize);
      const normalizedRects = normalizeSuggestionRects(rawRects, displaySize);
      const drafts: SuggestedQuestionDraft[] = normalizedRects.map((rect, index) => ({
        qNo: activeQNo + index,
        part: {
          id: `suggest-${index + 1}-${createPartId()}`,
          order: 1,
          pageNo,
          rect: displayToPngRect(rect, displaySize),
        },
      }));
      setSuggestedDrafts(drafts);
      setSelectedSuggestedPartId(drafts[0]?.part.id ?? null);
      if (drafts.length === 0) {
        setQuestionError(
          "이 페이지에서 제안 영역을 찾지 못했습니다. 수동으로 영역을 생성해 주세요.",
        );
      } else {
        setQuestionError(null);
        setNoticeMessage(
          `문항 ${drafts[0].qNo}번부터 ${drafts[drafts.length - 1].qNo}번까지 제안 ${drafts.length}개를 생성했습니다.`,
        );
      }
    } catch (error) {
      setQuestionError(getErrorMessage(error));
    } finally {
      setIsSuggesting(false);
    }
  }, [activeQNo, displaySize, pageNo]);

  const updateSuggestedDraftFromDisplayRect = useCallback(
    (partId: string, rect: DisplayRect) => {
      if (!displaySize.width || !displaySize.height) {
        return;
      }
      const clamped = clampDisplayRect(rect, displaySize);
      const nextPngRect = displayToPngRect(clamped, displaySize);
      setSuggestedDrafts((prev) =>
        prev.map((draft) =>
          draft.part.id === partId
            ? {
                ...draft,
                part: {
                  ...draft.part,
                  rect: nextPngRect,
                },
              }
            : draft,
        ),
      );
    },
    [displaySize],
  );

  const addSuggestedDraft = useCallback(() => {
    if (!pageNo || !displaySize.width || !displaySize.height || suggestedDrafts.length === 0) {
      return;
    }

    const orderedPrev = [...suggestedDrafts].sort((a, b) => a.qNo - b.qNo);
    const startQNo = orderedPrev[0]?.qNo ?? activeQNo;
    const selectedIndex = selectedSuggestedPartId
      ? orderedPrev.findIndex((draft) => draft.part.id === selectedSuggestedPartId)
      : -1;
    const insertIndex = selectedIndex >= 0 ? selectedIndex + 1 : orderedPrev.length;

    const anchorRect =
      selectedIndex >= 0
        ? pngToDisplayRect(orderedPrev[selectedIndex].part.rect, displaySize)
        : orderedPrev.length > 0
          ? pngToDisplayRect(orderedPrev[orderedPrev.length - 1].part.rect, displaySize)
          : null;
    const baseRect = anchorRect
      ? clampDisplayRect(
          {
            ...anchorRect,
            x: anchorRect.x + SUGGESTION_INSERT_OFFSET_PX,
            y: anchorRect.y + SUGGESTION_INSERT_OFFSET_PX,
          },
          displaySize,
        )
      : createDefaultDisplayRect(displaySize);

    const newDraft: SuggestedQuestionDraft = {
      qNo: startQNo + insertIndex,
      part: {
        id: `suggest-manual-${createPartId()}`,
        order: 1,
        pageNo,
        rect: displayToPngRect(baseRect, displaySize),
      },
    };
    const inserted = [
      ...orderedPrev.slice(0, insertIndex),
      newDraft,
      ...orderedPrev.slice(insertIndex),
    ];
    const renumbered = inserted.map((draft, index) => ({
      ...draft,
      qNo: startQNo + index,
    }));
    setSuggestedDrafts(renumbered);
    setSelectedSuggestedPartId(newDraft.part.id);
    setQuestionError(null);
    setNoticeMessage(`문항 ${newDraft.qNo}번 위치에 제안 영역을 새로 삽입했습니다.`);
  }, [activeQNo, displaySize, pageNo, selectedSuggestedPartId, suggestedDrafts]);

  const addOrCreateRegion = useCallback(() => {
    if (suggestedDrafts.length > 0) {
      addSuggestedDraft();
      return;
    }
    createSinglePart();
  }, [addSuggestedDraft, createSinglePart, suggestedDrafts.length]);

  const deleteSuggestedDraftById = useCallback(
    (partId: string) => {
      setSuggestedDrafts((prev) => {
        if (prev.length === 0) {
          return prev;
        }
        const orderedPrev = [...prev].sort((a, b) => a.qNo - b.qNo);
        const startQNo = orderedPrev[0]?.qNo ?? activeQNo;
        const filtered = orderedPrev.filter((draft) => draft.part.id !== partId);
        const renumbered = filtered.map((draft, index) => ({
          ...draft,
          qNo: startQNo + index,
        }));
        setSelectedSuggestedPartId((current) => {
          if (current && current !== partId && renumbered.some((draft) => draft.part.id === current)) {
            return current;
          }
          return renumbered[0]?.part.id ?? null;
        });
        return renumbered;
      });
      setNoticeMessage("제안 영역을 삭제했습니다.");
    },
    [activeQNo],
  );

  const saveSuggestedDrafts = useCallback(async () => {
    if (!examId || !pageNo || suggestedDrafts.length === 0) {
      return;
    }

    setShowAllQuestions(true);
    setSaveState("saving");
    setSaveError(null);
    setNoticeMessage(null);
    try {
      const orderedDrafts = [...suggestedDrafts].sort((a, b) => a.qNo - b.qNo);
      const overlapPairs: Array<[number, number]> = [];
      for (let i = 0; i < orderedDrafts.length; i += 1) {
        const aRect = orderedDrafts[i].part.rect;
        for (let j = i + 1; j < orderedDrafts.length; j += 1) {
          const bRect = orderedDrafts[j].part.rect;
          const iou = getIoU(
            { x: aRect.x, y: aRect.y, width: aRect.width, height: aRect.height },
            { x: bRect.x, y: bRect.y, width: bRect.width, height: bRect.height },
          );
          if (iou >= SUGGESTION_OVERLAP_WARN_IOU) {
            overlapPairs.push([orderedDrafts[i].qNo, orderedDrafts[j].qNo]);
          }
        }
      }
      for (const draft of orderedDrafts) {
        await saveQuestionRecord({
          examId,
          qNo: draft.qNo,
          pageNo,
          reviewStatus: "draft",
          parts: [
            {
              ...draft.part,
              order: 1,
              pageNo,
            },
          ],
        });
      }

      setSaveState("saved");
      setLastSavedAt(Date.now());
      clearSuggestedDrafts();

      const firstQNo = orderedDrafts[0].qNo;
      const lastQNo = orderedDrafts[orderedDrafts.length - 1].qNo;
      const overlapSummary =
        overlapPairs.length > 0
          ? (() => {
              const sample = overlapPairs.slice(0, 3).map(([a, b]) => `Q${a}-Q${b}`).join(", ");
              const remains =
                overlapPairs.length > 3 ? ` 외 ${overlapPairs.length - 3}건` : "";
              return ` 겹침 경고(${sample}${remains})`;
            })()
          : "";
      setNoticeMessage(
        `자동 제안 ${orderedDrafts.length}개를 문항 ${firstQNo}~${lastQNo}로 저장했습니다.${overlapSummary}`,
      );
      await loadQuestion(activeQNo);
    } catch (error) {
      setSaveState("error");
      setSaveError(getErrorMessage(error));
      setQuestionError(getErrorMessage(error));
    }
  }, [activeQNo, clearSuggestedDrafts, examId, loadQuestion, pageNo, suggestedDrafts]);

  const restorePreviousSnapshot = useCallback(async () => {
    if (!examId || !pageNo) {
      return;
    }

    setSaveState("saving");
    setSaveError(null);
    setQuestionError(null);
    setNoticeMessage(null);

    try {
      const restored = await restoreQuestionPreviousSnapshot(examId, activeQNo, pageNo);
      if (!restored) {
        setSaveState("idle");
        setHasPreviousSnapshot(false);
        setQuestionError("복구 가능한 이전 스냅샷이 없습니다.");
        return;
      }

      skipNextAutosaveRef.current = true;
      setParts(restored.parts);
      setSelectedPartId(restored.parts[0]?.id ?? null);
      setReviewStatus(restored.reviewStatus);
      setHasPreviousSnapshot(Boolean(restored.previousSnapshot));
      clearSuggestedDrafts();
      setSaveState("saved");
      setLastSavedAt(Date.now());
      setNoticeMessage("최근 스냅샷으로 복구했습니다.");
    } catch (error) {
      setSaveState("error");
      const message = getErrorMessage(error);
      setSaveError(message);
      setQuestionError(message);
    }
  }, [activeQNo, clearSuggestedDrafts, examId, pageNo]);

  const deleteCurrentQuestionAndShift = useCallback(async () => {
    if (!examId || !pageNo) {
      return;
    }

    setSaveState("saving");
    setSaveError(null);
    setQuestionError(null);
    setNoticeMessage(null);

    try {
      const result = await deleteQuestionAndShift(examId, pageNo, activeQNo);
      if (!result.deleted) {
        setSaveState("idle");
        setQuestionError("삭제할 문항을 찾지 못했습니다.");
        return;
      }

      setSaveState("saved");
      setLastSavedAt(Date.now());
      await loadQuestion(result.nextQNo);
      setNoticeMessage(
        result.shiftedCount > 0
          ? `문항 ${activeQNo}번을 삭제하고 뒤 문항 ${result.shiftedCount}개의 번호를 당겼습니다.`
          : `문항 ${activeQNo}번을 삭제했습니다.`,
      );
    } catch (error) {
      setSaveState("error");
      const message = getErrorMessage(error);
      setSaveError(message);
      setQuestionError(message);
    }
  }, [activeQNo, examId, loadQuestion, pageNo]);

  const markAllCurrentPageQuestionsDone = useCallback(async () => {
    if (!examId || !pageNo) {
      return;
    }

    const targets = pageQuestionSummaries.filter((summary) => summary.parts.length > 0);
    if (targets.length < 1) {
      setNoticeMessage("현재 페이지에 최종 완료로 변경할 문항이 없습니다.");
      return;
    }

    setSaveState("saving");
    setSaveError(null);
    setQuestionError(null);
    setNoticeMessage(null);

    try {
      for (const summary of targets) {
        await saveQuestionRecord({
          examId,
          qNo: summary.qNo,
          pageNo,
          reviewStatus: "done",
          parts: summary.parts.map((part, index) => ({
            ...part,
            order: index + 1,
            pageNo,
          })),
        });
      }

      if (targets.some((summary) => summary.qNo === activeQNo)) {
        skipNextAutosaveRef.current = true;
        setReviewStatus("done");
      }
      setSaveState("saved");
      setLastSavedAt(Date.now());
      await loadPageQuestionSummary();
      setNoticeMessage(`현재 페이지 문항 ${targets.length}개를 최종 완료로 변경했습니다.`);
    } catch (error) {
      setSaveState("error");
      const message = getErrorMessage(error);
      setSaveError(message);
      setQuestionError(message);
    }
  }, [activeQNo, examId, loadPageQuestionSummary, pageNo, pageQuestionSummaries]);

  const reviewStatusText = useMemo(() => {
    if (reviewStatus === "reviewed") {
      return "검수 완료";
    }
    if (reviewStatus === "done") {
      return "최종 완료";
    }
    return "초안";
  }, [reviewStatus]);

  const saveStatusText = useMemo(() => {
    if (saveState === "saving") {
      return "자동 저장 중...";
    }
    if (saveState === "saved") {
      const timestamp = lastSavedAt ? new Date(lastSavedAt).toLocaleTimeString() : "";
      return `자동 저장 완료${timestamp ? ` (${timestamp})` : ""}`;
    }
    if (saveState === "error") {
      return `자동 저장 실패${saveError ? ` (${saveError})` : ""}`;
    }
    return "자동 저장 대기";
  }, [lastSavedAt, saveError, saveState]);

  const isPageOutOfRange = Boolean(pageNo && displayPageCount && pageNo > displayPageCount);
  const canRenderEditor = !!examId && !!pageNo && !isPageOutOfRange;

  return (
    <ClientErrorBoundary title="문제 편집 오류">
      <main className="aq-page aq-page-wide">
        <header className="aq-hero">
          <p className="aq-kicker">QUESTION EDITOR</p>
          <h1 className="aq-title">문제 편집</h1>
          <p className="aq-desc">
            시험 ID <b>{examId || "(유효하지 않음)"}</b>의 문항 영역과 검수 상태를 페이지 단위로 편집합니다.
          </p>
        </header>
        <p style={{ margin: "14px 0 18px" }}>
          페이지 번호: <b>{pageNo ?? "(유효하지 않음)"}</b>
          {displayPageCount ? (
            <>
              {" / "}
              <b>{displayPageCount}</b>
            </>
          ) : null}
          {"  "}
          현재 페이지 문제수: <b>{isPageQuestionSummaryLoading ? "..." : currentPageQuestionCount}</b>
          {"  "}
          {currentPageCategory ? `카테고리: ${currentPageCategory}` : "카테고리: -"}
          <button
            type="button"
            className="aq-btn-primary"
            onClick={() => void goToPreviousPage()}
            disabled={
              !canRenderEditor || !pageNo || pageNo <= 1 || isQuestionLoading || saveState === "saving"
            }
            style={{ marginLeft: 10 }}
          >
            이전 페이지
          </button>
          <button
            type="button"
            className="aq-btn-primary"
            onClick={() => void goToNextPage()}
            disabled={
              !canRenderEditor ||
              isQuestionLoading ||
              saveState === "saving" ||
              Boolean(displayPageCount && pageNo && pageNo >= displayPageCount)
            }
            style={{ marginLeft: 10 }}
          >
            다음 페이지
          </button>
        </p>

        <div className="aq-panel" style={{ display: "flex", gap: 12, marginBottom: 14, alignItems: "center" }}>
          <button
            type="button"
            onClick={() => void jumpQuestion(activeQNo - 1)}
            disabled={activeQNo <= 1 || isQuestionLoading}
          >
            이전 문항
          </button>
          <input
            type="number"
            min={1}
            value={qNoInput}
            onChange={(event) => setQNoInput(event.target.value)}
            style={{ width: 90 }}
          />
          <button
            type="button"
            onClick={() => {
              const target = toPositiveInt(qNoInput);
              if (!target) {
                setQuestionError("문항 번호는 1 이상이어야 합니다.");
                return;
              }
              void jumpQuestion(target);
            }}
            disabled={isQuestionLoading}
          >
            문항 불러오기
          </button>
          <button type="button" onClick={() => void jumpQuestion(activeQNo + 1)} disabled={isQuestionLoading}>
            다음 문항
          </button>
          <span style={{ color: "#666" }}>
            현재 문항 번호: <b>{activeQNo}</b>
          </span>
        </div>

        <div className="aq-panel" style={{ display: "flex", gap: 8, marginBottom: 14, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ color: "#444" }}>검수 상태:</span>
          <button
            type="button"
            onClick={() => setReviewStatus("draft")}
            style={{
              border: reviewStatus === "draft" ? "2px solid #0284c7" : "1px solid #ddd",
              background: reviewStatus === "draft" ? "rgba(2, 132, 199, 0.08)" : "#fff",
            }}
          >
            초안
          </button>
          <button
            type="button"
            onClick={() => setReviewStatus("reviewed")}
            style={{
              border: reviewStatus === "reviewed" ? "2px solid #0f766e" : "1px solid #ddd",
              background: reviewStatus === "reviewed" ? "rgba(15, 118, 110, 0.08)" : "#fff",
            }}
          >
            검수 완료
          </button>
          <button
            type="button"
            onClick={() => setReviewStatus("done")}
            style={{
              border: reviewStatus === "done" ? "2px solid #166534" : "1px solid #ddd",
              background: reviewStatus === "done" ? "rgba(22, 101, 52, 0.08)" : "#fff",
            }}
          >
            최종 완료
          </button>
          <button
            type="button"
            onClick={() => void markAllCurrentPageQuestionsDone()}
            disabled={
              !canRenderEditor ||
              isQuestionLoading ||
              isPageQuestionSummaryLoading ||
              saveState === "saving" ||
              currentPageQuestionCount < 1
            }
          >
            현재 페이지 전체 최종 완료
          </button>
          <button type="button" onClick={() => void restorePreviousSnapshot()} disabled={!hasPreviousSnapshot}>
            최근 스냅샷 복구
          </button>
          <span style={{ marginLeft: "auto", color: "#444" }}>
            현재 상태: <b>{reviewStatusText}</b>
          </span>
          <span style={{ color: hasPreviousSnapshot ? "#166534" : "#666" }}>
            {hasPreviousSnapshot ? "복구 가능" : "복구본 없음"}
          </span>
        </div>

        <div className="aq-panel" style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={() => setShowAllQuestions((prev) => !prev)}
            disabled={!canRenderEditor}
          >
            문항 전체 보기: {showAllQuestions ? "켜짐" : "꺼짐"}
          </button>
          <button
            type="button"
            onClick={() => void runAutoSuggest()}
            disabled={!canRenderEditor || !displaySize.width || isSuggesting || showAllQuestions}
          >
            {isSuggesting ? "영역 제안 중..." : "자동 제안"}
          </button>
          <button
            type="button"
            onClick={() => void saveSuggestedDrafts()}
            disabled={suggestedDrafts.length === 0 || !canRenderEditor || showAllQuestions}
          >
            제안 일괄 저장({suggestedDrafts.length})
          </button>
          <button
            type="button"
            onClick={addOrCreateRegion}
            disabled={
              !canRenderEditor ||
              !displaySize.width ||
              isSuggesting ||
              showAllQuestions ||
              (suggestedDrafts.length < 1 && partsOnCurrentPage.length > 0)
            }
          >
            {suggestedDrafts.length > 0 ? "영역 추가(제안)" : "영역 생성"}
          </button>
          <button type="button" onClick={deleteSelectedPart} disabled={!selectedPartId || showAllQuestions}>
            선택 영역 삭제
          </button>
          <button
            type="button"
            onClick={() => void deleteCurrentQuestionAndShift()}
            disabled={!canRenderEditor || isQuestionLoading || saveState === "saving"}
          >
            현재 문항 삭제(번호 당김)
          </button>
          <button
            type="button"
            onClick={clearSuggestedDrafts}
            disabled={suggestedDrafts.length === 0 || showAllQuestions}
          >
            제안 초기화
          </button>
          {showAllQuestions ? (
            <span style={{ color: "#666" }}>전체 보기에서는 박스 편집이 잠깁니다.</span>
          ) : null}
          {!showAllQuestions ? (
            <span style={{ color: "#666" }}>
              제안이 있으면 현재 선택 박스 뒤에 새 문항으로 영역이 추가됩니다.
            </span>
          ) : null}
          <span style={{ marginLeft: "auto", color: "#444" }}>{saveStatusText}</span>
        </div>

        {questionError ? <p className="aq-status aq-status-error">{questionError}</p> : null}
        {noticeMessage ? <p className="aq-status aq-status-ok">{noticeMessage}</p> : null}
        {!canRenderEditor ? (
          <p style={{ color: "crimson" }}>
            {isPageOutOfRange
              ? "페이지 범위를 벗어났습니다. 페이지 리스트에서 다시 진입해 주세요."
              : "유효하지 않은 시험 ID 또는 페이지 번호입니다."}
          </p>
        ) : null}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) 320px",
            gap: 16,
            alignItems: "start",
          }}
        >
          <section
            className="aq-panel"
            style={{
              padding: 10,
              minHeight: 400,
            }}
          >
            {isImageLoading ? <p>페이지 이미지를 불러오는 중...</p> : null}
            {pageImageError ? (
              <p style={{ color: "crimson" }}>페이지 이미지 로드 실패: {pageImageError}</p>
            ) : null}
            {pageImageUrl ? (
              <div style={{ position: "relative", width: "100%", maxWidth: 900 }}>
                <img
                  ref={imageRef}
                  src={pageImageUrl}
                  alt={`시험 페이지 ${pageNo}`}
                  onError={() => {
                    setIsImageLoading(false);
                    setPageImageError(
                      "페이지 이미지를 표시하지 못했습니다. Storage 읽기 권한 또는 파일 존재 여부를 확인해 주세요.",
                    );
                  }}
                  onLoad={(event) => {
                    setIsImageLoading(false);
                    const rect = event.currentTarget.getBoundingClientRect();
                    setDisplaySize({
                      width: Math.max(0, rect.width),
                      height: Math.max(0, rect.height),
                    });
                  }}
                  style={{ display: "block", width: "100%", height: "auto", userSelect: "none" }}
                />

                {displaySize.width > 0 && displaySize.height > 0 ? (
                  <div
                    style={{
                      position: "absolute",
                      inset: 0,
                    }}
                  >
                    {showAllQuestions
                      ? allQuestionOverlayParts.map((item) => {
                          const rect = pngToDisplayRect(item.part.rect, displaySize);
                          const isActiveQuestion = item.qNo === activeQNo;
                          return (
                            <div
                              key={`${item.qNo}-${item.part.id}`}
                              style={{
                                position: "absolute",
                                left: rect.x,
                                top: rect.y,
                                width: rect.width,
                                height: rect.height,
                                border: `2px solid ${isActiveQuestion ? "#e11d48" : "#0284c7"}`,
                                background: isActiveQuestion
                                  ? "rgba(225, 29, 72, 0.08)"
                                  : "rgba(2, 132, 199, 0.06)",
                                pointerEvents: "none",
                                boxSizing: "border-box",
                              }}
                            >
                              <span
                                style={{
                                  display: "inline-block",
                                  padding: "2px 6px",
                                  fontSize: 12,
                                  color: "#fff",
                                  background: isActiveQuestion ? "#e11d48" : "#0284c7",
                                }}
                              >
                                Q{item.qNo}
                              </span>
                            </div>
                          );
                        })
                      : partsOnCurrentPage.map((part) => {
                          const rect = pngToDisplayRect(part.rect, displaySize);
                          const selected = part.id === selectedPartId;
                          return (
                            <Rnd
                              key={part.id}
                              bounds="parent"
                              size={{ width: rect.width, height: rect.height }}
                              position={{ x: rect.x, y: rect.y }}
                              minWidth={MIN_BOX_DISPLAY_SIZE}
                              minHeight={MIN_BOX_DISPLAY_SIZE}
                              onDragStop={(_, data) => {
                                updatePartFromDisplayRect(part.id, {
                                  x: data.x,
                                  y: data.y,
                                  width: rect.width,
                                  height: rect.height,
                                });
                              }}
                              onResizeStop={(_, __, refElement, ___, position) => {
                                const width = Number.parseFloat(refElement.style.width);
                                const height = Number.parseFloat(refElement.style.height);
                                updatePartFromDisplayRect(part.id, {
                                  x: position.x,
                                  y: position.y,
                                  width,
                                  height,
                                });
                              }}
                              onMouseDown={() => setSelectedPartId(part.id)}
                              style={{
                                border: `2px solid ${selected ? "#e11d48" : "#0284c7"}`,
                                background: selected
                                  ? "rgba(225, 29, 72, 0.08)"
                                  : "rgba(2, 132, 199, 0.06)",
                                boxSizing: "border-box",
                              }}
                            >
                              <div
                                style={{
                                  fontSize: 12,
                                  color: "#fff",
                                  background: selected ? "#e11d48" : "#0284c7",
                                  padding: "2px 6px",
                                  display: "inline-block",
                                }}
                              >
                                {part.order}
                              </div>
                            </Rnd>
                          );
                        })}

                    {suggestedDrafts
                      .filter((draft) => draft.part.pageNo === pageNo)
                      .map((draft) => {
                        const rect = pngToDisplayRect(draft.part.rect, displaySize);
                        const isSelectedSuggestion = draft.part.id === selectedSuggestedPartId;
                        return (
                          <Rnd
                            key={draft.part.id}
                            bounds="parent"
                            size={{ width: rect.width, height: rect.height }}
                            position={{ x: rect.x, y: rect.y }}
                            minWidth={MIN_BOX_DISPLAY_SIZE}
                            minHeight={MIN_BOX_DISPLAY_SIZE}
                            disableDragging={showAllQuestions}
                            enableResizing={!showAllQuestions}
                            cancel=".suggestion-delete-button"
                            onDragStop={(_, data) => {
                              updateSuggestedDraftFromDisplayRect(draft.part.id, {
                                x: data.x,
                                y: data.y,
                                width: rect.width,
                                height: rect.height,
                              });
                            }}
                            onResizeStop={(_, __, refElement, ___, position) => {
                              const width = Number.parseFloat(refElement.style.width);
                              const height = Number.parseFloat(refElement.style.height);
                              updateSuggestedDraftFromDisplayRect(draft.part.id, {
                                x: position.x,
                                y: position.y,
                                width,
                                height,
                              });
                            }}
                            onMouseDown={(event) => {
                              event.stopPropagation();
                              setSelectedSuggestedPartId(draft.part.id);
                            }}
                            style={{
                              border: `2px dashed ${isSelectedSuggestion ? "#b45309" : "#f59e0b"}`,
                              background: isSelectedSuggestion
                                ? "rgba(180, 83, 9, 0.14)"
                                : "rgba(245, 158, 11, 0.08)",
                              cursor: "pointer",
                              boxSizing: "border-box",
                              zIndex: isSelectedSuggestion ? 8 : 7,
                            }}
                          >
                            <div style={{ position: "relative", width: "100%", height: "100%" }}>
                              <span
                                style={{
                                  display: "inline-block",
                                  padding: "2px 6px",
                                  fontSize: 12,
                                  color: "#fff",
                                  background: isSelectedSuggestion ? "#b45309" : "#f59e0b",
                                }}
                              >
                                Q{draft.qNo}
                              </span>
                              <button
                                type="button"
                                className="suggestion-delete-button"
                                onMouseDown={(event) => {
                                  event.stopPropagation();
                                }}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  deleteSuggestedDraftById(draft.part.id);
                                }}
                                disabled={showAllQuestions}
                                aria-label={`제안 영역 Q${draft.qNo} 삭제`}
                                style={{
                                  position: "absolute",
                                  top: 4,
                                  right: 4,
                                  width: 22,
                                  height: 22,
                                  border: 0,
                                  borderRadius: 999,
                                  background: "rgba(127, 29, 29, 0.9)",
                                  color: "#fff",
                                  fontSize: 14,
                                  fontWeight: 700,
                                  padding: 0,
                                  display: "inline-flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  lineHeight: 1,
                                  cursor: showAllQuestions ? "default" : "pointer",
                                }}
                              >
                                ×
                              </button>
                            </div>
                          </Rnd>
                        );
                      })}
                  </div>
                ) : null}
              </div>
            ) : null}
          </section>

          <aside
            className="aq-panel"
            style={{
              padding: 12,
              background: "#fafafa",
            }}
          >
            <p style={{ margin: "0 0 8px" }}>
              현재 페이지 전체 문제 수: <b>{isPageQuestionSummaryLoading ? "..." : currentPageQuestionCount}</b>
            </p>
            <p style={{ margin: "0 0 8px" }}>
              현재 문항 전체 영역 수: <b>{parts.length}</b>
            </p>
            <div style={{ display: "grid", gap: 8 }}>
              {parts.map((part, index) => {
                const selected = part.id === selectedPartId;
                return (
                  <article
                    key={part.id}
                    onClick={() => setSelectedPartId(part.id)}
                    style={{
                      border: "1px solid #ddd",
                      borderRadius: 8,
                      padding: 8,
                      cursor: "pointer",
                      background: selected ? "rgba(225, 29, 72, 0.08)" : "#fff",
                    }}
                  >
                    <p style={{ margin: 0, fontWeight: 600 }}>영역 #{index + 1}</p>
                    <p style={{ margin: "4px 0", fontSize: 13, color: "#555" }}>페이지 번호: {part.pageNo}</p>
                  </article>
                );
              })}
            </div>
          </aside>
        </div>

        <div style={{ marginTop: 18 }}>
          <button type="button" className="aq-btn-primary" onClick={() => void goToPageList()}>
            페이지 리스트로 돌아가기
          </button>
        </div>
      </main>
    </ClientErrorBoundary>
  );
}
