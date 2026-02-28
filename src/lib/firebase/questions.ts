import {
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  where,
} from "firebase/firestore";

import { getClientDb } from "./client";

export const PNG_PAGE_WIDTH = 2481;
export const PNG_PAGE_HEIGHT = 3508;
export const REVIEW_STATUSES = ["draft", "reviewed", "done"] as const;

export type PngRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export type QuestionPart = {
  id: string;
  order: number;
  pageNo: number;
  rect: PngRect;
};

export type QuestionSnapshot = {
  pageNo: number;
  parts: QuestionPart[];
  reviewStatus: ReviewStatus;
  savedAt: number;
};

export type QuestionRecord = {
  examId: string;
  qNo: number;
  pageNo: number;
  parts: QuestionPart[];
  reviewStatus: ReviewStatus;
  previousSnapshot: QuestionSnapshot | null;
};

export type QuestionPageStats = {
  questionCount: number;
  draftCount: number;
  reviewedCount: number;
  doneCount: number;
};

export type PageQuestionSummary = {
  qNo: number;
  reviewStatus: ReviewStatus;
  parts: QuestionPart[];
};

export type QuestionCandidate = {
  qNo: number;
  pageNo: number;
  reviewStatus: ReviewStatus;
  part: QuestionPart;
};

function toInt(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return Math.round(numeric);
}

function toPositiveInt(value: unknown): number | null {
  const parsed = toInt(value);
  return parsed && parsed > 0 ? parsed : null;
}

function toNonNegativeInt(value: unknown): number | null {
  const parsed = toInt(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

function normalizeReviewStatus(value: unknown): ReviewStatus {
  if (value === "reviewed" || value === "done") {
    return value;
  }
  return "draft";
}

function reviewStatusRank(status: ReviewStatus): number {
  if (status === "done") {
    return 3;
  }
  if (status === "reviewed") {
    return 2;
  }
  return 1;
}

function normalizeRect(value: unknown): PngRect | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const x = toNonNegativeInt(raw.x);
  const y = toNonNegativeInt(raw.y);
  const width = toPositiveInt(raw.width);
  const height = toPositiveInt(raw.height);

  if (x === null || y === null || width === null || height === null) {
    return null;
  }

  const clampedX = Math.min(x, PNG_PAGE_WIDTH - 1);
  const clampedY = Math.min(y, PNG_PAGE_HEIGHT - 1);
  const clampedWidth = Math.min(width, PNG_PAGE_WIDTH - clampedX);
  const clampedHeight = Math.min(height, PNG_PAGE_HEIGHT - clampedY);

  if (clampedWidth < 1 || clampedHeight < 1) {
    return null;
  }

  return {
    x: clampedX,
    y: clampedY,
    width: clampedWidth,
    height: clampedHeight,
  };
}

function normalizePart(
  value: unknown,
  index: number,
  fallbackPageNo: number,
): QuestionPart | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const id =
    typeof raw.id === "string" && raw.id.trim().length > 0
      ? raw.id.trim()
      : `part-${index + 1}`;
  const order = toPositiveInt(raw.order) ?? index + 1;
  const pageNo = toPositiveInt(raw.pageNo) ?? fallbackPageNo;
  const rect = normalizeRect(raw.rect);

  if (!rect) {
    return null;
  }

  return { id, order, pageNo, rect };
}

function normalizeParts(value: unknown, fallbackPageNo: number): QuestionPart[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((part, index) => normalizePart(part, index, fallbackPageNo))
    .filter((part): part is QuestionPart => part !== null)
    .sort((a, b) => a.order - b.order);
}

function normalizeSnapshot(value: unknown, fallbackPageNo: number): QuestionSnapshot | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const pageNo = toPositiveInt(raw.pageNo) ?? fallbackPageNo;
  const parts = normalizeParts(raw.parts, pageNo);
  const reviewStatus = normalizeReviewStatus(raw.reviewStatus);
  const savedAt = toPositiveInt(raw.savedAt) ?? Date.now();
  return {
    pageNo,
    parts,
    reviewStatus,
    savedAt,
  };
}

function toTimestampMillis(value: unknown): number {
  if (!value || typeof value !== "object") {
    return 0;
  }
  const raw = value as { toMillis?: () => number; toDate?: () => Date };
  if (typeof raw.toMillis === "function") {
    const ms = raw.toMillis();
    if (Number.isFinite(ms)) {
      return ms;
    }
  }
  if (typeof raw.toDate === "function") {
    const date = raw.toDate();
    if (date instanceof Date && Number.isFinite(date.getTime())) {
      return date.getTime();
    }
  }
  return 0;
}

