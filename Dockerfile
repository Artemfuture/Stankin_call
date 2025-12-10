FROM python:3.12.3

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Указываем, что приложение будет слушать на порту 5000
EXPOSE 5000

# Команда для запуска приложения
# Используем eventlet для лучшей производительности с SocketIO
CMD ["python", "-m", "eventlet.wsgi", "-k", "eventlet", "-b", "0.0.0.0:5000", "app.py"]