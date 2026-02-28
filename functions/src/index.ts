import { initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { PubSub } from "@google-cloud/pubsub";
import { logger } from "firebase-functions";
import { setGlobalOptions } from "firebase-functions/v2";
import { onRequest } from "firebase-functions/v2/https";
import { onMessagePublished } from "firebase-functions/v2/pubsub";
import { onObjectFinalized } from "firebase-functions/v2/storage";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.js";

initializeApp();

setGlobalOptions({
  region: "us-central1",
  memory: "2GiB",
  cpu: 2,
  timeoutSeconds: 540,
  maxInstances: 10,
});

const A4_WIDTH_PX = 2481;
const A4_HEIGHT_PX = 3508;
const THUMB_WIDTH_PX = 496;
const THUMB_HEIGHT_PX = 701;
const PAGES_PER_RENDER_BATCH = 20;
const RENDER_BATCH_TOPIC = "exam-render-batches";
const SOURCE_PDF_PATH = /^(?:GeneratePDF|pdf)\/([^/]+)\/([^/]+)\.pdf$/i;
const pubsub = new PubSub();

type CreateCanvasFn = (width: number, height: number) => any;
let createCanvasFn: CreateCanvasFn | null = null;

type PdfDocumentProxyLike = {
  numPages: number;
  getPage: (pageNumber: number) => Promise<any>;
  cleanup: () => void;
  destroy: () => void;
};

type RenderRequest = {
  bucketName: string;
  objectPath: string;
  startPage?: number;
  forcedExamId?: string;
  forcedSubject?: string;
};

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "Unknown render error";
}

function getErrorStack(error: unknown): string | null {
  if (error instanceof Error && error.stack) {
    return error.stack;
  }
  return null;
}

function parsePdfSourcePath(objectPath: string) {
  const match = objectPath.match(SOURCE_PDF_PATH);
  if (!match) {
    return null;
  }
  return {
    subject: match[1],
    examId: match[2],
  };
}

function toPositiveInt(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  const integer = Math.floor(numeric);
  return integer > 0 ? integer : null;
}

async function enqueueRenderBatch(examId: string, startPage: number): Promise<void> {
  await pubsub.topic(RENDER_BATCH_TOPIC).publishMessage({
    json: {
      examId,
      startPage,
    },
  });
}

async function ensureCreateCanvas(): Promise<CreateCanvasFn> {
  if (!createCanvasFn) {
    const canvasModule = await import("canvas");
    createCanvasFn = canvasModule.createCanvas as CreateCanvasFn;
  }
  return createCanvasFn;
}

function getCreateCanvas(): CreateCanvasFn {
  if (!createCanvasFn) {
    throw new Error("Canvas module is not initialized.");
  }
  return createCanvasFn;
}

class PdfCanvasFactory {
  create(width: number, height: number) {
    const createCanvas = getCreateCanvas();
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d", { alpha: false });
    return { canvas, context };
  }

  reset(canvasAndContext: { canvas: any; context: any }, width: number, height: number) {
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }

  destroy(canvasAndContext: { canvas: any }) {
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
  }
}

async function clearDerivedOutputs(bucketName: string, examId: string) {
  const bucket = getStorage().bucket(bucketName);
  const [files] = await bucket.getFiles({ prefix: `derived/${examId}/` });

  if (files.length === 0) {
    return;
  }

  await Promise.all(files.map((file) => file.delete({ ignoreNotFound: true })));
}