function toStoredParts(parts: QuestionPart[]) {
  return parts.map((part, index) => ({
    id: part.id,
    order: index + 1,
    pageNo: part.pageNo,
    rect: {
      x: part.rect.x,
      y: part.rect.y,
      width: part.rect.width,
      height: part.rect.height,
    },
  }));
}

function toStoredSnapshot(snapshot: QuestionSnapshot) {
  return {
    pageNo: snapshot.pageNo,
    parts: toStoredParts(snapshot.parts),
    reviewStatus: snapshot.reviewStatus,
    savedAt: snapshot.savedAt,
  };
}

function hasMeaningfulParts(parts: QuestionPart[]): boolean {
  return parts.some((part) => part.rect.width > 0 && part.rect.height > 0);
}

function shiftPageNoIfNeeded(pageNo: number, deletedPageNo: number): number {
  if (pageNo > deletedPageNo) {
    return pageNo - 1;
  }
  return pageNo;
}

function shiftPartsPageNos(parts: QuestionPart[], deletedPageNo: number): QuestionPart[] {
  return parts.map((part) => ({
    ...part,
    pageNo: shiftPageNoIfNeeded(part.pageNo, deletedPageNo),
  }));
}

function shiftSnapshotPageNos(
  snapshot: QuestionSnapshot | null,
  deletedPageNo: number,
): QuestionSnapshot | null {
  if (!snapshot) {
    return null;
  }
  return {
    ...snapshot,
    pageNo: shiftPageNoIfNeeded(snapshot.pageNo, deletedPageNo),
    parts: shiftPartsPageNos(snapshot.parts, deletedPageNo),
  };
}

function questionDocId(examId: string, pageNo: number, qNo: number): string {
  return `${examId}_${pageNo}_${qNo}`;
}

function legacyQuestionDocId(examId: string, qNo: number): string {
  return `${examId}_${qNo}`;
}

type QuestionDocMatch = {
  ref: ReturnType<typeof doc>;
  data: Record<string, unknown>;
};

async function findQuestionDocByPageAndQNo(
  examId: string,
  pageNo: number,
  qNo: number,
): Promise<QuestionDocMatch | null> {
  const db = getClientDb();

  const preferredRef = doc(db, "questions", questionDocId(examId, pageNo, qNo));
  const preferredSnap = await getDoc(preferredRef);
  if (preferredSnap.exists()) {
    return {
      ref: preferredRef,
      data: preferredSnap.data() as Record<string, unknown>,
    };
  }

  const legacyRef = doc(db, "questions", legacyQuestionDocId(examId, qNo));
  const legacySnap = await getDoc(legacyRef);
  if (legacySnap.exists()) {
    const legacyData = legacySnap.data() as Record<string, unknown>;
    const legacyPageNo = toPositiveInt(legacyData.pageNo) ?? pageNo;
    if (legacyPageNo === pageNo) {
      return {
        ref: legacyRef,
        data: legacyData,
      };
    }
  }

  const questionsRef = collection(db, "questions");
  const q = query(questionsRef, where("examId", "==", examId));
  const snap = await getDocs(q);
  for (const docSnap of snap.docs) {
    const data = docSnap.data() as Record<string, unknown>;
    const recordPageNo = toPositiveInt(data.pageNo);
    const recordQNo = toPositiveInt(data.qNo);
    if (recordPageNo === pageNo && recordQNo === qNo) {
      return {
        ref: docSnap.ref as ReturnType<typeof doc>,
        data,
      };
    }
  }

  return null;
}

export async function fetchQuestionRecord(
  examId: string,
  qNo: number,
  fallbackPageNo: number,
): Promise<QuestionRecord | null> {
  const matched = await findQuestionDocByPageAndQNo(examId, fallbackPageNo, qNo);
  if (!matched) {
    return null;
  }

  const data = matched.data;
  const pageNo = toPositiveInt(data.pageNo) ?? fallbackPageNo;
  const parts = normalizeParts(data.parts, pageNo);
  const reviewStatus = normalizeReviewStatus(data.reviewStatus);
  const previousSnapshot = normalizeSnapshot(data.previousSnapshot, pageNo);

  return {
    examId,
    qNo,
    pageNo,
    parts,
    reviewStatus,
    previousSnapshot,
  };
}

