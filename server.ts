/**
 * Spotify Web Server
 * Proxies YouTube Music InnerTube API, LRCLIB synced lyrics, SponsorBlock,
 * direct audio streaming (/api/stream) for background playback,
 * and mounts Vite development middleware or static production dist.
 */

import express from 'express';
import type { Request as Req, Response as Res } from 'express';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import dotenv from 'dotenv';

const execFileAsync = promisify(execFile);

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

/* ---------------- Playback Access Lock & Admin Codes (Supabase + Signed Fallback) ---------------- */
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || 'admin1234').trim();
const USING_DEFAULT_ADMIN_PW = !process.env.ADMIN_PASSWORD;
const TOKEN_SECRET = (
  process.env.ACCESS_TOKEN_SECRET ||
  crypto.createHash('sha256').update(`spotify-access:${ADMIN_PASSWORD}`).digest('hex')
).trim();
const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const HAS_SUPABASE = Boolean(SUPABASE_URL && SUPABASE_KEY);

interface AccessCodeRecord {
  code: string;
  label: string;
  max_uses: number;
  uses: number;
  active: boolean;
  expires_at: string | null;
  created_at: string;
  last_active_at?: string | null;
  bound_device?: string | null;
  kind?: 'supabase' | 'signed' | 'memory';
}

const localCodeStore = new Map<string, AccessCodeRecord>();
const usedSignedDeviceMap = new Map<string, string>();
const revokedLocalCodes = new Set<string>();
const codeActiveCache = new Map<
  string,
  { ok: boolean; expiresAt: number; uses: number; maxUses: number; deviceId: string | null }
>();

function safeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function hmacSign(data: string, len = 24): string {
  return crypto.createHmac('sha256', TOKEN_SECRET).update(data).digest('hex').slice(0, len).toUpperCase();
}

const SESSION_AES_KEY = crypto.createHash('sha256').update(`session-aes:${TOKEN_SECRET}`).digest();

function createServerEcdh() {
  const ecdh = crypto.createECDH('prime256v1');
  for (let i = 0; i < 16; i++) {
    const priv = crypto.createHmac('sha256', TOKEN_SECRET).update(`ecdh-p256-v1:${i}`).digest();
    try {
      ecdh.setPrivateKey(priv);
      return ecdh;
    } catch {}
  }
  ecdh.generateKeys();
  return ecdh;
}
const SERVER_ECDH = createServerEcdh();
const SERVER_ECDH_PUB_B64U = SERVER_ECDH.getPublicKey(null, 'uncompressed').toString('base64url');

function signSessionPayload(payload: Record<string, any>): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', SESSION_AES_KEY, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v2.${iv.toString('base64url')}.${tag.toString('base64url')}.${enc.toString('base64url')}`;
}

function verifySessionToken(token: string): Record<string, any> | null {
  if (!token || typeof token !== 'string') return null;
  if (token.startsWith('v2.')) {
    const parts = token.split('.');
    if (parts.length !== 4) return null;
    try {
      const iv = Buffer.from(parts[1], 'base64url');
      const tag = Buffer.from(parts[2], 'base64url');
      const enc = Buffer.from(parts[3], 'base64url');
      if (iv.length !== 12 || tag.length !== 16) return null;
      const decipher = crypto.createDecipheriv('aes-256-gcm', SESSION_AES_KEY, iv);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
      const obj = JSON.parse(plain);
      if (!obj || typeof obj !== 'object') return null;
      if (typeof obj.exp === 'number' && obj.exp > 0 && Date.now() > obj.exp) return null;
      return obj;
    } catch {
      return null;
    }
  }
  // Legacy v1 fallback
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const b64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!b64 || !sig) return null;
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(b64).digest('base64url').slice(0, 32);
  if (!safeEqualStr(sig, expected)) return null;
  try {
    const obj = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
    if (!obj || typeof obj !== 'object') return null;
    if (typeof obj.exp === 'number' && obj.exp > 0 && Date.now() > obj.exp) return null;
    return obj;
  } catch {
    return null;
  }
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

function extractAccessToken(req: Req, explicitToken = ''): string {
  if (explicitToken && typeof explicitToken === 'string') return explicitToken.trim();
  const q = typeof req.query.token === 'string' ? req.query.token.trim() : '';
  if (q) return q;
  const h = req.headers['x-access-token'];
  if (typeof h === 'string' && h.trim()) return h.trim();
  const cookies = parseCookies(req.headers.cookie);
  return cookies.sm_access || '';
}

function setAccessCookie(res: Res, token: string | null, maxAgeSec = 90 * 24 * 3600) {
  const isHttps = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1';
  const attrs = [
    `sm_access=${token ? encodeURIComponent(token) : ''}`,
    'Path=/',
    'HttpOnly',
    isHttps ? 'SameSite=None' : 'SameSite=Lax',
    isHttps ? 'Secure' : '',
    token ? `Max-Age=${maxAgeSec}` : 'Max-Age=0',
  ].filter(Boolean);
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function setNoStore(res: Res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
}

function generateSignedCode(expiresAtMs: number | null): string {
  const expPart = expiresAtMs ? Math.floor(expiresAtMs / 60000).toString(36).toUpperCase() : '0';
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let nonce = '';
  const rnd = crypto.randomBytes(4);
  for (let i = 0; i < 4; i++) nonce += chars[rnd[i] % chars.length];
  const sig = hmacSign(`${expPart}:${nonce}`, 8);
  return `SP1-${expPart}-${nonce}-${sig}`;
}

function verifySignedCode(rawCode: string): { valid: boolean; expiresAtMs: number | null; reason?: string } {
  const clean = rawCode.trim().toUpperCase();
  const m = clean.match(/^SP1-([0-9A-Z]+)-([0-9A-Z]{4})-([0-9A-F]{8})$/);
  if (!m) return { valid: false, expiresAtMs: null, reason: 'format' };
  const [, expPart, nonce, sig] = m;
  const expected = hmacSign(`${expPart}:${nonce}`, 8);
  if (!safeEqualStr(sig, expected)) return { valid: false, expiresAtMs: null, reason: 'Kode tidak valid' };
  if (expPart === '0') return { valid: true, expiresAtMs: null };
  const expMin = parseInt(expPart, 36);
  if (!Number.isFinite(expMin) || expMin <= 0) return { valid: false, expiresAtMs: null, reason: 'Kode tidak valid' };
  const expiresAtMs = expMin * 60000;
  if (Date.now() > expiresAtMs) return { valid: false, expiresAtMs, reason: 'Kode sudah kedaluwarsa' };
  return { valid: true, expiresAtMs };
}

function randomCodeString(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const rnd = crypto.randomBytes(6);
  let body = '';
  for (let i = 0; i < 6; i++) body += chars[rnd[i] % chars.length];
  return `SP-${body}`;
}

async function sbFetch(tablePath: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    apikey: SUPABASE_KEY,
    ...(SUPABASE_KEY.startsWith('eyJ') ? { Authorization: `Bearer ${SUPABASE_KEY}` } : {}),
    'Content-Type': 'application/json',
    ...((init.headers as Record<string, string>) || {}),
  };
  return fetchTimeout(`${SUPABASE_URL}/rest/v1/${tablePath}`, { ...init, headers }, 6000);
}

async function isCodeActiveInSupabase(code: string, reqDid = ''): Promise<boolean> {
  if (!HAS_SUPABASE || !code) return true;
  const hit = codeActiveCache.get(code);
  if (hit && hit.expiresAt > Date.now()) {
    if (!hit.ok) return false;
    if (hit.uses <= 0) return false;
    if (hit.maxUses === 1 && hit.deviceId && reqDid && hit.deviceId !== reqDid) return false;
    return true;
  }
  try {
    const r = await sbFetch(`access_codes?code=eq.${encodeURIComponent(code)}&select=*`);
    if (!r.ok) return true; // avoid breaking playback on transient DB hiccup
    const rows: any = await r.json();
    const row = Array.isArray(rows) ? rows[0] : null;
    let ok = false;
    const uses = Number(row?.uses) || 0;
    const maxUses = Number(row?.max_uses) || 0;
    const deviceId = row?.device_id ? String(row.device_id) : null;
    if (row && row.active) {
      ok = !row.expires_at || Date.now() <= new Date(row.expires_at).getTime();
    }
    codeActiveCache.set(code, { ok, expiresAt: Date.now() + 15_000, uses, maxUses, deviceId });
    if (!ok || uses <= 0) return false;
    if (maxUses === 1 && deviceId && reqDid && deviceId !== reqDid) return false;
    return true;
  } catch {
    return true;
  }
}

async function releaseCodeSlot(code: string, reqDid = ''): Promise<void> {
  if (!code || code === 'ADMIN') return;
  codeActiveCache.delete(code);
  if (HAS_SUPABASE) {
    try {
      const r = await sbFetch(`access_codes?code=eq.${encodeURIComponent(code)}&select=*`);
      if (!r.ok) return;
      const rows: any = await r.json();
      const row = Array.isArray(rows) ? rows[0] : null;
      if (!row) return;
      const nextUses = Math.max(0, (Number(row.uses) || 0) - 1);
      const patchBody: Record<string, any> = { uses: nextUses };
      if ('device_id' in row && (row.device_id === reqDid || nextUses === 0)) {
        patchBody.device_id = null;
      }
      await sbFetch(`access_codes?code=eq.${encodeURIComponent(code)}`, {
        method: 'PATCH',
        body: JSON.stringify(patchBody),
      });
    } catch {}
    return;
  }
  const mem = localCodeStore.get(code);
  if (mem) {
    mem.uses = Math.max(0, (mem.uses || 0) - 1);
    if (mem.bound_device === reqDid || mem.uses === 0) mem.bound_device = null;
  }
  const prevDid = usedSignedDeviceMap.get(code);
  if (prevDid && (!reqDid || prevDid === reqDid)) {
    usedSignedDeviceMap.delete(code);
  }
}

async function getValidAccessPayload(req: Req, explicitToken = '', explicitDid = ''): Promise<Record<string, any> | null> {
  const token = extractAccessToken(req, explicitToken);
  const payload = verifySessionToken(token);
  if (!payload || (payload.role !== 'listener' && payload.role !== 'admin_listener')) return null;
  const headerDid = typeof req.headers['x-device-id'] === 'string' ? req.headers['x-device-id'].trim() : '';
  const queryDid = typeof req.query.did === 'string' ? req.query.did.trim() : '';
  const reqDid = explicitDid.trim() || headerDid || queryDid;
  if (payload.did && (!reqDid || !safeEqualStr(String(payload.did), reqDid))) {
    return null;
  }
  if (payload.role === 'admin_listener') return payload;
  const code = String(payload.code || '');
  if (HAS_SUPABASE && code) {
    const ok = await isCodeActiveInSupabase(code, reqDid);
    if (!ok) return null;
  } else if (code) {
    if (revokedLocalCodes.has(code)) return null;
    const mem = localCodeStore.get(code);
    if (mem && !mem.active) return null;
    if (mem && mem.max_uses > 0 && mem.uses <= 0) return null;
    if (mem && mem.bound_device && reqDid && mem.bound_device !== reqDid) return null;
  }
  return payload;
}

async function requirePlaybackAccess(req: Req, res: Res): Promise<boolean> {
  const payload = await getValidAccessPayload(req);
  if (payload) return true;
  res.status(401).json({ error: 'locked', message: 'Masukkan kode akses untuk memutar lagu' });
  return false;
}

function checkAdminToken(token: string): boolean {
  const payload = verifySessionToken(token);
  return Boolean(payload && payload.role === 'admin');
}

function requireAdminAuth(req: Req, res: Res): boolean {
  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!checkAdminToken(token)) {
    res.status(401).json({ error: 'Unauthorized admin' });
    return false;
  }
  return true;
}

async function opAccessStatus(req: Req, explicitToken = '', explicitDid = '') {
  const payload = await getValidAccessPayload(req, explicitToken, explicitDid);
  if (!payload) {
    return {
      status: 200,
      body: {
        unlocked: false,
        lockEnabled: true,
        storage: HAS_SUPABASE ? 'supabase' : 'signed',
      },
    };
  }
  if (payload && payload.code && payload.code !== 'ADMIN') {
    const code = String(payload.code);
    const nowIso = new Date().toISOString();
    if (HAS_SUPABASE) {
      sbFetch(`access_codes?code=eq.${encodeURIComponent(code)}`, {
        method: 'PATCH',
        body: JSON.stringify({ last_active_at: nowIso }),
      }).catch(() => {});
    } else {
      const mem = localCodeStore.get(code);
      if (mem) mem.last_active_at = nowIso;
    }
  }
  return {
    status: 200,
    body: {
      unlocked: true,
      lockEnabled: true,
      label: payload.label || 'Akses Aktif',
      code: payload.code || '',
      expiresAt: payload.exp || null,
      storage: HAS_SUPABASE ? 'supabase' : 'signed',
    },
  };
}

