// Получаем имя пользователя из URL-параметра
const urlParams = new URLSearchParams(window.location.search);
const username = urlParams.get('username') || 'Аноним';
const roomID = document.getElementById('roomId').textContent;
const socket = io('http://5.228.149.114:5000');

let localStream;
let peerConnections = {}; // { username: RTCPeerConnection }
let isScreenShared = false;
let audioEnabled = true;
let videoEnabled = true;
let isStreaming = false;
const config = { 
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ] 
};

const localVideo = document.getElementById('local-video');
const remoteVideos = document.getElementById('remote-videos');
const messageInput = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');
const messagesDiv = document.getElementById('messages');
const startBtn = document.getElementById('start-btn');
const screenBtn = document.getElementById('screen-btn');
const toggleAudioBtn = document.getElementById('toggle-audio-btn');
const toggleVideoBtn = document.getElementById('toggle-video-btn');
const userList = document.getElementById('user-list');

let isModerator = false;

socket.emit('join', { room: roomID, username: username });

// Обновление списка участников
socket.on('user_joined', (data) => {
    isModerator = data.users.some(u => u.username === username && u.is_moderator);
    updateParticipantList(data.users);

    // Восстанавливаем историю чата
    messagesDiv.innerHTML = '';
    data.messages.forEach(msg => {
        addMessageToChat(msg.username, msg.message);
    });

    // Создаём соединения с новыми участниками
    data.users.forEach(user => {
        if (user.username !== username && !peerConnections[user.username]) {
            createPeerConnection(user.username);
        }
    });

    // Отправляем offer новому участнику от всех, у кого есть поток
    if (localStream) {
        createOffer(data.username);
    }

    // Отправляем offer всем, кто уже был в комнате
    if (localStream) {
        data.users.forEach(user => {
            if (user.username !== username) {
                createOffer(user.username);
            }
        });
    }
});

socket.on('user_left', (data) => {
    // Закрываем соединение
    if (peerConnections[data.username]) {
        peerConnections[data.username].close();
        delete peerConnections[data.username];
    }
    // Удаляем видео
    const video = document.getElementById(`video-${data.username}`);
    if (video) {
        video.srcObject = null; // Освобождаем ресурсы
        video.remove();
    }
    // Обновляем список участников
    updateParticipantList(data.users);
});

socket.on('user_kicked', (data) => {
    if (data.target === username) {
        alert('Вас выгнал модератор.');
        window.location.href = '/';
    }
});

socket.on('stop_screen_share', (data) => {
    if (data.target === username && isScreenShared) {
        localVideo.srcObject = localStream;
        screenBtn.textContent = 'Демонстрация экрана';
        localVideo.classList.remove('screen-shared');
        isScreenShared = false;
        for (const user in peerConnections) {
            const sender = peerConnections[user].getSenders().find(s => s.track.kind === 'video');
            if (sender) sender.replaceTrack(localStream.getVideoTracks()[0]);
        }
    }
});

socket.on('screen_share_started', (data) => {
    const video = document.getElementById(`video-${data.username}`);
    if (video) video.classList.add('screen-shared');
});

socket.on('screen_share_stopped', (data) => {
    const video = document.getElementById(`video-${data.username}`);
    if (video) video.classList.remove('screen-shared');
});

