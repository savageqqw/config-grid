/**
 * PCForge — локальний сервер
 * Запуск: node server.js
 * Сайт відкриється на: http://localhost:3000
 */

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const PORT            = process.env.PORT || 3000;
const USERS_FILE      = path.join(__dirname, 'users.json');
const COMPONENTS_FILE = path.join(__dirname, 'components.json');

// ── УТИЛІТИ ───────────────────────────────────────────────────────────────────

function hashPassword(password) {
  return crypto.createHash('sha256').update(password + 'pcforge_salt').digest('hex');
}

function readUsers() {
  if (!fs.existsSync(USERS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
  catch { return []; }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}

function readComponents() {
  if (!fs.existsSync(COMPONENTS_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(COMPONENTS_FILE, 'utf8')); }
  catch { return {}; }
}

function saveComponents(data) {
  fs.writeFileSync(COMPONENTS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function sendJSON(res, status, data) {
  res.writeHead(status, {
    'Content-Type':                'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods':'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':'Content-Type',
  });
  res.end(JSON.stringify(data));
}

function serveStatic(req, res) {
  // Відрізаємо query string (?build=..., ?preset=... тощо)
  const urlPath = req.url.split('?')[0];
  let filePath = path.join(__dirname, urlPath === '/' ? 'shell.html' : urlPath);
  const extMap = {
    '.html':'text/html', '.css':'text/css', '.js':'application/javascript',
    '.json':'application/json', '.png':'image/png', '.jpg':'image/jpeg',
    '.ico':'image/x-icon', '.svg':'image/svg+xml',
  };
  const contentType = extMap[path.extname(filePath)] || 'text/plain';
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Не знайдено: ' + req.url); return; }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

function isAdmin(email) {
  const users = readUsers();
  const user  = users.find(u => u.email.toLowerCase() === (email || '').toLowerCase());
  return user?.isAdmin === true;
}

// ── AUTH ──────────────────────────────────────────────────────────────────────

async function handleRegister(req, res) {
  const { name, email, password } = await parseBody(req);
  if (!name || !email || !password)
    return sendJSON(res, 400, { ok: false, error: 'Заповніть усі поля' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return sendJSON(res, 400, { ok: false, error: 'Некоректний email' });
  if (password.length < 6)
    return sendJSON(res, 400, { ok: false, error: 'Пароль надто короткий (мін. 6 символів)' });

  const users = readUsers();
  if (users.find(u => u.email.toLowerCase() === email.toLowerCase()))
    return sendJSON(res, 409, { ok: false, error: 'Акаунт з таким email вже існує' });

  const newUser = {
    id: crypto.randomUUID(), name: name.trim(),
    email: email.trim().toLowerCase(), password: hashPassword(password),
    isAdmin: false, createdAt: new Date().toISOString(),
  };
  users.push(newUser);
  saveUsers(users);
  console.log(`  [+] Реєстрація: ${newUser.name} <${newUser.email}>`);
  sendJSON(res, 201, { ok: true, user: { id: newUser.id, name: newUser.name, email: newUser.email, isAdmin: false } });
}

async function handleLogin(req, res) {
  const { email, password } = await parseBody(req);
  if (!email || !password)
    return sendJSON(res, 400, { ok: false, error: 'Заповніть усі поля' });

  const users = readUsers();
  const user  = users.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (!user)
    return sendJSON(res, 404, { ok: false, error: 'Акаунт з таким email не знайдено' });
  if (user.password !== hashPassword(password))
    return sendJSON(res, 401, { ok: false, error: 'Невірний пароль' });

  console.log(`  [✓] Вхід: ${user.name} <${user.email}> ${user.isAdmin ? '👑 АДМІН' : ''}`);
  sendJSON(res, 200, { ok: true, user: { id: user.id, name: user.name, email: user.email, isAdmin: user.isAdmin === true } });
}

function handleUsersList(req, res) {
  const users = readUsers().map(u => ({ id: u.id, name: u.name, email: u.email, isAdmin: u.isAdmin || false, createdAt: u.createdAt }));
  sendJSON(res, 200, { ok: true, count: users.length, users });
}

// ── COMPONENTS CRUD ───────────────────────────────────────────────────────────

function handleGetComponents(req, res) {
  sendJSON(res, 200, readComponents());
}

async function handleAddComponent(req, res) {
  const { adminEmail, category, item } = await parseBody(req);
  if (!isAdmin(adminEmail))
    return sendJSON(res, 403, { ok: false, error: 'Доступ заборонено — потрібні права адміна' });
  if (!category || !item || !item.name)
    return sendJSON(res, 400, { ok: false, error: 'Вкажіть category та item.name' });

  const data = readComponents();
  if (!data[category])
    return sendJSON(res, 400, { ok: false, error: `Категорія "${category}" не знайдена` });

  const maxNum = data[category].items.reduce((m, it) => Math.max(m, parseInt(it.id.replace(/\D/g,'')) || 0), 0);
  item.id       = category.slice(0,2) + (maxNum + 1);
  item.category = category;
  item.cat      = category;
  // Ціна зберігається як є — підтримується '~2500' (приблизна) або 2500 (точна)

  data[category].items.push(item);
  saveComponents(data);
  console.log(`  [+] Додано: [${category}] ${item.name}`);
  sendJSON(res, 201, { ok: true, item });
}

async function handleUpdateComponent(req, res) {
  const { adminEmail, category, item } = await parseBody(req);
  if (!isAdmin(adminEmail))
    return sendJSON(res, 403, { ok: false, error: 'Доступ заборонено' });

  const data = readComponents();
  if (!data[category]) return sendJSON(res, 400, { ok: false, error: 'Категорія не знайдена' });
  const idx = data[category].items.findIndex(i => i.id === item.id);
  if (idx === -1) return sendJSON(res, 404, { ok: false, error: 'Компонент не знайдено' });

  data[category].items[idx] = { ...data[category].items[idx], ...item };
  saveComponents(data);
  console.log(`  [✎] Оновлено: [${category}] ${item.name}`);
  sendJSON(res, 200, { ok: true, item: data[category].items[idx] });
}

async function handleDeleteComponent(req, res) {
  const { adminEmail, category, id } = await parseBody(req);
  if (!isAdmin(adminEmail))
    return sendJSON(res, 403, { ok: false, error: 'Доступ заборонено' });

  const data = readComponents();
  if (!data[category]) return sendJSON(res, 400, { ok: false, error: 'Категорія не знайдена' });
  const before = data[category].items.length;
  data[category].items = data[category].items.filter(i => i.id !== id);
  if (data[category].items.length === before)
    return sendJSON(res, 404, { ok: false, error: 'Компонент не знайдено' });

  saveComponents(data);
  console.log(`  [✗] Видалено: [${category}] id=${id}`);
  sendJSON(res, 200, { ok: true });
}

// ── IMAGE UPLOAD ─────────────────────────────────────────────────────────────

const IMAGES_DIR = path.join(__dirname, 'images');
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR);

async function handleImageUpload(req, res) {
  const urlObj     = new URL(req.url, 'http://localhost');
  const adminEmail = urlObj.searchParams.get('adminEmail');
  if (!isAdmin(adminEmail))
    return sendJSON(res, 403, { ok: false, error: 'Доступ заборонено' });

  const ct = req.headers['content-type'] || '';
  if (!ct.includes('multipart/form-data'))
    return sendJSON(res, 400, { ok: false, error: 'Потрібен multipart/form-data' });

  // Читаємо тіло
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const buf = Buffer.concat(chunks);

  // Витягуємо boundary
  const boundaryMatch = ct.match(/boundary=([^\s;]+)/);
  if (!boundaryMatch) return sendJSON(res, 400, { ok: false, error: 'boundary не знайдено' });
  const boundary = Buffer.from('--' + boundaryMatch[1]);

  // Шукаємо частини
  let pos = 0;
  while (pos < buf.length) {
    const bPos = buf.indexOf(boundary, pos);
    if (bPos === -1) break;
    pos = bPos + boundary.length;

    // Пропускаємо CRLF після boundary
    if (buf[pos] === 0x0d && buf[pos+1] === 0x0a) pos += 2;
    else if (buf[pos] === 0x2d && buf[pos+1] === 0x2d) break; // --boundary--

    // Читаємо заголовки частини
    const headerEnd = buf.indexOf(Buffer.from('\r\n\r\n'), pos);
    if (headerEnd === -1) break;
    const header = buf.slice(pos, headerEnd).toString('utf8');
    pos = headerEnd + 4;

    if (!header.includes('filename=')) continue;

    // Дані до наступного boundary
    const nextBoundary = buf.indexOf(boundary, pos);
    const dataEnd = nextBoundary === -1 ? buf.length : nextBoundary - 2; // -2 для CRLF
    const fileData = buf.slice(pos, dataEnd);

    // Розширення
    const fnMatch = header.match(/filename="([^"]+)"/);
    if (!fnMatch) continue;
    const ext = path.extname(fnMatch[1]).toLowerCase();
    if (!['.jpg','.jpeg','.png','.webp','.gif'].includes(ext))
      return sendJSON(res, 400, { ok: false, error: 'Дозволені: jpg, png, webp, gif' });

    const fname = crypto.randomUUID() + ext;
    fs.writeFileSync(path.join(IMAGES_DIR, fname), fileData);
    const imgUrl = '/images/' + fname;
    console.log(`  [🖼] Збережено: ${imgUrl} (${fileData.length} байт)`);
    return sendJSON(res, 200, { ok: true, url: imgUrl });
  }

  sendJSON(res, 400, { ok: false, error: 'Файл не знайдено' });
}

// ── РОУТЕР ────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const { method, url } = req;

  if (method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers':'Content-Type' });
    return res.end();
  }

  if (url.startsWith('/api/upload') && method === 'POST') return handleImageUpload(req, res);
  if (url.startsWith('/images/')) {
    const imgPath = path.join(__dirname, 'images', path.basename(url.split('?')[0]));
    return fs.readFile(imgPath, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      const ext = path.extname(imgPath).toLowerCase();
      const mime = {'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.gif':'image/gif'};
      res.writeHead(200, { 'Content-Type': mime[ext]||'image/jpeg', 'Cache-Control':'public,max-age=31536000' });
      res.end(data);
    });
  }
  if (url === '/api/register'   && method === 'POST')   return handleRegister(req, res);
  if (url === '/api/login'      && method === 'POST')   return handleLogin(req, res);
  if (url === '/api/users'      && method === 'GET')    return handleUsersList(req, res);
  if (url === '/api/components' && method === 'GET')    return handleGetComponents(req, res);
  if (url === '/api/components' && method === 'POST')   return handleAddComponent(req, res);
  if (url === '/api/components' && method === 'PUT')    return handleUpdateComponent(req, res);
  if (url === '/api/components' && method === 'DELETE') return handleDeleteComponent(req, res);
  serveStatic(req, res);
});

// ── СТАРТ ─────────────────────────────────────────────────────────────────

function ensureComponentsJson() {
  if (fs.existsSync(COMPONENTS_FILE)) return;
  console.log('  [⚙] components.json не знайдено — генерую з components.js...');
  try {
    const src  = fs.readFileSync(path.join(__dirname, 'components.js'), 'utf8');
    const match = src.match(/window\.COMPONENTS_DATA\s*=\s*([\s\S]*?);\s*$/);
    if (!match) { console.error('  [✗] Не вдалося розпарсити components.js'); return; }
    const data = (new Function('return ' + match[1]))();
    fs.writeFileSync(COMPONENTS_FILE, JSON.stringify(data, null, 2), 'utf8');
    console.log('  [✓] components.json створено!');
  } catch(e) {
    console.error('  [✗] Помилка:', e.message);
  }
}
function ensureAdminExists() {
  const users = readUsers();
  if (users.find(u => u.isAdmin === true)) return;

  const admin = {
    id: crypto.randomUUID(), name: 'Admin',
    email: 'admin@pcforge.local', password: hashPassword('admin123'),
    isAdmin: true, createdAt: new Date().toISOString(),
  };
  users.unshift(admin);
  saveUsers(users);

  console.log('  ┌─────────────────────────────────────────┐');
  console.log('  │       СТВОРЕНО АКАУНТ АДМІНА            │');
  console.log('  │  Email  : admin@pcforge.local           │');
  console.log('  │  Пароль : admin123                      │');
  console.log('  │  Зміни пароль після першого входу!      │');
  console.log('  └─────────────────────────────────────────┘');
}

server.listen(PORT, '0.0.0.0', () => {
  const os = require('os');
  const nets = os.networkInterfaces();
  let localIp = null;
  for (const ifaces of Object.values(nets)) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) { localIp = iface.address; break; }
    }
    if (localIp) break;
  }

  console.log('\n  ╔══════════════════════════════════════════╗');
  console.log('  ║        ⚙  PCForge запущено!              ║');
  console.log('  ╠══════════════════════════════════════════╣');
  console.log(`  ║  💻 Локально :  http://localhost:${PORT}/shell.html  ║`);
  if (localIp) {
    const padded = `http://${localIp}:${PORT}/shell.html`.padEnd(34);
    console.log(`  ║  🌐 Мережа   :  ${padded}  ║`);
  }
  console.log('  ╠══════════════════════════════════════════╣');
  console.log('  ║  Ctrl+C — зупинити                       ║');
  console.log('  ╚══════════════════════════════════════════╝\n');

  ensureComponentsJson();
  ensureAdminExists();
});