async function opAccessVerify(res: Res, codeInput: string, didInput: string) {
  try {
    const rawCode = String(codeInput || '').trim().toUpperCase();
    const rawDid = String(didInput || '').trim().slice(0, 64);
    const deviceId = rawDid || crypto.randomBytes(12).toString('hex');
    if (!rawCode || rawCode.length < 3) {
      return { status: 400, body: { error: 'Masukkan kode akses terlebih dahulu.' } };
    }

    let label = 'Akses Premium';
    let codeExpMs: number | null = null;

    if (HAS_SUPABASE) {
      const r = await sbFetch(`access_codes?code=eq.${encodeURIComponent(rawCode)}&select=*`);
      if (!r.ok) {
        return { status: 502, body: { error: 'Gagal memeriksa database kode akses. Cek koneksi Supabase.' } };
      }
      const rows: any = await r.json();
      const row = Array.isArray(rows) ? rows[0] : null;
      if (!row) {
        return { status: 403, body: { error: 'Kode akses tidak ditemukan. Minta kode valid ke Admin.' } };
      }
      if (!row.active) {
        return { status: 403, body: { error: 'Kode akses ini sudah dinonaktifkan oleh Admin.' } };
      }
      if (row.expires_at) {
        codeExpMs = new Date(row.expires_at).getTime();
        if (Number.isFinite(codeExpMs) && Date.now() > codeExpMs) {
          return { status: 403, body: { error: 'Kode akses ini sudah kedaluwarsa.' } };
        }
      }
      const maxUses = Number(row.max_uses) || 0;
      const uses = Number(row.uses) || 0;
      const sameBoundDevice =
        maxUses === 1 &&
        uses >= 1 &&
        'device_id' in row &&
        row.device_id &&
        rawDid &&
        row.device_id === rawDid;

      if (!sameBoundDevice) {
        if (maxUses > 0 && uses >= maxUses) {
          return {
            status: 403,
            body: {
              error:
                maxUses === 1
                  ? 'Kode ini dibatasi 1 perangkat dan sudah digunakan di perangkat lain.'
                  : 'Batas pemakaian kode ini sudah habis.',
            },
          };
        }

        const patchBody: Record<string, any> = { uses: uses + 1 };
        if ('device_id' in row && !row.device_id && deviceId) patchBody.device_id = deviceId;
        const patchRes = await sbFetch(
          `access_codes?code=eq.${encodeURIComponent(rawCode)}${maxUses > 0 ? `&uses=lt.${maxUses}` : ''}`,
          {
            method: 'PATCH',
            headers: { Prefer: 'return=representation' },
            body: JSON.stringify(patchBody),
          }
        );
        if (!patchRes.ok) {
          return { status: 502, body: { error: 'Gagal memperbarui status kode akses.' } };
        }
        const updated: any = await patchRes.json().catch(() => []);
        if (maxUses > 0 && (!Array.isArray(updated) || !updated.length)) {
          return {
            status: 403,
            body: {
              error:
                maxUses === 1
                  ? 'Kode ini dibatasi 1 perangkat dan sudah digunakan di perangkat lain.'
                  : 'Batas pemakaian kode ini sudah habis.',
            },
          };
        }
      }
      label = row.label || 'Akses Aktif';
      codeActiveCache.delete(rawCode);
    } else {
      const mem = localCodeStore.get(rawCode);
      if (mem) {
        if (!mem.active) {
          return { status: 403, body: { error: 'Kode akses ini sudah dinonaktifkan oleh Admin.' } };
        }
        if (mem.expires_at && Date.now() > new Date(mem.expires_at).getTime()) {
          return { status: 403, body: { error: 'Kode akses ini sudah kedaluwarsa.' } };
        }
        const sameBoundDevice =
          mem.max_uses === 1 && mem.uses >= 1 && mem.bound_device && rawDid && mem.bound_device === rawDid;
        if (!sameBoundDevice) {
          if (mem.max_uses > 0 && mem.uses >= mem.max_uses) {
            return {
              status: 403,
              body: {
                error:
                  mem.max_uses === 1
                    ? 'Kode ini dibatasi 1 perangkat dan sudah digunakan di perangkat lain.'
                    : 'Batas pemakaian kode ini sudah habis.',
              },
            };
          }
          mem.uses += 1;
          if (!mem.bound_device && deviceId) mem.bound_device = deviceId;
        }
        label = mem.label || 'Akses Aktif';
        codeExpMs = mem.expires_at ? new Date(mem.expires_at).getTime() : null;
      } else {
        if (revokedLocalCodes.has(rawCode)) {
          return { status: 403, body: { error: 'Kode akses ini sudah dihapus atau dinonaktifkan Admin.' } };
        }
        const signed = verifySignedCode(rawCode);
        if (!signed.valid) {
          return {
            status: 403,
            body: { error: signed.reason && signed.reason !== 'format' ? signed.reason : 'Kode akses tidak valid. Hubungi Admin.' },
          };
        }
        const prevDid = usedSignedDeviceMap.get(rawCode);
        if (prevDid && (!rawDid || prevDid !== rawDid)) {
          return { status: 403, body: { error: 'Kode ini dibatasi 1 perangkat dan sudah digunakan di perangkat lain.' } };
        }
        if (!prevDid) usedSignedDeviceMap.set(rawCode, deviceId);
        label = 'Kode Akses Resmi';
        codeExpMs = signed.expiresAtMs;
      }
    }

    const defaultSessionExp = Date.now() + 90 * 24 * 3600 * 1000;
    const sessionExp = codeExpMs ? Math.min(codeExpMs, defaultSessionExp) : defaultSessionExp;
    const token = signSessionPayload({
      v: 2,
      role: 'listener',
      code: rawCode,
      label,
      did: deviceId,
      exp: sessionExp,
    });
    setAccessCookie(res, token, Math.max(60, Math.floor((sessionExp - Date.now()) / 1000)));
    return {
      status: 200,
      body: {
        ok: true,
        unlocked: true,
        token,
        label,
        code: rawCode,
        expiresAt: sessionExp,
        storage: HAS_SUPABASE ? 'supabase' : 'signed',
      },
    };
  } catch (e: any) {
    return { status: 500, body: { error: e?.message || 'Gagal memverifikasi kode' } };
  }
}

async function opAccessLock(req: Req, res: Res, explicitToken = '', explicitDid = '') {
  const token = extractAccessToken(req, explicitToken);
  const payload = verifySessionToken(token);
  const headerDid = typeof req.headers['x-device-id'] === 'string' ? req.headers['x-device-id'].trim() : '';
  const reqDid = explicitDid.trim() || headerDid || String(payload?.did || '');
  let released = false;
  if (payload && payload.role === 'listener' && payload.code) {
    if (!payload.did || !reqDid || safeEqualStr(String(payload.did), reqDid)) {
      await releaseCodeSlot(String(payload.code), reqDid);
      released = true;
    }
  }
  setAccessCookie(res, null);
  return { status: 200, body: { ok: true, unlocked: false, released } };
}

function opAdminLogin(res: Res, passwordInput: string, didInput: string) {
  const pw = String(passwordInput || '').trim();
  if (!pw || !safeEqualStr(pw, ADMIN_PASSWORD)) {
    return { status: 401, body: { error: 'Password admin salah.' } };
  }
  const rawDid = String(didInput || '').trim().slice(0, 64);
  const deviceId = rawDid || crypto.randomBytes(12).toString('hex');
  const exp = Date.now() + 12 * 3600 * 1000;
  const adminToken = signSessionPayload({ v: 2, role: 'admin', exp });
  const accessToken = signSessionPayload({
    v: 2,
    role: 'admin_listener',
    code: 'ADMIN',
    label: 'Admin (Tanpa Kode)',
    did: deviceId,
    exp,
  });
  setAccessCookie(res, accessToken, 12 * 3600);
  return {
    status: 200,
    body: {
      ok: true,
      adminToken,
      accessToken,
      accessInfo: { label: 'Admin (Tanpa Kode)', code: 'ADMIN', expiresAt: exp },
      expiresAt: exp,
      storage: HAS_SUPABASE ? 'supabase' : 'signed',
      usingDefaultPassword: USING_DEFAULT_ADMIN_PW,
    },
  };
}

async function opAdminListCodes(adminToken: string) {
  if (!checkAdminToken(adminToken)) return { status: 401, body: { error: 'Unauthorized admin' } };
  try {
    if (HAS_SUPABASE) {
      const r = await sbFetch('access_codes?select=*&order=created_at.desc&limit=100');
      if (!r.ok) {
        const errTxt = await r.text().catch(() => '');
        return { status: 502, body: { error: `Supabase error (${r.status}): ${errTxt || 'cek tabel access_codes'}` } };
      }
      const rows = await r.json();
      return {
        status: 200,
        body: {
          storage: 'supabase',
          usingDefaultPassword: USING_DEFAULT_ADMIN_PW,
          codes: Array.isArray(rows) ? rows : [],
        },
      };
    }
    const codes = Array.from(localCodeStore.values()).sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
    return {
      status: 200,
      body: {
        storage: 'signed',
        usingDefaultPassword: USING_DEFAULT_ADMIN_PW,
        codes,
      },
    };
  } catch (e: any) {
    return { status: 500, body: { error: e?.message || 'Gagal memuat daftar kode' } };
  }
}

async function opAdminCreateCode(adminToken: string, input: Record<string, any>) {
  if (!checkAdminToken(adminToken)) return { status: 401, body: { error: 'Unauthorized admin' } };
  try {
    const rawCustom = String(input?.code || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    const label = String(input?.label || '').trim().slice(0, 60) || 'Pengguna';
    const maxUses = Math.max(0, Math.min(10000, Number(input?.maxUses ?? 1) || 0));
    const expiresInDays = Number(input?.expiresInDays) || 0;
    const expiresAtMs = expiresInDays > 0 ? Date.now() + expiresInDays * 24 * 3600 * 1000 : null;
    const expires_at = expiresAtMs ? new Date(expiresAtMs).toISOString() : null;

    if (HAS_SUPABASE) {
      const code = rawCustom || randomCodeString();
      if (code.length < 3) return { status: 400, body: { error: 'Kode minimal 3 karakter.' } };
      const payload: AccessCodeRecord = {
        code,
        label,
        max_uses: maxUses,
        uses: 0,
        active: true,
        expires_at,
        created_at: new Date().toISOString(),
      };
      const r = await sbFetch('access_codes', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const msg = await r.text().catch(() => '');
        if (r.status === 409 || /duplicate/i.test(msg)) {
          return { status: 409, body: { error: `Kode "${code}" sudah ada.` } };
        }
        return { status: 502, body: { error: `Gagal menyimpan ke Supabase (${r.status})` } };
      }
      const inserted: any = await r.json().catch(() => [payload]);
      codeActiveCache.delete(code);
      return { status: 200, body: { ok: true, code: Array.isArray(inserted) ? inserted[0] : payload } };
    }

    const code = rawCustom || generateSignedCode(expiresAtMs);
    if (code.length < 3) return { status: 400, body: { error: 'Kode minimal 3 karakter.' } };
    if (localCodeStore.has(code)) return { status: 409, body: { error: `Kode "${code}" sudah ada.` } };
    const record: AccessCodeRecord = {
      code,
      label,
      max_uses: maxUses,
      uses: 0,
      active: true,
      expires_at,
      created_at: new Date().toISOString(),
      bound_device: null,
      kind: rawCustom ? 'memory' : 'signed',
    };
    revokedLocalCodes.delete(code);
    usedSignedDeviceMap.delete(code);
    localCodeStore.set(code, record);
    return { status: 200, body: { ok: true, code: record } };
  } catch (e: any) {
    return { status: 500, body: { error: e?.message || 'Gagal membuat kode' } };
  }
}

async function opAdminToggleCode(adminToken: string, rawCode: string, active: boolean) {
  if (!checkAdminToken(adminToken)) return { status: 401, body: { error: 'Unauthorized admin' } };
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code) return { status: 400, body: { error: 'Kode tidak valid' } };
  codeActiveCache.delete(code);
  try {
    if (HAS_SUPABASE) {
      const r = await sbFetch(`access_codes?code=eq.${encodeURIComponent(code)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ active }),
      });
      if (!r.ok) return { status: 502, body: { error: 'Gagal mengubah status kode di Supabase' } };
      const rows: any = await r.json().catch(() => []);
      return { status: 200, body: { ok: true, code: Array.isArray(rows) ? rows[0] : { code, active } } };
    }
    const mem = localCodeStore.get(code);
    if (mem) mem.active = active;
    if (active) revokedLocalCodes.delete(code);
    else revokedLocalCodes.add(code);
    return { status: 200, body: { ok: true, code: mem || { code, active } } };
  } catch (e: any) {
    return { status: 500, body: { error: e?.message || 'Gagal update kode' } };
  }
}

async function opAdminReleaseCode(adminToken: string, rawCode: string) {
  if (!checkAdminToken(adminToken)) return { status: 401, body: { error: 'Unauthorized admin' } };
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code) return { status: 400, body: { error: 'Kode tidak valid' } };
  codeActiveCache.delete(code);
  try {
    if (HAS_SUPABASE) {
      const r = await sbFetch(`access_codes?code=eq.${encodeURIComponent(code)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ uses: 0, device_id: null }),
      });
      if (!r.ok) return { status: 502, body: { error: 'Gagal melepaskan perangkat dari kode di Supabase' } };
      const rows: any = await r.json().catch(() => []);
      return { status: 200, body: { ok: true, code: Array.isArray(rows) ? rows[0] : { code, uses: 0, device_id: null } } };
    }
    const mem = localCodeStore.get(code);
    if (mem) {
      mem.uses = 0;
      mem.bound_device = null;
    }
    usedSignedDeviceMap.delete(code);
    return { status: 200, body: { ok: true, code: mem || { code, uses: 0, bound_device: null } } };
  } catch (e: any) {
    return { status: 500, body: { error: e?.message || 'Gagal mengosongkan kode' } };
  }
}

async function opAdminDeleteCode(adminToken: string, rawCode: string) {
  if (!checkAdminToken(adminToken)) return { status: 401, body: { error: 'Unauthorized admin' } };
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code) return { status: 400, body: { error: 'Kode tidak valid' } };
  codeActiveCache.delete(code);
  try {
    if (HAS_SUPABASE) {
      const r = await sbFetch(`access_codes?code=eq.${encodeURIComponent(code)}`, { method: 'DELETE' });
      if (!r.ok) return { status: 502, body: { error: 'Gagal menghapus kode di Supabase' } };
      return { status: 200, body: { ok: true } };
    }
    revokedLocalCodes.add(code);
    usedSignedDeviceMap.delete(code);
    localCodeStore.delete(code);
    return { status: 200, body: { ok: true } };
  } catch (e: any) {
    return { status: 500, body: { error: e?.message || 'Gagal menghapus kode' } };
  }
}

