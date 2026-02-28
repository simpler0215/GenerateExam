import { NextRequest, NextResponse } from "next/server";

function getStorageBucket(): string {
  const bucket = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
  if (!bucket) {
    throw new Error("Missing NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET");
  }
  return bucket;
}

function isSafeStoragePath(path: string): boolean {
  if (!path) {
    return false;
  }
  if (path.includes("..")) {
    return false;
  }
  if (!path.startsWith("derived/")) {
    return false;
  }
  return true;
}

export async function GET(request: NextRequest) {
  const storagePath = request.nextUrl.searchParams.get("path")?.trim() ?? "";
  if (!isSafeStoragePath(storagePath)) {
    return NextResponse.json({ error: "Invalid storage path." }, { status: 400 });
  }

  try {
    const bucket = getStorageBucket();
    const upstreamUrl = `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(
      bucket,
    )}/o/${encodeURIComponent(storagePath)}?alt=media`;

    const upstream = await fetch(upstreamUrl, { cache: "no-store" });
    if (!upstream.ok) {
      return NextResponse.json(
        { error: `Storage fetch failed (${upstream.status}).` },
        { status: upstream.status },
      );
    }

    const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
    const body = await upstream.arrayBuffer();
    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected proxy error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
