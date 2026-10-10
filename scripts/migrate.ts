import { initDb, closeDb } from '../src/server/db';

try { await initDb(); console.log('OpenTutor 数据库已初始化'); }
finally { await closeDb(); }
