'use strict';

const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT || 3000);
const SESSION_SECRET = process.env.SESSION_SECRET || 'local-development-only-change-this-secret-please';
const TEACHER_PASSWORD = process.env.TEACHER_PASSWORD || 'matherzat-demo-2026';
const hasSupabase = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
let supabase = null;
if (hasSupabase) {
  const { createClient } = require('@supabase/supabase-js');
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
} else if (process.env.NODE_ENV === 'production') {
  throw new Error('Production серверіне SUPABASE_URL және SUPABASE_SERVICE_ROLE_KEY қажет.');
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { serveClient: true, pingInterval: 25000, pingTimeout: 20000 });
const sessionStore = new session.MemoryStore();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      fontSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: null
    }
  }
}));
app.use(express.json({ limit: '300kb' }));
const sessionMiddleware = session({
  name: 'matherzat.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 8 * 60 * 60 * 1000
  }
});
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, 'public'), { etag: true, maxAge: '1h' }));

const memoryRooms = new Map();
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 12, standardHeaders: 'draft-8', legacyHeaders: false });
const joinLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false });

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function safeCode(value) { return typeof value === 'string' && /^[A-Z0-9]{6}$/.test(value); }
function createCode() {
  const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  let result = '';
  for (let i = 0; i < 6; i++) result += alphabet[crypto.randomInt(0, alphabet.length)];
  return result;
}
function cleanText(value, max = 500) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}
function validateQuestions(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    throw new HttpError(400, 'Тестте 1–100 сұрақ болуы керек.');
  }
  return value.map((q, i) => {
    const prompt = cleanText(q?.q, 1000);
    const options = Array.isArray(q?.o) ? q.o.map(v => cleanText(v, 300)) : [];
    const answer = Number(q?.a);
    const difficulty = ['easy', 'medium', 'hard'].includes(q?.d) ? q.d : 'medium';
    if (!prompt || options.length !== 4 || options.some(v => !v) || !Number.isInteger(answer) || answer < 0 || answer > 3) {
      throw new HttpError(400, `${i + 1}-сұрақтың мәтінін, төрт жауабын және дұрыс жауабын тексеріңіз.`);
    }
    return { q: prompt, o: options, a: answer, d: difficulty };
  });
}
function durationFor(question) {
  if (question?.d === 'easy') return 30;
  if (question?.d === 'hard') return 45;
  return 40;
}
async function loadRoom(code) {
  if (!safeCode(code)) return null;
  if (!supabase) return memoryRooms.get(code) || null;
  const { data, error } = await supabase.from('quiz_rooms').select('*').eq('code', code).maybeSingle();
  if (error) throw new Error(`Дерекқор қатесі: ${error.message}`);
  return data || null;
}
async function saveRoom(room) {
  room.updated_at = new Date().toISOString();
  if (!supabase) {
    memoryRooms.set(room.code, room);
    return;
  }
  const { error } = await supabase.from('quiz_rooms').upsert(room, { onConflict: 'code' });
  if (error) throw new Error(`Дерекқорға сақтау қатесі: ${error.message}`);
}
function scoreFor(room, player) {
  return (room.questions || []).reduce((sum, q, i) => sum + (player.answers?.[i] === q.a ? 1 : 0), 0);
}
function publicPlayers(room) {
  return (room.players || []).map(p => ({
    id: p.id,
    name: p.name,
    team: p.team || 0,
    score: scoreFor(room, p),
    answered: p.answers?.[room.current_index] !== undefined && p.answers?.[room.current_index] !== null
  }));
}
function makeState(room, req) {
  const role = req.session.role;
  const base = {
    role,
    room: {
      code: room.code, title: room.title, status: room.status,
      currentIndex: room.current_index,
      questionCount: room.questions.length,
      questionStartedAt: room.question_started_at,
      durationSeconds: room.duration_seconds,
      players: publicPlayers(room)
    }
  };
  if (role === 'teacher') {
    return { ...base, room: { ...base.room, questions: room.questions } };
  }
  const player = room.players.find(p => p.id === req.session.playerId);
  if (!player) throw new HttpError(401, 'Оқушы сессиясы табылмады. QR арқылы қайта кіріңіз.');
  const q = room.questions[room.current_index];
  const secondsElapsed = room.question_started_at ? (Date.now() - new Date(room.question_started_at).getTime()) / 1000 : Infinity;
  const canAnswer = room.status === 'running' && Boolean(q) && secondsElapsed < Number(room.duration_seconds || 0) &&
    (player.answers?.[room.current_index] === undefined || player.answers?.[room.current_index] === null);
  const currentQuestion = q ? {
    q: q.q, o: q.o, d: q.d,
    ...(room.status === 'finished' ? { correctIndex: q.a } : {})
  } : null;
  const review = room.status === 'finished' ? room.questions.map((item, index) => ({
    q: item.q, options: item.o, correctIndex: item.a,
    selectedIndex: player.answers?.[index] ?? null
  })) : [];
  return {
    ...base,
    room: { ...base.room, players: undefined },
    player: { name: player.name, team: player.team || 0, score: scoreFor(room, player), answer: player.answers?.[room.current_index] ?? null },
    currentQuestion,
    canAnswer,
    review
  };
}
function requireRole(role) {
  return (req, res, next) => req.session.role === role ? next() : next(new HttpError(401, 'Алдымен тиісті кабинетке кіріңіз.'));
}
async function requireTeacherRoom(req, res, next) {
  try {
    if (req.session.role !== 'teacher') throw new HttpError(401, 'Мұғалім кабинеті қажет.');
    const code = req.params.code;
    if (!safeCode(code) || req.session.roomCode !== code) throw new HttpError(403, 'Бұл тестті басқаруға рұқсатыңыз жоқ.');
    const room = await loadRoom(code);
    if (!room) throw new HttpError(404, 'Тест бөлмесі табылмады.');
    req.room = room;
    next();
  } catch (e) { next(e); }
}
function broadcastRoom(code) { io.to(`room:${code}`).emit('room:update'); }
function handleError(err, req, res, next) {
  if (res.headersSent) return next(err);
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Серверде қате пайда болды. Қайта көріңіз.' : err.message });
}

