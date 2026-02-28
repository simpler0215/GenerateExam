import Link from "next/link";

export default function HomePage() {
  return (
    <main className="aq-page">
      <header className="aq-hero">
        <p className="aq-kicker">AUTOQUIZ ADMIN</p>
        <h1 className="aq-title">관리자 시작 페이지</h1>
        <p className="aq-desc">시험 생성과 문제지 생성을 한곳에서 빠르게 관리할 수 있습니다.</p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Link className="aq-link-chip" href="/admin/exams/create">
            시험 생성 페이지로 이동
          </Link>
          <Link className="aq-link-chip" href="/admin/papers/create">
            문제지 생성 페이지로 이동
          </Link>
        </div>
      </header>
    </main>
  );
}
