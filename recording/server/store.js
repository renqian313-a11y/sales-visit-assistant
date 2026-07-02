// 数据存储：MVP 阶段先用本地文件，跑通后再换数据库/对象存储。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const AUDIO_DIR = path.join(DATA_DIR, 'audio');
const DB_FILE = path.join(DATA_DIR, 'records.json');

fs.mkdirSync(AUDIO_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, '{}');

function readAll() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return {}; }
}
function writeAll(obj) {
  fs.writeFileSync(DB_FILE, JSON.stringify(obj, null, 2));
}

export function createVisit({ customer_name, store_type, bd_user, consent }) {
  const all = readAll();
  const id = 'visit_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  all[id] = {
    id,
    bd_user: bd_user || '本次BD',
    customer_name: customer_name || '',
    store_type: store_type || '',
    start_time: new Date().toISOString(),
    end_time: null,
    consent: { given: !!consent, time: new Date().toISOString() },
    status: 'recording',
    audio_file: null,
    transcript: '',
    live_transcript: '',
    live_dialogue: [],
    dialogue: [],
    keywords_hit: [],
    summary: null,
    todos: [],
    scripts: [],
  };
  writeAll(all);
  return all[id];
}

export function getVisit(id) {
  return readAll()[id] || null;
}

export function updateVisit(id, patch) {
  const all = readAll();
  if (!all[id]) return null;
  all[id] = { ...all[id], ...patch };
  writeAll(all);
  return all[id];
}

export function listVisits() {
  return Object.values(readAll()).sort((a, b) => (b.start_time || '').localeCompare(a.start_time || ''));
}

export function saveAudio(id, buffer, ext) {
  const file = `${id}.${ext}`;
  fs.writeFileSync(path.join(AUDIO_DIR, file), buffer);
  return file;
}