function updateParticipantList(users) {
    userList.innerHTML = '';
    users.forEach(user => {
        const li = document.createElement('li');
        li.textContent = user.username + (user.is_moderator ? ' (Модератор)' : '');

        if (isModerator && user.username !== username) {
            const controls = document.createElement('div');
            controls.style.display = 'inline-block';
            controls.style.marginLeft = '10px';

            const kickBtn = document.createElement('button');
            kickBtn.textContent = 'Выгнать';
            kickBtn.onclick = () => {
                socket.emit('kick_user', { room: roomID, moderator: username, target: user.username });
                li.remove();
            };

            const toggleAudioBtn = document.createElement('button');
            toggleAudioBtn.textContent = user.audio_enabled ? 'Выкл. аудио' : 'Вкл. аудио';
            toggleAudioBtn.onclick = () => {
                const newEnabled = !user.audio_enabled;
                socket.emit('toggle_track', { room: roomID, target: user.username, type: 'audio', enabled: newEnabled });
            };

            const toggleVideoBtn = document.createElement('button');
            toggleVideoBtn.textContent = user.video_enabled ? 'Выкл. видео' : 'Вкл. видео';
            toggleVideoBtn.onclick = () => {
                const newEnabled = !user.video_enabled;
                socket.emit('toggle_track', { room: roomID, target: user.username, type: 'video', enabled: newEnabled });
            };

            const stopScreenBtn = document.createElement('button');
            stopScreenBtn.textContent = 'Ост. демонстрацию';
            if (!user.screen_shared) stopScreenBtn.disabled = true;
            stopScreenBtn.onclick = () => {
                socket.emit('stop_screen_share', { room: roomID, target: user.username });
            };

            controls.appendChild(kickBtn);
            controls.appendChild(toggleAudioBtn);
            controls.appendChild(toggleVideoBtn);
            controls.appendChild(stopScreenBtn);

            li.appendChild(controls);
        }
        userList.appendChild(li);
    });
}

let presenceTimer;
function showPresenceModal() {
    const modal = document.getElementById('presenceModal');
    modal.style.display = 'block';
    setTimeout(() => {
        if (modal.style.display === 'block') {
            alert('Вы были отключены за неактивность.');
            window.location.href = '/';
        }
    }, 30000);
}
function resetPresenceTimer() {
    clearTimeout(presenceTimer);
    const modal = document.getElementById('presenceModal');
    modal.style.display = 'none';
    presenceTimer = setTimeout(showPresenceModal, 600000);
}
document.getElementById('confirmPresence').addEventListener('click', resetPresenceTimer);
resetPresenceTimer();

function copyRoomId() {
    const roomIdText = document.getElementById('roomId').textContent;
    navigator.clipboard.writeText(roomIdText).then(() => {
        alert('ID комнаты скопирован: ' + roomIdText);
    });
}

// --- Начало/завершение трансляции ---
startBtn.onclick = async () => {
    if (!isStreaming) {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        localVideo.srcObject = localStream;
        startBtn.textContent = 'Завершить трансляцию';
        isStreaming = true;
        screenBtn.disabled = false;
        toggleAudioBtn.disabled = false;
        toggleVideoBtn.disabled = false;
    } else {
        // Завершаем трансляцию
        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
            localVideo.srcObject = null;
        }
        startBtn.textContent = 'Начать трансляцию';
        isStreaming = false;
        screenBtn.disabled = true;
        toggleAudioBtn.disabled = true;
        toggleVideoBtn.disabled = true;
    }
};

// Создание WebRTC-соединения
function createPeerConnection(targetUser) {
    const pc = new RTCPeerConnection(config);
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('candidate', { candidate: event.candidate, room: roomID, sender: username, target: targetUser });
        }
    };
    pc.ontrack = (event) => {
        // Проверяем, есть ли уже видео для этого пользователя
        const existingVideo = document.getElementById(`video-${targetUser}`);
        if (existingVideo) return;

        const video = document.createElement('video');
        video.id = `video-${targetUser}`;
        video.srcObject = event.streams[0];
        video.autoplay = true;
        video.playsInline = true;
        video.classList.add('video-item');
        remoteVideos.appendChild(video);
    };
    if (localStream) {
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }
    peerConnections[targetUser] = pc;
}

// Создание offer для отправки другому участнику
function createOffer(targetUser) {
    if (!peerConnections[targetUser]) {
        createPeerConnection(targetUser);
    }
    const pc = peerConnections[targetUser];
    pc.createOffer()
        .then(offer => {
            pc.setLocalDescription(offer);
            socket.emit('offer', { offer, room: roomID, sender: username, target: targetUser });
        });
}

