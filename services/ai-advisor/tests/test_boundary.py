"""AI サービスの境界が壊れていないことを検査する(ADR-0007 / 脅威 T-13)。

このテストは実装の詳細ではなく **境界そのもの** を守る。
将来 DB クライアントや Executor クライアントを import した時点で失敗する。
"""

from __future__ import annotations

import pathlib
import re

SRC = pathlib.Path(__file__).resolve().parents[1] / "app"

FORBIDDEN_IMPORTS = [
    r"\bpsycopg",          # DB 直接接続
    r"\basyncpg\b",
    r"\bsqlalchemy\b",
    r"executor",           # Executor クライアント
]


def test_ai_service_has_no_database_or_executor_dependency() -> None:
    offenders: list[str] = []
    for path in SRC.rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        # docstring/コメント内の言及は除外し、import 文だけを見る
        imports = "\n".join(
            line for line in text.splitlines() if re.match(r"\s*(import|from)\s", line)
        )
        for pattern in FORBIDDEN_IMPORTS:
            if re.search(pattern, imports, re.IGNORECASE):
                offenders.append(f"{path.name}: {pattern}")
    assert not offenders, (
        "AI サービスに DB / Executor への依存が持ち込まれています。"
        "ADR-0007 により advisory-only を維持してください: " + ", ".join(offenders)
    )


def test_requirements_do_not_include_db_or_http_client_to_executor() -> None:
    req = (SRC.parent / "requirements.txt").read_text(encoding="utf-8").lower()
    for forbidden in ("psycopg", "asyncpg", "sqlalchemy"):
        assert forbidden not in req, f"{forbidden} は AI サービスに追加しないでください"
