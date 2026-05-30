/* ================================================================
   PCForge — pcforge-store.js
   Глобальний стан та утиліти для Vue 3 CDN
   Ціни зберігаються в гривнях (₴) напряму.
   ================================================================ */

const API = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
  ? 'http://localhost:3000/api'
  : '/api';

// ── УТИЛІТИ ───────────────────────────────────────────────────────────────────

/** Парсить ціну — підтримує число або рядок "~2500" */
function parsePrice(val) {
  if (val === null || val === undefined || val === '') return 0;
  const s = String(val).replace(/\s/g, '');
  const approx = s.startsWith('~');
  const num = parseFloat(s.replace('~', '')) || 0;
  return { num, approx };
}

/** Форматує ціну в гривнях. Якщо ціна рядок "~2500" — показує "~2 500 ₴" */
function fmt(val) {
  const { num, approx } = parsePrice(val);
  return (approx ? '~' : '') + Math.round(num).toLocaleString('uk-UA') + '\u00a0₴';
}

/** Числове значення ціни для розрахунків */
function priceNum(val) { return parsePrice(val).num; }

const TIER_COLORS = { ultra: '#ff4444', high: '#ff8c00', mid: '#00d4ff', budget: '#22c55e' };
const TIER_UA     = { ultra: 'Ультра', high: 'High-End', mid: 'Mid-Range', budget: 'Budget' };
const STEPS       = ['cpu', 'gpu', 'ram', 'motherboard', 'storage', 'psu', 'case', 'cooling'];

// ── ГЛОБАЛЬНИЙ СТОР (Vue.reactive) ───────────────────────────────────────────
const PCForgeStore = Vue.reactive({
  // Компоненти
  CD: {},
  cdLoaded: false,

  // Синхронізація цін
  syncStatus: null,   // null | 'syncing' | 'done' | 'error'
  syncTime: null,     // час останньої синхронізації
  syncResults: null,  // { updated, failed, total }

  // Авторизація
  get user() { try { return JSON.parse(localStorage.getItem('pcforge_user') || 'null'); } catch { return null; } },
  saveUser(u) { localStorage.setItem('pcforge_user', JSON.stringify(u)); },
  clearUser() { localStorage.removeItem('pcforge_user'); },

  // Збережені збірки
  get builds() { try { return JSON.parse(localStorage.getItem('pcforge_builds') || '[]'); } catch { return []; } },
  saveBuild(b) {
    const all = this.builds; all.unshift(b);
    localStorage.setItem('pcforge_builds', JSON.stringify(all.slice(0, 30)));
  },
  deleteBuild(id) {
    localStorage.setItem('pcforge_builds', JSON.stringify(this.builds.filter(b => b.id !== id)));
  },

  // Конфігуратор selected
  get selected() { try { return JSON.parse(localStorage.getItem('pcforge_sel') || 'null') || defaultSel(); } catch { return defaultSel(); } },
  saveSelected(sel) { localStorage.setItem('pcforge_sel', JSON.stringify(sel)); },
  clearSelected() { localStorage.removeItem('pcforge_sel'); },
});

function defaultSel() {
  return { cpu: null, gpu: null, ram: null, motherboard: null, storage: null, psu: null, case: null, cooling: null };
}

// ── ЗАВАНТАЖЕННЯ КОМПОНЕНТІВ ──────────────────────────────────────────────────
async function loadComponents() {
  // Спочатку синхронно з components.js (миттєво)
  if (window.COMPONENTS_DATA) {
    PCForgeStore.CD = window.COMPONENTS_DATA;
    Object.entries(PCForgeStore.CD).forEach(([cat, c]) => {
      if (c && Array.isArray(c.items)) c.items.forEach(i => { i.cat = cat; });
    });
    PCForgeStore.cdLoaded = true;
  }
  // Потім оновлюємо з сервера (актуальні дані з components.json)
  try {
    const res = await fetch(API + '/components', { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const data = await res.json();
      PCForgeStore.CD = data;
      Object.entries(PCForgeStore.CD).forEach(([cat, c]) => {
        if (c && Array.isArray(c.items)) c.items.forEach(i => { i.cat = cat; });
      });
      PCForgeStore.cdLoaded = true;
    }
  } catch { /* сервер недоступний — залишаємо дані з components.js */ }
}

// ── СИНХРОНІЗАЦІЯ ЦІН З ROZETKA ──────────────────────────────────────────────
async function syncPrices(adminEmail) {
  PCForgeStore.syncStatus = 'syncing';
  try {
    const res = await fetch(API + '/sync-prices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminEmail }),
      signal: AbortSignal.timeout(120000), // 2 хвилини
    });
    const data = await res.json();
    if (data.ok) {
      PCForgeStore.syncStatus = 'done';
      PCForgeStore.syncTime = Date.now();
      PCForgeStore.syncResults = data.results;
      // Перезавантажуємо компоненти з оновленими цінами
      await loadComponents();
    } else {
      PCForgeStore.syncStatus = 'error';
    }
    return data;
  } catch (e) {
    PCForgeStore.syncStatus = 'error';
    return { ok: false, error: e.message };
  }
}