async function renderPageToBuffers(pdfDoc: PdfDocumentProxyLike, pageNo: number) {
  const createCanvas = getCreateCanvas();
  const page = await pdfDoc.getPage(pageNo);
  const baseViewport = page.getViewport({ scale: 1 });
  const renderScale = Math.max(
    A4_WIDTH_PX / baseViewport.width,
    A4_HEIGHT_PX / baseViewport.height,
  );
  const renderViewport = page.getViewport({ scale: renderScale });
  const renderWidth = Math.max(1, Math.floor(renderViewport.width));
  const renderHeight = Math.max(1, Math.floor(renderViewport.height));
  const renderCanvas = createCanvas(renderWidth, renderHeight);
  const renderContext = renderCanvas.getContext("2d", { alpha: false });

  if (!renderContext) {
    throw new Error("Failed to create page rendering context.");
  }

  await page
    .render({
      canvasContext: renderContext,
      viewport: renderViewport,
      canvasFactory: new PdfCanvasFactory(),
      intent: "print",
      background: "#ffffff",
    })
    .promise;

  const pageCanvas = createCanvas(A4_WIDTH_PX, A4_HEIGHT_PX);
  const pageContext = pageCanvas.getContext("2d", { alpha: false });

  if (!pageContext) {
    throw new Error("Failed to create page output context.");
  }

  pageContext.fillStyle = "#ffffff";
  pageContext.fillRect(0, 0, A4_WIDTH_PX, A4_HEIGHT_PX);
  pageContext.drawImage(renderCanvas, 0, 0, A4_WIDTH_PX, A4_HEIGHT_PX);

  const png = pageCanvas.toBuffer("image/png");

  const thumbCanvas = createCanvas(THUMB_WIDTH_PX, THUMB_HEIGHT_PX);
  const thumbContext = thumbCanvas.getContext("2d", { alpha: false });

  if (!thumbContext) {
    throw new Error("Failed to create thumbnail context.");
  }

  thumbContext.drawImage(pageCanvas, 0, 0, THUMB_WIDTH_PX, THUMB_HEIGHT_PX);
  const jpg = thumbCanvas.toBuffer("image/jpeg", {
    quality: 0.82,
    progressive: true,
  });

  page.cleanup();
  renderCanvas.width = 0;
  renderCanvas.height = 0;
  pageCanvas.width = 0;
  pageCanvas.height = 0;
  thumbCanvas.width = 0;
  thumbCanvas.height = 0;

  return { png, jpg };
}

