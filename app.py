from flask import Flask, render_template, request
from flask_socketio import SocketIO, emit, join_room, leave_room
import secrets

app = Flask(__name__)
app.config['SECRET_KEY'] = 'your-secret-key'
socketio = SocketIO(app, cors_allowed_origins="*")

# Хранение информации о комнатах в памяти (в реальных приложениях используй базу данных)
rooms = {}

@app.route('/')
def index():
    """
    Главная страница — позволяет создать новую комнату или войти в существующую.
    """
    return render_template('index.html')

@app.route('/create_room', methods=['POST'])
def create_room():
    """
    Создаёт уникальную комнату с ID и возвращает ссылку на страницу регистрации.
    """
    room_id = secrets.token_hex(4)  # Генерация уникального ID (8 шестнадцатеричных символов)
    # Инициализация комнаты: список участников, модератор и история чата
    rooms[room_id] = {'users': [], 'moderator': None, 'messages': []}
    # Перенаправляем на страницу регистрации, а не в комнату
    return f'<a href="/join_form/{room_id}">Войти в комнату {room_id}</a>'

@app.route('/room/<room_id>')
def room(room_id):
    """
    Страница видеоконференции.
    Проверяет, существует ли комната, иначе возвращает 404.
    """
    if room_id not in rooms:
        return "Комната не найдена", 404
    return render_template('room.html', room_id=room_id)

@app.route('/join_form/<room_id>')
def join_form(room_id):
    """
    Страница регистрации: ввод ФИО перед входом в комнату.
    """
    if room_id not in rooms:
        return "Комната не найдена", 404
    return render_template('join_form.html', room_id=room_id)

# Событие: пользователь заходит в комнату
@socketio.on('join')
def on_join(data):
    """
    Обработка события входа пользователя в комнату.
    Назначает первого участника модератором.
    """
    room_id = data['room']
    username = data.get('username', 'Аноним')
    join_room(room_id)

    # Проверяем, не вошёл ли уже такой пользователь (защита от дубликатов при обновлении)
    existing_user = next((u for u in rooms[room_id]['users'] if u['username'] == username), None)
    if existing_user:
        # Если пользователь уже есть, обновляем его данные
        # Не переназначаем модератора
        existing_user['is_moderator'] = existing_user['is_moderator']
        existing_user['audio_enabled'] = True
        existing_user['video_enabled'] = True
        existing_user['screen_shared'] = False
    else:
        # Иначе добавляем нового
        is_first_user = len(rooms[room_id]['users']) == 0
        rooms[room_id]['users'].append({
            'username': username,
            'is_moderator': False,  # Пока не модератор
            'audio_enabled': True,
            'video_enabled': True,
            'screen_shared': False
        })

        # Назначаем первого вошедшего модератором, если модератора ещё нет
        if not rooms[room_id]['moderator']:
            rooms[room_id]['moderator'] = username
            rooms[room_id]['users'][-1]['is_moderator'] = True

    # Отправляем обновлённый список пользователей и историю чата всем в комнате
    emit('user_joined', {
        'username': username,
        'users': [
            {
                'username': u['username'],
                'is_moderator': u['is_moderator'],
                'audio_enabled': u['audio_enabled'],
                'video_enabled': u['video_enabled'],
                'screen_shared': u['screen_shared']
            } for u in rooms[room_id]['users']
        ],
        'messages': rooms[room_id]['messages']  # Отправляем историю чата
    }, room=room_id)

@socketio.on('message')
def handle_message(data):
    """
    Отправка сообщения чата всем участникам комнаты.
    """
    room_id = data['room']
    username = data.get('username', 'Аноним')
    msg = data['message']
    # Сохраняем сообщение в комнате
    rooms[room_id]['messages'].append({'username': username, 'message': msg})
    emit('message', {'username': username, 'message': msg}, room=room_id)

@socketio.on('offer')
def handle_offer(data):
    """
    Пересылает SDP offer от одного участника другим.
    """
    emit('offer', data, room=data['room'], skip_sid=request.sid)