async function opAdminExtendCode(adminToken: string, rawCode: string, days: number) {
  if (!checkAdminToken(adminToken)) return { status: 401, body: { error: 'Unauthorized admin' } };
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code) return { status: 400, body: { error: 'Kode tidak valid' } };
  codeActiveCache.delete(code);
  try {
    const expiresAtMs = days > 0 ? Date.now() + days * 24 * 3600 * 1000 : null;
    const expires_at = expiresAtMs ? new Date(expiresAtMs).toISOString() : null;
    if (HAS_SUPABASE) {
      const r = await sbFetch(`access_codes?code=eq.${encodeURIComponent(code)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ expires_at }),
      });
      if (!r.ok) return { status: 502, body: { error: 'Gagal memperpanjang masa berlaku di Supabase' } };
      const rows: any = await r.json().catch(() => []);
      return { status: 200, body: { ok: true, code: Array.isArray(rows) ? rows[0] : { code, expires_at } } };
    }
    const mem = localCodeStore.get(code);
    if (mem) mem.expires_at = expires_at;
    return { status: 200, body: { ok: true, code: mem || { code, expires_at } } };
  } catch (e: any) {
    return { status: 500, body: { error: e?.message || 'Gagal memperpanjang masa berlaku' } };
  }
}

/* Encrypted RPC Channel (ECDH P-256 + AES-256-GCM) — hides URLs, passwords, codes, users & payloads in DevTools Network */
app.get('/api/v1/cfg', (_req: Req, res: Res) => {
  setNoStore(res);
  res.json({ p: SERVER_ECDH_PUB_B64U });
});

app.post('/api/v1/rpc', async (req: Req, res: Res) => {
  setNoStore(res);
  try {
    const { e, k, n, d } = req.body || {};
    if (e !== 1 || typeof k !== 'string' || typeof n !== 'string' || typeof d !== 'string') {
      return res.status(400).json({ ok: false });
    }
    const clientPubBuf = Buffer.from(k, 'base64url');
    const ivBuf = Buffer.from(n, 'base64url');
    const rawBuf = Buffer.from(d, 'base64url');
    if (clientPubBuf.length !== 65 || ivBuf.length !== 12 || rawBuf.length < 16) {
      return res.status(400).json({ ok: false });
    }
    const sharedSecret = SERVER_ECDH.computeSecret(clientPubBuf);
    const aesKey = crypto.createHash('sha256').update(Buffer.concat([sharedSecret, clientPubBuf])).digest();
    const ctBuf = rawBuf.subarray(0, rawBuf.length - 16);
    const tagBuf = rawBuf.subarray(rawBuf.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, ivBuf);
    decipher.setAuthTag(tagBuf);
    const plainJson = Buffer.concat([decipher.update(ctBuf), decipher.final()]).toString('utf8');
    const rpc = JSON.parse(plainJson);
    const act = String(rpc?.a || '');
    const p = (rpc?.p && typeof rpc.p === 'object' ? rpc.p : {}) as Record<string, any>;
    const tok = typeof rpc?.tok === 'string' ? rpc.tok : '';
    const auth = typeof rpc?.auth === 'string' ? rpc.auth : '';
    const did = typeof rpc?.did === 'string' ? rpc.did : '';

    let out: { status: number; body: Record<string, any> };
    if (act === 's') out = await opAccessStatus(req, tok, did);
    else if (act === 'v') out = await opAccessVerify(res, p.code, p.deviceId || did);
    else if (act === 'l') out = await opAccessLock(req, res, tok, did);
    else if (act === 'al') out = opAdminLogin(res, p.password, p.deviceId || did);
    else if (act === 'ac') out = await opAdminListCodes(auth);
    else if (act === 'ak') out = await opAdminCreateCode(auth, p);
    else if (act === 'at') out = await opAdminToggleCode(auth, p.code, Boolean(p.active));
    else if (act === 'ar') out = await opAdminReleaseCode(auth, p.code);
    else if (act === 'ad') out = await opAdminDeleteCode(auth, p.code);
    else if (act === 'ae') out = await opAdminExtendCode(auth, p.code, Number(p.days) || 0);
    else out = { status: 400, body: { error: 'Unknown action' } };

    const respPlain = JSON.stringify({ status: out.status, ...out.body });
    const respIv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, respIv);
    const respEnc = Buffer.concat([cipher.update(respPlain, 'utf8'), cipher.final()]);
    const respTag = cipher.getAuthTag();
    return res.json({
      e: 1,
      n: respIv.toString('base64url'),
      d: Buffer.concat([respEnc, respTag]).toString('base64url'),
    });
  } catch {
    return res.status(400).json({ ok: false });
  }
});

app.get('/api/access/status', async (req: Req, res: Res) => {
  setNoStore(res);
  const out = await opAccessStatus(req);
  return res.status(out.status).json(out.body);
});

app.post('/api/access/verify', async (req: Req, res: Res) => {
  setNoStore(res);
  const rawDid = String(req.body?.deviceId || req.headers['x-device-id'] || '');
  const out = await opAccessVerify(res, String(req.body?.code || ''), rawDid);
  return res.status(out.status).json(out.body);
});

app.post('/api/access/lock', async (req: Req, res: Res) => {
  setNoStore(res);
  const out = await opAccessLock(req, res);
  return res.status(out.status).json(out.body);
});

app.post('/api/admin/login', (req: Req, res: Res) => {
  setNoStore(res);
  const rawDid = String(req.body?.deviceId || req.headers['x-device-id'] || '');
  const out = opAdminLogin(res, String(req.body?.password || ''), rawDid);
  return res.status(out.status).json(out.body);
});

app.get('/api/admin/codes', async (req: Req, res: Res) => {
  setNoStore(res);
  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const out = await opAdminListCodes(token);
  return res.status(out.status).json(out.body);
});

app.post('/api/admin/codes', async (req: Req, res: Res) => {
  setNoStore(res);
  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const out = await opAdminCreateCode(token, req.body || {});
  return res.status(out.status).json(out.body);
});

app.patch('/api/admin/codes/:code', async (req: Req, res: Res) => {
  setNoStore(res);
  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const out = await opAdminToggleCode(token, String(req.params.code || ''), Boolean(req.body?.active));
  return res.status(out.status).json(out.body);
});

app.post('/api/admin/codes/:code/release', async (req: Req, res: Res) => {
  setNoStore(res);
  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const out = await opAdminReleaseCode(token, String(req.params.code || ''));
  return res.status(out.status).json(out.body);
});

app.delete('/api/admin/codes/:code', async (req: Req, res: Res) => {
  setNoStore(res);
  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const out = await opAdminDeleteCode(token, String(req.params.code || ''));
  return res.status(out.status).json(out.body);
});


const YTM = 'https://music.youtube.com/youtubei/v1';
const CONTEXT = {
  client: {
    clientName: 'WEB_REMIX',
    clientVersion: '1.20240101.00.00',
    hl: 'id',
    gl: 'ID',
  },
};

const HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  Origin: 'https://music.youtube.com',
  Referer: 'https://music.youtube.com/',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
};

async function yt(endpoint: string, body: Record<string, any> = {}, query = ''): Promise<any> {
  const res = await fetchTimeout(
    `${YTM}/${endpoint}?prettyPrint=false${query}`,
    {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ context: CONTEXT, ...body }),
    },
    9000
  );
  if (!res.ok) throw new Error(`YTM ${endpoint} -> ${res.status}`);
  return res.json();
}

/* ---------------- Deep helpers ---------------- */
function findAll(obj: any, key: string, out: any[] = []): any[] {
  if (!obj || typeof obj !== 'object') return out;
  if (Array.isArray(obj)) {
    for (const v of obj) findAll(v, key, out);
    return out;
  }
  for (const k of Object.keys(obj)) {
    if (k === key) out.push(obj[k]);
    findAll(obj[k], key, out);
  }
  return out;
}

const findFirst = (obj: any, key: string): any => findAll(obj, key)[0];

const text = (o: any): string =>
  o && o.runs ? o.runs.map((r: any) => r.text).join('') : (o && o.simpleText) || '';

function normalizeDuration(s: any): string {
  const t = String(s || '').trim();
  if (/^\d{1,2}(\.\d{2}){1,2}$/.test(t)) return t.replace(/\./g, ':');
  return t;
}

function runsInfo(o: any): Array<{ name: string; browseId: string }> {
  const out: Array<{ name: string; browseId: string }> = [];
  if (!o || !o.runs) return out;
  for (const r of o.runs) {
    const be = r.navigationEndpoint && r.navigationEndpoint.browseEndpoint;
    if (be) out.push({ name: r.text, browseId: be.browseId });
  }
  return out;
}

function upscale(url: string | null): string | null {
  if (!url) return url;
  if (url.includes('googleusercontent.com')) return url.replace(/=w\d+-h\d+.*$/, '=w544-h544-l90-rj');
  return url;
}

function thumbs(o: any): string | null {
  const t = findAll(o, 'thumbnails')
    .flat()
    .filter((x) => x && x.url);
  if (!t.length) return null;
  const best = t.reduce((a, b) => ((b.width || 0) >= (a.width || 0) ? b : a));
  return upscale(best.url);
}

function endpointInfo(nav: any): any {
  if (!nav) return {};
  const we = nav.watchEndpoint;
  const be = nav.browseEndpoint;
  const wpe = nav.watchPlaylistEndpoint;
  if (we) return { videoId: we.videoId, playlistId: we.playlistId };
  if (wpe) return { playlistId: wpe.playlistId, watchPlaylist: true };
  if (be) {
    const id = be.browseId;
    let type = 'browse';
    if (id.startsWith('MPRE')) type = 'album';
    else if (id.startsWith('UC') || id.startsWith('MPLA')) type = 'artist';
    else if (id.startsWith('VL') || id.startsWith('PL') || id.startsWith('RDCLAK')) type = 'playlist';
    return { browseId: id, browseType: type };
  }
  return {};
}

/* ---------------- Item parsers ---------------- */
function parseTwoRow(r: any): any {
  const nav = r.navigationEndpoint || {};
  let info = endpointInfo(nav);
  if (!info.browseId && r.title && r.title.runs) {
    const tNav = r.title.runs[0] && r.title.runs[0].navigationEndpoint;
    const extra = endpointInfo(tNav || {});
    if (extra.browseId) info = { ...info, ...extra };
  }
  let type = 'song';
  if (info.browseType === 'album' || info.browseType === 'playlist' || info.browseType === 'artist') type = info.browseType;
  else if (info.videoId) type = 'song';
  else if (info.playlistId || info.watchPlaylist) type = 'playlist';

  const item: any = {
    type,
    title: text(r.title),
    subtitle: text(r.subtitle),
    thumbnail: thumbs(r.thumbnailRenderer),
    artists: runsInfo(r.subtitle),
    ...info,
  };

  if (r.thumbnailRenderer && findFirst(r, 'musicThumbnailRenderer')) {
    const style = findFirst(r, 'musicThumbnailRenderer').thumbnailCrop;
    if (style === 'MUSIC_THUMBNAIL_CROP_CIRCLE') item.type = 'artist';
  }
  return item;
}

function parseListItem(r: any): any {
  const cols = (r.flexColumns || []).map((c: any) =>
    c.musicResponsiveListItemFlexColumnRenderer ? c.musicResponsiveListItemFlexColumnRenderer.text : null
  );
  const title = cols[0] ? text(cols[0]) : '';
  const subtitle = cols
    .slice(1)
    .map((c: any) => text(c))
    .filter(Boolean)
    .join(' • ');

  let videoId: string | null = null;
  if (r.playlistItemData) videoId = r.playlistItemData.videoId;
  if (!videoId && cols[0] && cols[0].runs) {
    const we = cols[0].runs[0] && cols[0].runs[0].navigationEndpoint && cols[0].runs[0].navigationEndpoint.watchEndpoint;
    if (we) videoId = we.videoId;
  }
  if (!videoId) {
    const we = findFirst(r.overlay || {}, 'watchEndpoint');
    if (we) videoId = we.videoId;
  }

  const navInfo = endpointInfo(r.navigationEndpoint);
  const artists: any[] = [];
  const albums: any[] = [];
  for (const c of cols.slice(1)) {
    for (const e of runsInfo(c)) {
      if (e.browseId.startsWith('MPRE')) albums.push(e);
      else artists.push(e);
    }
  }

  const type = videoId ? 'song' : navInfo.browseType || 'song';
  const item: any = {
    type,
    title,
    subtitle,
    videoId,
    thumbnail: thumbs(r.thumbnail),
    artists,
    album: albums[0] || null,
    ...navInfo,
  };

  const fixed = findFirst(r, 'musicResponsiveListItemFixedColumnRenderer');
  if (fixed) item.duration = normalizeDuration(text(fixed.text));
  return item;
}

function parseSections(contents: any[]): any[] {
  const sections: any[] = [];
  for (const s of contents || []) {
    const car = s.musicCarouselShelfRenderer;
    const shelf = s.musicShelfRenderer;
    if (car) {
      const header = findFirst(car.header || {}, 'title');
      const items = (car.contents || [])
        .map((c: any) =>
          c.musicTwoRowItemRenderer
            ? parseTwoRow(c.musicTwoRowItemRenderer)
            : c.musicResponsiveListItemRenderer
            ? parseListItem(c.musicResponsiveListItemRenderer)
            : null
        )
        .filter((x: any) => x && x.title);
      if (items.length) sections.push({ title: text(header), items });
    } else if (shelf) {
      const items = (shelf.contents || [])
        .map((c: any) => (c.musicResponsiveListItemRenderer ? parseListItem(c.musicResponsiveListItemRenderer) : null))
        .filter((x: any) => x && x.title);
      if (items.length) sections.push({ title: text(shelf.title), items, list: true });
    }
  }
  return sections;
}

/* ---------------- Continuation helpers ---------------- */
function continuationCommandToken(item: any): string | null {
  return (
    item &&
    item.continuationEndpoint &&
    item.continuationEndpoint.continuationCommand &&
    item.continuationEndpoint.continuationCommand.token
  );
}

function continuationToken(d: any): string | null {
  const sl = findFirst(d, 'sectionListRenderer');
  if (sl && Array.isArray(sl.contents)) {
    for (const item of sl.contents) {
      const cir = item && item.continuationItemRenderer;
      const t = continuationCommandToken(cir);
      if (t) return t;
    }
  }
  for (const item of findAll(d, 'continuationItemRenderer')) {
    const t = continuationCommandToken(item);
    if (t) return t;
  }
  const legacy = findFirst(d, 'nextContinuationData');
  if (legacy && legacy.continuation) return legacy.continuation;
  return null;
}

function continuationContents(d: any): any[] {
  const append = findFirst(d, 'appendContinuationItemsAction');
  if (append && Array.isArray(append.continuationItems)) return append.continuationItems;
  const legacy = findFirst(d, 'sectionListContinuation');
  if (legacy && Array.isArray(legacy.contents)) return legacy.contents;
  const anyItems = findFirst(d, 'continuationItems');
  if (Array.isArray(anyItems)) return anyItems;
  return [];
}

/* ---------------- Cache ---------------- */
const cache = new Map<string, { v: any; t: number }>();
function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>, isValid?: (v: T) => boolean): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return Promise.resolve(hit.v);
  return fn().then((v) => {
    if (!isValid || isValid(v)) cache.set(key, { v, t: Date.now() });
    return v;
  });
}

/* ---------------- API Routes ---------------- */
/* ---------------- Home & Charts (Indonesian Hits First) ---------------- */
function collectSearchItems(d: any): any[] {
  const out: any[] = [];
  const seen = new Set<string>();
  for (const shelf of findAll(d, 'musicShelfRenderer')) {
    for (const c of shelf.contents || []) {
      if (!c.musicResponsiveListItemRenderer) continue;
      const it = parseListItem(c.musicResponsiveListItemRenderer);
      const k = it.videoId || it.browseId || it.title;
      if (it.title && k && !seen.has(k)) {
        seen.add(k);
        out.push(it);
      }
    }
  }
  return out;
}

app.get('/api/home', async (_req: Req, res: Res) => {
  getSoundCloudClientId(false).catch(() => {});
  try {
    const data = await cached('home_ID_v3', 15 * 60 * 1000, async () => {
      const [dHome, dCharts, dIdTrend, dIdPop, dIdArtist, dIdPls] = await Promise.all([
        yt('browse', { browseId: 'FEmusic_home' }).catch(() => null),
        yt('browse', { browseId: 'FEmusic_charts' }).catch(() => null),
        yt('search', { query: 'Top Hits Indonesia Terbaru Official Chart', params: SEARCH_PARAMS.songs }).catch(() => null),
        yt('search', { query: 'Lagu Pop Indonesia Viral TikTok Terbaru', params: SEARCH_PARAMS.songs }).catch(() => null),
        yt('search', { query: 'Artis Indonesia Terpopuler Penyanyi Band', params: SEARCH_PARAMS.artists }).catch(() => null),
        yt('search', { query: 'Top Hits Indonesia Playlist Spotify', params: SEARCH_PARAMS.playlists }).catch(() => null),
      ]);

      const idSections: any[] = [];
      const seenVids = new Set<string>();

      const trendSongs = collectSearchItems(dIdTrend).filter((it) => it.videoId);
      const chartSections = dCharts ? parseSections((findFirst(dCharts, 'sectionListRenderer') || {}).contents || []) : [];
      const chartSongs = chartSections.flatMap((s: any) => s.items || []).filter((it: any) => it && it.videoId);

      const primaryIdSongs: any[] = [];
      for (const it of [...trendSongs, ...chartSongs]) {
        if (!it.videoId || seenVids.has(it.videoId)) continue;
        seenVids.add(it.videoId);
        primaryIdSongs.push(it);
        if (primaryIdSongs.length >= 20) break;
      }
      if (primaryIdSongs.length) {
        idSections.push({ title: 'Trending & Hits Indonesia', items: primaryIdSongs });
      }

      const popSongs: any[] = [];
      for (const it of collectSearchItems(dIdPop)) {
        if (!it.videoId || seenVids.has(it.videoId)) continue;
        seenVids.add(it.videoId);
        popSongs.push(it);
        if (popSongs.length >= 18) break;
      }
      if (popSongs.length) {
        idSections.push({ title: 'Pop & Viral Indonesia Terbaru', items: popSongs });
      }

      const artistsItems = collectSearchItems(dIdArtist).filter((it) => it.type === 'artist' || it.browseType === 'artist').slice(0, 12);
      if (artistsItems.length) {
        idSections.push({ title: 'Artis Indonesia Populer', items: artistsItems });
      }

      const idPlaylists = collectSearchItems(dIdPls).filter((it) => it.browseId || it.playlistId).slice(0, 12);
      if (idPlaylists.length) {
        idSections.push({ title: 'Playlist Hits Indonesia', items: idPlaylists });
      }

      let homeSections: any[] = [];
      if (dHome) {
        const sl = findFirst(dHome, 'sectionListRenderer');
        if (sl) homeSections = parseSections(sl.contents);
        let token =
          continuationToken(dHome) ||
          (sl &&
            sl.continuations &&
            sl.continuations[0] &&
            sl.continuations[0].nextContinuationData &&
            sl.continuations[0].nextContinuationData.continuation);
        let n = 0;
        while (token && n < 2) {
          const d2 = await yt('browse', { continuation: token }).catch(() => null);
          if (!d2) break;
          const added = continuationContents(d2);
          if (!added.length) break;
          homeSections = homeSections.concat(parseSections(added));
          token = continuationToken(d2);
          n++;
        }
      }

      const merged = [...idSections, ...homeSections].filter((s) => s && s.items && s.items.length);
      return { sections: merged };
    }, (v) => Array.isArray(v?.sections) && v.sections.length > 0);
    res.json(data);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/charts', async (_req: Req, res: Res) => {
  try {
    const data = await cached('charts_ID_v2', 20 * 60 * 1000, async () => {
      const [dRising, dViral, dGlobalId, dArtists, dPlaylists] = await Promise.all([
        yt('search', { query: 'Lagu Indonesia Lagi Naik Daun Viral Terbaru', params: SEARCH_PARAMS.songs }).catch(() => null),
        yt('search', { query: 'Top 50 Indonesia Trending Hits Spotify', params: SEARCH_PARAMS.songs }).catch(() => null),
        yt('search', { query: 'Lagu Barat Viral di Indonesia TikTok Terbaru', params: SEARCH_PARAMS.songs }).catch(() => null),
        yt('search', { query: 'Penyanyi Band Indonesia Lagi Naik Daun Populer', params: SEARCH_PARAMS.artists }).catch(() => null),
        yt('search', { query: 'Viral 50 Indonesia Top Hits Playlist', params: SEARCH_PARAMS.playlists }).catch(() => null),
      ]);

      const seenVids = new Set<string>();
      const pickSongs = (d: any, limit: number) => {
        const out: any[] = [];
        for (const it of collectSearchItems(d)) {
          if (!it.videoId || seenVids.has(it.videoId)) continue;
          seenVids.add(it.videoId);
          out.push(it);
          if (out.length >= limit) break;
        }
        return out;
      };

      const sections: any[] = [];

      const risingSongs = pickSongs(dRising, 18);
      if (risingSongs.length) {
        sections.push({ title: 'Sedang Naik Daun di Indonesia', items: risingSongs, list: true });
      }

      const viralSongs = pickSongs(dViral, 15);
      if (viralSongs.length) {
        sections.push({ title: 'Top Hits & Viral Indonesia Saat Ini', items: viralSongs, list: true });
      }

      const risingArtists = collectSearchItems(dArtists)
        .filter((it) => it.type === 'artist' || it.browseType === 'artist')
        .slice(0, 12);
      if (risingArtists.length) {
        sections.push({ title: 'Artis Indonesia yang Lagi Naik Daun', items: risingArtists });
      }

      const globalInId = pickSongs(dGlobalId, 12);
      if (globalInId.length) {
        sections.push({ title: 'Lagu Luar yang Lagi Ramai di Indonesia', items: globalInId });
      }

      const idPlaylists = collectSearchItems(dPlaylists)
        .filter((it) => it.browseId || it.playlistId)
        .slice(0, 12);
      if (idPlaylists.length) {
        sections.push({ title: 'Playlist Trending Indonesia', items: idPlaylists });
      }

      return { sections };
    }, (v) => Array.isArray(v?.sections) && v.sections.length > 0);
    res.json(data);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/* SponsorBlock segments */
app.get('/api/sponsorblock', async (req: Req, res: Res) => {
  try {
    const vid = String(req.query.videoId || '');
    const cats = encodeURIComponent(
      JSON.stringify(['sponsor', 'selfpromo', 'interaction', 'intro', 'outro', 'music_offtopic'])
    );
    const r = await fetch(
      `https://sponsor.ajay.app/api/skipSegments?videoID=${encodeURIComponent(vid)}&categories=${cats}`
    );
    if (!r.ok) return res.json({ segments: [] });
    const arr = await r.json();
    const segments = (Array.isArray(arr) ? arr : [])
      .filter((s: any) => s && s.actionType === 'skip' && Array.isArray(s.segment))
      .filter((s: any) => s.locked === 1 || s.locked === true || typeof s.votes !== 'number' || s.votes >= 0)
      .map((s: any) => ({ category: s.category, start: Number(s.segment[0]), end: Number(s.segment[1]) }))
      .filter((s: any) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start && s.start >= 0)
      .sort((a: any, b: any) => a.start - b.start);
    res.json({ segments });
  } catch {
    res.json({ segments: [] });
  }
});

