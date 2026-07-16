FROM python:3.12-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# requirements.txt is a fully pinned + hashed lock compiled from requirements.in
# (see that file's header). --require-hashes makes the install reproducible and
# refuses any package whose artifact hash doesn't match.
COPY requirements.txt .
RUN pip install --no-cache-dir --require-hashes -r requirements.txt

COPY . .

EXPOSE 8765

CMD ["python", "-m", "src.server"]
