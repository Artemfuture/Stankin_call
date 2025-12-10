// Получаем имя пользователя из URL-параметра
const urlParams = new URLSearchParams(window.location.search);
const username = urlParams.get('username') || 'Аноним';
const roomID = document.getElementById('roomId').textContent;
const socket = io('http://5.228.149.114:5000'); //prod
// const socket = io('http://localhost:5000'); //test
let localStream;
let peerConnections = {}; // { username: RTCPeerConnection }
let iceCandidateQueues = {};
let offerCreationInProgress = {};
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
    console.log('Пользователь вошёл:', data);
    isModerator = data.users.some(u => u.username === username && u.is_moderator);
    updateParticipantList(data.users);

    messagesDiv.innerHTML = '';
    data.messages.forEach(msg => {
        addMessageToChat(msg.username, msg.message);
    });

    // Шаг 1: Создаём соединения с ВСЕМИ участниками (включая нового, если его ещё нет)
    data.users.forEach(user => {
        if (user.username !== username && !peerConnections[user.username]) {
            console.log(`Создаём соединение с пользователем: ${user.username} при user_joined`);
            createPeerConnection(user.username);
        }
    });

    // Шаг 2: Если у нас есть локальный поток, отправляем offer ВСЕМ, кроме себя
    if (localStream) {
        // Отправляем offer ВСЕМ, кроме себя
        data.users.forEach(user => {
            if (user.username !== username) {
                // Проверяем, не идёт ли уже создание offer для этого пользователя
                if (!offerCreationInProgress[user.username]) {
                    console.log(`Отправляем offer пользователю ${user.username} при событии user_joined (цикл по data.users)`);
                    // Устанавливаем флаг, что создание offer началось
                    offerCreationInProgress[user.username] = true;
                    createOffer(user.username);
                } else {
                    console.log(`Пропускаем offer для ${user.username}, так как он уже идёт.`);
                }
            }
        });

        // Отправляем offer НОВОМУ пользователю (data.username), если он не "я" и offer ещё не идёт
        if (data.username && data.username !== username && !offerCreationInProgress[data.username]) {
            console.log(`Отправляем offer НОВОМУ пользователю ${data.username} при событии user_joined`);
            // Устанавливаем флаг, что создание offer началось
            offerCreationInProgress[data.username] = true;
            createOffer(data.username);
        } else if (data.username && data.username !== username && offerCreationInProgress[data.username]) {
            console.log(`Пропускаем offer для НОВОГО пользователя ${data.username}, так как он уже идёт.`);
        }
    }
});

