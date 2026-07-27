# syntax=docker/dockerfile:1
# ベースイメージは digest 固定(AGENTS.md §1.14)
FROM python:3.12-slim@sha256:57cd7c3a7a273101a6485ba99423ee568157882804b1124b4dd04266317710de AS base
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

FROM base AS deps
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

FROM deps AS dev
COPY . .
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "3004", "--reload"]

FROM deps AS production
COPY . .
RUN useradd --create-home --uid 10001 advisor
USER advisor
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "3004"]
