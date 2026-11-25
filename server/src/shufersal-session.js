import fs from 'node:fs';
import path from 'node:path';

/** The adapter's saved cookie jar ({ cookies: [...] }), or null when it is missing or unreadable. */
export function readCookieJar(file) {
  try {
    const jar = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(jar?.cookies) && jar.cookies.length ? jar : null;
  } catch {
    return null;
  }
}

/** Writes the jar where the adapter reads it, atomically and readable by its owner only. */
export function writeCookieJar(file, jar) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(jar), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** The latest expiry among persistent cookies, as an ISO date, or null when all are session cookies. */
export function jarExpiry(jar) {
  const latest = Math.max(...(jar?.cookies ?? []).map((c) => (Number.isFinite(c.expires) && c.expires > 0 ? c.expires : 0)));
  return latest > 0 ? new Date(latest * 1000).toISOString() : null;
}