socket.on('offer', async (data) => {
    const targetUser = data.sender;
    if (!peerConnections[targetUser]) {
        createPeerConnection(targetUser);
    }
    const pc = peerConnections[targetUser];
    await pc.setRemoteDescription(data.offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('answer', { answer, room: roomID, sender: username, target: targetUser });
});

socket.on('answer', async (data) => {
    const targetUser = data.sender;
    const pc = peerConnections[targetUser];
    if (pc) {
        await pc.setRemoteDescription(data.answer);
    }
});

socket.on('candidate', async (data) => {
    const targetUser = data.sender;
    const pc = peerConnections[targetUser];
    if (pc) {
        try {
            await pc.addIceCandidate(data.candidate);
        } catch (e) {
            console.error('Ошибка добавления ICE-кандидата', e);
        }
    }
});

screenBtn.onclick = async () => {
    try {
        if (!isScreenShared) {
            const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
            localVideo.srcObject = screenStream;
            screenBtn.textContent = 'Приостановить демонстрацию';
            localVideo.classList.add('screen-shared');

            for (const user in peerConnections) {
                const sender = peerConnections[user].getSenders().find(s => s.track.kind === 'video');
                if (sender) sender.replaceTrack(screenStream.getVideoTracks()[0]);
            }

            socket.emit('screen_share_started', { room: roomID, username: username });

            screenStream.getVideoTracks()[0].onended = () => {
                localVideo.srcObject = localStream;
                screenBtn.textContent = 'Демонстрация экрана';
                localVideo.classList.remove('screen-shared');
                isScreenShared = false;
                socket.emit('screen_share_stopped', { room: roomID, username: username });

                for (const user in peerConnections) {
                    const sender = peerConnections[user].getSenders().find(s => s.track.kind === 'video');
                    if (sender) sender.replaceTrack(localStream.getVideoTracks()[0]);
                }
            };
            isScreenShared = true;
        } else {
            localVideo.srcObject = localStream;
            screenBtn.textContent = 'Демонстрация экрана';
            localVideo.classList.remove('screen-shared');
            isScreenShared = false;
            socket.emit('screen_share_stopped', { room: roomID, username: username });

            for (const user in peerConnections) {
                const sender = peerConnections[user].getSenders().find(s => s.track.kind === 'video');
                if (sender) sender.replaceTrack(localStream.getVideoTracks()[0]);
            }
        }
    } catch (e) {
        console.error('Ошибка демонстрации экрана', e);
    }
};

toggleAudioBtn.onclick = () => {
    audioEnabled = !audioEnabled;
    if (localStream) {
        localStream.getAudioTracks()[0].enabled = audioEnabled;
    }
    toggleAudioBtn.textContent = audioEnabled ? 'Выключить микрофон' : 'Включить микрофон';
    socket.emit('toggle_track', { room: roomID, target: username, type: 'audio', enabled: audioEnabled });
};

toggleVideoBtn.onclick = () => {
    videoEnabled = !videoEnabled;
    if (localStream) {
        localStream.getVideoTracks()[0].enabled = videoEnabled;
    }
    toggleVideoBtn.textContent = videoEnabled ? 'Выключить камеру' : 'Включить камеру';
    socket.emit('toggle_track', { room: roomID, target: username, type: 'video', enabled: videoEnabled });
};

socket.on('toggle_track', (data) => {
    console.log(`${data.target} ${data.enabled ? 'включил' : 'выключил'} ${data.type}`);
});

sendBtn.onclick = () => {
    const msg = messageInput.value;
    if (msg.trim()) {
        socket.emit('message', { room: roomID, username, message: msg });
        addMessageToChat(username, msg);
        messageInput.value = '';
    }
};

// --- Оптимизация чата ---
const MAX_CHAT_MESSAGES = 100; // Ограничиваем количество сообщений

socket.on('message', (data) => {
    addMessageToChat(data.username, data.message);
});

function addMessageToChat(username, message) {
    const p = document.createElement('p');
    p.innerHTML = `<b>${username}:</b> ${message}`;
    messagesDiv.appendChild(p);

    // Если сообщений > MAX_CHAT_MESSAGES, удаляем старые
    while (messagesDiv.children.length > MAX_CHAT_MESSAGES) {
        messagesDiv.removeChild(messagesDiv.firstChild);
    }

    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

// Убираем localStorage для чата — он теперь на сервере
window.onload = () => {
    // Не восстанавливаем чат из localStorage
};