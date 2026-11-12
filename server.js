const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const STATIC_ROOT = path.join(ROOT, 'site');
const PROJECT_ID = process.env.MANUS_PROJECT_ID;
const OAUTH_PORTAL_URL = process.env.MANUS_OAUTH_PORTAL_URL;
const OAUTH_API_URL = process.env.MANUS_OAUTH_API_URL;
const JWT_SECRET = process.env.MANUS_JWT_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;
const SESSION_COOKIE = 'webdev_app_session';
const OAUTH_NONCE_COOKIE = 'voxelcraft_oauth_nonce';
const SESSION_SECONDS = 60 * 60 * 24 * 30;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

if (!DATABASE_URL) throw new Error('DATABASE_URL is required.');
if (!PROJECT_ID || !OAUTH_PORTAL_URL || !OAUTH_API_URL || !JWT_SECRET) {
    throw new Error('Manus OAuth environment is incomplete.');
}

function databaseOptions(urlString) {
    const url = new URL(urlString);
    return {
        host: url.hostname,
        port: url.port ? Number(url.port) : 3306,
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        database: decodeURIComponent(url.pathname.replace(/^\//, '')),
        ssl: { rejectUnauthorized: false },
        waitForConnections: true,
        connectionLimit: 8,
        maxIdle: 8,
        idleTimeout: 60000,
        enableKeepAlive: true
    };
}

const pool = mysql.createPool(databaseOptions(DATABASE_URL));

async function ensureSchema() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS voxelcraft_users (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            open_id VARCHAR(191) NOT NULL UNIQUE,
            email VARCHAR(320) NULL,
            display_name VARCHAR(191) NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS voxelcraft_worlds (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            user_id BIGINT UNSIGNED NOT NULL,
            world_id VARCHAR(96) NOT NULL,
            world_name VARCHAR(191) NOT NULL,
            payload LONGTEXT NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY voxelcraft_world_owner_key (user_id, world_id),
            CONSTRAINT voxelcraft_world_user_fk FOREIGN KEY (user_id) REFERENCES voxelcraft_users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
}

function base64UrlJson(value) {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function parseBase64UrlJson(value) {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

function randomToken(bytes = 24) {
    return crypto.randomBytes(bytes).toString('base64url');
}

function parseCookies(request) {
    const result = {};
    for (const item of String(request.headers.cookie || '').split(';')) {
        const separator = item.indexOf('=');
        if (separator === -1) continue;
        result[item.slice(0, separator).trim()] = decodeURIComponent(item.slice(separator + 1).trim());
    }
    return result;
}

function cookie(name, value, options = {}) {
    const parts = [`${name}=${encodeURIComponent(value)}`];
    if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
    parts.push(`Path=${options.path || '/'}`);
    if (options.httpOnly !== false) parts.push('HttpOnly');
    parts.push(`SameSite=${options.sameSite || 'None'}`);
    if (options.secure !== false) parts.push('Secure');
    return parts.join('; ');
}

function clearCookie(name) {
    return cookie(name, '', { maxAge: 0 });
}

function appendCookie(response, value) {
    const current = response.getHeader('Set-Cookie');
    response.setHeader('Set-Cookie', current ? (Array.isArray(current) ? [...current, value] : [current, value]) : [value]);
}

function requestOrigin(request) {
    const forwardedProto = String(request.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
    const forwardedHost = String(request.headers['x-forwarded-host'] || request.headers.host || '').split(',')[0].trim();
    return `${forwardedProto}://${forwardedHost}`;
}

function callbackUrl(request) {
    return `${requestOrigin(request)}/api/auth/callback`;
}

function hmac(value) {
    return crypto.createHmac('sha256', JWT_SECRET).update(value).digest('base64url');
}

function signJwt(payload) {
    const header = base64UrlJson({ alg: 'HS256', typ: 'JWT' });
    const body = base64UrlJson(payload);
    return `${header}.${body}.${hmac(`${header}.${body}`)}`;
}

function verifyJwt(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    try {
        const expected = hmac(`${parts[0]}.${parts[1]}`);
        const actual = parts[2];
        const expectedBuffer = Buffer.from(expected);
        const actualBuffer = Buffer.from(actual);
        if (expectedBuffer.length !== actualBuffer.length || !crypto.timingSafeEqual(expectedBuffer, actualBuffer)) return null;
        const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        if (header.alg !== 'HS256') return null;
        if (payload.exp && Number(payload.exp) < Math.floor(Date.now() / 1000)) return null;
        if (payload.appId && payload.appId !== PROJECT_ID) return null;
        if (payload.app_id && payload.app_id !== PROJECT_ID) return null;
        const openId = payload.openId || payload.open_id || payload.sub;
        if (!openId) return null;
        return { ...payload, openId: String(openId) };
    } catch {
        return null;
    }
}

function sendJson(response, statusCode, body) {
    const text = JSON.stringify(body);
    response.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(text)
    });
    response.end(text);
}

function sendError(response, statusCode, message) {
    sendJson(response, statusCode, { error: message });
}

function redirect(response, location) {
    response.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
    response.end();
}

function readBody(request) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        request.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new Error('Request body is too large.'));
                request.destroy();
                return;
            }
            chunks.push(chunk);
        });
        request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        request.on('error', reject);
    });
}