app.get('/api/moods', async (_req: Req, res: Res) => {
  try {
    const data = await cached('moods', 60 * 60 * 1000, async () => {
      const d = await yt('browse', { browseId: 'FEmusic_moods_and_genres' });
      const cats = findAll(d, 'musicNavigationButtonRenderer').map((b: any) => ({
        title: text(b.buttonText),
        color: b.solid ? '#' + (b.solid.leftStripeColor >>> 0).toString(16).padStart(8, '0').slice(2) : null,
        browseId: b.clickCommand && b.clickCommand.browseEndpoint && b.clickCommand.browseEndpoint.browseId,
        params: b.clickCommand && b.clickCommand.browseEndpoint && b.clickCommand.browseEndpoint.params,
      }));
      return { categories: cats.filter((c: any) => c.browseId) };
    }, (v) => Array.isArray(v?.categories) && v.categories.length > 0);
    res.json(data);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

const SEARCH_PARAMS: Record<string, string> = {
  songs: 'EgWKAQIIAWoMEA4QChADEAQQCRAF',
  videos: 'EgWKAQIQAWoMEA4QChADEAQQCRAF',
  albums: 'EgWKAQIYAWoMEA4QChADEAQQCRAF',
  artists: 'EgWKAQIgAWoMEA4QChADEAQQCRAF',
  playlists: 'EgeKAQQoAEABagwQDhAKEAMQBBAJEAU=',
};

app.get('/api/search', async (req: Req, res: Res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ sections: [] });
    const filter = String(req.query.filter || '');
    const body: Record<string, any> = { query: q };
    if (filter && SEARCH_PARAMS[filter]) body.params = SEARCH_PARAMS[filter];

    const d = await yt('search', body);
    const sections: any[] = [];
    const shelves = findAll(d, 'musicShelfRenderer');
    for (const shelf of shelves) {
      const items = (shelf.contents || [])
        .map((c: any) => (c.musicResponsiveListItemRenderer ? parseListItem(c.musicResponsiveListItemRenderer) : null))
        .filter((x: any) => x && x.title);
      if (items.length) sections.push({ title: text(shelf.title), items });
    }

    if (!sections.length) {
      const flat: any[] = [];
      const seen = new Set();
      for (const sec of findAll(d, 'itemSectionRenderer')) {
        for (const c of sec.contents || []) {
          if (!c.musicResponsiveListItemRenderer) continue;
          const it = parseListItem(c.musicResponsiveListItemRenderer);
          const key = it.videoId || it.browseId || it.title;
          if (it.title && !seen.has(key)) {
            seen.add(key);
            flat.push(it);
          }
        }
      }
      if (flat.length) sections.push({ title: 'Results', items: flat });
    }

    const top = findFirst(d, 'musicCardShelfRenderer');
    if (top) {
      const info = endpointInfo(
        findFirst(top.title || {}, 'navigationEndpoint') ||
          (top.title && top.title.runs && top.title.runs[0] && top.title.runs[0].navigationEndpoint)
      );
      sections.unshift({
        title: 'Top result',
        items: [
          {
            type: info.videoId ? 'song' : info.browseType || 'song',
            title: text(top.title),
            subtitle: text(top.subtitle),
            thumbnail: thumbs(top.thumbnail),
            ...info,
          },
        ],
      });
    }

    res.json({ sections });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/suggest', async (req: Req, res: Res) => {
  try {
    const d = await yt('music/get_search_suggestions', { input: req.query.q || '' });
    const sugg = findAll(d, 'searchSuggestionRenderer').map((s: any) => text(s.suggestion));
    res.json({ suggestions: sugg });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/next', async (req: Req, res: Res) => {
  try {
    const videoId = String(req.query.videoId || '').trim();
    const playlistId = String(req.query.playlistId || '').trim();
    const titleHint = String(req.query.title || '').trim();
    const artistHint = String(req.query.artist || '').trim();

    const fetchNextBody = async (plId: string) => {
      const body: Record<string, any> = { isAudioOnly: true, tunerSettingValue: 'AUTOMIX_SETTING_NORMAL' };
      if (videoId) {
        body.videoId = videoId;
        body.playlistId = plId || `RDAMVM${videoId}`;
        body.watchEndpointMusicSupportedConfigs = {
          watchEndpointMusicConfig: { musicVideoType: 'MUSIC_VIDEO_TYPE_ATV' },
        };
      } else if (plId) {
        body.playlistId = plId;
      }
      if (req.query.params) body.params = req.query.params;
      return yt('next', body);
    };

    const extractPanels = (d: any) => {
      const panels = findAll(d, 'playlistPanelVideoRenderer');
      return panels
        .map((p: any) => ({
          videoId: p.videoId,
          title: displayTitle(text(p.title)),
          artist: text(p.shortBylineText || p.longBylineText),
          artists: runsInfo(p.longBylineText),
          duration: text(p.lengthText),
          thumbnail: thumbs(p.thumbnail),
          selected: !!p.selected,
        }))
        .filter((x: any) => x.videoId);
    };

    let d: any = null;
    let queue: any[] = [];
    try {
      d = await fetchNextBody(playlistId);
      queue = extractPanels(d);
    } catch {}

    let lyricsBrowseId: string | null = null;
    let relatedBrowseId: string | null = null;
    if (d) {
      for (const tab of findAll(d, 'tabRenderer')) {
        const id = tab.endpoint && tab.endpoint.browseEndpoint && tab.endpoint.browseEndpoint.browseId;
        if (!id) continue;
        if (id.startsWith('MPLYt')) lyricsBrowseId = id;
        if (id.startsWith('MPTRt')) relatedBrowseId = id;
      }
    }

    const countOther = (arr: any[]) => arr.filter((x) => x.videoId && x.videoId !== videoId).length;

    // If custom playlistId had no more tracks, retry with YouTube Music AutoMix radio (RDAMVM...)
    if (videoId && playlistId && countOther(queue) === 0) {
      try {
        const dRadio = await fetchNextBody(`RDAMVM${videoId}`);
        const radioQueue = extractPanels(dRadio);
        if (countOther(radioQueue) > 0) queue = radioQueue;
      } catch {}
    }

    // Final fallback: search similar/Indonesian hits so suggested playback never stalls
    if (videoId && countOther(queue) === 0) {
      try {
        const qStr = `${artistHint || titleHint} lagu hits`.trim() || 'Lagu Hits Indonesia Terbaru';
        const dSearch = await yt('search', { query: qStr, params: SEARCH_PARAMS.songs });
        const found = collectSearchItems(dSearch)
          .filter((it: any) => it.videoId && it.videoId !== videoId)
          .slice(0, 15)
          .map((it: any) => ({
            videoId: it.videoId,
            title: displayTitle(it.title),
            artist: it.subtitle || (it.artists || []).map((a: any) => a.name).join(', '),
            artists: it.artists || [],
            duration: it.duration || '',
            thumbnail: it.thumbnail || null,
            selected: false,
          }));
        if (found.length) queue = [...queue, ...found];
      } catch {}
    }

    res.json({ queue, lyricsBrowseId, relatedBrowseId });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/related', async (req: Req, res: Res) => {
  try {
    const d = await yt('browse', { browseId: req.query.browseId });
    const sl = findFirst(d, 'sectionListRenderer');
    let sections: any[] = sl ? parseSections(sl.contents) : [];

    for (const g of findAll(d, 'gridRenderer')) {
      const items = (g.items || [])
        .map((c: any) => {
          if (c.musicTwoRowItemRenderer) return parseTwoRow(c.musicTwoRowItemRenderer);
          if (c.musicResponsiveListItemRenderer) return parseListItem(c.musicResponsiveListItemRenderer);
          return null;
        })
        .filter((x: any) => x && x.title);
      if (items.length) sections.push({ title: text(findFirst(g.header || {}, 'title') || {}), items });
    }

    sections = sections.filter((x: any) => x.items && x.items.length);
    res.json({ sections });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

async function browsePage(rawId: string, params?: string) {
  let id = rawId || '';
  if (/^(PL|RDCLAK|VLPL|OLAK)/.test(id) && !id.startsWith('VL')) id = 'VL' + id;
  const body: Record<string, any> = { browseId: id };
  if (params) body.params = params;
  const d = await yt('browse', body);

  let header: any = null;
  const hResp =
    findFirst(d, 'musicResponsiveHeaderRenderer') ||
    findFirst(d, 'musicDetailHeaderRenderer') ||
    findFirst(d, 'musicImmersiveHeaderRenderer') ||
    findFirst(d, 'musicVisualHeaderRenderer') ||
    findFirst(d, 'musicEditablePlaylistDetailHeaderRenderer');
  if (hResp) {
    header = {
      title: text(hResp.title),
      subtitle: [text(hResp.subtitle), text(hResp.secondSubtitle)].filter(Boolean).join(' • '),
      description: text(hResp.description) || text(findFirst(hResp, 'description') || {}),
      thumbnail: thumbs(hResp.thumbnail || hResp.foregroundThumbnail || {}),
      artists: runsInfo(hResp.subtitle).concat(runsInfo(hResp.straplineTextOne)),
      strapline: text(hResp.straplineTextOne),
    };
    if (!header.thumbnail) header.thumbnail = thumbs(hResp);
  }

  let playlistId: string | null = null;
  const wpe = findFirst(d, 'watchPlaylistEndpoint');
  if (wpe) playlistId = wpe.playlistId;

  let tracks: any[] = [];
  const shelves = findAll(d, 'musicShelfRenderer').concat(findAll(d, 'musicPlaylistShelfRenderer'));
  for (const shelf of shelves) {
    const items = (shelf.contents || [])
      .map((c: any) => (c.musicResponsiveListItemRenderer ? parseListItem(c.musicResponsiveListItemRenderer) : null))
      .filter((x: any) => x && x.title);
    if (items.length && items.filter((i: any) => i.videoId).length >= items.length / 2 && !tracks.length) {
      tracks = items;
    }
  }

  // Fetch continuation pages for playlist / album tracks
  let cTok = continuationToken(d);
  let pageCount = 0;
  while (cTok && pageCount < 4 && tracks.length < 350) {
    const dCont = await yt('browse', { continuation: cTok }).catch(() => null);
    if (!dCont) break;
    const addedItems = continuationContents(dCont);
    const parsedCont = addedItems
      .map((c: any) => (c.musicResponsiveListItemRenderer ? parseListItem(c.musicResponsiveListItemRenderer) : null))
      .filter((x: any) => x && x.title && x.videoId);
    if (!parsedCont.length) break;
    tracks = tracks.concat(parsedCont);
    cTok = continuationToken(dCont);
    pageCount++;
  }

  const sl = findFirst(d, 'sectionListRenderer');
  let sections = sl ? parseSections(sl.contents).filter((s: any) => !s.list || !tracks.length) : [];
  if (tracks.length) {
    sections = sections.filter((s: any) => !(s.list && s.items[0] && s.items[0].videoId === tracks[0].videoId));
  }

  const grids = findAll(d, 'gridRenderer');
  for (const g of grids) {
    const items = (g.items || [])
      .map((c: any) => (c.musicTwoRowItemRenderer ? parseTwoRow(c.musicTwoRowItemRenderer) : null))
      .filter(Boolean);
    if (items.length) sections.push({ title: text(findFirst(g.header || {}, 'title') || {}), items });
  }

  if (header && !header.thumbnail && tracks[0]) header.thumbnail = tracks[0].thumbnail;

  if (header && tracks.length) {
    const ha = (header.artists && header.artists[0]) || (header.strapline ? { name: header.strapline } : null);
    if (ha && ha.name) {
      tracks = tracks.map((t: any) => {
        if (t.artist || (t.artists && t.artists.length)) return t;
        return {
          ...t,
          artist: ha.name,
          artists: t.artists && t.artists.length ? t.artists : [ha],
          artistBrowseId: ha.browseId || t.artistBrowseId,
        };
      });
    }
  }

  return { header, tracks, sections, playlistId };
}

app.get('/api/browse', async (req: Req, res: Res) => {
  try {
    res.json(await browsePage(String(req.query.id || ''), req.query.params ? String(req.query.params) : undefined));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------------- Music download via loader.to ---------------- */
const LOADER_API = 'https://loader.to/ajax/download.php';
const DL_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const LOADER_API_KEY = process.env.LOADER_API_KEY || '';

app.get('/api/download-start', async (req: Req, res: Res) => {
  if (!(await requirePlaybackAccess(req, res))) return;
  const videoId = String(req.query.videoId || '');
  if (!/^[\w-]{6,20}$/.test(videoId)) return res.status(400).json({ error: 'bad id' });
  try {
    const target = encodeURIComponent('https://www.youtube.com/watch?v=' + videoId);
    const u = `${LOADER_API}?format=mp3&url=${target}${
      LOADER_API_KEY ? `&apikey=${encodeURIComponent(LOADER_API_KEY)}` : ''
    }`;
    const r = await fetch(u, { headers: { 'User-Agent': DL_UA, Referer: 'https://loader.to/' } });
    if (!r.ok) {
      return res.status(502).json({ error: `converter responded ${r.status}`, upstreamStatus: r.status });
    }
    let d: any;
    try {
      d = await r.json();
    } catch {
      return res.status(502).json({ error: 'converter returned a non-JSON response (likely rate-limited)' });
    }
    if (!d.success || !d.id) {
      const reason = d.text || d.message || d.error || 'converter refused this song';
      return res.status(502).json({ error: String(reason) });
    }
    res.json({ jobId: d.id, progressUrl: d.progress_url, title: d.title || null });
  } catch (e: any) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/download-progress', async (req: Req, res: Res) => {
  const purl = String(req.query.progressUrl || '');
  try {
    const pu = new URL(purl);
    const PROGRESS_HOSTS = ['loader.to', 'savenow.to', 'affadaffa.com', 'oceansaver.in'];
    const host = pu.hostname;
    const okHost = pu.protocol === 'https:' && PROGRESS_HOSTS.some((h) => host === h || host.endsWith('.' + h));
    if (!okHost) {
      return res.status(400).json({ error: 'bad progress url' });
    }
    const r = await fetch(purl, { headers: { 'User-Agent': DL_UA } });
    if (!r.ok) throw new Error(`progress -> ${r.status}`);
    const d: any = await r.json();
    const progress = Number(d.progress) || 0;
    const url = d.download_url || null;
    const done = (d.success === 1 || d.success === true) && !!url;
    const failed = !done && (progress >= 1000 || d.success === false || d.error || d.status === 'error');
    res.json({
      progress,
      done,
      failed: !!failed,
      url,
      text: d.text || d.message || d.error || '',
    });
  } catch (e: any) {
    res.status(502).json({ error: e.message });
  }
});

function parseSpotifyTarget(raw: string): { spotifyType: 'album' | 'playlist' | 'track'; id: string } | null {
  const s = String(raw || '').trim();
  const uriMatch = s.match(/^spotify:(album|playlist|track):([a-zA-Z0-9]{10,40})$/i);
  if (uriMatch) {
    return { spotifyType: uriMatch[1].toLowerCase() as 'album' | 'playlist' | 'track', id: uriMatch[2] };
  }
  try {
    const u = new URL(s.includes('://') ? s : 'https://' + s);
    if (u.hostname.endsWith('spotify.com')) {
      const pm = u.pathname.match(/\/(?:intl-[a-z-]+\/)?(?:embed\/)?(album|playlist|track)\/([a-zA-Z0-9]{10,40})/i);
      if (pm) {
        return { spotifyType: pm[1].toLowerCase() as 'album' | 'playlist' | 'track', id: pm[2] };
      }
    }
  } catch {}
  return null;
}

function fmtMsDuration(ms: number): string {
  const sec = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (!sec) return '';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

async function matchSpotifyTrackOnYtm(spTrack: { title: string; artist: string; durationMs?: number; fallbackCover?: string | null }) {
  const cleanSpTitle = String(spTrack.title || '').replace(/\u00a0/g, ' ').trim();
  const cleanSpArtist = String(spTrack.artist || '').replace(/\u00a0/g, ' ').trim();
  const primaryArt = cleanSpArtist.split(',')[0].trim();
  const q = `${cleanSpTitle} ${primaryArt}`.trim();
  if (!q) return null;

  let cands: any[] = [];
  try {
    const d = await yt('search', { query: q, params: SEARCH_PARAMS.songs });
    cands = collectSearchItems(d).filter((x) => x.videoId);
  } catch {}

  if (!cands.length) {
    try {
      const d = await yt('search', { query: q });
      cands = collectSearchItems(d).filter((x) => x.videoId);
    } catch {}
  }
  if (!cands.length) return null;

  const targetSec = Math.round((Number(spTrack.durationMs) || 0) / 1000);
  let best = cands[0];
  let bestScore = -999;

  for (const c of cands.slice(0, 6)) {
    let score = simScore(c.title || '', cleanSpTitle) * 2.5 + simScore(c.subtitle || '', primaryArt) * 1.4;
    if (targetSec && c.duration) {
      const parts = String(c.duration).split(':').map(Number);
      if (parts.length >= 2 && parts.every((n) => Number.isFinite(n))) {
        const cSec = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
        const diff = Math.abs(cSec - targetSec);
        if (diff <= 4) score += 1.0;
        else if (diff <= 12) score += 0.4;
        else if (diff > 45) score -= 0.8;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }

  return {
    type: 'song',
    videoId: best.videoId,
    title: cleanSpTitle || best.title,
    artist: cleanSpArtist || best.subtitle || '',
    subtitle: cleanSpArtist || best.subtitle || '',
    thumbnail: best.thumbnail || spTrack.fallbackCover || null,
    duration: best.duration || fmtMsDuration(spTrack.durationMs || 0),
    artists: best.artists || [],
  };
}

app.get('/api/resolve', async (req: Req, res: Res) => {
  try {
    let raw = String(req.query.url || '').trim();
    const spDirect = parseSpotifyTarget(raw);
    if (spDirect) return res.json({ kind: 'spotify', ...spDirect });

    let u: URL;
    try {
      u = new URL(raw.includes('://') ? raw : 'https://' + raw);
    } catch {
      return res.status(400).json({ error: 'Invalid URL' });
    }

    if (u.hostname === 'spotify.link' || u.hostname.endsWith('.spotify.link')) {
      try {
        const r = await fetchTimeout(u.toString(), { redirect: 'follow', headers: { 'User-Agent': DL_UA } }, 6000);
        const spRedirect = parseSpotifyTarget(r.url);
        if (spRedirect) return res.json({ kind: 'spotify', ...spRedirect });
        u = new URL(r.url);
      } catch {}
    }

    const spFromUrl = parseSpotifyTarget(u.toString());
    if (spFromUrl) return res.json({ kind: 'spotify', ...spFromUrl });

    const list = u.searchParams.get('list');
    const v = u.searchParams.get('v');
    const m = u.pathname.match(/\/(playlist|channel|browse|watch)\/?([^/]*)?/);
    if (list && !v) return res.json({ kind: 'playlist', id: list });
    if (v) return res.json({ kind: 'song', videoId: v, playlistId: list || null });
    if (u.hostname === 'youtu.be' && u.pathname.length > 1) {
      return res.json({ kind: 'song', videoId: u.pathname.slice(1).split('/')[0], playlistId: list || null });
    }
    if (m && m[1] === 'channel' && m[2]) return res.json({ kind: 'artist', id: m[2] });
    if (m && m[1] === 'browse' && m[2]) return res.json({ kind: m[2].startsWith('MPRE') ? 'album' : 'playlist', id: m[2] });
    return res.status(400).json({ error: 'Link tidak dikenali. Tempel link album/playlist/lagu Spotify atau YouTube Music.' });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/spotify-import', async (req: Req, res: Res) => {
  try {
    let type = String(req.query.type || '').toLowerCase();
    let id = String(req.query.id || '').trim();
    if (!id && req.query.url) {
      const parsed = parseSpotifyTarget(String(req.query.url));
      if (parsed) {
        type = parsed.spotifyType;
        id = parsed.id;
      }
    }
    if (!/^(album|playlist|track)$/.test(type) || !/^[a-zA-Z0-9]{10,40}$/.test(id)) {
      return res.status(400).json({ error: 'Invalid Spotify album, playlist, or track ID' });
    }

    const embedUrl = `https://open.spotify.com/embed/${type}/${id}`;
    const r = await fetchTimeout(embedUrl, { headers: { 'User-Agent': DL_UA } }, 10000);
    if (!r.ok) return res.status(502).json({ error: `Spotify responded ${r.status}` });
    const html = await r.text();
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) return res.status(502).json({ error: 'Could not read Spotify data (album/playlist may be private)' });

    const nextData = JSON.parse(m[1]);
    const entity = nextData?.props?.pageProps?.state?.data?.entity;
    if (!entity) return res.status(404).json({ error: 'Spotify album or playlist not found' });

    let cover =
      entity?.coverArt?.sources?.[0]?.url ||
      entity?.visualIdentity?.image?.[0]?.url ||
      null;
    let title = String(entity.name || entity.title || 'Spotify Import').trim();
    const subtitle = String(entity.subtitle || (entity.artists || []).map((a: any) => a.name).join(', ') || '').replace(/\u00a0/g, ' ').trim();

    if (!cover) {
      try {
        const oe = await fetchTimeout(`https://open.spotify.com/oembed?url=${encodeURIComponent(`https://open.spotify.com/${type}/${id}`)}`, {}, 4000);
        if (oe.ok) {
          const oj: any = await oe.json();
          cover = oj.thumbnail_url || null;
          if (!title && oj.title) title = oj.title;
        }
      } catch {}
    }

    let rawTracks: Array<{ title: string; artist: string; durationMs: number }> = [];
    if (type === 'track') {
      const art = (entity.artists || []).map((a: any) => a.name).join(', ') || subtitle;
      rawTracks = [{ title, artist: art, durationMs: Number(entity.duration) || 0 }];
    } else if (Array.isArray(entity.trackList)) {
      rawTracks = entity.trackList.slice(0, 60).map((t: any) => ({
        title: String(t.title || '').replace(/\u00a0/g, ' ').trim(),
        artist: String(t.subtitle || subtitle || '').replace(/\u00a0/g, ' ').trim(),
        durationMs: Number(t.duration) || 0,
      })).filter((t: any) => t.title);
    }

    if (!rawTracks.length) {
      return res.status(404).json({ error: 'No playable tracks found in this Spotify link' });
    }

    const matched: any[] = [];
    const seenVids = new Set<string>();
    const BATCH = 5;
    for (let i = 0; i < rawTracks.length; i += BATCH) {
      const chunk = rawTracks.slice(i, i + BATCH);
      const results = await Promise.all(
        chunk.map((t) => matchSpotifyTrackOnYtm({ ...t, fallbackCover: cover }).catch(() => null))
      );
      for (const hit of results) {
        if (hit && hit.videoId && !seenVids.has(hit.videoId)) {
          seenVids.add(hit.videoId);
          matched.push(hit);
        }
      }
    }

    res.json({
      kind: type,
      header: {
        title,
        subtitle: subtitle ? `${subtitle} • Spotify` : 'Spotify Import',
        thumbnail: cover || (matched[0] && matched[0].thumbnail) || null,
        source: 'Spotify',
      },
      totalFound: rawTracks.length,
      tracks: matched,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message || 'Spotify import failed' });
  }
});

/* ---------------- Lyrics matching ---------------- */
function displayTitle(t: string): string {
  const raw = String(t || '').trim();
  if (!raw) return '';
  const cleaned = raw
    .replace(/\s*[\(\[]\s*official\s*(hd\s*)?(4k\s*)?(music\s*)?(lyric(s)?\s*)?(audio|video|visualizer|mv)[^\)\]]*[\)\]]/gi, '')
    .replace(/\s*[\(\[]\s*(official\s*)?(hd\s*)?(music\s*)?(lyric(s)?\s*)?(audio|video|visualizer|mv)[^\)\]]*[\)\]]/gi, '')
    .replace(/\s*[\(\[]\s*(official\s*)?(4k|hd|hq|8d(?:\s*audio)?|1080p|720p)\s*[\)\]]/gi, '')
    .replace(/\s*-\s*(official|lyric(s)?|audio|video|visualizer|topic).*$/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return cleaned || raw;
}

function cleanTitle(t: string): string {
  return String(t || '')
    .replace(/\((feat|ft|with|prod)[^)]*\)/gi, '')
    .replace(/\[(feat|ft|with|prod)[^\]]*\]/gi, '')
    .replace(/\((official|lyric|lyrics|audio|video|visualizer|music video|mv|hd|4k|remaster(ed)?( \d{4})?|live|acoustic|explicit|clean)[^)]*\)/gi, '')
    .replace(/\[[^\]]*(official|lyric|audio|video|remaster|visualizer|live|mv)[^\]]*\]/gi, '')
    .replace(/[\(\[]\s*(4k|hd|hq|8d( audio)?|1080p|720p)\s*[\)\]]/gi, '')
    .replace(/\s*-\s*(official|lyric|lyrics|audio|video|visualizer|topic).*/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function primaryArtist(a: string): string {
  return String(a || '')
    .split(/\s*[,&•·]\s*|\s+(?:feat\.?|ft\.?|with|x|vs\.?)\s+/i)[0]
    .replace(/\s*-\s*topic$/i, '')
    .trim();
}

function norm(x: string): string {
  return String(x || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g, ' ')
    .trim();
}

function simScore(a: string, b: string): number {
  a = norm(a);
  b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.85;
  const aw = new Set(a.split(' '));
  const bw = new Set(b.split(' '));
  let hit = 0;
  for (const w of aw) if (bw.has(w)) hit++;
  return hit / Math.max(aw.size, bw.size);
}

async function fetchTimeout(url: string, opts: any = {}, ms = 4500): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

async function lyricsOvh(title: string, artist: string): Promise<string | null> {
  if (!title || !artist) return null;
  try {
    const r = await fetchTimeout(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`);
    if (!r.ok) return null;
    const j: any = await r.json();
    const lyr = String(j.lyrics || '').replace(/\r\n/g, '\n').trim();
    return lyr.length > 24 ? lyr : null;
  } catch {
    return null;
  }
}

async function neteaseLyrics(title: string, artist: string): Promise<{ synced: string | null; plain: string | null } | null> {
  try {
    const q = `${title} ${artist}`.trim();
    if (!q) return null;
    const r = await fetchTimeout(
      `https://music.163.com/api/search/get/web?s=${encodeURIComponent(q)}&type=1&limit=8`,
      { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://music.163.com/' } }
    );
    if (!r.ok) return null;
    const j: any = await r.json();
    const songs = (j.result || {}).songs || [];
    let best: any = null;
    let bestScore = 0;
    for (const song of songs) {
      const an = (song.artists || []).map((a: any) => a.name).join(' ');
      const score = simScore(song.name, title) * 2 + simScore(an, artist);
      if (score > bestScore) {
        bestScore = score;
        best = song;
      }
    }
    if (!best || bestScore < 1.4) return null;
    const lr = await fetchTimeout(
      `https://music.163.com/api/song/lyric?id=${best.id}&lv=1&kv=1&tv=-1`,
      { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://music.163.com/' } }
    );
    if (!lr.ok) return null;
    const L: any = await lr.json();
    const synced = (L.lrc && L.lrc.lyric) || '';
    const hasTime = /\[[0-9]+:[0-9]/.test(synced);
    if (hasTime && synced.length > 40) {
      const plain = synced.replace(/\[[^\]]+\]/g, '').replace(/\n{3,}/g, '\n\n').trim();
      return { synced, plain: plain || null };
    }
    const plain = synced.replace(/\[[^\]]+\]/g, '').trim();
    if (plain.length > 24) return { synced: null, plain };
    return null;
  } catch {
    return null;
  }
}

async function lrclibGet(title: string, artist: string, duration: number): Promise<any> {
  try {
    const u = `https://lrclib.net/api/get?track_name=${encodeURIComponent(title)}&artist_name=${encodeURIComponent(
      artist
    )}${duration ? `&duration=${Math.round(duration)}` : ''}`;
    const r = await fetchTimeout(u, { headers: { 'User-Agent': 'SpotifyWeb/1.0' } }, 4000);
    if (!r.ok) return null;
    const j: any = await r.json();
    if (j.instrumental) return null;
    return j.syncedLyrics || j.plainLyrics ? j : null;
  } catch {
    return null;
  }
}

async function lrclibSearch(params: Record<string, any>): Promise<any[]> {
  try {
    const qs = new URLSearchParams(params).toString();
    const r = await fetchTimeout(`https://lrclib.net/api/search?${qs}`, { headers: { 'User-Agent': 'SpotifyWeb/1.0' } }, 4000);
    if (!r.ok) return [];
    return (await r.json()) as any[];
  } catch {
    return [];
  }
}

function pickBest(cands: any[], title: string, artist: string, duration: number): any {
  const dur = Number(duration) || 0;
  let best: any = null;
  let bestScore = 0;
  for (const c of cands) {
    if (!c || c.instrumental || (!c.syncedLyrics && !c.plainLyrics)) continue;
    const tScore = simScore(c.trackName || c.name, title);
    let score = tScore * 2 + simScore(c.artistName, artist);
    if (dur && c.duration) {
      const diff = Math.abs(c.duration - dur);
      if (diff <= 2) score += 1.2;
      else if (diff <= 5) score += 0.6;
      else if (diff > 20) score -= 1;
    }
    if (c.syncedLyrics) score += 0.8;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  if (!best) return null;
  if (bestScore >= 1.4) return best;
  if (simScore(best.trackName || best.name, title) >= 0.85 && bestScore >= 0.95) return best;
  return null;
}

async function textylLyrics(title: string, artist: string): Promise<string | null> {
  const q = `${artist || ''} ${title || ''}`.trim();
  if (!q) return null;
  try {
    const r = await fetchTimeout(`https://api.textyl.co/api/lyrics?q=${encodeURIComponent(q)}`);
    if (!r.ok) return null;
    const arr: any = await r.json();
    if (!Array.isArray(arr) || arr.length < 4) return null;
    const synced = arr
      .map((x: any) => {
        const sec = Number(x.seconds) || 0;
        const m = Math.floor(sec / 60);
        const s = (sec % 60).toFixed(2).padStart(5, '0');
        return `[${m}:${s}]${x.lyrics || ''}`;
      })
      .join('\n');
    return synced.length > 40 ? synced : null;
  } catch {
    return null;
  }
}

function extractYtmLyrics(d: any): string | null {
  for (const shelf of findAll(d, 'musicDescriptionShelfRenderer')) {
    const lyr = text(shelf.description);
    if (lyr && lyr.length > 20) return lyr;
  }
  for (const block of findAll(d, 'formattedDescription')) {
    const lyr = text(block);
    if (lyr && lyr.length > 40 && lyr.split('\n').length > 4) return lyr;
  }
  return null;
}

app.get('/api/lyrics', async (req: Req, res: Res) => {
  const title = String(req.query.title || '');
  const artist = String(req.query.artist || '');
  const duration = Number(req.query.duration) || 0;
  const browseId = String(req.query.browseId || '');

  try {
    const ct = cleanTitle(title);
    const pa = primaryArtist(artist);
    let tUse = ct || title;
    let aUse = pa || artist;
    const dash = String(tUse).match(/^(.{2,48}?)\s*[-–—]\s+(.+)$/);
    if (dash && (!aUse || simScore(dash[1], aUse) >= 0.45)) {
      aUse = aUse || dash[1];
      tUse = dash[2];
    }

    let synced: string | null = null;
    let plain: string | null = null;
    let source: string | null = null;

    if (browseId) {
      try {
        const body = {
          context: { client: { ...CONTEXT.client, hl: 'id', gl: 'ID' } },
          browseId,
        };
        const r = await fetchTimeout(
          `${YTM}/browse?prettyPrint=false`,
          {
            method: 'POST',
            headers: HEADERS,
            body: JSON.stringify(body),
          },
          4500
        );
        if (r.ok) {
          const d = await r.json();
          const lyr = extractYtmLyrics(d);
          if (lyr) {
            plain = lyr;
            source = 'YouTube Music';
          }
        }
      } catch {}
    }

    const exactHits = await Promise.all([
      lrclibGet(tUse, aUse, duration),
      lrclibGet(tUse, aUse, 0),
      title && title !== tUse ? lrclibGet(cleanTitle(title), pa, 0) : null,
    ]);

    for (const hit of exactHits) {
      if (!hit) continue;
      synced = synced || hit.syncedLyrics || null;
      plain = plain || hit.plainLyrics || null;
      source = synced ? 'LRCLIB' : source || 'LRCLIB';
      if (synced) break;
    }

    if (!synced) {
      const [s1, s2, s3, ne, ovh, tx] = await Promise.all([
        lrclibSearch({ track_name: tUse, artist_name: aUse }),
        lrclibSearch({ q: `${tUse} ${aUse}`.trim() }),
        lrclibSearch({ track_name: tUse }),
        neteaseLyrics(tUse, aUse),
        plain ? null : lyricsOvh(tUse, aUse),
        textylLyrics(tUse, aUse),
      ]);
      const best = pickBest([].concat((s1 as any) || [], (s2 as any) || [], (s3 as any) || []), tUse, aUse, duration);
      if (best) {
        synced = best.syncedLyrics || synced;
        plain = plain || best.plainLyrics;
        source = best.syncedLyrics ? 'LRCLIB' : source || 'LRCLIB';
      }
      if (!synced && ne && ne.synced) {
        synced = ne.synced;
        plain = plain || ne.plain;
        source = 'NetEase';
      } else if (!plain && ne && ne.plain) {
        plain = ne.plain;
        source = source || 'NetEase';
      }
      if (!synced && tx) {
        synced = tx;
        source = 'Textyl';
      }
      if (!synced && !plain && ovh) {
        plain = ovh;
        source = 'lyrics.ovh';
      }
    }

    res.json({ synced: synced || null, plain: plain || null, source });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/* Album art proxy */
app.get('/api/thumb', async (req: Req, res: Res) => {
  try {
    const raw = String(req.query.url || '');
    const u = new URL(raw);
    const host = u.hostname;
    const ok =
      host.endsWith('ytimg.com') ||
      host.endsWith('ggpht.com') ||
      host.endsWith('googleusercontent.com') ||
      host.endsWith('scdn.co') ||
      host.endsWith('spotifycdn.com');
    if (!ok) return res.status(400).end();

    const r = await fetchTimeout(raw, {
      headers: { 'User-Agent': 'Mozilla/5.0 SpotifyThumb/1.0', Accept: 'image/*' },
    }, 6000);
    if (!r.ok) return res.status(502).end();

    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch {
    res.status(500).end();
  }
});

/* Direct audio stream proxy (enables native HTML5 <audio> background playback when screen is off or app is minimized) */
interface StreamInfo {
  url: string;
  mimeType: string;
  contentLength?: string;
  fetchedAt: number;
  expiresAt: number;
}
interface AudioBufferEntry {
  buf: Buffer;
  mimeType: string;
  expiresAt: number;
}
type ResolvedScStream =
  | { kind: 'url'; url: string; mimeType: string; expiresAt: number }
  | { kind: 'buffer'; buf: Buffer; mimeType: string; expiresAt: number };

const streamCache = new Map<string, StreamInfo>();
const streamInFlight = new Map<string, Promise<StreamInfo>>();
const scUrlCache = new Map<string, { url: string; mimeType: string; expiresAt: number }>();
const scBufferCache = new Map<string, AudioBufferEntry>();
const scInFlight = new Map<string, Promise<ResolvedScStream | null>>();
let scClientCache: { id: string; expiresAt: number } | null = null;
let scClientInFlight: Promise<string | null> | null = null;
let ytStreamBlockedUntil = 0;

const PLAYER_CLIENTS = [
  {
    clientName: 'ANDROID_VR',
    clientVersion: '1.56.21',
    osName: 'Android',
    osVersion: '12L',
    androidSdkVersion: 32,
  },
  {
    clientName: 'ANDROID_MUSIC',
    clientVersion: '7.02.52',
    osName: 'Android',
    osVersion: '13',
    androidSdkVersion: 33,
  },
];

async function fetchDirectAudioFromClient(videoId: string, client: Record<string, any>): Promise<any[] | null> {
  try {
    const res = await fetchTimeout(
      'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId, context: { client } }),
      },
      1800
    );
    if (!res.ok) return null;
    const data: any = await res.json();
    const status = data?.playabilityStatus?.status;
    if (status && status !== 'OK') return null;

    const adaptive = (data?.streamingData?.adaptiveFormats || []).filter(
      (f: any) => f && typeof f.mimeType === 'string' && f.mimeType.startsWith('audio/') && f.url
    );
    if (!adaptive.length) return null;
    return adaptive.map((f: any) => ({ ...f, _expiresInSec: Number(data?.streamingData?.expiresInSeconds) || 18000 }));
  } catch {
    return null;
  }
}

async function resolveAudioStream(videoId: string, hq = false, prefer = 'mp4', forceRefresh = false): Promise<StreamInfo> {
  const key = `${videoId}:${hq ? 'hq' : 'std'}:${prefer}`;
  const now = Date.now();
  if (!forceRefresh) {
    const hit = streamCache.get(key);
    if (hit && hit.expiresAt > now + 60_000) return hit;
    const inflight = streamInFlight.get(key);
    if (inflight) return inflight;
  }

  const job = (async (): Promise<StreamInfo> => {
    // Race YouTube Android VR & Android Music clients so the fastest responder wins immediately
    let adaptive: any[] | null = null;
    try {
      adaptive = await Promise.any(
        PLAYER_CLIENTS.map(async (c) => {
          const r = await fetchDirectAudioFromClient(videoId, c);
          if (!r || !r.length) throw new Error('empty');
          return r;
        })
      );
    } catch {
      adaptive = null;
    }
    if (!adaptive || !adaptive.length) throw new Error('no direct youtube audio streams');

    const mp4 = adaptive.filter((f: any) => f.mimeType.includes('audio/mp4')).sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0));
    const webm = adaptive.filter((f: any) => f.mimeType.includes('audio/webm')).sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0));
    const all = [...adaptive].sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0));

    let chosen: any = null;
    if (prefer === 'webm' && webm.length) {
      chosen = webm[0];
    } else if (mp4.length) {
      chosen = mp4[0];
    } else {
      chosen = all[0];
    }

    const expiresInSec = chosen._expiresInSec || 18000;
    const resolvedAt = Date.now();
    const info: StreamInfo = {
      url: chosen.url,
      mimeType: String(chosen.mimeType).split(';')[0].trim(),
      contentLength: chosen.contentLength ? String(chosen.contentLength) : undefined,
      fetchedAt: resolvedAt,
      expiresAt: resolvedAt + Math.min(expiresInSec, 7200) * 1000,
    };
    streamCache.set(key, info);
    return info;
  })();

  streamInFlight.set(key, job);
  try {
    return await job;
  } finally {
    if (streamInFlight.get(key) === job) streamInFlight.delete(key);
  }
}

async function getSoundCloudClientId(force = false): Promise<string | null> {
  if (!force && scClientCache && scClientCache.expiresAt > Date.now()) {
    return scClientCache.id;
  }
  if (!force && scClientInFlight) return scClientInFlight;

  const job = (async (): Promise<string | null> => {
    try {
      const home = await fetchTimeout('https://soundcloud.com', { headers: { 'User-Agent': DL_UA } }, 3500);
      if (!home.ok) return null;
      const html = await home.text();
      const scripts = [...html.matchAll(/src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)].map((m) => m[1]);
      const targets = scripts.reverse().slice(0, 6);
      if (!targets.length) return null;
      const found = await Promise.any(
        targets.map(async (s) => {
          const r = await fetchTimeout(s, { headers: { 'User-Agent': DL_UA } }, 3000);
          if (!r.ok) throw new Error('script failed');
          const js = await r.text();
          const m = js.match(/client_id:"([a-zA-Z0-9]{20,40})"/);
          if (!m) throw new Error('no client_id');
          return m[1];
        })
      );
      if (found) {
        scClientCache = { id: found, expiresAt: Date.now() + 6 * 60 * 60 * 1000 };
        return found;
      }
    } catch {}
    return null;
  })();

  scClientInFlight = job;
  try {
    return await job;
  } finally {
    if (scClientInFlight === job) scClientInFlight = null;
  }
}

function setScUrlCache(key: string, entry: { url: string; mimeType: string; expiresAt: number }) {
  if (scUrlCache.has(key)) scUrlCache.delete(key);
  scUrlCache.set(key, entry);
  while (scUrlCache.size > 48) {
    const oldestKey = scUrlCache.keys().next().value;
    if (oldestKey) scUrlCache.delete(oldestKey);
    else break;
  }
}

function setScBufferCache(key: string, entry: AudioBufferEntry) {
  if (scBufferCache.has(key)) scBufferCache.delete(key);
  scBufferCache.set(key, entry);
  while (scBufferCache.size > 12) {
    const oldestKey = scBufferCache.keys().next().value;
    if (oldestKey) scBufferCache.delete(oldestKey);
    else break;
  }
}

async function lookupTrackMeta(videoId: string): Promise<{ title: string; artist: string; durationSec: number } | null> {
  try {
    const d = await yt('next', { videoId, isAudioOnly: true });
    const p = findFirst(d, 'playlistPanelVideoRenderer');
    if (!p) return null;
    const durStr = text(p.lengthText);
    const parts = durStr.split(':').map(Number);
    const durationSec = parts.length === 2 ? parts[0] * 60 + parts[1] : parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : 0;
    return {
      title: displayTitle(text(p.title)),
      artist: text(p.shortBylineText || p.longBylineText),
      durationSec,
    };
  } catch {
    return null;
  }
}

function scoreSoundCloudCandidate(cand: any, targetTitle: string, targetArtist: string, targetDurSec: number): number {
  const cTitle = String(cand.title || '');
  const cArtist = String(cand.user?.username || cand.publisher_metadata?.artist || '');
  const combined = `${cTitle} ${cArtist}`.toLowerCase();
  const targetLower = `${targetTitle} ${targetArtist}`.toLowerCase();

  let score = simScore(cTitle, targetTitle) * 3.0;
  if (targetArtist) {
    score += Math.max(simScore(cArtist, targetArtist), simScore(cTitle, targetArtist)) * 1.5;
  }

  const durSec = Math.round((Number(cand.duration) || 0) / 1000);
  if (durSec < 45 && (targetDurSec >= 60 || !targetDurSec)) score -= 5;
  if (durSec > 540 && (targetDurSec > 0 ? targetDurSec < 480 : !/(mix|nonstop|album|1\s*jam)/i.test(targetTitle))) score -= 6;
  else if (targetDurSec > 0 && durSec > 0) {
    const diff = Math.abs(durSec - targetDurSec);
    if (diff <= 5) score += 1.4;
    else if (diff <= 15) score += 0.6;
    else if (diff > 60) score -= 2.0;
  }

  const badMods = ['cover', 'remix', 'koplo', 'dangdut', 'karaoke', 'instrumental', 'slowed', 'reverb', 'speed up', 'sped up', 'nightcore', '8d', 'live'];
  for (const mod of badMods) {
    if (combined.includes(mod) && !targetLower.includes(mod)) {
      score -= 1.6;
    }
  }
  if (cand.policy === 'ALLOW') score += 0.3;
  // Prefer direct-streamable progressive transcodings so playback starts immediately without segment download/remux
  const hasProg = (cand.media?.transcodings || []).some((tr: any) => !tr.snipped && tr.format?.protocol === 'progressive');
  if (hasProg) score += 0.45;
  return score;
}

async function downloadInBatches(urls: string[], concurrency = 8): Promise<Buffer[]> {
  const out: Buffer[] = new Array(urls.length);
  let idx = 0;
  async function worker() {
    while (idx < urls.length) {
      const i = idx++;
      const r = await fetchTimeout(urls[i], { headers: { 'User-Agent': DL_UA } }, 8000);
      if (!r.ok) throw new Error(`seg ${i} -> ${r.status}`);
      out[i] = Buffer.from(await r.arrayBuffer());
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, () => worker()));
  return out;
}

async function resolveSoundCloudStream(
  videoId: string,
  rawTitle: string,
  rawArtist: string,
  rawDurSec = 0,
  forceRefresh = false
): Promise<ResolvedScStream | null> {
  if (!forceRefresh) {
    const cachedUrl = scUrlCache.get(videoId);
    if (cachedUrl && cachedUrl.expiresAt > Date.now()) {
      return { kind: 'url', url: cachedUrl.url, mimeType: cachedUrl.mimeType, expiresAt: cachedUrl.expiresAt };
    }
    const cachedEntry = scBufferCache.get(videoId);
    if (cachedEntry && cachedEntry.expiresAt > Date.now()) {
      return { kind: 'buffer', buf: cachedEntry.buf, mimeType: cachedEntry.mimeType, expiresAt: cachedEntry.expiresAt };
    }
    const existing = scInFlight.get(videoId);
    if (existing) return existing;
  }

  const job = (async (): Promise<ResolvedScStream | null> => {
    try {
      let title = displayTitle(cleanTitle(rawTitle) || rawTitle);
      let artist = primaryArtist(rawArtist);
      let durSec = rawDurSec;

      if (!title) {
        const meta = await lookupTrackMeta(videoId);
        if (meta) {
          title = displayTitle(cleanTitle(meta.title) || meta.title);
          artist = primaryArtist(meta.artist);
          if (!durSec) durSec = meta.durationSec;
        }
      }
      if (!title) return null;

      let cid = await getSoundCloudClientId(false);
      if (!cid) return null;

      const queries = [`${title} ${artist}`.trim(), title].filter(Boolean);
      let candidates: any[] = [];
      for (const q of queries) {
        let sr = await fetchTimeout(
          `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(q)}&client_id=${cid}&limit=10`,
          { headers: { 'User-Agent': DL_UA } },
          4000
        );
        if (sr.status === 401 || sr.status === 403) {
          cid = await getSoundCloudClientId(true);
          if (!cid) return null;
          sr = await fetchTimeout(
            `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(q)}&client_id=${cid}&limit=10`,
            { headers: { 'User-Agent': DL_UA } },
            4000
          );
        }
        if (!sr.ok) continue;
        const j: any = await sr.json();
        const valid = (j.collection || []).filter((t: any) =>
          (t.media?.transcodings || []).some(
            (tr: any) =>
              !tr.snipped &&
              tr.duration >= 30000 &&
              (tr.format?.protocol === 'progressive' || (tr.format?.mime_type || '').includes('audio/mp4'))
          )
        );
        if (valid.length) {
          candidates = valid;
          break;
        }
      }
      if (!candidates.length) return null;

      const sorted = candidates
        .map((c) => ({ c, score: scoreSoundCloudCandidate(c, title, artist, durSec) }))
        .sort((a, b) => b.score - a.score);

      for (const { c } of sorted.slice(0, 3)) {
        const trs = (c.media?.transcodings || []).filter((tr: any) => !tr.snipped);
        const prog = trs.find((tr: any) => tr.format?.protocol === 'progressive');
        const hlsMp4 = trs.find((tr: any) => tr.format?.protocol === 'hls' && (tr.format?.mime_type || '').includes('audio/mp4'));
        const chosen = prog || hlsMp4;
        if (!chosen) continue;

        const uRes = await fetchTimeout(`${chosen.url}?client_id=${cid}`, { headers: { 'User-Agent': DL_UA } }, 3500);
        if (!uRes.ok) continue;
        const uJson: any = await uRes.json();
        if (!uJson.url) continue;

        if (chosen.format?.protocol === 'progressive') {
          const mimeType = (chosen.format?.mime_type || 'audio/mpeg').split(';')[0].trim();
          const expiresAt = Date.now() + 5 * 60 * 1000;
          setScUrlCache(videoId, { url: uJson.url, mimeType, expiresAt });
          return { kind: 'url', url: uJson.url, mimeType, expiresAt };
        }

        // Fallback only for tracks without progressive stream: HLS fMP4 -> seekable faststart M4A
        const m3u8Res = await fetchTimeout(uJson.url, { headers: { 'User-Agent': DL_UA } }, 4500);
        if (!m3u8Res.ok) continue;
        const m3u8 = await m3u8Res.text();
        const mapMatch = m3u8.match(/#EXT-X-MAP:URI="([^"]+)"/);
        const segs = m3u8
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.startsWith('http'));
        if (!segs.length) continue;

        const urls = mapMatch ? [mapMatch[1], ...segs] : segs;
        const chunks = await downloadInBatches(urls, 10);
        const rawBuf = Buffer.concat(chunks);

        const tmpTag = `${videoId}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const inPath = path.join(os.tmpdir(), `sp_in_${tmpTag}.mp4`);
        const outPath = path.join(os.tmpdir(), `sp_out_${tmpTag}.m4a`);
        let finalBuf = rawBuf;
        try {
          await fs.writeFile(inPath, rawBuf);
          await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-i', inPath, '-c', 'copy', '-movflags', '+faststart', outPath], {
            timeout: 8000,
          });
          finalBuf = await fs.readFile(outPath);
        } catch {
          // Fall back to concatenated fMP4 if ffmpeg is unavailable
        } finally {
          fs.unlink(inPath).catch(() => {});
          fs.unlink(outPath).catch(() => {});
        }

        const entry: AudioBufferEntry = { buf: finalBuf, mimeType: 'audio/mp4', expiresAt: Date.now() + 40 * 60 * 1000 };
        setScBufferCache(videoId, entry);
        return { kind: 'buffer', buf: finalBuf, mimeType: 'audio/mp4', expiresAt: entry.expiresAt };
      }
      return null;
    } catch {
      return null;
    } finally {
      if (scInFlight.get(videoId) === job) scInFlight.delete(videoId);
    }
  })();

  scInFlight.set(videoId, job);
  return job;
}

function serveBufferRange(req: Req, res: Res, buf: Buffer, mimeType: string) {
  const total = buf.length;
  const isHead = req.method === 'HEAD';
  res.setHeader('Content-Type', mimeType || 'audio/mp4');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-store');

  const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : '';
  const m = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
  if (m) {
    let start = m[1] ? parseInt(m[1], 10) : 0;
    let end = m[2] ? parseInt(m[2], 10) : total - 1;
    if (!m[1] && m[2]) {
      const suffix = parseInt(m[2], 10);
      start = Math.max(0, total - suffix);
      end = total - 1;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= total || start > end) {
      res.status(416);
      res.setHeader('Content-Range', `bytes */${total}`);
      return res.end();
    }
    end = Math.min(end, total - 1);
    const slice = buf.subarray(start, end + 1);
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
    res.setHeader('Content-Length', String(slice.length));
    return isHead ? res.end() : res.send(slice);
  }

  res.status(200);
  res.setHeader('Content-Length', String(total));
  return isHead ? res.end() : res.send(buf);
}

async function proxyUpstreamUrl(req: Req, res: Res, targetUrl: string, fallbackMime: string, fallbackLength?: string, signal?: AbortSignal): Promise<number> {
  const isHead = req.method === 'HEAD';
  const reqHeaders: Record<string, string> = { 'User-Agent': DL_UA };
  if (typeof req.headers.range === 'string') reqHeaders.Range = req.headers.range;

  let upstream = await fetch(targetUrl, { method: isHead ? 'HEAD' : 'GET', headers: reqHeaders, signal });
  if (isHead && (upstream.status === 405 || upstream.status === 501)) {
    try { upstream.body?.cancel(); } catch {}
    upstream = await fetch(targetUrl, { method: 'GET', headers: reqHeaders, signal });
  }
  if (!(upstream.ok || upstream.status === 206)) {
    try { upstream.body?.cancel(); } catch {}
    return upstream.status;
  }
  if (res.writableEnded || res.headersSent || signal?.aborted) {
    try { upstream.body?.cancel(); } catch {}
    return 499;
  }

  res.status(upstream.status);
  res.setHeader('Content-Type', upstream.headers.get('content-type') || fallbackMime || 'audio/mp4');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-store');
  const cl = upstream.headers.get('content-length') || fallbackLength;
  if (cl) res.setHeader('Content-Length', cl);
  const cr = upstream.headers.get('content-range');
  if (cr) res.setHeader('Content-Range', cr);

  if (isHead || !upstream.body) {
    try { upstream.body?.cancel(); } catch {}
    res.end();
    return upstream.status;
  }

  const nodeStream = Readable.fromWeb(upstream.body as any);
  const cleanup = () => {
    try { nodeStream.destroy(); } catch {}
  };
  res.once('close', cleanup);
  nodeStream.once('error', () => {
    res.off('close', cleanup);
    if (!res.headersSent) res.status(502).end();
    else if (!res.writableEnded) res.end();
  });
  nodeStream.once('end', () => res.off('close', cleanup));
  nodeStream.pipe(res);
  return upstream.status;
}

app.get('/api/prefetch', async (req: Req, res: Res) => {
  if (!(await requirePlaybackAccess(req, res))) return;
  const videoId = String(req.query.videoId || '');
  if (!/^[\w-]{6,20}$/.test(videoId)) return res.json({ ok: false });
  const hq = req.query.hq === '1';
  const prefer = req.query.prefer === 'webm' ? 'webm' : 'mp4';
  const title = String(req.query.title || '').trim();
  const artist = String(req.query.artist || '').trim();
  const dur = Number(req.query.dur) || 0;

  // Already cached and valid? Return immediately
  const now = Date.now();
  const key = `${videoId}:${hq ? 'hq' : 'std'}:${prefer}`;
  const ytHit = streamCache.get(key);
  const scUrlHit = scUrlCache.get(videoId);
  const scBufHit = scBufferCache.get(videoId);
  if (
    (ytStreamBlockedUntil <= now && ytHit && ytHit.expiresAt > now + 60_000) ||
    (scUrlHit && scUrlHit.expiresAt > now) ||
    (scBufHit && scBufHit.expiresAt > now)
  ) {
    return res.json({ ok: true, cached: true });
  }

  if (ytStreamBlockedUntil <= now) {
    try {
      const info = await resolveAudioStream(videoId, hq, prefer, false);
      const probe = await fetchTimeout(info.url, { headers: { Range: 'bytes=0-0' } }, 1500);
      if (probe.ok || probe.status === 206) {
        try { probe.body?.cancel(); } catch {}
        return res.json({ ok: true, source: 'yt' });
      }
      ytStreamBlockedUntil = Date.now() + 3 * 60 * 1000;
    } catch {
      ytStreamBlockedUntil = Date.now() + 3 * 60 * 1000;
    }
  }

  const entry = await resolveSoundCloudStream(videoId, title, artist, dur);
  return res.json({ ok: !!entry, source: entry ? 'sc' : 'none' });
});

app.get('/api/stream', async (req: Req, res: Res) => {
  if (!(await requirePlaybackAccess(req, res))) return;
  const videoId = String(req.query.videoId || '');
  if (!/^[\w-]{6,20}$/.test(videoId)) return res.status(400).json({ error: 'bad videoId' });
  const hq = req.query.hq === '1';
  const prefer = req.query.prefer === 'webm' ? 'webm' : 'mp4';
  const title = String(req.query.title || '').trim();
  const artist = String(req.query.artist || '').trim();
  const dur = Number(req.query.dur) || 0;

  // 1. Serve cached SoundCloud direct URL or buffer instantaneously (0ms lookup)
  const cachedScUrl = scUrlCache.get(videoId);
  if (cachedScUrl && cachedScUrl.expiresAt > Date.now()) {
    const ac = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) ac.abort();
    });
    try {
      const status = await proxyUpstreamUrl(req, res, cachedScUrl.url, cachedScUrl.mimeType, undefined, ac.signal);
      if (status >= 200 && status < 300) return;
      scUrlCache.delete(videoId);
    } catch (e: any) {
      if (e?.name === 'AbortError') return;
      scUrlCache.delete(videoId);
    }
  }

  const cachedSc = scBufferCache.get(videoId);
  if (cachedSc && cachedSc.expiresAt > Date.now()) {
    return serveBufferRange(req, res, cachedSc.buf, cachedSc.mimeType);
  }

  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) ac.abort();
  });

  // Pre-warm SoundCloud client_id concurrently if not cached yet
  if (!scClientCache || scClientCache.expiresAt <= Date.now()) {
    getSoundCloudClientId(false).catch(() => {});
  }

  // 2. Try YouTube direct audio stream (skipped automatically for 3 min if IP is 403-blocked)
  if (ytStreamBlockedUntil <= Date.now()) {
    try {
      let info = await resolveAudioStream(videoId, hq, prefer, false);
      let status = await proxyUpstreamUrl(req, res, info.url, info.mimeType, info.contentLength, ac.signal);
      if (status >= 200 && status < 300) return;

      if ((status === 403 || status === 410) && Date.now() - info.fetchedAt > 60_000) {
        info = await resolveAudioStream(videoId, hq, prefer, true);
        status = await proxyUpstreamUrl(req, res, info.url, info.mimeType, info.contentLength, ac.signal);
        if (status >= 200 && status < 300) return;
      }

      if (status === 403 || status === 410) {
        ytStreamBlockedUntil = Date.now() + 3 * 60 * 1000;
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') return;
      ytStreamBlockedUntil = Date.now() + 3 * 60 * 1000;
    }
  }

  // 3. Direct streaming SoundCloud fallback (progressive MP3 streams immediately with Range pass-through!)
  try {
    const scStream = await resolveSoundCloudStream(videoId, title, artist, dur);
    if (scStream && !res.writableEnded && !ac.signal.aborted) {
      if (scStream.kind === 'url') {
        const status = await proxyUpstreamUrl(req, res, scStream.url, scStream.mimeType, undefined, ac.signal);
        if (status >= 200 && status < 300) return;
        scUrlCache.delete(videoId);
      } else {
        return serveBufferRange(req, res, scStream.buf, scStream.mimeType);
      }
    }
  } catch (e: any) {
    if (e?.name === 'AbortError') return;
    scUrlCache.delete(videoId);
  }

  if (!res.headersSent) res.status(502).json({ error: 'stream unavailable' });
});

/* ---------------- Server startup ---------------- */
async function start() {
  const isProd = process.env.NODE_ENV === 'production';
  const PORT = 3000;

  if (isProd) {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req: Req, res: Res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  if (process.env.VERCEL !== '1') {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Spotify running at http://0.0.0.0:${PORT} (${isProd ? 'production' : 'development'})`);
    });
  }
}

if (process.env.VERCEL !== '1') {
  start();
}

export default app;