async function renderPdfFromStorage({
  bucketName,
  objectPath,
  startPage,
  forcedExamId,
  forcedSubject,
}: RenderRequest): Promise<{
  examId: string;
  subject: string;
  pageCount: number;
  nextPageStart: number | null;
}> {
  const parsedPath = parsePdfSourcePath(objectPath);
  const examId = forcedExamId ?? parsedPath?.examId ?? "";
  const subject = forcedSubject ?? parsedPath?.subject ?? "";

  if (!examId) {
    throw new Error(`Could not resolve examId from path: ${objectPath}`);
  }
  if (!subject) {
    throw new Error(`Could not resolve subject from path: ${objectPath}`);
  }

  const sourceBucket = getStorage().bucket(bucketName);
  const sourceFile = sourceBucket.file(objectPath);
  const tempPdfPath = path.join(os.tmpdir(), `${examId}-${Date.now()}.pdf`);
  const batchStartPage = Math.max(1, Math.floor(startPage ?? 1));
  await ensureCreateCanvas();

  await getFirestore()
    .collection("exams")
    .doc(examId)
    .set(
      {
        subject,
        examId,
        problemPdfPath: objectPath,
        renderStatus: "running",
        lastRenderError: FieldValue.delete(),
        renderFailedAt: FieldValue.delete(),
      },
      { merge: true },
    );

  logger.info("Starting PDF render.", { objectPath, subject, examId });

  let loadingTask: any;
  let pdfDoc: PdfDocumentProxyLike | null = null;

  try {
    await sourceFile.download({ destination: tempPdfPath });
    if (batchStartPage === 1) {
      await clearDerivedOutputs(bucketName, examId);
    }

    const pdfBytes = new Uint8Array(await fs.readFile(tempPdfPath));

    loadingTask = pdfjsLib.getDocument({
      data: pdfBytes,
      disableWorker: true,
      // Keep Node rendering path deterministic in Cloud Functions.
      isOffscreenCanvasSupported: false,
      useSystemFonts: true,
      isEvalSupported: false,
      stopAtErrors: true,
      verbosity: pdfjsLib.VerbosityLevel.ERRORS,
    } as any);

    pdfDoc = (await loadingTask.promise) as PdfDocumentProxyLike;
    const pageCount = pdfDoc.numPages;
    const batchEndPage = Math.min(pageCount, batchStartPage + PAGES_PER_RENDER_BATCH - 1);

    for (let pageNo = batchStartPage; pageNo <= batchEndPage; pageNo += 1) {
      const { png, jpg } = await renderPageToBuffers(pdfDoc, pageNo);
      const pageOutputPath = `derived/${examId}/pages/${pageNo}.png`;
      const thumbOutputPath = `derived/${examId}/thumbs/${pageNo}.jpg`;

      await Promise.all([
        sourceBucket.file(pageOutputPath).save(png, {
          resumable: false,
          contentType: "image/png",
          metadata: {
            metadata: {
              examId,
              pageNo: String(pageNo),
              sourcePdf: objectPath,
            },
          },
        }),
        sourceBucket.file(thumbOutputPath).save(jpg, {
          resumable: false,
          contentType: "image/jpeg",
          metadata: {
            metadata: {
              examId,
              pageNo: String(pageNo),
              sourcePdf: objectPath,
            },
          },
        }),
      ]);
    }

    const nextPageStart = batchEndPage < pageCount ? batchEndPage + 1 : null;
    const isCompleted = nextPageStart === null;

    await getFirestore()
      .collection("exams")
      .doc(examId)
      .set(
        {
          subject,
          examId,
          problemPdfPath: objectPath,
          pageCount,
          renderedPageCount: batchEndPage,
          nextPageStart: nextPageStart ?? FieldValue.delete(),
          renderedAt: isCompleted ? FieldValue.serverTimestamp() : FieldValue.delete(),
          renderStatus: isCompleted ? "ready" : "running",
          lastRenderError: FieldValue.delete(),
        },
        { merge: true },
      );

    logger.info("Processed PDF render batch.", {
      examId,
      pageCount,
      batchStartPage,
      batchEndPage,
      nextPageStart,
    });

    return { examId, subject, pageCount, nextPageStart };
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    const errorStack = getErrorStack(error);

    await getFirestore()
      .collection("exams")
      .doc(examId)
      .set(
        {
          renderStatus: "failed",
          nextPageStart: batchStartPage,
          lastRenderError: errorMessage,
          renderFailedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

    logger.error("PDF render failed.", {
      objectPath,
      examId,
      errorMessage,
      errorStack,
    });
    throw error;
  } finally {
    try {
      if (pdfDoc) {
        pdfDoc.cleanup();
        pdfDoc.destroy();
      }
      if (loadingTask?.destroy) {
        await loadingTask.destroy();
      }
    } finally {
      await fs.rm(tempPdfPath, { force: true });
    }
  }
}

export const renderPdfPages = onObjectFinalized(async (event) => {
  const objectPath = event.data.name;
  const parsedPath = objectPath ? parsePdfSourcePath(objectPath) : null;

  if (!objectPath || !parsedPath) {
    return;
  }

  const { examId } = parsedPath;

  await getFirestore()
    .collection("exams")
    .doc(examId)
    .set(
      {
        examId,
        problemPdfPath: objectPath,
        renderStatus: "queued",
        nextPageStart: 1,
        pageCount: FieldValue.delete(),
        renderedPageCount: FieldValue.delete(),
        renderedAt: FieldValue.delete(),
        lastRenderError: FieldValue.delete(),
        renderFailedAt: FieldValue.delete(),
      },
      { merge: true },
    );

  await enqueueRenderBatch(examId, 1);
});

export const renderPdfBatchWorker = onMessagePublished(
  { topic: RENDER_BATCH_TOPIC, retry: true, maxInstances: 1, concurrency: 1 },
  async (event) => {
    const payload = (event.data.message.json ?? {}) as {
      examId?: unknown;
      startPage?: unknown;
    };
    const examIdRaw = typeof payload.examId === "string" ? payload.examId.trim() : "";
    const startPage = toPositiveInt(payload.startPage) ?? 1;

    if (!examIdRaw) {
      logger.warn("Ignored render batch message without examId.");
      return;
    }

    const examSnap = await getFirestore().collection("exams").doc(examIdRaw).get();
    if (!examSnap.exists) {
      logger.warn("Ignored render batch for missing exam document.", { examId: examIdRaw });
      return;
    }

    const examData = examSnap.data() ?? {};
    const problemPdfPath =
      typeof examData.problemPdfPath === "string" ? examData.problemPdfPath : "";
    const subject = typeof examData.subject === "string" ? examData.subject : "";
    const renderStatus = typeof examData.renderStatus === "string" ? examData.renderStatus : null;
    const nextPageStartFromDoc = toPositiveInt(examData.nextPageStart) ?? 1;
    const bucketName = getStorage().bucket().name;

    if (!problemPdfPath) {
      logger.warn("Ignored render batch without problemPdfPath.", { examId: examIdRaw });
      return;
    }

    if (renderStatus === "ready") {
      logger.info("Skipped render batch because exam is already ready.", {
        examId: examIdRaw,
        startPage,
      });
      return;
    }

    if (startPage !== nextPageStartFromDoc) {
      logger.info("Skipped stale/out-of-order render batch.", {
        examId: examIdRaw,
        startPage,
        nextPageStartFromDoc,
      });
      return;
    }

    const result = await renderPdfFromStorage({
      bucketName,
      objectPath: problemPdfPath,
      startPage,
      forcedExamId: examIdRaw,
      forcedSubject: subject,
    });

    if (result.nextPageStart) {
      await enqueueRenderBatch(examIdRaw, result.nextPageStart);
    }
  },
);

export const rerenderExamPages = onRequest({ cors: true }, async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Only POST is allowed." });
    return;
  }

  const examIdRaw = (req.body?.examId ?? req.query.examId ?? "").toString().trim();
  const startPage = toPositiveInt(req.body?.startPage ?? req.query.startPage) ?? 1;
  if (!examIdRaw) {
    res.status(400).json({ ok: false, error: "examId is required." });
    return;
  }

  const examSnap = await getFirestore().collection("exams").doc(examIdRaw).get();
  if (!examSnap.exists) {
    res.status(404).json({ ok: false, error: "Exam not found." });
    return;
  }

  const examData = examSnap.data() ?? {};
  const renderStatus = typeof examData.renderStatus === "string" ? examData.renderStatus : null;
  const nextPageStartFromDoc = toPositiveInt(examData.nextPageStart) ?? 1;

  if (renderStatus === "running") {
    res.status(202).json({
      ok: true,
      examId: examIdRaw,
      queued: true,
      alreadyQueued: true,
      nextPageStart: nextPageStartFromDoc,
    });
    return;
  }

  if (renderStatus === "queued") {
    await enqueueRenderBatch(examIdRaw, nextPageStartFromDoc);
    res.status(202).json({
      ok: true,
      examId: examIdRaw,
      queued: true,
      requeued: true,
      nextPageStart: nextPageStartFromDoc,
    });
    return;
  }

  await getFirestore()
    .collection("exams")
    .doc(examIdRaw)
    .set(
      {
        renderStatus: "queued",
        nextPageStart: startPage,
        ...(startPage === 1
          ? {
              pageCount: FieldValue.delete(),
              renderedPageCount: FieldValue.delete(),
              renderedAt: FieldValue.delete(),
            }
          : {}),
        lastRenderError: FieldValue.delete(),
        renderFailedAt: FieldValue.delete(),
      },
      { merge: true },
    );

  await enqueueRenderBatch(examIdRaw, startPage);

  res.status(202).json({
    ok: true,
    examId: examIdRaw,
    queued: true,
    startPage,
  });
});