// ── СУМІСНІСТЬ ────────────────────────────────────────────────────────────────
function findComp(cat, id) { return PCForgeStore.CD[cat]?.items?.find(i => i.id === id); }

function calcPrice(sel) {
  return Object.entries(sel).reduce((s, [cat, id]) => s + (id ? priceNum(findComp(cat, id)?.price) : 0), 0);
}

function calcPerf(sel) {
  const cpu = findComp('cpu', sel.cpu);
  const gpu = findComp('gpu', sel.gpu);
  if (!cpu && !gpu) return 0;
  return Math.round((cpu?.perf || 0) * 0.35 + (gpu?.perf || 0) * 0.65);
}

function checkCompat(sel) {
  const errs = [], warns = [];
  const cpu = findComp('cpu', sel.cpu);
  const mb  = findComp('motherboard', sel.motherboard);
  const psu = findComp('psu', sel.psu);
  const gpu = findComp('gpu', sel.gpu);
  if (cpu && mb && cpu.socket !== mb.socket)
    errs.push(`Сокет CPU (${cpu.socket}) не сумісний з MB (${mb.socket})`);
  if (psu && cpu && gpu) {
    const need = cpu.tdp + gpu.tdp + 100;
    if (psu.wattage < need)           errs.push(`БЖ ${psu.wattage}W замало — потрібно ~${need}W`);
    else if (psu.wattage < need * 1.2) warns.push(`Рекомендується запас: ~${Math.ceil(need * 1.2 / 50) * 50}W`);
  }
  return { errs, warns };
}

function getSpecsFull(item, cat) {
  const row = (k, v) => v !== undefined && v !== null && v !== '' ? { k, v: String(v) } : null;
  const specs = {
    cpu:         [row('Ядра / Потоки', item.cores && item.threads ? `${item.cores} / ${item.threads}` : null), row('Boost Clock', item.boost), row('TDP', item.tdp ? item.tdp + 'W' : null), row('Сокет', item.socket), row('Архітектура', item.arch), row('Кеш L3', item.cache)],
    gpu:         [row('VRAM', item.vram), row('Шина', item.bus), row('TDP', item.tdp ? item.tdp + 'W' : null), row('Частота', item.clock), row('API', item.api)],
    ram:         [row('Тип', item.ram_type), row("Об'єм", item.capacity), row('Частота', item.speed), row('Таймінги', item.cl), row('Напруга', item.voltage)],
    motherboard: [row('Сокет', item.socket), row('Чіпсет', item.chipset), row('Тип RAM', item.ram_type), row('Слоти RAM', item.ramSlots), row('M.2', item.m2Slots)],
    storage:     [row('Інтерфейс', item.type), row("Об'єм", item.capacity), row('Читання', item.read), row('Запис', item.write), row('TBW', item.tbw)],
    psu:         [row('Потужність', item.wattage ? item.wattage + 'W' : null), row('Сертифікат', item.rating), row('Модульність', item.modular)],
    case:        [row('Форм-фактор', item.formFactor), row('МБ підтримка', item.mbSupport), row('Радіатор', item.radiator)],
    cooling:     [row('Тип', item.type), row('Сокети', item.sockets), row('Max TDP', item.tdpSupport ? item.tdpSupport + 'W' : null), row('Шум', item.noise)],
  };
  return (specs[cat] || []).filter(Boolean);
}
