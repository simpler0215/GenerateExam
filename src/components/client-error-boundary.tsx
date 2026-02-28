"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = {
  children: ReactNode;
  title?: string;
};

type State = {
  hasError: boolean;
  message: string | null;
};

export class ClientErrorBoundary extends Component<Props, State> {
  state: State = {
    hasError: false,
    message: null,
  };

  static getDerivedStateFromError(error: unknown): State {
    const message = error instanceof Error ? error.message : "알 수 없는 클라이언트 오류";
    return {
      hasError: true,
      message,
    };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("ClientErrorBoundary", { error, info });
  }

  render() {
    if (this.state.hasError) {
      return (
        <section
          style={{
            maxWidth: 980,
            margin: "40px auto",
            padding: "0 16px",
          }}
        >
          <h1 style={{ marginBottom: 8 }}>{this.props.title ?? "페이지 오류"}</h1>
          <p style={{ color: "crimson", marginTop: 0 }}>
            클라이언트 오류가 발생했습니다. 페이지를 새로고침해 주세요.
          </p>
          {this.state.message ? (
            <p style={{ color: "#444" }}>
              상세 내용: <code>{this.state.message}</code>
            </p>
          ) : null}
        </section>
      );
    }

    return this.props.children;
  }
}
