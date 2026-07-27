"""SOLVI Assist — advisory-only の AI サービス(ADR-0007)。

このサービスが持たないもの:
  - 業務データベースへの接続
  - Executor(SOLVI Run)への到達経路
  - 特権API資格情報

上記は「まだ実装していない」ではなく **恒久的な制約** である。
AI の出力は常に提案であり、承認・実行・状態変更を確定しない。
提案を確定するのは人間または決定論的ルール(Core API)側の責務。
"""

from __future__ import annotations

import os
from datetime import datetime, timezone

from fastapi import FastAPI
from pydantic import BaseModel

SERVICE_VERSION = os.environ.get("SOLVI_VERSION", "dev")
ENV = os.environ.get("SOLVI_ENV", "development")

app = FastAPI(
    title="SOLVI Assist",
    version=SERVICE_VERSION,
    description="Advisory-only AI service. Never performs privileged actions.",
)


class Liveness(BaseModel):
    status: str
    service: str
    version: str


class Readiness(BaseModel):
    status: str
    dependencies: list[dict[str, str]]
    checked_at: str
    advisory_only: bool


@app.get("/healthz", response_model=Liveness)
def healthz() -> Liveness:
    return Liveness(status="ok", service="ai-advisor", version=SERVICE_VERSION)


@app.get("/readyz", response_model=Readiness)
def readyz() -> Readiness:
    # 依存する外部モデルプロバイダは Phase 3 以降に追加する(OQ-006 で経路が未決)。
    # 現時点では依存がないため常に ready。
    return Readiness(
        status="ready",
        dependencies=[],
        checked_at=datetime.now(timezone.utc).isoformat(),
        advisory_only=True,
    )