app.get('/health', (req, res) => res.json({ ok: true, database: supabase ? 'supabase' : 'memory-demo' }));
app.get('/api/session', async (req, res, next) => {
  try {
    if (!req.session.role) return res.json({ role: null });
    if (!req.session.roomCode) return res.json({ role: req.session.role });
    const room = await loadRoom(req.session.roomCode);
    if (!room) return res.json({ role: req.session.role, roomMissing: true });
    res.json(makeState(room, req));
  } catch (e) { next(e); }
});

app.post('/api/teacher/login', loginLimiter, (req, res, next) => {
  const supplied = String(req.body?.password || '');
  const expected = Buffer.from(TEACHER_PASSWORD);
  const actual = Buffer.from(supplied);
  const valid = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  if (!valid) return next(new HttpError(401, 'Құпиясөз қате.'));
  req.session.regenerate(err => {
    if (err) return next(err);
    req.session.role = 'teacher';
    req.session.save(saveErr => saveErr ? next(saveErr) : res.json({ ok: true, role: 'teacher' }));
  });
});
app.post('/api/student/join', joinLimiter, async (req, res, next) => {
  try {
    const code = cleanText(req.body?.code, 6).toUpperCase();
    const name = cleanText(req.body?.name, 60);
    if (!safeCode(code)) throw new HttpError(400, '6 таңбалы бөлме кодын енгізіңіз.');
    if (name.length < 2) throw new HttpError(400, 'Аты-жөніңізді толық енгізіңіз.');
    const room = await loadRoom(code);
    if (!room) throw new HttpError(404, 'Мұндай кодтағы тест табылмады.');
    if (room.status === 'finished') throw new HttpError(400, 'Бұл тест аяқталған.');
    const existing = (room.players || []).find(p => p.name.toLocaleLowerCase('kk') === name.toLocaleLowerCase('kk'));
    let player = existing;
    let resumeToken = null;
    if (existing) {
      const suppliedToken = String(req.body?.resumeToken || '');
      const suppliedHash = crypto.createHash('sha256').update(suppliedToken).digest('hex');
      const storedHash = String(existing.resumeHash || '');
      const tokenMatches = suppliedToken.length >= 32 && storedHash.length === suppliedHash.length &&
        crypto.timingSafeEqual(Buffer.from(suppliedHash), Buffer.from(storedHash));
      if (!tokenMatches) throw new HttpError(409, 'Бұл аты-жөнмен оқушы тіркелген. Бұрын қолданған құрылғыдан кіріңіз немесе аты-жөніңізді нақтылаңыз.');
    } else {
      const currentOne = (room.players || []).filter(p => p.team === 1).length;
      const currentTwo = (room.players || []).filter(p => p.team === 2).length;
      const assignedTeam = room.status === 'running' ? (currentOne <= currentTwo ? 1 : 2) : 0;
      resumeToken = crypto.randomBytes(32).toString('hex');
      const resumeHash = crypto.createHash('sha256').update(resumeToken).digest('hex');
      player = { id: crypto.randomUUID(), name, team: assignedTeam, answers: {}, resumeHash };
      room.players = [...(room.players || []), player];
      await saveRoom(room);
    }
    req.session.regenerate(err => {
      if (err) return next(err);
      req.session.role = 'student';
      req.session.roomCode = code;
      req.session.playerId = player.id;
      req.session.save(async saveErr => {
        if (saveErr) return next(saveErr);
        broadcastRoom(code);
        try {
          const fresh = await loadRoom(code);
          res.json({ ...makeState(fresh, req), ...(resumeToken ? { resumeToken } : {}) });
        } catch (readError) { next(readError); }
      });
    });
  } catch (e) { next(e); }
});