async function readJson(request) {
    const text = await readBody(request);
    if (!text) return {};
    try { return JSON.parse(text); }
    catch { throw new Error('Request body must be valid JSON.'); }
}

async function upsertUser(identity) {
    const openId = String(identity.openId || '').slice(0, 191);
    if (!openId) throw new Error('The OAuth identity did not include an openId.');
    const displayName = String(identity.name || identity.displayName || identity.email || 'Voxelcraft Player').slice(0, 191);
    const email = identity.email ? String(identity.email).slice(0, 320) : null;
    await pool.query(
        `INSERT INTO voxelcraft_users (open_id, email, display_name) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE email = VALUES(email), display_name = VALUES(display_name)`,
        [openId, email, displayName]
    );
    const [rows] = await pool.query('SELECT id, open_id, email, display_name, created_at FROM voxelcraft_users WHERE open_id = ?', [openId]);
    return rows[0];
}

async function currentUser(request) {
    const token = parseCookies(request)[SESSION_COOKIE];
    const claims = verifyJwt(token);
    if (!claims) return null;
    const user = await upsertUser({ openId: claims.openId, name: claims.name, email: claims.email });
    return { id: Number(user.id), openId: user.open_id, email: user.email, name: user.display_name, createdAt: user.created_at };
}

function publicUser(user) {
    return user ? { openId: user.openId, email: user.email, name: user.name, createdAt: user.createdAt } : null;
}