socket.on('user_left', (data) => {
    console.log(`${data.username} покинул комнату.`);
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
        for (const targetUser in peerConnections) {
            const pc = peerConnections[targetUser];
            if (pc && pc.signalingState === 'stable') { // Убедимся, что можно добавить трек и сделать renegotiation
                console.log(`Добавляем локальные треки к существующему соединению с ${targetUser}`);
                const tracksToAdd = localStream.getTracks();
                let tracksAdded = false;
                for (const track of tracksToAdd) {
                    if (track.enabled) {
                        // Проверяем, не добавлен ли уже этот трек к этому соединению
                        const sender = pc.getSenders().find(s => s.track && s.track.id === track.id);
                        if (!sender) {
                            pc.addTrack(track, localStream);
                            tracksAdded = true;
                            console.log(`Трек ${track.kind} добавлен к соединению с ${targetUser}`);
                        } else {
                            console.log(`Трек ${track.kind} уже добавлен к соединению с ${targetUser}`);
                        }
                    }
                }
                // Если были добавлены новые треки, инициируем renegotiation
                if (tracksAdded) {
                    console.log(`Инициируем renegotiation для соединения с ${targetUser}`);
                    createOffer(targetUser); // Пересоздаём offer с новыми треками
                }
            } else {
                console.log(`Не добавляем треки к соединению с ${targetUser}, состояние: ${pc ? pc.signalingState : 'не существует'}`);
            }
        }
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
    if (peerConnections[targetUser]) {
        console.log(`Соединение с ${targetUser} уже существует.`, peerConnections[targetUser].signalingState, peerConnections[targetUser].iceConnectionState);
        return;
    }

    console.log(`Создаём соединение с ${targetUser}`);
    const pc = new RTCPeerConnection(config);

    // Инициализируем очередь ICE-кандидатов и флаг offer для этого пользователя
    iceCandidateQueues[targetUser] = [];
    offerCreationInProgress[targetUser] = false; // Изначально не создаём offer

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            console.log(`Отправляем ICE-кандидат для ${targetUser}`, event.candidate);
            socket.emit('candidate', {
                candidate: event.candidate,
                room: roomID,
                username: username,
                target: targetUser
            });
        } else {
            console.log(`Все ICE-кандидаты для ${targetUser} отправлены.`);
        }
    };

    pc.ontrack = (event) => {
        console.log(`Получен трек от ${targetUser}`, event.streams[0]);
        const videoId = `video-${targetUser}`;
        let video = document.getElementById(videoId);

        if (!video) {
            console.log(`Создаём новый элемент video для ${targetUser}`);
            video = document.createElement('video');
            video.id = videoId;
            video.autoplay = true;
            video.playsInline = true;
            video.classList.add('video-item');
            remoteVideos.appendChild(video);
        } else {
            console.log(`Обновляем srcObject существующего элемента video для ${targetUser}`);
        }

        video.srcObject = event.streams[0];
    };

    if (localStream) { // <-- ВАЖНО: проверяем, что localStream существует
        console.log(`Добавляем локальный поток к соединению с ${targetUser}`);
        localStream.getTracks().forEach(track => {
            // Добавляем только активные треки
            if (track.enabled) {
                 pc.addTrack(track, localStream);
            }
        });
    } else {
        console.log(`Предупреждение: localStream отсутствует при создании соединения с ${targetUser}. Поток не будет отправлен.`);
        // В реальной ситуации вы можете подписаться на событие, когда localStream станет доступен,
        // и добавить треки позже.
    }

    pc.onconnectionstatechange = (event) => {
        console.log(`Состояние соединения с ${targetUser} изменилось:`, pc.connectionState);
    };

    pc.onsignalingstatechange = (event) => {
        console.log(`Состояние сигнализации с ${targetUser} изменилось:`, pc.signalingState);
        // Если состояние стало 'stable', можно сбросить флаг offer
        if (pc.signalingState === 'stable') {
            offerCreationInProgress[targetUser] = false;
            console.log(`Сбросили флаг offerCreationInProgress для ${targetUser}`);
        }
    };

    peerConnections[targetUser] = pc;
    console.log(`Соединение с ${targetUser} создано и сохранено.`, pc.signalingState, pc.iceConnectionState);
}
// Создание offer для отправки другому участнику
function createOffer(targetUser) {
    console.log(`Попытка создать offer для ${targetUser}`);
    const pc = peerConnections[targetUser];
    if (!pc) {
        console.error(`Соединение с ${targetUser} не найдено при попытке создать offer.`);
        // Сбрасываем флаг, если соединение вдруг исчезло
        offerCreationInProgress[targetUser] = false;
        return;
    }

    // Проверяем состояние перед созданием offer
    if (pc.signalingState !== 'stable' && pc.signalingState !== 'have-remote-offer') {
        console.warn(`Состояние соединения с ${targetUser} не позволяет создать offer: ${pc.signalingState}`);
        // Сбрасываем флаг, если состояние неожиданно изменилось
        offerCreationInProgress[targetUser] = false;
        return;
    }

    // Устанавливаем флаг, что offer идёт (дублирующая проверка, но лишней не будет)
    offerCreationInProgress[targetUser] = true;

    pc.createOffer()
        .then(offer => {
            console.log(`Создан offer для ${targetUser}`, offer);
            return pc.setLocalDescription(offer);
        })
        .then(() => {
            console.log(`Установлен local description для ${targetUser}`, pc.localDescription);
            // Отправляем offer пользователю targetUser
            socket.emit('offer', {
                offer: pc.localDescription,
                room: roomID,
                username: username,
                target: targetUser
            });
        })
        .catch(e => {
            console.error('Ошибка создания offer:', e, e.name, e.message);
            // В случае ошибки, сбрасываем флаг, чтобы можно было попробовать снова
            offerCreationInProgress[targetUser] = false;
        });
}
function sendOffer(targetUser) {
    console.log(`Отправляем offer для ${targetUser}`);
    const pc = peerConnections[targetUser];
    if (!pc) {
        console.error(`Соединение с ${targetUser} не найдено при попытке создать offer.`);
        return;
    }

    pc.createOffer()
        .then(offer => {
            console.log(`Создан offer для ${targetUser}`, offer);
            return pc.setLocalDescription(offer);
        })
        .then(() => {
            console.log(`Установлен local description для ${targetUser}`, pc.localDescription);
            // Отправляем offer пользователю targetUser
            socket.emit('offer', {
                offer: pc.localDescription,
                room: roomID,
                username: username,
                target: targetUser
            });
        })
        .catch(e => console.error('Ошибка создания offer:', e, e.name, e.message));
}