export async function saveQuestionRecord(
  record: Pick<QuestionRecord, "examId" | "qNo" | "pageNo" | "parts" | "reviewStatus">,
): Promise<{ hasPreviousSnapshot: boolean }> {
  const db = getClientDb();
  const ref = doc(db, "questions", questionDocId(record.examId, record.pageNo, record.qNo));
  const normalizedParts = toStoredParts(record.parts);
  const current = await findQuestionDocByPageAndQNo(record.examId, record.pageNo, record.qNo);

  let previousSnapshot: QuestionSnapshot | null = null;
  if (current) {
    const currentData = current.data;
    const currentPageNo = toPositiveInt(currentData.pageNo) ?? record.pageNo;
    const currentParts = normalizeParts(currentData.parts, currentPageNo);
    const currentReviewStatus = normalizeReviewStatus(currentData.reviewStatus);
    previousSnapshot = {
      pageNo: currentPageNo,
      parts: currentParts,
      reviewStatus: currentReviewStatus,
      savedAt: Date.now(),
    };
  }

  await setDoc(
    ref,
    {
      examId: record.examId,
      qNo: record.qNo,
      pageNo: record.pageNo,
      parts: normalizedParts,
      reviewStatus: record.reviewStatus,
      previousSnapshot: previousSnapshot ? toStoredSnapshot(previousSnapshot) : deleteField(),
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );

  if (current && current.ref.id !== ref.id) {
    await deleteDoc(current.ref);
  }

  return { hasPreviousSnapshot: previousSnapshot !== null };
}

export async function fetchNextQuestionNumber(examId: string, pageNo?: number): Promise<number> {
  const db = getClientDb();
  const questionsRef = collection(db, "questions");
  const q = query(questionsRef, where("examId", "==", examId));
  const snap = await getDocs(q);

  let maxQNo = 0;
  for (const docSnap of snap.docs) {
    const data = docSnap.data() as Record<string, unknown>;
    const recordPageNo = toPositiveInt(data.pageNo);
    const recordQNo = toPositiveInt(data.qNo);
    if (pageNo && recordPageNo !== pageNo) {
      continue;
    }
    if (recordQNo && recordQNo > maxQNo) {
      maxQNo = recordQNo;
    }
  }

  return maxQNo + 1;
}

export async function restoreQuestionPreviousSnapshot(
  examId: string,
  qNo: number,
  fallbackPageNo: number,
): Promise<QuestionRecord | null> {
  const db = getClientDb();
  const current = await findQuestionDocByPageAndQNo(examId, fallbackPageNo, qNo);
  if (!current) {
    return null;
  }

  const ref = doc(db, "questions", questionDocId(examId, fallbackPageNo, qNo));
  const data = current.data;
  const currentPageNo = toPositiveInt(data.pageNo) ?? fallbackPageNo;
  const currentParts = normalizeParts(data.parts, currentPageNo);
  const currentReviewStatus = normalizeReviewStatus(data.reviewStatus);
  const previousSnapshot = normalizeSnapshot(data.previousSnapshot, currentPageNo);

  if (!previousSnapshot) {
    return null;
  }

  const restoredParts = previousSnapshot.parts.map((part, index) => ({
    ...part,
    order: index + 1,
  }));
  const swappedPreviousSnapshot: QuestionSnapshot = {
    pageNo: currentPageNo,
    parts: currentParts,
    reviewStatus: currentReviewStatus,
    savedAt: Date.now(),
  };

  await setDoc(
    ref,
    {
      examId,
      qNo,
      pageNo: previousSnapshot.pageNo,
      parts: toStoredParts(restoredParts),
      reviewStatus: previousSnapshot.reviewStatus,
      previousSnapshot: toStoredSnapshot(swappedPreviousSnapshot),
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );

  if (current.ref.id !== ref.id) {
    await deleteDoc(current.ref);
  }

  return {
    examId,
    qNo,
    pageNo: previousSnapshot.pageNo,
    parts: restoredParts,
    reviewStatus: previousSnapshot.reviewStatus,
    previousSnapshot: swappedPreviousSnapshot,
  };
}

export async function deleteQuestionAndShift(
  examId: string,
  pageNo: number,
  qNo: number,
): Promise<{ deleted: boolean; shiftedCount: number; nextQNo: number }> {
  const db = getClientDb();
  const questionsRef = collection(db, "questions");
  const q = query(questionsRef, where("examId", "==", examId));
  const snap = await getDocs(q);

  type QuestionDocRow = {
    qNo: number;
    ref: (typeof snap.docs)[number]["ref"];
    data: Record<string, unknown>;
  };

  const docs = snap.docs
    .map((docSnap) => {
      const data = docSnap.data() as Record<string, unknown>;
      const recordPageNo = toPositiveInt(data.pageNo);
      const recordQNo = toPositiveInt(data.qNo);
      if (!recordPageNo || !recordQNo || recordPageNo !== pageNo) {
        return null;
      }
      return {
        qNo: recordQNo,
        ref: docSnap.ref,
        data,
      };
    })
    .filter((item): item is QuestionDocRow => item !== null)
    .sort((a, b) => a.qNo - b.qNo);

  const target = docs.find((item) => item.qNo === qNo);
  if (!target) {
    return {
      deleted: false,
      shiftedCount: 0,
      nextQNo: Math.max(1, qNo),
    };
  }

  await deleteDoc(target.ref);

  const after = docs.filter((item) => item.qNo > qNo).sort((a, b) => a.qNo - b.qNo);
  for (const item of after) {
    const newQNo = item.qNo - 1;
    const targetRef = doc(db, "questions", questionDocId(examId, pageNo, newQNo));
    await setDoc(
      targetRef,
      {
        ...item.data,
        examId,
        pageNo,
        qNo: newQNo,
        updatedAt: serverTimestamp(),
      },
    );

    if (item.ref.id !== targetRef.id) {
      await deleteDoc(item.ref);
    }
  }

  return {
    deleted: true,
    shiftedCount: after.length,
    nextQNo: after.length > 0 ? qNo : Math.max(1, qNo - 1),
  };
}

export async function fetchExamQuestionStatsByPage(
  examId: string,
): Promise<Map<number, QuestionPageStats>> {
  const db = getClientDb();
  const questionsRef = collection(db, "questions");
  const q = query(questionsRef, where("examId", "==", examId));
  const snap = await getDocs(q);

  type DedupRow = {
    pageNo: number;
    qNo: number;
    reviewStatus: ReviewStatus;
    updatedAtMs: number;
  };

  const latestByPageAndQNo = new Map<string, DedupRow>();
  for (const docSnap of snap.docs) {
    const data = docSnap.data() as Record<string, unknown>;
    const pageNo = toPositiveInt(data.pageNo);
    const qNo = toPositiveInt(data.qNo);
    if (!pageNo || !qNo) {
      continue;
    }
    const parts = normalizeParts(data.parts, pageNo);
    if (!hasMeaningfulParts(parts)) {
      continue;
    }
    const row: DedupRow = {
      pageNo,
      qNo,
      reviewStatus: normalizeReviewStatus(data.reviewStatus),
      updatedAtMs: toTimestampMillis(data.updatedAt),
    };
    const key = `${pageNo}_${qNo}`;
    const prev = latestByPageAndQNo.get(key);
    if (
      !prev ||
      row.updatedAtMs > prev.updatedAtMs ||
      (row.updatedAtMs === prev.updatedAtMs &&
        reviewStatusRank(row.reviewStatus) >= reviewStatusRank(prev.reviewStatus))
    ) {
      latestByPageAndQNo.set(key, row);
    }
  }

  const statsByPageNo = new Map<number, QuestionPageStats>();
  for (const row of latestByPageAndQNo.values()) {
    const { pageNo, reviewStatus } = row;
    const prev = statsByPageNo.get(pageNo) ?? {
      questionCount: 0,
      draftCount: 0,
      reviewedCount: 0,
      doneCount: 0,
    };
    prev.questionCount += 1;
    if (reviewStatus === "done") {
      prev.doneCount += 1;
    } else if (reviewStatus === "reviewed") {
      prev.reviewedCount += 1;
    } else {
      prev.draftCount += 1;
    }
    statsByPageNo.set(pageNo, prev);
  }

  return statsByPageNo;
}

export async function fetchPageQuestionSummaries(
  examId: string,
  pageNo: number,
): Promise<PageQuestionSummary[]> {
  const db = getClientDb();
  const questionsRef = collection(db, "questions");
  const q = query(questionsRef, where("examId", "==", examId));
  const snap = await getDocs(q);

  type DedupRow = PageQuestionSummary & { updatedAtMs: number };
  const latestByQNo = new Map<number, DedupRow>();
  for (const docSnap of snap.docs) {
    const data = docSnap.data() as Record<string, unknown>;
    const recordPageNo = toPositiveInt(data.pageNo);
    const qNo = toPositiveInt(data.qNo);
    if (!recordPageNo || !qNo || recordPageNo !== pageNo) {
      continue;
    }
    const parts = normalizeParts(data.parts, recordPageNo);
    if (!hasMeaningfulParts(parts)) {
      continue;
    }
    const row: DedupRow = {
      qNo,
      reviewStatus: normalizeReviewStatus(data.reviewStatus),
      parts,
      updatedAtMs: toTimestampMillis(data.updatedAt),
    };
    const prev = latestByQNo.get(qNo);
    if (
      !prev ||
      row.updatedAtMs > prev.updatedAtMs ||
      (row.updatedAtMs === prev.updatedAtMs &&
        reviewStatusRank(row.reviewStatus) >= reviewStatusRank(prev.reviewStatus))
    ) {
      latestByQNo.set(qNo, row);
    }
  }

  return [...latestByQNo.values()]
    .map(({ updatedAtMs: _updatedAtMs, ...row }) => row)
    .sort((a, b) => a.qNo - b.qNo);
}

export async function fetchExamQuestionCandidates(
  examId: string,
  options?: {
    includeStatuses?: ReviewStatus[];
  },
): Promise<QuestionCandidate[]> {
  const db = getClientDb();
  const questionsRef = collection(db, "questions");
  const q = query(questionsRef, where("examId", "==", examId));
  const snap = await getDocs(q);

  const includeStatuses = new Set<ReviewStatus>(
    options?.includeStatuses && options.includeStatuses.length > 0
      ? options.includeStatuses
      : REVIEW_STATUSES,
  );

  type DedupRow = QuestionCandidate & { updatedAtMs: number };
  const latestByKey = new Map<string, DedupRow>();

  for (const docSnap of snap.docs) {
    const data = docSnap.data() as Record<string, unknown>;
    const recordPageNo = toPositiveInt(data.pageNo);
    const qNo = toPositiveInt(data.qNo);
    if (!recordPageNo || !qNo) {
      continue;
    }

    const reviewStatus = normalizeReviewStatus(data.reviewStatus);
    if (!includeStatuses.has(reviewStatus)) {
      continue;
    }

    const parts = normalizeParts(data.parts, recordPageNo);
    if (!hasMeaningfulParts(parts)) {
      continue;
    }
    const part = parts.find((item) => item.pageNo === recordPageNo) ?? parts[0];
    if (!part) {
      continue;
    }

    const row: DedupRow = {
      qNo,
      pageNo: recordPageNo,
      reviewStatus,
      part,
      updatedAtMs: toTimestampMillis(data.updatedAt),
    };

    const key = `${recordPageNo}_${qNo}`;
    const prev = latestByKey.get(key);
    if (
      !prev ||
      row.updatedAtMs > prev.updatedAtMs ||
      (row.updatedAtMs === prev.updatedAtMs &&
        reviewStatusRank(row.reviewStatus) >= reviewStatusRank(prev.reviewStatus))
    ) {
      latestByKey.set(key, row);
    }
  }

  return [...latestByKey.values()]
    .map(({ updatedAtMs: _updatedAtMs, ...row }) => row)
    .sort((a, b) => (a.pageNo === b.pageNo ? a.qNo - b.qNo : a.pageNo - b.pageNo));
}

export async function deleteQuestionsByPageAndShift(
  examId: string,
  deletedPageNo: number,
): Promise<{ deletedCount: number; shiftedCount: number }> {
  const db = getClientDb();
  const questionsRef = collection(db, "questions");
  const q = query(questionsRef, where("examId", "==", examId));
  const snap = await getDocs(q);

  let deletedCount = 0;
  let shiftedCount = 0;

  for (const docSnap of snap.docs) {
    const data = docSnap.data() as Record<string, unknown>;
    const recordPageNo = toPositiveInt(data.pageNo);
    if (!recordPageNo) {
      continue;
    }

    if (recordPageNo === deletedPageNo) {
      await deleteDoc(docSnap.ref);
      deletedCount += 1;
      continue;
    }

    if (recordPageNo < deletedPageNo) {
      continue;
    }

    const parts = normalizeParts(data.parts, recordPageNo);
    const shiftedParts = shiftPartsPageNos(parts, deletedPageNo).map((part, index) => ({
      ...part,
      order: index + 1,
    }));
    const previousSnapshot = normalizeSnapshot(data.previousSnapshot, recordPageNo);
    const shiftedSnapshot = shiftSnapshotPageNos(previousSnapshot, deletedPageNo);

    await setDoc(
      docSnap.ref,
      {
        ...data,
        examId,
        pageNo: recordPageNo - 1,
        parts: toStoredParts(shiftedParts),
        reviewStatus: normalizeReviewStatus(data.reviewStatus),
        previousSnapshot: shiftedSnapshot ? toStoredSnapshot(shiftedSnapshot) : deleteField(),
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );
    shiftedCount += 1;
  }

  return {
    deletedCount,
    shiftedCount,
  };
}
