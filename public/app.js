'use strict';

const $ = id => document.getElementById(id);
let socket = null;
let currentRole = null;
let roomState = null;
let editorQuestions = [];
let lastEditorRoom = null;
let timerHandle = null;
let toastHandle = null;
let qrLoadedFor = null;

const sampleQuestions = [
  { q: 'Арифметикалық прогрессияның алғашқы мүшесі 3, айырмасы 2. 5-мүшесін табыңдар.', o: ['9', '10', '11', '12'], a: 2, d: 'easy' },
  { q: '2, 5, 8, 11, ... прогрессиясының айырмасы нешеге тең?', o: ['2', '3', '4', '5'], a: 1, d: 'medium' },
  { q: 'Алғашқы 6 натурал тақ санның қосындысын табыңдар.', o: ['30', '36', '42', '49'], a: 1, d: 'hard' }
];

async function api(url, options = {}) {
  const config = { method: options.method || 'GET', credentials: 'same-origin', headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) } };
  if (options.body) config.body = JSON.stringify(options.body);
  const response = await fetch(url, config);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Сұрау орындалмады (${response.status}).`);
  return data;
}
function notify(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastHandle);
  toastHandle = setTimeout(() => toast.classList.remove('show'), 3400);
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function setConnection(state, text) {
  const badge = $('connectionBadge');
  badge.className = `connection ${state}`;
  badge.lastChild.textContent = ` ${text}`;
}
function showView(view) {
  $('entryView').classList.toggle('hidden', view !== 'entry');
  $('teacherView').classList.toggle('hidden', view !== 'teacher');
  $('studentView').classList.toggle('hidden', view !== 'student');
}
function showRoleForm(role) {
  document.querySelectorAll('.role-tab').forEach(button => {
    const active = button.dataset.role === role;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  $('studentJoinForm').classList.toggle('hidden', role !== 'student');
  $('teacherLoginForm').classList.toggle('hidden', role !== 'teacher');
}
function activeRoomCode() { return roomState?.room?.code || null; }
function attachSocket() {
  if (typeof io !== 'function') {
    setConnection('offline', 'Live байланыс қолжетімсіз');
    return;
  }
  if (socket) socket.disconnect();
  socket = io({ transports: ['websocket', 'polling'] });
  socket.on('connect', () => {
    setConnection('online', 'Серверге қосылды');
    const code = activeRoomCode();
    if (code) socket.emit('watch-room', code);
  });
  socket.on('disconnect', () => setConnection('offline', 'Қайта қосылуда'));
  socket.on('connect_error', () => setConnection('offline', 'Байланыс үзіліп тұр'));
  socket.on('room:update', () => refreshState(true));
}
async function refreshState(quiet = false) {
  try {
    const state = await api('/api/session');
    if (!state.role) return;
    currentRole = state.role;
    roomState = state;
    if (state.role === 'teacher') {
      showView('teacher');
      renderTeacher(state);
    } else {
      showView('student');
      renderStudent(state);
    }
    const code = activeRoomCode();
    if (code && socket?.connected) socket.emit('watch-room', code);
  } catch (error) {
    if (!quiet) notify(error.message);
  }
}

function difficultyLabel(value) {
  return value === 'easy' ? 'Оңай · 30 сек' : value === 'hard' ? 'Қиын · 45 сек' : 'Орташа · 40 сек';
}
function renderEditor() {
  const root = $('questionEditor');
  $('questionCountBadge').textContent = `${editorQuestions.length} сұрақ`;
  root.innerHTML = '';
  editorQuestions.forEach((question, index) => {
    const card = document.createElement('div');
    card.className = 'question-item';
    card.innerHTML = `
      <div class="question-item-head"><strong>${index + 1}-СҰРАҚ</strong><button type="button" class="remove-question" data-remove="${index}">Өшіру</button></div>
      <label>Сұрақ мәтіні</label><textarea data-field="q" data-index="${index}" maxlength="1000" placeholder="Сұрақ мәтінін енгізіңіз">${escapeHtml(question.q)}</textarea>
      <div class="option-edit-grid">${question.o.map((option, optionIndex) => `<div><label>${'ABCD'[optionIndex]} нұсқасы</label><input data-option="${optionIndex}" data-index="${index}" maxlength="300" value="${escapeHtml(option)}" placeholder="Жауап нұсқасы"></div>`).join('')}</div>
      <div class="question-meta-edit">
        <div><label>Дұрыс жауап</label><select data-field="a" data-index="${index}">${question.o.map((_, optionIndex) => `<option value="${optionIndex}" ${question.a === optionIndex ? 'selected' : ''}>${'ABCD'[optionIndex]} нұсқасы</option>`).join('')}</select></div>
        <div><label>Қиындық деңгейі</label><select data-field="d" data-index="${index}"><option value="easy" ${question.d === 'easy' ? 'selected' : ''}>Оңай · 30 сек</option><option value="medium" ${question.d === 'medium' ? 'selected' : ''}>Орташа · 40 сек</option><option value="hard" ${question.d === 'hard' ? 'selected' : ''}>Қиын · 45 сек</option></select></div>
      </div>`;
    card.querySelectorAll('[data-field], [data-option]').forEach(input => input.addEventListener('input', () => {
      const qIndex = Number(input.dataset.index);
      if (input.dataset.option !== undefined) editorQuestions[qIndex].o[Number(input.dataset.option)] = input.value;
      else if (input.dataset.field === 'a' || input.dataset.field === 'a') editorQuestions[qIndex].a = Number(input.value);
      else editorQuestions[qIndex][input.dataset.field] = input.value;
      if (input.dataset.option !== undefined) {
        const select = card.querySelector('[data-field="a"]');
        const current = select.value;
        select.innerHTML = editorQuestions[qIndex].o.map((_, optionIndex) => `<option value="${optionIndex}" ${Number(current) === optionIndex ? 'selected' : ''}>${'ABCD'[optionIndex]} нұсқасы</option>`).join('');
      }
    }));
    card.querySelector('[data-remove]').addEventListener('click', () => {
      editorQuestions.splice(index, 1);
      renderEditor();
    });
    root.appendChild(card);
  });
}
function validateEditor() {
  if (!editorQuestions.length) throw new Error('Кемінде бір сұрақ қосыңыз.');
  editorQuestions.forEach((q, i) => {
    if (!q.q.trim() || q.o.length !== 4 || q.o.some(option => !String(option).trim())) {
      throw new Error(`${i + 1}-сұрақтың мәтіні мен төрт жауап нұсқасын толтырыңыз.`);
    }
    if (!Number.isInteger(Number(q.a)) || q.a < 0 || q.a > 3) throw new Error(`${i + 1}-сұрақтың дұрыс жауабын таңдаңыз.`);
  });
}
function renderTeacher(state) {
  const room = state.room;
  if (room?.questions && (lastEditorRoom !== room.code || !editorQuestions.length)) {
    editorQuestions = room.questions.map(q => ({ ...q, o: [...q.o] }));
    lastEditorRoom = room.code;
    $('testTitleInput').value = room.title;
    renderEditor();
  }
  if (!room) {
    $('noRoomNotice').classList.remove('hidden');
    $('roomActivePanel').classList.add('hidden');
    $('teacherLivePanel').classList.add('hidden');
    $('teacherResults').classList.add('hidden');
    $('createRoomBtn').classList.remove('hidden');
    $('saveQuestionsBtn').classList.add('hidden');
    $('roomStatusBadge').textContent = 'Әлі ашылған жоқ';
    $('roomStatusBadge').className = 'status-badge';
    $('addQuestionBtn').disabled = false;
    return;
  }

  $('noRoomNotice').classList.add('hidden');
  $('roomActivePanel').classList.remove('hidden');
  $('roomCodeText').textContent = room.code;
  $('createRoomBtn').classList.toggle('hidden', room.status !== 'finished');
  $('createRoomBtn').textContent = room.status === 'finished' ? 'Жаңа тест бөлмесін ашу' : 'Тест бөлмесін ашу';
  $('saveQuestionsBtn').classList.toggle('hidden', room.status !== 'lobby');
  $('addQuestionBtn').disabled = room.status !== 'lobby';
  $('testTitleInput').disabled = room.status !== 'lobby';
  $('questionEditor').querySelectorAll('input,textarea,select,button').forEach(el => { el.disabled = room.status !== 'lobby'; });

  const badge = $('roomStatusBadge');
  badge.textContent = room.status === 'lobby' ? 'Оқушыларды күтуде' : room.status === 'running' ? 'Тест жүріп жатыр' : 'Тест аяқталды';
  badge.className = `status-badge ${room.status}`;
  const players = room.players || [];
  $('participantCount').textContent = players.length;
  $('teamOneCount').textContent = players.filter(p => p.team === 1).length;
  $('teamTwoCount').textContent = players.filter(p => p.team === 2).length;
  $('participantHint').textContent = players.length ? `${players.length} оқушы қосылды` : 'Оқушыларды күтіңіз';
  $('participantList').innerHTML = players.length ? players.map(p => `<div class="participant-row"><span>${escapeHtml(p.name)}</span><span class="team-tag ${p.team === 1 ? 'one' : p.team === 2 ? 'two' : ''}">${p.team === 1 ? '🔵 1-топ' : p.team === 2 ? '🟢 2-топ' : 'Топ бөлінбеген'}</span></div>`).join('') : '<p class="muted">Әзірге оқушы қосылған жоқ.</p>';

  $('randomizeTeamsBtn').classList.toggle('hidden', room.status !== 'lobby' || players.length < 1);
  $('startQuizBtn').classList.toggle('hidden', room.status !== 'lobby');
  $('startQuizBtn').disabled = players.length === 0;
  $('nextQuestionBtn').classList.toggle('hidden', room.status !== 'running');
  $('finishQuizBtn').classList.toggle('hidden', room.status !== 'running');
  $('startQuizBtn').textContent = 'START · Бастау';
  $('nextQuestionBtn').textContent = room.currentIndex >= room.questionCount - 1 ? 'Соңғы сұрақты аяқтау →' : 'Келесі сұрақ →';

  if (room.status === 'lobby') {
    $('teacherLivePanel').classList.add('hidden');
    $('teacherResults').classList.add('hidden');
  } else if (room.status === 'running') {
    $('teacherLivePanel').classList.remove('hidden');
    $('teacherResults').classList.add('hidden');
    const question = room.questions[room.currentIndex];
    if (question) {
      $('liveQuestionLabel').textContent = `${room.currentIndex + 1}-сұрақ / ${room.questionCount}`;
      $('teacherQuestionText').textContent = question.q;
      $('teacherAnswerOptions').innerHTML = question.o.map((option, index) => `<div class="teacher-option ${index === question.a ? 'correct' : ''}">${'ABCD'[index]}. ${escapeHtml(option)}${index === question.a ? ' ✓' : ''}</div>`).join('');
      const answered = players.filter(p => p.answered).length;
      $('answeredCountText').textContent = `Жауап бергендер: ${answered} / ${players.length}. Таймер бітпей-ақ келесі сұрақты аша аласыз.`;
      $('questionProgress').style.width = `${((room.currentIndex + 1) / room.questionCount) * 100}%`;
      updateTimer(room.questionStartedAt, room.durationSeconds, $('teacherTimer'));
    }
  } else {
    $('teacherLivePanel').classList.add('hidden');
    $('teacherResults').classList.remove('hidden');
    renderResults(room);
  }
  if (room.code !== qrLoadedFor) loadQr(room.code);
}
async function loadQr(code) {
  try {
    const data = await api(`/api/teacher/rooms/${code}/qr`);
    if (activeRoomCode() !== code) return;
    $('qrImageWrap').innerHTML = `<img alt="Оқушыларға арналған MATHERZAT QR коды" src="${data.dataUrl}">`;
    $('joinLink').href = data.joinUrl;
    qrLoadedFor = code;
  } catch (error) { notify(error.message); }
}
function renderResults(room) {
  const players = [...(room.players || [])].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'kk'));
  const one = players.filter(p => p.team === 1);
  const two = players.filter(p => p.team === 2);
  const average = group => group.length ? (group.reduce((total, p) => total + p.score, 0) / group.length).toFixed(2) : '0.00';
  const avgOne = Number(average(one));
  const avgTwo = Number(average(two));
  $('teamOneAverage').textContent = average(one);
  $('teamTwoAverage').textContent = average(two);
  $('winningTeam').textContent = !one.length || !two.length ? '—' : avgOne > avgTwo ? '🔵 1-топ' : avgTwo > avgOne ? '🟢 2-топ' : 'Тең нәтиже';
  $('rankingBody').innerHTML = players.length ? players.map((p, index) => `<tr><td>${index + 1}</td><td><strong>${escapeHtml(p.name)}</strong></td><td>${p.team === 1 ? '🔵 1-топ' : p.team === 2 ? '🟢 2-топ' : '—'}</td><td><strong>${p.score} / ${room.questionCount}</strong></td><td>${room.questionCount ? Math.round(p.score / room.questionCount * 100) : 0}%</td></tr>`).join('') : '<tr><td colspan="5">Оқушы нәтижесі жоқ.</td></tr>';
}
function updateTimer(startAt, duration, element) {
  clearInterval(timerHandle);
  if (!startAt || !duration) { element.textContent = '00:00'; return; }
  const update = () => {
    const remaining = Math.max(0, Math.ceil(duration - (Date.now() - new Date(startAt).getTime()) / 1000));
    element.textContent = `00:${String(remaining).padStart(2, '0')}`;
    if (remaining <= 0) clearInterval(timerHandle);
  };
  update();
  timerHandle = setInterval(update, 250);
}

function renderStudent(state) {
  const room = state.room;
  const player = state.player;
  $('studentTestTitle').textContent = room.title;
  $('studentGreeting').textContent = `${player.name} · ${player.team === 1 ? '🔵 1-топ' : player.team === 2 ? '🟢 2-топ' : 'Тестке қосылдыңыз'}`;
  $('studentScore').textContent = player.score;
  $('studentProgressBar').style.width = `${room.questionCount ? Math.max(0, (room.currentIndex + 1) / room.questionCount * 100) : 0}%`;
  $('studentWaiting').classList.toggle('hidden', room.status !== 'lobby');
  $('studentQuestionPanel').classList.toggle('hidden', room.status !== 'running');
  $('studentFinished').classList.toggle('hidden', room.status !== 'finished');
  if (room.status === 'lobby') {
    clearInterval(timerHandle);
    $('studentWaiting').querySelector('h2').textContent = 'Мұғалімді күтіңіз';
    $('studentWaiting').querySelector('p').textContent = 'Тест басталған кезде сұрақ осы жерде автоматты түрде пайда болады.';
    return;
  }
  if (room.status === 'finished') {
    clearInterval(timerHandle);
    $('studentFinalText').textContent = `${player.name}, сіз ${player.score} / ${room.questionCount} ұпай жинадыңыз.`;
    $('studentReview').innerHTML = (state.review || []).map((item, index) => {
      const correct = item.selectedIndex === item.correctIndex;
      const selected = item.selectedIndex === null ? 'Жауап берілмеді' : `${'ABCD'[item.selectedIndex]}. ${escapeHtml(item.options[item.selectedIndex])}`;
      const right = `${'ABCD'[item.correctIndex]}. ${escapeHtml(item.options[item.correctIndex])}`;
      return `<div class="review-item"><strong>${index + 1}. ${escapeHtml(item.q)}</strong><div class="${correct ? 'good' : 'bad'}">Сіздің жауабыңыз: ${selected}</div><div class="good">Дұрыс жауап: ${right}</div></div>`;
    }).join('');
    return;
  }
  const question = state.currentQuestion;
  if (!question) return;
  $('studentQuestionNumber').textContent = `${room.currentIndex + 1} / ${room.questionCount}`;
  $('studentDifficulty').textContent = question.d === 'easy' ? 'Оңай' : question.d === 'hard' ? 'Қиын' : 'Орташа';
  $('studentQuestionText').textContent = question.q;
  const selectedAnswer = player.answer;
  $('studentOptions').innerHTML = question.o.map((option, index) => `<button type="button" class="answer-option ${selectedAnswer === index ? 'selected' : ''}" data-answer="${index}" ${!state.canAnswer ? 'disabled' : ''}><span>${'ABCD'[index]}.</span> ${escapeHtml(option)}</button>`).join('');
  const message = $('studentAnswerMessage');
  if (selectedAnswer !== null) {
    message.textContent = 'Жауабыңыз қабылданды. Келесі сұрақты күтіңіз.';
    message.className = 'answer-message success';
  } else if (!state.canAnswer) {
    message.textContent = 'Уақыт аяқталды. Бұл сұраққа 0 ұпай қойылады.';
    message.className = 'answer-message warning';
  } else {
    message.textContent = 'Бір дұрыс жауапты таңдаңыз. Жауап бір рет қана қабылданады.';
    message.className = 'answer-message';
  }
  $('studentOptions').querySelectorAll('[data-answer]').forEach(button => button.addEventListener('click', () => submitAnswer(Number(button.dataset.answer))));
  updateStudentTimer(room.questionStartedAt, room.durationSeconds, state.canAnswer, selectedAnswer);
}
function updateStudentTimer(startAt, duration, canAnswer, selectedAnswer) {
  clearInterval(timerHandle);
  const update = () => {
    const remaining = Math.max(0, Math.ceil(duration - (Date.now() - new Date(startAt).getTime()) / 1000));
    $('studentTimer').textContent = `00:${String(remaining).padStart(2, '0')}`;
    if (remaining <= 0) {
      clearInterval(timerHandle);
      if (selectedAnswer === null) {
        $('studentOptions').querySelectorAll('button').forEach(button => { button.disabled = true; });
        $('studentAnswerMessage').textContent = 'Уақыт аяқталды. Бұл сұраққа 0 ұпай қойылады.';
        $('studentAnswerMessage').className = 'answer-message warning';
      }
    }
  };
  update();
  if (canAnswer && selectedAnswer === null) timerHandle = setInterval(update, 250);
}
async function submitAnswer(answer) {
  $('studentOptions').querySelectorAll('button').forEach(button => { button.disabled = true; });
  try {
    await api('/api/student/answer', { method: 'POST', body: { answer } });
    await refreshState(true);
  } catch (error) {
    notify(error.message);
    await refreshState(true);
  }
}

// Role choice and login forms
document.querySelectorAll('.role-tab').forEach(button => button.addEventListener('click', () => showRoleForm(button.dataset.role)));
$('studentJoinForm').addEventListener('submit', async event => {
  event.preventDefault();
  const submit = event.submitter;
  submit.disabled = true;
  try {
    const code = $('roomCodeInput').value.trim().toUpperCase();
    const resumeToken = localStorage.getItem(`matherzat.resume.${code}`) || '';
    const state = await api('/api/student/join', { method: 'POST', body: { code, name: $('studentNameInput').value.trim(), resumeToken } });
    if (state.resumeToken) localStorage.setItem(`matherzat.resume.${code}`, state.resumeToken);
    currentRole = 'student'; roomState = state; showView('student'); renderStudent(state);
    if (socket?.connected) socket.emit('watch-room', state.room.code);
  } catch (error) { notify(error.message); }
  finally { submit.disabled = false; }
});
$('teacherLoginForm').addEventListener('submit', async event => {
  event.preventDefault();
  const submit = event.submitter; submit.disabled = true;
  try {
    await api('/api/teacher/login', { method: 'POST', body: { password: $('teacherPassword').value } });
    $('teacherPassword').value = '';
    currentRole = 'teacher';
    editorQuestions = sampleQuestions.map(q => ({ ...q, o: [...q.o] }));
    lastEditorRoom = null;
    showView('teacher'); renderEditor();
    await refreshState(true);
  } catch (error) { notify(error.message); }
  finally { submit.disabled = false; }
});

// Teacher question editor and room controls
$('addQuestionBtn').addEventListener('click', () => {
  editorQuestions.push({ q: '', o: ['', '', '', ''], a: 0, d: 'easy' });
  renderEditor();
});
$('createRoomBtn').addEventListener('click', async () => {
  try {
    validateEditor();
    const result = await api('/api/teacher/rooms', { method: 'POST', body: { title: $('testTitleInput').value.trim() || 'Математика тесті', questions: editorQuestions } });
    lastEditorRoom = null;
    await refreshState(true);
    if (socket?.connected) socket.emit('watch-room', result.code);
    notify(`Тест бөлмесі ашылды. Код: ${result.code}`);
  } catch (error) { notify(error.message); }
});
$('saveQuestionsBtn').addEventListener('click', async () => {
  const code = activeRoomCode(); if (!code) return;
  try {
    validateEditor();
    await api(`/api/teacher/rooms/${code}/questions`, { method: 'PUT', body: { title: $('testTitleInput').value.trim(), questions: editorQuestions } });
    notify('Тест сұрақтары сақталды.');
    await refreshState(true);
  } catch (error) { notify(error.message); }
});
$('randomizeTeamsBtn').addEventListener('click', async () => {
  const code = activeRoomCode(); if (!code) return;
  try { await api(`/api/teacher/rooms/${code}/teams`, { method: 'POST' }); await refreshState(true); notify('Оқушылар екі топқа бөлінді.'); }
  catch (error) { notify(error.message); }
});
$('startQuizBtn').addEventListener('click', async () => {
  const code = activeRoomCode(); if (!code) return;
  try { await api(`/api/teacher/rooms/${code}/start`, { method: 'POST' }); await refreshState(true); notify('Тест басталды!'); }
  catch (error) { notify(error.message); }
});
$('nextQuestionBtn').addEventListener('click', async () => {
  const code = activeRoomCode(); if (!code) return;
  try { const result = await api(`/api/teacher/rooms/${code}/next`, { method: 'POST' }); await refreshState(true); if (result.finished) notify('Тест аяқталды. Нәтижелер дайын.'); }
  catch (error) { notify(error.message); }
});
$('finishQuizBtn').addEventListener('click', async () => {
  const code = activeRoomCode(); if (!code) return;
  if (!confirm('Тестті қазір аяқтайсыз ба?')) return;
  try { await api(`/api/teacher/rooms/${code}/finish`, { method: 'POST' }); await refreshState(true); notify('Тест аяқталды.'); }
  catch (error) { notify(error.message); }
});
$('copyCodeBtn').addEventListener('click', async () => {
  const code = activeRoomCode(); if (!code) return;
  try { await navigator.clipboard.writeText(code); notify('Бөлме коды көшірілді.'); }
  catch { notify(`Бөлме коды: ${code}`); }
});
$('teacherLogout').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST' }); } catch {}
  currentRole = null; roomState = null; lastEditorRoom = null; qrLoadedFor = null; showView('entry'); showRoleForm('student'); notify('Мұғалім кабинетінен шықтыңыз.');
});

// Prefill the room code from a QR link and restore an existing session.
const initialRoomCode = new URLSearchParams(location.search).get('room');
if (initialRoomCode) $('roomCodeInput').value = initialRoomCode.toUpperCase();
attachSocket();
(async function init() {
  try {
    const state = await api('/api/session');
    if (state.role) {
      currentRole = state.role; roomState = state;
      if (state.role === 'teacher') {
        editorQuestions = state.room?.questions?.map(q => ({ ...q, o: [...q.o] })) || sampleQuestions.map(q => ({ ...q, o: [...q.o] }));
        showView('teacher'); renderEditor(); renderTeacher(state);
      } else {
        showView('student'); renderStudent(state);
      }
      if (state.room?.code && socket?.connected) socket.emit('watch-room', state.room.code);
    } else {
      showView('entry'); showRoleForm(initialRoomCode ? 'student' : 'student');
    }
  } catch (error) { showView('entry'); notify(error.message); }
})();
// Polling is a fallback if a school network blocks WebSocket connections.
setInterval(() => { if (currentRole) refreshState(true); }, 4000);
