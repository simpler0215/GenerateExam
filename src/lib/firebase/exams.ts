import { deleteField, doc, serverTimestamp, setDoc } from "firebase/firestore";
import { getMetadata, ref, uploadBytesResumable } from "firebase/storage";

import { getClientDb, getClientStorage } from "./client";

const renderSpec = {
  dpi: 300,
  width: 2481,
  height: 3508,
} as const;
const MAX_PDF_BYTES = 300 * 1024 * 1024;

type CreateExamWithPdfInput = {
  subject: string;
  examId: string;
  pdfFile: File;
  onUploadProgress?: (progressPercent: number) => void;
};

type CreateExamFromExistingPdfInput = {
  subject: string;
  examId: string;
  problemPdfPath?: string;
};

function sanitizeSubjectForPath(subject: string): string {
  return subject
    .trim()
    .replace(/[\\/#?[\]]+/g, "-")
    .replace(/\s+/g, "_");
}

function validatePdfFile(pdfFile: File): void {
  const isPdfMime = pdfFile.type === "application/pdf";
  const hasPdfExt = pdfFile.name.toLowerCase().endsWith(".pdf");

  if (!isPdfMime && !hasPdfExt) {
    throw new Error("PDF 파일만 업로드할 수 있습니다.");
  }
  if (pdfFile.size > MAX_PDF_BYTES) {
    throw new Error("PDF 파일 용량이 너무 큽니다. 최대 300MB까지 가능합니다.");
  }
}

function buildProblemPdfPath(subject: string, examId: string): string {
  const subjectPathSegment = sanitizeSubjectForPath(subject);
  return `GeneratePDF/${subjectPathSegment}/${examId}.pdf`;
}

async function upsertExamDoc({
  subject,
  examId,
  problemPdfPath,
}: {
  subject: string;
  examId: string;
  problemPdfPath: string;
}): Promise<void> {
  const db = getClientDb();

  await setDoc(
    doc(db, "exams", examId),
    {
      subject,
      examId,
      problemPdfPath,
      createdAt: serverTimestamp(),
      renderSpec,
      renderStatus: "queued",
      nextPageStart: 1,
      pageCount: deleteField(),
      renderedPageCount: deleteField(),
      lastRenderError: deleteField(),
      renderFailedAt: deleteField(),
      renderedAt: deleteField(),
    },
    { merge: true },
  );
}

export async function createExamWithPdf({
  subject,
  examId,
  pdfFile,
  onUploadProgress,
}: CreateExamWithPdfInput): Promise<{ examId: string; problemPdfPath: string }> {
  const trimmedSubject = subject.trim();
  const trimmedExamId = examId.trim();

  if (!trimmedSubject) {
    throw new Error("과목을 입력해 주세요.");
  }
  if (!trimmedExamId) {
    throw new Error("시험 ID를 입력해 주세요.");
  }
  validatePdfFile(pdfFile);

  const problemPdfPath = buildProblemPdfPath(trimmedSubject, trimmedExamId);
  const storage = getClientStorage();
  const storageRef = ref(storage, problemPdfPath);

  const uploadTask = uploadBytesResumable(storageRef, pdfFile, {
    contentType: "application/pdf",
  });

  await new Promise<void>((resolve, reject) => {
    uploadTask.on(
      "state_changed",
      (snapshot) => {
        if (!onUploadProgress) {
          return;
        }
        const progressPercent =
          (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
        onUploadProgress(progressPercent);
      },
      (error) => reject(error),
      () => resolve(),
    );
  });

  await upsertExamDoc({
    subject: trimmedSubject,
    examId: trimmedExamId,
    problemPdfPath,
  });

  return {
    examId: trimmedExamId,
    problemPdfPath,
  };
}

export async function createExamFromExistingPdf({
  subject,
  examId,
  problemPdfPath,
}: CreateExamFromExistingPdfInput): Promise<{ examId: string; problemPdfPath: string }> {
  const trimmedSubject = subject.trim();
  const trimmedExamId = examId.trim();

  if (!trimmedSubject) {
    throw new Error("과목을 입력해 주세요.");
  }
  if (!trimmedExamId) {
    throw new Error("시험 ID를 입력해 주세요.");
  }

  const resolvedProblemPdfPath =
    problemPdfPath?.trim() || buildProblemPdfPath(trimmedSubject, trimmedExamId);
  const storage = getClientStorage();
  const storageRef = ref(storage, resolvedProblemPdfPath);

  try {
    await getMetadata(storageRef);
  } catch {
    throw new Error(
      `'${resolvedProblemPdfPath}' 경로에서 PDF를 찾을 수 없습니다. 먼저 업로드했는지, 과목/시험 ID가 맞는지 확인해 주세요.`,
    );
  }

  await upsertExamDoc({
    subject: trimmedSubject,
    examId: trimmedExamId,
    problemPdfPath: resolvedProblemPdfPath,
  });

  return {
    examId: trimmedExamId,
    problemPdfPath: resolvedProblemPdfPath,
  };
}