app.post('/api/teacher/rooms', requireRole('teacher'), async (req, res, next) => {
  try {
    const title = cleanText(req.body?.title, 100) || 'Математика тесті';
    const questions = validateQuestions(req.body?.questions);
    let code;
    let exists = true;
    for (let i = 0; i < 12 && exists; i++) {
      code = createCode();
      exists = Boolean(await loadRoom(code));
    }
    if (exists) throw new HttpError(503, 'Бөлме кодын жасау мүмкін болмады. Қайталап көріңіз.');
    const room = {
      code, title, status: 'lobby', questions, players: [], current_index: -1,
      question_started_at: null, duration_seconds: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    };
    await saveRoom(room);
    req.session.roomCode = code;
    req.session.save(err => {
      if (err) return next(err);
      res.json({ ok: true, code, title });
    });
  } catch (e) { next(e); }
});
app.put('/api/teacher/rooms/:code/questions', requireTeacherRoom, async (req, res, next) => {
  try {
    if (req.room.status !== 'lobby') throw new HttpError(409, 'Тест басталғаннан кейін сұрақтарды өзгертуге болмайды.');
    req.room.questions = validateQuestions(req.body?.questions);
    req.room.title = cleanText(req.body?.title, 100) || req.room.title;
    await saveRoom(req.room);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
app.post('/api/teacher/rooms/:code/teams', requireTeacherRoom, async (req, res, next) => {
  try {
    const shuffled = [...req.room.players].sort(() => Math.random() - 0.5);
    shuffled.forEach((p, i) => { p.team = i % 2 + 1; });
    await saveRoom(req.room);
    broadcastRoom(req.room.code);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
app.post('/api/teacher/rooms/:code/start', requireTeacherRoom, async (req, res, next) => {
  try {
    if (req.room.status !== 'lobby') throw new HttpError(409, 'Тест басталып кеткен немесе аяқталған.');
    if (!req.room.players.length) throw new HttpError(400, 'Алдымен кемінде бір оқушы қосылуы керек.');
    if (!req.room.questions.length) throw new HttpError(400, 'Тестте сұрақ жоқ.');
    if (req.room.players.some(p => !p.team)) {
      req.room.players.forEach((p, i) => { p.team = i % 2 + 1; });
    }
    req.room.status = 'running';
    req.room.current_index = 0;
    req.room.question_started_at = new Date().toISOString();
    req.room.duration_seconds = durationFor(req.room.questions[0]);
    await saveRoom(req.room);
    broadcastRoom(req.room.code);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
app.post('/api/teacher/rooms/:code/next', requireTeacherRoom, async (req, res, next) => {
  try {
    if (req.room.status !== 'running') throw new HttpError(409, 'Қазір белсенді тест жоқ.');
    // Мұғалім таймер біткенін күтпей келесі сұрақты аша алады.
    const nextIndex = req.room.current_index + 1;
    if (nextIndex >= req.room.questions.length) {
      req.room.status = 'finished';
      req.room.question_started_at = null;
      req.room.duration_seconds = null;
    } else {
      req.room.current_index = nextIndex;
      req.room.question_started_at = new Date().toISOString();
      req.room.duration_seconds = durationFor(req.room.questions[nextIndex]);
    }
    await saveRoom(req.room);
    broadcastRoom(req.room.code);
    res.json({ ok: true, finished: req.room.status === 'finished' });
  } catch (e) { next(e); }
});
app.post('/api/teacher/rooms/:code/finish', requireTeacherRoom, async (req, res, next) => {
  try {
    req.room.status = 'finished';
    req.room.question_started_at = null;
    req.room.duration_seconds = null;
    await saveRoom(req.room);
    broadcastRoom(req.room.code);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
app.get('/api/teacher/rooms/:code/qr', requireTeacherRoom, async (req, res, next) => {
  try {
    const base = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    const joinUrl = `${base}/?room=${req.room.code}`;
    const dataUrl = await QRCode.toDataURL(joinUrl, { width: 320, margin: 2, errorCorrectionLevel: 'M' });
    res.json({ dataUrl, joinUrl });
  } catch (e) { next(e); }
});
app.post('/api/student/answer', requireRole('student'), async (req, res, next) => {
  try {
    const room = await loadRoom(req.session.roomCode);
    if (!room) throw new HttpError(404, 'Тест бөлмесі табылмады.');
    if (room.status !== 'running') throw new HttpError(409, 'Қазір жауап қабылданбайды.');
    const player = room.players.find(p => p.id === req.session.playerId);
    if (!player) throw new HttpError(401, 'Оқушы табылмады. Қайта кіріңіз.');
    const index = room.current_index;
    const question = room.questions[index];
    const answer = Number(req.body?.answer);
    if (!Number.isInteger(answer) || answer < 0 || answer > 3) throw new HttpError(400, 'Жауап нұсқасын таңдаңыз.');
    if (player.answers?.[index] !== undefined && player.answers?.[index] !== null) throw new HttpError(409, 'Жауабыңыз қабылданып қойған.');
    const elapsed = (Date.now() - new Date(room.question_started_at).getTime()) / 1000;
    if (elapsed >= room.duration_seconds) throw new HttpError(410, 'Уақыт аяқталды. Бұл сұраққа 0 ұпай қойылады.');
    player.answers = player.answers || {};
    player.answers[index] = answer;
    await saveRoom(room);
    broadcastRoom(room.code);
    const updatedPlayer = room.players.find(p => p.id === player.id);
    res.json({ ok: true, score: scoreFor(room, updatedPlayer) });
  } catch (e) { next(e); }
});
app.post('/api/logout', (req, res, next) => {
  req.session.destroy(err => err ? next(err) : res.clearCookie('matherzat.sid').json({ ok: true }));
});

io.engine.use(sessionMiddleware);
io.on('connection', socket => {
  socket.on('watch-room', code => {
    if (!safeCode(code)) return;
    sessionStore.get(socket.request.sessionID, (err, sess) => {
      if (err || !sess || sess.roomCode !== code || !['teacher', 'student'].includes(sess.role)) return;
      socket.join(`room:${code}`);
    });
  });
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next(new HttpError(404, 'API жолы табылмады.'));
  if (req.method !== 'GET') return next(new HttpError(404, 'Жол табылмады.'));
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.use(handleError);

server.listen(PORT, () => {
  console.log(`MATHERZAT іске қосылды: http://localhost:${PORT}`);
  console.log(`Дерекқор: ${supabase ? 'Supabase' : 'жергілікті demo жады (сервер қайта қосылса, деректер өшеді)'}`);
  if (!process.env.TEACHER_PASSWORD) console.log('Демо мұғалім құпиясөзі: matherzat-demo-2026 (жариялағанда міндетті түрде өзгертіңіз)');
});