socket.on('offer', async (data) => {
    console.log('Получен offer от:', data.username, data);
    const senderUser = data.username;

    if (!peerConnections[senderUser]) {
        console.log(`Соединение с ${senderUser} не существует, создаём его при получении offer.`);
        createPeerConnection(senderUser);
    }

    const pc = peerConnections[senderUser];
    if (!pc) {
        console.error(`Не удалось создать/найти соединение с ${senderUser} для offer`);
        offerCreationInProgress[senderUser] = false; // Сбрасываем флаг, если соединения нет
        return;
    }

    try {
        await pc.setRemoteDescription(data.offer);
        console.log(`Установлен remote description для ${senderUser} (offer)`);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        console.log(`Отправляем answer пользователю ${senderUser}`);
        socket.emit('answer', {
            answer: answer,
            room: roomID,
            username: username,
            target: senderUser
        });

        // После установки remoteDescription, добавляем отложенные кандидаты
        const pendingCandidates = iceCandidateQueues[senderUser] || [];
        if (pendingCandidates.length > 0) {
            console.log(`Добавляем ${pendingCandidates.length} отложенных кандидатов для ${senderUser}`);
            for (const candidate of pendingCandidates) {
                await pc.addIceCandidate(candidate);
            }
            // Очищаем очередь
            iceCandidateQueues[senderUser] = [];
        }
    } catch (e) {
        console.error('Ошибка обработки offer:', e, e.name, e.message);
        // В случае ошибки, сбрасываем флаг offer, чтобы можно было попробовать снова
        offerCreationInProgress[senderUser] = false;
    }
});

socket.on('answer', async (data) => {
    console.log('Получен answer от:', data.username, data);
    const senderUser = data.username;
    const pc = peerConnections[senderUser];

    if (pc) {
        try {
            await pc.setRemoteDescription(data.answer);
            console.log(`Установлен remote description для ${senderUser} (answer)`);
            // После установки remoteDescription, добавляем отложенные кандидаты
            const pendingCandidates = iceCandidateQueues[senderUser] || [];
            if (pendingCandidates.length > 0) {
                console.log(`Добавляем ${pendingCandidates.length} отложенных кандидатов для ${senderUser}`);
                for (const candidate of pendingCandidates) {
                    await pc.addIceCandidate(candidate);
                }
                // Очищаем очередь
                iceCandidateQueues[senderUser] = [];
            }
        } catch (e) {
            console.error('Ошибка обработки answer:', e, e.name, e.message);
            // Сбрасываем флаг offer, если была ошибка при обработке ответа
            offerCreationInProgress[senderUser] = false;
        }
    } else {
        console.warn(`Соединение с ${senderUser} не найдено для ответа.`);
        // Сбрасываем флаг, если соединение исчезло
        offerCreationInProgress[senderUser] = false;
    }
});

socket.on('candidate', async (data) => {
    console.log('Получен candidate от:', data.username, data);
    const senderUser = data.username;
    const pc = peerConnections[senderUser];

    if (pc && data.candidate) {
        if (pc.remoteDescription) {
            try {
                await pc.addIceCandidate(data.candidate);
                console.log(`Добавлен ICE-кандидат от ${senderUser}`);
            } catch (e) {
                console.error('Ошибка добавления ICE-кандидата:', e, e.name, e.message);
            }
        } else {
            console.log(`remoteDescription для ${senderUser} ещё не установлен, добавляем кандидат в очередь`);
            iceCandidateQueues[senderUser]?.push(data.candidate);
        }
    } else {
        console.warn(`Соединение с ${senderUser} не найдено для candidate или candidate пуст.`, pc, data.candidate);
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
        // Отправляем сообщение в комнату
        socket.emit('message', { room: roomID, username, message: msg });
        // УБРАЛИ: addMessageToChat(username, msg);
        messageInput.value = ''; // Очищаем поле
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