async function exchangeOAuthCode(code, redirectUri) {
    const exchange = await fetch(`${OAUTH_API_URL}/webdev.v1.WebDevAuthPublicService/ExchangeToken`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: PROJECT_ID, grantType: 'authorization_code', code, redirectUri })
    });
    if (!exchange.ok) throw new Error(`OAuth token exchange failed (${exchange.status}).`);
    const token = await exchange.json();
    if (!token.accessToken) throw new Error('OAuth token exchange returned no access token.');
    const info = await fetch(`${OAUTH_API_URL}/webdev.v1.WebDevAuthPublicService/GetUserInfo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken: token.accessToken })
    });
    if (!info.ok) throw new Error(`OAuth identity lookup failed (${info.status}).`);
    return info.json();
}

function validateWorldId(value) {
    const worldId = String(value || '');
    if (!/^[A-Za-z0-9_-]{1,96}$/.test(worldId)) throw new Error('Invalid world ID.');
    return worldId;
}

function parseWorldPayload(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('World data must be an object.');
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new Error('World data is too large.');
    return { value, text };
}

async function listWorlds(userId) {
    const [rows] = await pool.query('SELECT world_id, world_name, payload, updated_at FROM voxelcraft_worlds WHERE user_id = ? ORDER BY updated_at DESC', [userId]);
    return rows.map(row => {
        let data = {};
        try { data = JSON.parse(row.payload); } catch { data = {}; }
        return { id: row.world_id, name: row.world_name, data, updatedAt: row.updated_at };
    });
}

async function saveWorld(userId, worldId, name, data) {
    const safeId = validateWorldId(worldId);
    const parsed = parseWorldPayload(data);
    const safeName = String(name || data.settings?.name || 'Voxelcraft World').trim().slice(0, 191) || 'Voxelcraft World';
    await pool.query(
        `INSERT INTO voxelcraft_worlds (user_id, world_id, world_name, payload) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE world_name = VALUES(world_name), payload = VALUES(payload)`,
        [userId, safeId, safeName, parsed.text]
    );
}

async function handleApi(request, response, url) {
    if (url.pathname === '/api/health' && request.method === 'GET') {
        sendJson(response, 200, { ok: true, service: 'voxelcraft' });
        return true;
    }
    if (url.pathname === '/api/auth/me' && request.method === 'GET') {
        const user = await currentUser(request);
        sendJson(response, 200, { authenticated: Boolean(user), user: publicUser(user), cloudSave: Boolean(user) });
        return true;
    }
    if (url.pathname === '/api/auth/start' && request.method === 'GET') {
        const mode = url.searchParams.get('mode') === 'signup' ? 'signup' : 'signin';
        const nonce = randomToken(18);
        const redirectUri = callbackUrl(request);
        const state = base64UrlJson({ nonce, mode, redirectUri });
        appendCookie(response, cookie(OAUTH_NONCE_COOKIE, nonce, { maxAge: 600 }));
        const loginUrl = new URL('/app-auth', OAUTH_PORTAL_URL);
        loginUrl.searchParams.set('appId', PROJECT_ID);
        loginUrl.searchParams.set('redirectUri', redirectUri);
        loginUrl.searchParams.set('state', state);
        loginUrl.searchParams.set('responseType', 'code');
        redirect(response, loginUrl.toString());
        return true;
    }
    if (url.pathname === '/api/auth/callback' && request.method === 'GET') {
        const state = parseBase64UrlJson(url.searchParams.get('state') || '');
        const nonce = parseCookies(request)[OAUTH_NONCE_COOKIE];
        const redirectUri = callbackUrl(request);
        if (!state.nonce || !nonce || state.nonce !== nonce || state.redirectUri !== redirectUri) {
            sendError(response, 400, 'The sign-in request expired or was invalid. Please try again.');
            return true;
        }
        const code = url.searchParams.get('code');
        if (!code) {
            sendError(response, 400, 'The sign-in provider did not return an authorization code.');
            return true;
        }
        const identity = await exchangeOAuthCode(code, redirectUri);
        const user = await upsertUser(identity);
        const now = Math.floor(Date.now() / 1000);
        const session = signJwt({ appId: PROJECT_ID, openId: user.open_id, sub: user.open_id, name: user.display_name, email: user.email, iat: now, exp: now + SESSION_SECONDS });
        appendCookie(response, cookie(SESSION_COOKIE, session, { maxAge: SESSION_SECONDS }));
        appendCookie(response, clearCookie(OAUTH_NONCE_COOKIE));
        redirect(response, '/');
        return true;
    }
    if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
        appendCookie(response, clearCookie(SESSION_COOKIE));
        sendJson(response, 200, { ok: true });
        return true;
    }

    const worldMatch = url.pathname.match(/^\/api\/worlds\/([^/]+)$/);
    const user = await currentUser(request);
    if (url.pathname === '/api/worlds' && request.method === 'GET') {
        if (!user) { sendError(response, 401, 'Sign in is required.'); return true; }
        sendJson(response, 200, { worlds: await listWorlds(user.id) });
        return true;
    }
    if (url.pathname === '/api/worlds/migrate' && request.method === 'POST') {
        if (!user) { sendError(response, 401, 'Sign in is required.'); return true; }
        const body = await readJson(request);
        if (!Array.isArray(body.worlds) || body.worlds.length > 32) throw new Error('Invalid migration payload.');
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();
            for (const world of body.worlds) {
                const worldId = validateWorldId(world.id);
                const parsed = parseWorldPayload(world.data || {});
                const name = String(world.name || world.data?.settings?.name || 'Voxelcraft World').trim().slice(0, 191) || 'Voxelcraft World';
                await connection.query(
                    `INSERT INTO voxelcraft_worlds (user_id, world_id, world_name, payload) VALUES (?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE world_name = VALUES(world_name), payload = VALUES(payload)`,
                    [user.id, worldId, name, parsed.text]
                );
            }
            await connection.commit();
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally { connection.release(); }
        sendJson(response, 200, { worlds: await listWorlds(user.id) });
        return true;
    }
    if (worldMatch && request.method === 'PUT') {
        if (!user) { sendError(response, 401, 'Sign in is required.'); return true; }
        const body = await readJson(request);
        await saveWorld(user.id, decodeURIComponent(worldMatch[1]), body.name, body.data);
        sendJson(response, 200, { ok: true });
        return true;
    }
    if (worldMatch && request.method === 'DELETE') {
        if (!user) { sendError(response, 401, 'Sign in is required.'); return true; }
        const worldId = validateWorldId(decodeURIComponent(worldMatch[1]));
        await pool.query('DELETE FROM voxelcraft_worlds WHERE user_id = ? AND world_id = ?', [user.id, worldId]);
        sendJson(response, 200, { ok: true, worlds: await listWorlds(user.id) });
        return true;
    }
    return false;
}

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

function serveStatic(request, response, url) {
    let relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    if (relative.includes('\0') || relative.includes('..')) { sendError(response, 400, 'Invalid path.'); return; }
    const filePath = path.resolve(STATIC_ROOT, `.${relative}`);
    if (!filePath.startsWith(`${STATIC_ROOT}${path.sep}`)) { sendError(response, 400, 'Invalid path.'); return; }
    fs.stat(filePath, (statError, stat) => {
        if (statError || !stat.isFile()) { sendError(response, 404, 'Not found.'); return; }
        const type = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
        const headers = { 'Content-Type': type };
        if (path.extname(filePath).toLowerCase() === '.html') headers['Cache-Control'] = 'no-store, max-age=0';
        else headers['Cache-Control'] = 'public, max-age=86400';
        response.writeHead(200, headers);
        fs.createReadStream(filePath).pipe(response);
    });
}

const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    try {
        if (url.pathname.startsWith('/api/')) {
            if (await handleApi(request, response, url)) return;
            sendError(response, 404, 'API route not found.');
            return;
        }
        serveStatic(request, response, url);
    } catch (error) {
        console.error(error);
        if (!response.headersSent) sendError(response, 500, error.message || 'Server error.');
        else response.destroy();
    }
});

ensureSchema()
    .then(() => server.listen(PORT, '0.0.0.0', () => console.log(`Voxelcraft server listening on ${PORT}`)))
    .catch(error => { console.error('Database initialization failed:', error); process.exit(1); });

process.on('SIGTERM', async () => { await pool.end(); process.exit(0); });
process.on('SIGINT', async () => { await pool.end(); process.exit(0); });
