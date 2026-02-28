import Link from "next/link";

export default function HomePage() {
  return (
    <main style={{ maxWidth: 800, margin: "40px auto", padding: "0 16px" }}>
      <h1 style={{ marginBottom: 12 }}>AutoQuiz</h1>
      <p style={{ marginBottom: 20 }}>관리자 시작 페이지</p>
      <div style={{ display: "grid", gap: 8 }}>
        <Link href="/admin/exams/create">시험 생성 페이지로 이동</Link>
        <Link href="/admin/papers/create">문제지 생성 페이지로 이동</Link>
      </div>
    </main>
  );
}
