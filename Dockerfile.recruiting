FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential curl tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*

COPY requirements-recruiting.txt ./requirements-recruiting.txt
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements-recruiting.txt

COPY . .

RUN chmod +x scripts/recruiting/run_railway_worker.sh

CMD ["bash", "scripts/recruiting/run_railway_worker.sh"]
