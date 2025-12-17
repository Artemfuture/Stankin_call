FROM python:3.12.3-slim  # Используем slim для меньшего размера

WORKDIR /app

# Устанавливаем системные зависимости для некоторых Python пакетов
RUN apt-get update && apt-get install -y \
    gcc \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Копируем остальные файлы
COPY . .

# Указываем порт
EXPOSE 5000

# Устанавливаем переменные окружения
ENV PYTHONUNBUFFERED=1
ENV FLASK_APP=app.py

# Команда для запуска
CMD ["python", "app.py"]