@socketio.on('answer')
def handle_answer(data):
    """
    Пересылает SDP answer от одного участника другим.
    """
    emit('answer', data, room=data['room'], skip_sid=request.sid)

@socketio.on('candidate')
def handle_candidate(data):
    """
    Пересылает ICE-кандидат от одного участника другим.
    """
    emit('candidate', data, room=data['room'], skip_sid=request.sid)

@socketio.on('toggle_track')
def handle_toggle_track(data):
    """
    Обработка события включения/выключения аудио/видео у участника (модератором или им самим).
    """
    room_id = data['room']
    target_username = data['target']
    track_type = data['type']  # 'audio' или 'video'
    enabled = data['enabled']

    room_info = rooms.get(room_id)
    if room_info:
        # Обновляем состояние аудио/видео в списке участников
        for u in room_info['users']:
            if u['username'] == target_username:
                if track_type == 'audio':
                    u['audio_enabled'] = enabled
                elif track_type == 'video':
                    u['video_enabled'] = enabled

    # Отправляем команду всем участникам, чтобы они обновили состояние у себя
    emit('toggle_track', {'target': target_username, 'type': track_type, 'enabled': enabled}, room=room_id, skip_sid=request.sid)

@socketio.on('stop_screen_share')
def handle_stop_screen_share(data):
    """
    Обработка остановки демонстрации экрана у участника (модератором).
    """
    room_id = data['room']
    target_username = data['target']

    room_info = rooms.get(room_id)
    if room_info:
        # Обновляем статус демонстрации экрана
        for u in room_info['users']:
            if u['username'] == target_username:
                u['screen_shared'] = False

    # Отправляем команду участнику остановить демонстрацию
    emit('stop_screen_share', {'target': target_username}, room=room_id)

@socketio.on('screen_share_started')
def handle_screen_share_started(data):
    """
    Отправляет событие о начале демонстрации экрана всем участникам.
    """
    emit('screen_share_started', {'username': data['username']}, room=data['room'], skip_sid=request.sid)

@socketio.on('screen_share_stopped')
def handle_screen_share_stopped(data):
    """
    Отправляет событие об остановке демонстрации экрана всем участникам.
    """
    emit('screen_share_stopped', {'username': data['username']}, room=data['room'], skip_sid=request.sid)

@socketio.on('kick_user')
def handle_kick_user(data):
    """
    Обработка исключения участника модератором.
    """
    room_id = data['room']
    moderator_username = data.get('moderator')
    target_username = data.get('target')

    room_info = rooms.get(room_id)
    if room_info and room_info['moderator'] == moderator_username:
        # Удаляем участника из списка
        room_info['users'] = [u for u in room_info['users'] if u['username'] != target_username]
        # Уведомляем всех участников, что пользователь вышел
        emit('user_kicked', {'target': target_username}, room=room_id)

@socketio.on('leave')
def on_leave(data):
    """
    Обработка выхода пользователя из комнаты.
    """
    room_id = data['room']
    username = data.get('username', 'Аноним')
    leave_room(room_id)

    if room_id in rooms:
        # Удаляем пользователя из списка участников
        rooms[room_id]['users'] = [u for u in rooms[room_id]['users'] if u['username'] != username]
        # Отправляем обновлённый список участникам
        emit('user_left', {'username': username, 'users': [
            {
                'username': u['username'],
                'is_moderator': u['is_moderator'],
                'audio_enabled': u['audio_enabled'],
                'video_enabled': u['video_enabled'],
                'screen_shared': u['screen_shared']
            } for u in rooms[room_id]['users']
        ]}, room=room_id)

if __name__ == '__main__':
    # Запуск сервера на 0.0.0.0 для доступа с других устройств
    context = ('cert.pem', 'key.pem')
    socketio.run(app, host='0.0.0.0', port=5000, debug=True, allow_unsafe_werkzeug=True)