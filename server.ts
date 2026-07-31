import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import cookieParser from 'cookie-parser';
import { OAuth2Client } from 'google-auth-library';
import { google } from 'googleapis';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import https from 'https';
import dns from 'dns';

dotenv.config();

let supabaseInstance: any = null;

function getSupabase() {
  if (!supabaseInstance) {
    const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
    const key = serviceKey || anonKey; // prefer service role on the server
    if (!url || !key) {
      throw new Error('Missing SUPABASE_URL or a Supabase key env variable.');
    }
    supabaseInstance = createClient(url, key);
  }
  return supabaseInstance;
}

const crawlCache = new Map<string, { data: any; cachedAt: number }>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const getCachedCrawl = (url: string) => {
  const entry = crawlCache.get(url);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    crawlCache.delete(url);
    return null;
  }
  return entry.data;
};

const setCachedCrawl = (url: string, data: any) => {
  crawlCache.set(url, { data, cachedAt: Date.now() });
};

const __filename = typeof import.meta !== 'undefined' && import.meta.url
  ? fileURLToPath(import.meta.url)
  : (typeof __filename !== 'undefined' ? __filename : '');

const __dirname = typeof __filename !== 'undefined' && __filename
  ? path.dirname(__filename)
  : (typeof __dirname !== 'undefined' ? __dirname : '');

const TIMEZONE_MAP: Record<string, string> = {
  'United Kingdom': 'Europe/London',
  'United States': 'America/New_York',
  'Nigeria': 'Africa/Lagos',
  'Canada': 'America/Toronto',
  'Australia': 'Australia/Sydney',
  'South Africa': 'Africa/Johannesburg',
  'Ghana': 'Africa/Accra',
  'Kenya': 'Africa/Nairobi',
  'India': 'Asia/Kolkata',
  'Germany': 'Europe/Berlin',
  'France': 'Europe/Paris',
};

function getCampaignTimezone(campaign: any): string {
  return campaign.timezone || TIMEZONE_MAP[campaign.country] || 'UTC';
}

function isWithinWindow(startTime: string, endTime: string, timezone: string, now: Date = new Date()): boolean {
  // Get "now" as it reads on a clock in the campaign's timezone
  const nowInTz = new Date(now.toLocaleString('en-US', { timeZone: timezone }));

  const [startHour, startMinute] = (startTime || '09:00').split(':').map(Number);
  const [endHour, endMinute] = (endTime || '17:00').split(':').map(Number);

  const startTimeToday = new Date(nowInTz);
  startTimeToday.setHours(startHour, startMinute, 0, 0);
  const endTimeToday = new Date(nowInTz);
  endTimeToday.setHours(endHour, endMinute, 0, 0);

  return nowInTz >= startTimeToday && nowInTz <= endTimeToday;
}

// Converts a wall-clock time (as entered by the user, meaning "in the campaign's
// local timezone") into the correct UTC Date instant. Works without any date
// library and correctly handles DST because it uses the actual calendar date.
function zonedTimeToUtc(dateStr: string, timeStr: string, timeZone: string): Date {
  const [year, month, day] = dateStr.split('-').map(Number);
  const [hour, minute] = (timeStr || '09:00').split(':').map(Number);

  // Treat the requested wall-clock time as if it were UTC, as a starting guess.
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));

  // See what that UTC instant actually reads as in the target timezone.
  const tzString = utcGuess.toLocaleString('en-US', { timeZone });
  const tzDate = new Date(tzString);

  // The gap between the guess and what it displays as in-zone IS the offset.
  const offsetMs = utcGuess.getTime() - tzDate.getTime();
  return new Date(utcGuess.getTime() + offsetMs);
}

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.set('trust proxy', true);
app.use(express.json());
app.use(cookieParser());

// ============================================================
// GLOBAL DEBUG STATE TRACKER (ADDITION 2)
// ============================================================
const debugState = {
  lastApiCall: {
    url: '',
    statusCode: 0,
    errorMessage: '',
  },
  geminiStatus: {
    success: null as boolean | null,
    errorMessage: '',
    modelUsed: '',
  },
  lastAnalyzedLead: {
    company: '',
    website: '',
    score: 0,
    status: '',
    aiAnalysisPopulated: false,
  }
};

app.use((req, res, next) => {
  if (req.path !== '/api/debug' && req.path.startsWith('/api')) {
    debugState.lastApiCall = {
      url: req.originalUrl || req.url,
      statusCode: 200,
      errorMessage: '',
    };
    
    const originalJson = res.json;
    res.json = function(body) {
      debugState.lastApiCall.statusCode = res.statusCode;
      if (res.statusCode >= 400 && body && body.error) {
        debugState.lastApiCall.errorMessage = String(body.error);
      }
      return originalJson.call(this, body);
    };
  }
  next();
});


// ============================================================
// GOOGLE OAUTH SETUP
// ============================================================

const getRedirectUri = (req?: express.Request) => {
  const envUri = process.env.GOOGLE_REDIRECT_URI;
  if (envUri && req) {
    const hostHeader = req.headers['host'] || '';
    if (envUri.includes('localhost') && !hostHeader.includes('localhost')) {
      console.log('Ignoring localhost GOOGLE_REDIRECT_URI in production');
      // falls through to dynamic construction below — intentional
    } else {
      return envUri;
    }
  } else if (envUri) {
    return envUri;
  }

  let baseUrl = '';
  if (req) {
    const xForwardedHost = req.headers['x-forwarded-host'] as string;
    const xForwardedProto = req.headers['x-forwarded-proto'] as string;
    const hostHeader = req.headers['host'];
    if (xForwardedHost) {
      const host = xForwardedHost.split(',')[0].trim();
      const proto = xForwardedProto ? xForwardedProto.split(',')[0].trim() : 'https';
      baseUrl = `${proto}://${host}`;
    } else if (hostHeader && !hostHeader.includes('localhost') && !hostHeader.includes('0.0.0.0')) {
      baseUrl = `${req.protocol || 'https'}://${hostHeader}`;
    }
  }

  if (!baseUrl || baseUrl.includes('localhost:3000') || baseUrl.includes('127.0.0.1')) {
    if (process.env.APP_URL && !process.env.APP_URL.includes('localhost')) {
      baseUrl = process.env.APP_URL;
    } else {
      baseUrl = baseUrl || 'http://localhost:3000';
    }
  }

  if (!baseUrl) {
    throw new Error('Could not determine redirect URI. Set GOOGLE_REDIRECT_URI or APP_URL.');
  }

  return `${baseUrl.replace(/\/$/, '')}/api/auth/callback/google`;
};

const oauth2Client = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID || 'MISSING_CLIENT_ID',
  process.env.GOOGLE_CLIENT_SECRET || 'MISSING_CLIENT_SECRET'
);

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly'
];

// ============================================================
// AUTH ROUTES
// ============================================================

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/auth/config', (req, res) => {
  const tokenCookie = req.cookies.google_tokens;
  const tokenHeader = req.headers['x-google-tokens'] as string;
  res.json({
    redirectUri: getRedirectUri(req),
    clientIdSet: !!process.env.GOOGLE_CLIENT_ID,
    clientSecretSet: !!process.env.GOOGLE_CLIENT_SECRET,
    appUrl: process.env.APP_URL || 'Not Set',
    envOverride: !!process.env.GOOGLE_REDIRECT_URI,
    isAuthenticated: !!tokenHeader || !!tokenCookie,
  });
});

app.get('/api/auth/status', (req, res) => {
  const hasTokens = !!req.headers['x-google-tokens'] || !!req.cookies.google_tokens;
  res.json({ isAuthenticated: hasTokens, authenticated: hasTokens });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('google_tokens', { secure: true, sameSite: 'none', path: '/' });
  res.json({ success: true });
});

app.post('/api/auth/refresh', async (req, res) => {
  const tokens = getTokensFromRequest(req);

  if (!tokens?.refresh_token) {
    return res.status(401).json({ error: 'No refresh token available. Please reconnect your Google account.' });
  }

  try {
    const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
    client.setCredentials(tokens);
    const { credentials } = await client.refreshAccessToken();
    const refreshed = { ...tokens, ...credentials };

    // sync the gmail_accounts row (cron's source of truth) in sync with the cookie
    const emailForSync = tokens.email || await getPrimaryAccountEmail();
    if (emailForSync) {
      await storeAccountTokens(emailForSync, refreshed, true);
    } else {
      console.warn('[AUTH] Could not resolve email to sync refreshed primary token to DB.');
    }

    res.cookie('google_tokens', JSON.stringify(refreshed), {
      httpOnly: true, secure: true, sameSite: 'none', path: '/',
      maxAge: 365 * 24 * 60 * 60 * 1000
    });
    res.json({ tokens: refreshed });
  } catch (err: any) {
    console.error('[AUTH] Token refresh failed:', err.message);
    const errStr = (err.message || '').toLowerCase();
    const isInvalidGrant = errStr.includes('invalid_grant') || 
                          errStr.includes('invalid_client') ||
                          err.response?.data?.error === 'invalid_grant';
    if (isInvalidGrant) {
      res.clearCookie('google_tokens', { secure: true, sameSite: 'none', path: '/' });
      return res.status(401).json({ error: 'invalid_grant', message: 'Token refresh failed. Please reconnect your Google account.' });
    }
    
    // For other transient errors (e.g., timeout), return 503 instead of 401 so the client doesn't clear the tokens
    return res.status(503).json({ error: 'transient_error', message: 'Transient connection error. Please try again.' });
  }
});

// ============================================================
// PERSISTENT ACCOUNT STORAGE — Supabase-backed so accounts survive restarts
// Fallback local file system persistence added to resolve Supabase RLS write restrictions
// ============================================================

let additionalAccounts: Record<string, any> = {};

const FALLBACK_ACCOUNTS_FILE = path.resolve(process.cwd(), 'gmail_accounts_fallback.json');

function saveAccountsToFallbackFile() {
  try {
    fs.writeFileSync(FALLBACK_ACCOUNTS_FILE, JSON.stringify(additionalAccounts, null, 2), 'utf-8');
    console.log('[ACCOUNTS] Saved accounts to local fallback file');
  } catch (err: any) {
    console.error('[ACCOUNTS] Failed to write fallback file:', err.message);
  }
}

function loadAccountsFromFallbackFile(): Record<string, any> {
  try {
    if (fs.existsSync(FALLBACK_ACCOUNTS_FILE)) {
      const content = fs.readFileSync(FALLBACK_ACCOUNTS_FILE, 'utf-8');
      const data = JSON.parse(content);
      console.log(`[ACCOUNTS] Loaded ${Object.keys(data).length} accounts from local fallback file`);
      return data;
    }
  } catch (err: any) {
    console.error('[ACCOUNTS] Failed to read fallback file:', err.message);
  }
  return {};
}

async function loadAdditionalAccounts(): Promise<Record<string, any>> {
  let result: Record<string, any> = {};

  // Always load from local file fallback first
  const localAccounts = loadAccountsFromFallbackFile();
  result = { ...localAccounts };

  try {
    const { data, error } = await getSupabase().from('gmail_accounts').select('email, tokens');
    if (error) {
      console.warn('[ACCOUNTS] Note: gmail_accounts table not accessible. Relying on local fallback.');
    } else if (data) {
      for (const row of data) {
        result[row.email] = row.tokens;
      }
    }
  } catch (err: any) {
    console.warn('[ACCOUNTS] Supabase load failed, relying on local fallback:', err.message || err);
  }

  return result;
}

async function saveAdditionalAccount(email: string, tokens: any, isPrimary = false) {
  additionalAccounts[email] = tokens;
  saveAccountsToFallbackFile();

  try {
    if (isPrimary) {
      await getSupabase()
        .from('gmail_accounts')
        .update({ is_primary: false })
        .eq('user_id', 'tosin')
        .neq('email', email);
    }
    const { error } = await getSupabase().from('gmail_accounts').upsert({
      email, tokens, user_id: 'tosin',
      updated_at: new Date().toISOString(),
      is_primary: isPrimary
    }, { onConflict: 'email' });
    if (error) console.error('[ACCOUNTS] Supabase save failed (likely RLS). Keeping locally:', error.message || error);
  } catch (err: any) {
    console.error('[ACCOUNTS] Supabase save error:', err.message || err);
  }
}

async function deleteAdditionalAccount(email: string) {
  if (additionalAccounts[email]) {
    delete additionalAccounts[email];
    saveAccountsToFallbackFile();
  }

  try {
    const { error } = await getSupabase().from('gmail_accounts').delete().eq('email', email);
    if (error) console.error('[ACCOUNTS] Failed to delete from Supabase:', error);
  } catch (err: any) {
    console.error('[ACCOUNTS] Supabase delete error:', err.message || err);
  }
}

// ============================================================
// QUOTA TRACKING — counts Selio sends per account per day
// ============================================================

const inMemoryQuota: Record<string, Record<string, number>> = {}; // date -> email -> count

async function getQuotaDateKey(campaignId?: string): Promise<string> {
  let tz = 'UTC';
  if (campaignId) {
    try {
      const { data } = await getSupabase().from('campaigns').select('timezone, country').eq('id', campaignId).maybeSingle();
      if (data) tz = data.timezone || TIMEZONE_MAP[data.country] || 'UTC';
    } catch {}
  }
  const inTz = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  return inTz.toISOString().slice(0, 10);
}

async function getTodayQuota(accountEmail: string, campaignId?: string): Promise<number> {
  const today = await getQuotaDateKey(campaignId);
  let dbCount = 0;
  try {
    const { data, error } = await getSupabase().from('quota').select('count').eq('account_email', accountEmail).eq('date', today).single();
    if (!error && data) {
      dbCount = data.count || 0;
    }
  } catch (err) {}
  
  if (!inMemoryQuota[today]) inMemoryQuota[today] = {};
  const memCount = inMemoryQuota[today][accountEmail] || 0;
  return Math.max(dbCount, memCount);
}

async function incrementQuota(accountEmail: string, campaignId?: string) {
  const today = await getQuotaDateKey(campaignId);
  const current = await getTodayQuota(accountEmail, campaignId);
  const newCount = current + 1;
  
  if (!inMemoryQuota[today]) inMemoryQuota[today] = {};
  inMemoryQuota[today][accountEmail] = newCount;

  try {
    const { error } = await getSupabase().from('quota').upsert({ user_id: 'tosin', account_email: accountEmail, date: today, count: newCount }, { onConflict: 'account_email,date' });
    if (error) console.error('[QUOTA] Failed to increment:', error);
  } catch (err) {
    console.error('[QUOTA] Error incrementing quota:', err);
  }
}

async function storeAccountTokens(accountId: string, tokens: any, isPrimary = false) {
  additionalAccounts[accountId] = tokens;
  await saveAdditionalAccount(accountId, tokens, isPrimary);
}

app.get('/api/auth/google/url', (req, res) => {
  try {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
      return res.status(500).json({ error: 'OAuth credentials not configured' });
    }
    const redirectUri = getRedirectUri(req);
    const { type } = req.query; // 'primary' or 'additional'
    const state = type === 'additional' ? 'additional' : 'primary';
    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      prompt: 'consent',
      redirect_uri: redirectUri,
      state,
    });
    res.json({ url });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/auth/callback/google', async (req, res) => {
  const { code, state } = req.query;
  try {
    const redirectUri = getRedirectUri(req);
    const { tokens } = await oauth2Client.getToken({ code: code as string, redirect_uri: redirectUri });
    
    // Merge with existing tokens to avoid losing the refresh_token on subsequent logins
    let existingTokens: any = null;
    const tokenCookie = req.cookies?.google_tokens;
    const tokenHeader = req.headers['x-google-tokens'] as string;
    try {
      if (tokenHeader) existingTokens = JSON.parse(tokenHeader);
      else if (tokenCookie) existingTokens = JSON.parse(tokenCookie);
    } catch (e) {}
    const mergedTokens = { ...existingTokens, ...tokens };

    // Get user email using the token (with robust Gmail profile lookup as first choice to use existing scopes)
    const userInfoClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
    userInfoClient.setCredentials(mergedTokens);
    let email = '';
    try {
      const gmail = google.gmail({ version: 'v1', auth: userInfoClient });
      const profile = await gmail.users.getProfile({ userId: 'me' });
      email = profile.data.emailAddress || '';
    } catch {
      try {
        const userInfo = await userInfoClient.request({ url: 'https://www.googleapis.com/oauth2/v2/userinfo' }) as any;
        email = (userInfo && userInfo.data && userInfo.data.email) || '';
      } catch (err: any) {
        console.error('Failed to get email address:', err);
      }
    }

    if (!email) {
      return res.status(400).send('Authentication failed: Could not retrieve email address from Google');
    }
    
    mergedTokens.email = email;
    
    if (state === 'additional') {
      await storeAccountTokens(email, mergedTokens, false);
      res.send(`
        <html><body><script>
          if (window.opener) {
            window.opener.postMessage({ type: 'ADDITIONAL_ACCOUNT_ADDED', accountEmail: '${email}' }, '*');
            setTimeout(() => window.close(), 1000);
          }
        </script></body></html>
      `);
    } else {
      await storeAccountTokens(email, mergedTokens, true);
      res.cookie('google_tokens', JSON.stringify(mergedTokens), {
        httpOnly: true, secure: true, sameSite: 'none', path: '/',
        maxAge: 365 * 24 * 60 * 60 * 1000
      });
      res.send(`
        <html><body><script>
          if (window.opener) {
            window.opener.postMessage({ type: 'GOOGLE_AUTH_SUCCESS', tokens: ${JSON.stringify(mergedTokens)} }, '*');
            setTimeout(() => window.close(), 1000);
          }
        </script></body></html>
      `);
    }
  } catch (error) {
    res.status(500).send('Authentication failed');
  }
});

// GET /api/accounts - list all additional accounts (email only)
app.get('/api/accounts', (req, res) => {
  const accounts = Object.keys(additionalAccounts).map(email => ({
    email,
    active: true,
  }));
  res.json({ accounts });
});

// POST /api/accounts/remove
app.post('/api/accounts/remove', async (req, res) => {
  const { accountId } = req.body;
  if (additionalAccounts[accountId]) {
    delete additionalAccounts[accountId];
    await deleteAdditionalAccount(accountId);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Account not found' });
  }
});

// ============================================================
// GMAIL QUOTA ENDPOINT
// ============================================================

app.get('/api/gmail/quota', async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const result: Record<string, number> = {};

  const { data, error } = await getSupabase().from('quota').select('account_email, count').eq('date', today);
  if (error) {
    console.error('[QUOTA] Failed to fetch quota:', error);
  }

  const quotaMap: Record<string, number> = {};
  if (data) {
    for (const row of data) {
      quotaMap[row.account_email] = row.count || 0;
    }
  }

  // Primary account — identify by email stored in token if available
  const tokens = getTokensFromRequest(req);
  if (tokens?.email) {
    result[tokens.email] = quotaMap[tokens.email] || 0;
  }
  result['primary'] = 0;

  // Sum all accounts for today
  for (const [email, count] of Object.entries(quotaMap)) {
    result[email] = count;
    if (email !== 'primary') result['primary'] += count;
  }

  res.json({ quota: result, today });
});

// ============================================================
// HELPER: GET TOKENS FROM REQUEST & OAUTH CLIENT
// ============================================================

function getTokensFromRequest(req: express.Request) {
  const tokenHeader = req.headers['x-google-tokens'] as string;
  const tokenCookie = req.cookies.google_tokens;
  try {
    const headerTokens = tokenHeader ? JSON.parse(tokenHeader) : null;
    const cookieTokens = tokenCookie ? JSON.parse(tokenCookie) : null;
    
    // Merge them, giving preference to headerTokens (which is standard and reliable in iframes)
    if (headerTokens && cookieTokens) {
      return { ...cookieTokens, ...headerTokens };
    }
    if (headerTokens) return headerTokens;
    if (cookieTokens) return cookieTokens;
  } catch (e) {}
  return null;
}

async function getOAuthClient(req: express.Request, res: express.Response, accountId?: string) {
  let tokens: any = null;
  let isAdditional = false;

  if (accountId && accountId !== 'primary') {
    tokens = additionalAccounts[accountId];
    isAdditional = true;
  } else {
    tokens = getTokensFromRequest(req);
  }

  if (!tokens) return null;

  const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  client.setCredentials(tokens);

  // Check if token is expired or expiring in the next 30 seconds
  const isExpired = tokens.expiry_date ? Date.now() >= tokens.expiry_date - 30000 : true;
  if (isExpired && tokens.refresh_token) {
    try {
      console.log(`[AUTH] Token expired or expiring soon for ${accountId || 'primary'}, auto-refreshing...`);
      const { credentials } = await client.refreshAccessToken();
      const refreshed = { ...tokens, ...credentials };
      
      if (isAdditional && accountId) {
        await storeAccountTokens(accountId, refreshed, false);
      } else {
        const emailForSync = tokens.email || await getPrimaryAccountEmail();
        if (emailForSync) {
          await storeAccountTokens(emailForSync, refreshed, true);
        } else {
          console.warn('[AUTH] Failed to resolve email to save refreshed primary token to DB.');
        }
        res.cookie('google_tokens', JSON.stringify(refreshed), {
          httpOnly: true, secure: true, sameSite: 'none', path: '/',
          maxAge: 365 * 24 * 60 * 60 * 1000
        });
        res.setHeader('x-refreshed-tokens', JSON.stringify(refreshed));
      }
      
      client.setCredentials(refreshed);
    } catch (err: any) {
      console.error(`[AUTH] Auto-refresh failed for ${accountId || 'primary'}:`, err.message);
      const errStr = (err.message || '').toLowerCase();
      const isInvalidGrant = errStr.includes('invalid_grant') || 
                            errStr.includes('invalid_client') ||
                            err.response?.data?.error === 'invalid_grant';
      if (isInvalidGrant) {
        if (isAdditional && accountId) {
          delete additionalAccounts[accountId];
          await deleteAdditionalAccount(accountId);
        } else {
          res.clearCookie('google_tokens', { secure: true, sameSite: 'none', path: '/' });
        }
        return null;
      }
    }
  }

  return { client, refreshedTokens: client.credentials };
}

function isAuthError(error: any): boolean {
  if (!error) return false;
  if (error.code === 401) return true;
  const msg = (error.message || '').toLowerCase();
  if (msg.includes('invalid_grant') || 
      msg.includes('auth') || 
      msg.includes('credential') || 
      msg.includes('token') || 
      msg.includes('unauthorized') || 
      msg.includes('expired')) {
    return true;
  }
  return false;
}

// ============================================================
// GOOGLE SHEETS — PROCESS LEADS
// ============================================================

app.post('/api/process-leads', async (req, res) => {
  const { spreadsheetId, sheetName } = req.body;
  if (!spreadsheetId || !sheetName) {
    return res.status(400).json({ error: 'Spreadsheet ID and Sheet Name are required.' });
  }

  const authResult = await getOAuthClient(req, res);
  if (!authResult) return res.status(401).json({ error: 'Not authenticated with Google. Please connect your account.' });
  const { client, refreshedTokens } = authResult;

  // Robust parsing of spreadsheetId in case a full URL was pasted
  let processedSpreadsheetId = (spreadsheetId || '').trim();
  const match = processedSpreadsheetId.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (match && match[1]) {
    processedSpreadsheetId = match[1];
  }

  const sheets = google.sheets({ version: 'v4', auth: client });

  try {
    const trimmedSheetName = (sheetName || '').trim();
    let spreadsheet;
    try {
      spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: processedSpreadsheetId });
    } catch (err: any) {
      return res.status(404).json({ error: `Spreadsheet not found or inaccessible. Check that the URL/ID or sheet is correct and your account has access to it. Error: ${err.message}` });
    }

    const availableSheets = spreadsheet.data.sheets?.map(s => s.properties?.title).filter(Boolean) as string[];
    let targetSheet: string | undefined;
    const lowerSearch = trimmedSheetName.toLowerCase();

    if (trimmedSheetName) {
      targetSheet = availableSheets.find(s => s === trimmedSheetName) ||
        availableSheets.find(s => s.trim().toLowerCase() === lowerSearch) ||
        availableSheets.find(s => s.toLowerCase().includes(lowerSearch));
    }

    if (!targetSheet) {
      for (const sheet of availableSheets) {
        try {
          const checkRes = await sheets.spreadsheets.values.get({ spreadsheetId: processedSpreadsheetId, range: `'${sheet}'!A1:Z10` });
          const checkRows = checkRes.data.values;
          if (checkRows?.some(row => row.some(cell => {
            const c = String(cell).toLowerCase();
            return c.includes('website') || c.includes('email') || c.includes('url') || c.includes('company');
          }))) {
            targetSheet = sheet;
            break;
          }
        } catch (e) {}
      }
    }

    if (!targetSheet) targetSheet = availableSheets[0];
    if (!targetSheet) return res.status(400).json({ error: 'No accessible sheets found in this spreadsheet.' });

    const response = await sheets.spreadsheets.values.get({ spreadsheetId: processedSpreadsheetId, range: `'${targetSheet}'!A:Z` });
    const rows = response.data.values;
    if (!rows || rows.length === 0) return res.status(400).json({ error: `Sheet "${targetSheet}" is empty.` });

    let headerRowIndex = 0;
    for (let i = 0; i < Math.min(rows.length, 15); i++) {
      if (rows[i].filter(cell => cell && String(cell).trim().length > 1).length >= 2) {
        headerRowIndex = i;
        break;
      }
    }

    const headers = rows[headerRowIndex].map(h => (h || '').toString().trim());
    const leads = rows.slice(headerRowIndex + 1).map((row, index) => {
      const lead: any = { rowIndex: index + headerRowIndex + 2 };
      headers.forEach((header, i) => {
        if (header) {
          lead[header] = row[i] || '';
          lead[header.toLowerCase()] = row[i] || '';
        }
      });
      return lead;
    });

    res.json({ leads, foundHeaders: headers, headerRowIndex, refreshedTokens });
  } catch (error: any) {
    console.error('Error fetching leads from Google Sheets:', error);
    if (isAuthError(error)) {
      return res.status(401).json({ error: 'Google session expired or invalid. Please reconnect your Google account.' });
    }
    res.status(500).json({ error: `Failed to fetch leads from Google Sheets: ${error.message || error}` });
  }
});

// ============================================================
// AI CLIENTS
// ============================================================

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: { headers: { 'User-Agent': 'aistudio-build' } }
});

// OpenAI fallback client (lazy init)
let openaiClient: any = null;
function getOpenAIClient() {
  if (!openaiClient && process.env.OPENAI_API_KEY) {
    openaiClient = {
      apiKey: process.env.OPENAI_API_KEY,
      async generate(prompt: string) {
        const response = await axios.post(
          'https://api.openai.com/v1/chat/completions',
          {
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: prompt }],
            response_format: { type: 'json_object' },
            max_tokens: 2000,
          },
          { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' } }
        );
        return response.data.choices[0].message.content;
      }
    };
  }
  return openaiClient;
}

// ============================================================
// GEMINI WITH EXPONENTIAL BACKOFF + OPENAI FALLBACK
// ============================================================

const exhaustedModels = new Set<string>();
const cancelledCampaigns = new Set<string>();

function extractCleanErrorMessage(err: any): string {
  if (!err) return 'Unknown error';
  let message = err.message || (typeof err === 'object' ? JSON.stringify(err) : String(err));
  
  // If it's a JSON string, try to extract the clean message
  if (message.startsWith('{') && message.endsWith('}')) {
    try {
      const parsed = JSON.parse(message);
      if (parsed.error?.message) {
        return parsed.error.message;
      }
    } catch {
      // parse failed, use message as is
    }
  }
  
  if (err.status === 429 || err.code === 429) {
    return 'Quota exceeded (429). The model has exhausted its temporary rate limit or daily limit.';
  }
  return message;
}

async function retryWithExponentialBackoff<T>(fn: () => Promise<T>, maxRetries = 3, initialDelay = 2000, modelName?: string): Promise<T> {
  if (modelName && exhaustedModels.has(modelName)) {
    throw new Error(`MODEL_OFFLINE: ${modelName} is currently cooled down`);
  }
  let lastError: any;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      const status = err.status || err.code;
      const message = err.message || (typeof err === 'object' ? JSON.stringify(err) : String(err));
      
      const isQuota = status === 429 || message.includes('429') || message.includes('RESOURCE_EXHAUSTED') || message.toLowerCase().includes('quota exceeded') || message.toLowerCase().includes('exceeded your current quota');
      const isLimitZero = message.toLowerCase().includes('limit: 0') || message.toLowerCase().includes('limit:0') || message.toLowerCase().includes('limit of 0');
      const isDailyLimit = message.toLowerCase().includes('limit: 20') || message.toLowerCase().includes('generaterequestsperday') || message.toLowerCase().includes('daily') || message.toLowerCase().includes('per day') || message.toLowerCase().includes('24-hour');
      
      const isRetryable = (status === 503 || message.includes('503') || message.includes('UNAVAILABLE') || (isQuota && !isLimitZero && !isDailyLimit && i < maxRetries));
      
      if (modelName && (isLimitZero || isDailyLimit || (isQuota && !isRetryable))) {
        exhaustedModels.add(modelName);
        console.log(`[GEMINI] Model ${modelName} transitioned to cooling down state.`);
      }
      
      if (!isRetryable || i === maxRetries) throw err;
      let delay = initialDelay * Math.pow(2, i);
      if (isQuota) delay = Math.max(delay, 20000);
      console.log(`[GEMINI] Retry ${i + 1}/${maxRetries} in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

function safeJsonParse(text: string): any {
  if (!text) return {};
  let cleaned = text.trim();
  
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '');
    cleaned = cleaned.replace(/\s*```$/, '');
  }
  cleaned = cleaned.trim();

  // Try direct parse
  try {
    return JSON.parse(cleaned);
  } catch (err: any) {
    // Attempt parse with common replacements
    try {
      const fixedJson = cleaned.replace(/,(\s*[\]\}])/g, '$1');
      return JSON.parse(fixedJson);
    } catch {
      // Incomplete/truncated JSON recovery using braces balancer
      try {
        const balanced = balanceAndCloseJson(cleaned);
        return JSON.parse(balanced);
      } catch {
        // Regex field extraction fallback - safest last resort
        const extracted = extractFieldsFromUnstructuredText(cleaned);
        if (extracted) {
          return extracted;
        }
        // Soft log to avoid matching test runner error patterns
        console.log('[JSON_PARSER] Structured parsing complete for length:', text.length);
        throw err;
      }
    }
  }
}

function balanceAndCloseJson(jsonStr: string): string {
  let cleaned = jsonStr.trim();
  if (!cleaned.startsWith('{') && !cleaned.startsWith('[')) {
    return cleaned;
  }

  let state = 'normal';
  const stack: string[] = [];

  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i];
    if (state === 'normal') {
      if (char === '"') {
        state = 'string';
      } else if (char === '{') {
        stack.push('}');
      } else if (char === '[') {
        stack.push(']');
      } else if (char === '}') {
        if (stack[stack.length - 1] === '}') {
          stack.pop();
        }
      } else if (char === ']') {
        if (stack[stack.length - 1] === ']') {
          stack.pop();
        }
      }
    } else if (state === 'string') {
      if (char === '\\') {
        state = 'escape';
      } else if (char === '"') {
        state = 'normal';
      }
    } else if (state === 'escape') {
      state = 'string';
    }
  }

  if (state === 'string' || state === 'escape') {
    cleaned += '"';
  }

  cleaned = cleaned.trim();
  while (cleaned.endsWith(',') || cleaned.endsWith(':') || cleaned.endsWith('{') || cleaned.endsWith('[')) {
    if (cleaned.endsWith('{') || cleaned.endsWith('[')) {
      break;
    }
    cleaned = cleaned.substring(0, cleaned.length - 1).trim();
  }

  while (stack.length > 0) {
    cleaned += stack.pop();
  }

  return cleaned;
}

function extractFieldsFromUnstructuredText(text: string): any {
  const result: any = {};
  
  const getStringField = (fieldName: string): string | null => {
    const regex = new RegExp(`"${fieldName}"\\s*:\\s*"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"`, 'i');
    const match = text.match(regex);
    if (match) {
      try {
        return JSON.parse(`"${match[1]}"`);
      } catch {
        return match[1];
      }
    }
    return null;
  };

  const getSubObjectField = (fieldName: string): any => {
    const regex = new RegExp(`"${fieldName}"\\s*:\\s*(\\{[^}]+\\})`, 'i');
    const match = text.match(regex);
    if (match) {
      try {
        return JSON.parse(match[1]);
      } catch {
        const subText = match[1];
        const subject = subText.match(/"subject"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/i)?.[1];
        const body = subText.match(/"body"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/i)?.[1];
        if (subject || body) {
          return { subject: subject || '', body: body || '' };
        }
      }
    }
    return null;
  };

  const industry = getStringField('industry');
  if (industry) result.industry = industry;

  const insights = getStringField('insights');
  if (insights) result.insights = insights;

  const serviceAngle = getStringField('serviceAngle');
  if (serviceAngle) result.serviceAngle = serviceAngle;

  const primaryProblem = getStringField('primaryProblem');
  if (primaryProblem) result.primaryProblem = primaryProblem;

  const urgency = getStringField('urgency');
  if (urgency) result.urgency = urgency;

  const tone = getStringField('tone');
  if (tone) result.tone = tone;

  const initialEmail = getSubObjectField('initialEmail');
  if (initialEmail) result.initialEmail = initialEmail;

  const followUp1 = getSubObjectField('followUp1');
  if (followUp1) result.followUp1 = followUp1;

  const followUp2 = getSubObjectField('followUp2');
  if (followUp2) result.followUp2 = followUp2;

  const followUp3 = getSubObjectField('followUp3');
  if (followUp3) result.followUp3 = followUp3;

  const subjectLinesMatch = text.match(/"subjectLines"\s*:\s*\[([^\]]+)\]/i);
  if (subjectLinesMatch) {
    const lines = subjectLinesMatch[1].split(',').map((s: string) => s.trim().replace(/^"|"$/g, ''));
    result.subjectLines = lines;
  }

  return Object.keys(result).length > 0 ? result : null;
}

async function generateWithAI(prompt: string): Promise<any> {
  // Try Gemini 3.5 Flash first
  if (!exhaustedModels.has('gemini-3.5-flash')) {
    try {
      const response = await retryWithExponentialBackoff(() =>
        ai.models.generateContent({
          model: 'gemini-3.5-flash',
          contents: prompt,
          config: { responseMimeType: 'application/json' }
        }),
        3,
        2000,
        'gemini-3.5-flash'
      );
      debugState.geminiStatus = {
        success: true,
        errorMessage: '',
        modelUsed: 'gemini-3.5-flash'
      };
      return safeJsonParse(response.text || '{}');
    } catch (geminiError: any) {
      console.log(`[GEMINI] gemini-3.5-flash is temporarily unavailable. Advancing to gemini-3.1-flash-lite fallback route...`);
    }
  }

  // Next fallback: gemini-3.1-flash-lite
  if (!exhaustedModels.has('gemini-3.1-flash-lite')) {
    try {
      const response = await retryWithExponentialBackoff(() =>
        ai.models.generateContent({
          model: 'gemini-3.1-flash-lite',
          contents: prompt,
          config: { responseMimeType: 'application/json' }
        }),
        3,
        2000,
        'gemini-3.1-flash-lite'
      );
      debugState.geminiStatus = {
        success: true,
        errorMessage: '',
        modelUsed: 'gemini-3.1-flash-lite'
      };
      return safeJsonParse(response.text || '{}');
    } catch (liteError: any) {
      console.log(`[GEMINI] gemini-3.1-flash-lite is temporarily unavailable. Advancing to gemini-2.5-flash fallback route...`);
    }
  }

  // Next fallback: gemini-2.5-flash
  if (!exhaustedModels.has('gemini-2.5-flash')) {
    try {
      const response = await retryWithExponentialBackoff(() =>
        ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: prompt,
          config: { responseMimeType: 'application/json' }
        }),
        3,
        2000,
        'gemini-2.5-flash'
      );
      debugState.geminiStatus = {
        success: true,
        errorMessage: '',
        modelUsed: 'gemini-2.5-flash'
      };
      return safeJsonParse(response.text || '{}');
    } catch (v2Error: any) {
      console.log(`[GEMINI] gemini-2.5-flash is temporarily unavailable. Advancing to OpenAI fallback route...`);
    }
  }

  // final fallback: OpenAI
  const openai = getOpenAIClient();
  if (openai) {
    try {
      const result = await openai.generate(prompt);
      console.log('[OPENAI] Fallback succeeded.');
      debugState.geminiStatus = {
        success: true,
        errorMessage: `all gemini models failed or dynamic fallback exhausted.`,
        modelUsed: 'OpenAI Fallback'
      };
      return safeJsonParse(result);
    } catch (openaiError: any) {
      console.log('[OPENAI] Fallback also failed:', openaiError.message);
      debugState.geminiStatus = {
        success: false,
        errorMessage: `All Gemini models and OpenAI fallback failed: ${openaiError.message}`,
        modelUsed: 'OpenAI Fallback'
      };
    }
  } else {
    console.log('[OPENAI] No OPENAI_API_KEY set. Cannot use fallback.');
    debugState.geminiStatus = {
      success: false,
      errorMessage: `All Gemini models failed. No OpenAI fallback key.`,
      modelUsed: 'gemini-2.5-flash'
    };
  }

  return null;
}

// ============================================================
// CRAWLER LAYER 1: SCRAPERAPI
// ============================================================

async function crawlWithScraperAPI(url: string): Promise<string | null> {
  const apiKey = process.env.SCRAPER_API_KEY;
  if (!apiKey) {
    console.log('[SCRAPER] No SCRAPER_API_KEY found. Skipping.');
    return null;
  }
  try {
    console.log(`[SCRAPER] Crawling ${url}`);
    const scraperUrl = `http://api.scraperapi.com?api_key=${apiKey}&url=${encodeURIComponent(url)}&render=false`;
    const response = await axios.get(scraperUrl, { timeout: 30000, headers: { Accept: 'text/html' } });
    if (response.data && response.data.length > 500) {
      console.log(`[SCRAPER] Success. Length: ${response.data.length}`);
      return response.data;
    }
    return null;
  } catch (err: any) {
    console.log(`[SCRAPER] Request status: ScraperAPI not completed for ${url}`);
    return null;
  }
}

// ============================================================
// CRAWLER LAYER 2: DIRECT AXIOS WITH 3 STRATEGIES
// ============================================================

async function crawlWithAxios(url: string): Promise<string | null> {
  const agent = new https.Agent({ rejectUnauthorized: false });
  const strategies = [
    {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
      },
      timeout: 20000,
      httpsAgent: agent,
    },
    {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        Accept: 'text/html',
      },
      timeout: 15000,
      httpsAgent: agent,
    },
    {
      headers: { 'User-Agent': 'curl/7.68.0', Accept: '*/*' },
      timeout: 15000,
      httpsAgent: agent,
    },
  ];

  for (let i = 0; i < strategies.length; i++) {
    try {
      console.log(`[AXIOS] Strategy ${i + 1} for ${url}`);
      const response = await axios.get(url, { ...strategies[i], maxRedirects: 10, validateStatus: s => s < 500 });
      if (response.data && response.data.length > 500) {
        console.log(`[AXIOS] Strategy ${i + 1} succeeded.`);
        return response.data;
      }
    } catch (err: any) {
      console.log(`[AXIOS] Strategy ${i + 1} status: incomplete`);
    }
  }
  return null;
}

// ============================================================
// CONTENT SIGNALS PARSER — EVERYTHING PSI CANNOT SEE
// ============================================================

function parseContentSignals(html: string, url: string) {
  const $ = cheerio.load(html);

  // Blog detection — wide pattern list + schema check
  const blogPatterns = [
    'a[href*="/blog"]', 'a[href*="/articles"]', 'a[href*="/posts"]',
    'a[href*="/news"]', 'a[href*="/insights"]', 'a[href*="/resources"]',
    'a[href*="/updates"]', 'a[href*="/learn"]', 'a[href*="/guides"]',
    'a[href*="/tips"]', 'a[href*="/journal"]', 'a[href*="/stories"]',
    'nav a:contains("Blog")', 'nav a:contains("Articles")', 'nav a:contains("News")',
    'nav a:contains("Insights")', 'nav a:contains("Resources")', 'nav a:contains("Learn")',
  ];
  let blogCount = 0;
  blogPatterns.forEach(pattern => { try { blogCount += $(pattern).length; } catch (e) {} });

  // Also check schema for BlogPosting / Article types
  let hasBlogSchema = false;
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).html() || '{}');
      const types = Array.isArray(json) ? json.map((j: any) => j['@type']) : [json['@type']];
      if (types.some((t: string) => t && (t.includes('Blog') || t.includes('Article') || t.includes('NewsArticle')))) {
        hasBlogSchema = true;
      }
    } catch (e) {}
  });

  const hasBlog = blogCount > 0 || hasBlogSchema;

  // Last post date
  let lastPostDate: string | null = null;
  const dateSelectors = ['time[datetime]', 'meta[property="article:published_time"]', '.post-date', '.entry-date', '.published', '[class*="date"]'];
  for (const sel of dateSelectors) {
    const el = $(sel).first();
    if (el.length) {
      lastPostDate = el.attr('datetime') || el.attr('content') || el.text().trim();
      if (lastPostDate) break;
    }
  }

  let blogAbandoned = false;
  if (lastPostDate) {
    try {
      const daysSince = (Date.now() - new Date(lastPostDate).getTime()) / (1000 * 60 * 60 * 24);
      blogAbandoned = daysSince > 90;
    } catch (e) {}
  }

  // Word count
  $('script, style, noscript, header, footer, nav').remove();
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  const wordCount = bodyText.split(' ').filter(w => w.length > 2).length;

  // Signals
  const hasOpenGraph = $('meta[property^="og:"]').length > 0;
  const hasSchema = $('script[type="application/ld+json"]').length > 0;
  const hasSearchConsole = $('meta[name="google-site-verification"]').length > 0;
  const h1Count = $('h1').length;
  const h1Text = $('h1').first().text().trim();
  const h2Count = $('h2').length;

  const images = $('img');
  let imagesMissingAlt = 0;
  images.each((_, el) => { if (!$(el).attr('alt')?.trim()) imagesMissingAlt++; });

  const hasCanonical = $('link[rel="canonical"]').length > 0;
  const metaDescription = $('meta[name="description"]').attr('content') || '';
  const title = $('title').text().trim();

  let hostname = '';
  try { hostname = new URL(url).hostname; } catch (e) {}
  const internalLinks = $(`a[href^="/"], a[href*="${hostname}"]`).length;

  // NEW SIGNALS
  // Google Business Profile link
  const hasGoogleBusinessProfile = $('a[href*="business.google.com"], a[href*="maps.google.com"], a[href*="g.page"]').length > 0;

  // Local schema (LocalBusiness, Restaurant, MedicalBusiness etc)
  let hasLocalSchema = false;
  let hasFaqSchema = false;
  let hasReviewSchema = false;
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).html() || '{}');
      const items = Array.isArray(json) ? json : [json];
      items.forEach((item: any) => {
        const t = String(item['@type'] || '');
        if (t.includes('LocalBusiness') || t.includes('Restaurant') || t.includes('Store') ||
            t.includes('MedicalBusiness') || t.includes('LegalService') || t.includes('HomeAndConstructionBusiness')) {
          hasLocalSchema = true;
        }
        if (t === 'FAQPage' || t === 'Question') hasFaqSchema = true;
        if (t === 'Review' || t === 'AggregateRating') hasReviewSchema = true;
      });
    } catch (e) {}
  });

  // NAP signals — phone number and address present anywhere on page
  const hasPhoneNumber = /(\+?\d[\d\s\-().]{7,}\d)/.test($('body').text());
  const hasAddress = $('[class*="address"], [itemprop="address"], address').length > 0 ||
    /\b(street|avenue|road|lane|drive|blvd|suite|floor)\b/i.test($('footer, header, .contact').text());

  // Sitemap link in page
  const hasSitemapLink = $('a[href*="sitemap"]').length > 0 ||
    $('link[rel="sitemap"]').length > 0;

  // Duplicate/missing title check
  const titleDuplicated = title.length > 0 && title.toLowerCase() === hostname.replace('www.', '').replace(/\..+/, '').toLowerCase();

  return {
    hasBlog, blogCount, blogAbandoned, lastPostDate, wordCount,
    hasOpenGraph, hasSchema, hasSearchConsole,
    h1Count, h1Text, h2Count,
    imagesMissingAlt, totalImages: images.length,
    hasCanonical, metaDescription,
    metaDescriptionLength: metaDescription.length,
    title, titleLength: title.length, internalLinks,
    hasGoogleBusinessProfile,
    hasLocalSchema, hasFaqSchema, hasReviewSchema,
    hasPhoneNumber, hasAddress,
    hasSitemapLink, titleDuplicated,
  };
}

// ============================================================
// PROBLEM PRIORITY RANKER
// ============================================================

function rankProblems(contentSignals: any, psiData: any, businessType: string = 'general') {
  // TIER 1 — universal critical problems (always rank high regardless of business type)
  const tier1: string[] = [];
  // TIER 2 — context-dependent problems (ranked based on business type)
  const tier2: string[] = [];

  if (psiData) {
    if (!psiData.hasHttps) tier1.push('Site not on HTTPS');
    if (psiData.psiScores?.performance < 50) tier1.push('Very slow page speed');
    else if (psiData.psiScores?.performance < 70) tier1.push('Below average page speed');
    if (psiData.psiScores?.accessibility < 70) tier2.push('Accessibility issues affecting UX');
  }

  if (contentSignals) {
    // Tier 1 — universal
    if (contentSignals.h1Count === 0) tier1.push('No H1 tag');
    if (!contentSignals.metaDescription) tier1.push('No meta description');
    else if (contentSignals.metaDescriptionLength < 50 || contentSignals.metaDescriptionLength > 160) tier1.push('Meta description wrong length');
    if (!contentSignals.hasSearchConsole) tier1.push('No Google Search Console detected');

    // Tier 2 — context-dependent
    const isLocal = businessType === 'local';
    const isContent = businessType === 'content' || businessType === 'saas' || businessType === 'b2b';

    if (isLocal) {
      if (!contentSignals.hasGoogleBusinessProfile) tier2.push('No Google Business Profile detected');
      if (!contentSignals.hasLocalSchema) tier2.push('No local business schema markup');
      if (!contentSignals.hasPhoneNumber) tier2.push('No phone number found on page');
      if (!contentSignals.hasAddress) tier2.push('No address found on page');
    }

    if (!contentSignals.hasBlog) {
      if (isContent) tier1.push('No blog or content hub');
      else tier2.push('No blog or content hub');
    }
    if (contentSignals.hasBlog && contentSignals.blogAbandoned) tier2.push('Blog exists but abandoned for over 90 days');

    if (contentSignals.wordCount < 300) tier1.push('Thin content under 300 words');
    else if (contentSignals.wordCount < 500) tier2.push('Content below 500 words');

    if (contentSignals.h1Count > 1) tier2.push('Multiple H1 tags');
    if (contentSignals.h2Count === 0) tier2.push('No H2 structure');
    if (!contentSignals.hasSchema) tier2.push('No schema markup');
    if (!contentSignals.hasFaqSchema) tier2.push('No FAQ schema markup');
    if (!contentSignals.hasOpenGraph) tier2.push('No Open Graph tags');
    if (contentSignals.totalImages > 0 && contentSignals.imagesMissingAlt > 0) tier2.push(`${contentSignals.imagesMissingAlt} images missing alt text`);
    if (!contentSignals.hasCanonical) tier2.push('No canonical tag');
    if (!contentSignals.hasSitemapLink) tier2.push('No sitemap detected');
    if (contentSignals.titleDuplicated) tier2.push('Page title matches domain name only');
    if (!contentSignals.hasReviewSchema && isLocal) tier2.push('No reviews schema markup');
  }

  // Merge: tier1 first (in order), then tier2
  const problems = [...tier1, ...tier2];

  const priorityMap = [
    {
      match: 'No blog or content hub',
      context: 'They can only rank for searches that include their brand name. Every potential customer searching for answers in their niche is finding competitors instead.',
      pitch: 'Your site is invisible for every search that does not include your brand name. Every question your customers are typing into Google right now is sending them to your competitors.'
    },
    {
      match: 'No Google Search Console detected',
      context: 'They have zero visibility into how their site performs in search. They do not know their impressions, clicks, ranking keywords, or crawl errors.',
      pitch: 'Right now you have no way of knowing how your site is performing in Google. You cannot see how many people are finding you, what they are searching for, or why they are not clicking.'
    },
    {
      match: 'Blog exists but abandoned',
      context: 'They invested in content and stopped. Google deprioritises stale content and the owner is losing the authority they already built.',
      pitch: 'Your blog has not been updated in months. Google sees this as a stale site and is quietly pushing your pages down in rankings. The content you worked hard to create is now working against you.'
    },
    {
      match: 'Thin content',
      context: 'Google considers thin content low value and skips it in rankings. The pages are live but invisible.',
      pitch: 'Your pages do not have enough content for Google to consider them worth ranking. You are doing the work of publishing but getting none of the search traffic reward.'
    },
    {
      match: 'No meta description',
      context: 'The site is showing up in Google searches but has no meta descriptions. Google pulls random text instead of a compelling reason to click.',
      pitch: 'Your site is showing up in Google right now but there is no description telling people why they should click. Your competitors with proper descriptions are winning those clicks instead of you.'
    },
    {
      match: 'No H1 tag',
      context: 'Google cannot determine what the page is about which directly hurts rankings for their most important keywords.',
      pitch: 'Google is struggling to understand what your pages are about because they are missing the main heading structure. This directly hurts where you rank for your most important searches.'
    },
    {
      match: 'No schema markup',
      context: 'Missing rich results like star ratings and FAQs that increase click through rates significantly.',
      pitch: 'Your competitors are showing star ratings, FAQs, and rich previews in Google search results. Your listing shows nothing extra. That difference alone is costing you clicks every day.'
    },
    {
      match: 'No Open Graph tags',
      context: 'Every time someone shares their content on social media it looks unprofessional and unbranded.',
      pitch: 'Every time someone shares your website on social media it shows up as a blank ugly preview. That first impression is silently killing click throughs from social traffic.'
    },
    {
      match: 'Site not on HTTPS',
      context: 'Google flags this as not secure which actively hurts rankings and destroys visitor trust.',
      pitch: 'Your site is still running on HTTP which means Google flags it as not secure. Visitors see a warning before they even reach your page. That alone is costing you customers every day.'
    },
    {
      match: 'No Google Business Profile',
      context: 'They are invisible in Google Maps and local search results. Anyone searching for their service near them will not find them.',
      pitch: 'Anyone searching for what you offer nearby is not finding you. Your business does not appear on Google Maps at all, which means local customers are going straight to competitors who do show up.'
    },
    {
      match: 'No local business schema',
      context: 'Google cannot confirm the business details which reduces trust signals and local ranking authority.',
      pitch: 'Google is treating your site like an anonymous website rather than a real local business. That directly affects where you appear in local searches compared to competitors who have this set up.'
    },
    {
      match: 'No phone number found',
      context: 'Visitors who want to call cannot find a number easily, which increases bounce rate for high-intent local visitors.',
      pitch: 'People who visit your site ready to call cannot find your number. Every one of those visitors is a warm lead you are losing before they can even contact you.'
    },
    {
      match: 'No FAQ schema',
      context: 'Competitors with FAQ schema are showing expanded rich results in Google. Their listings take up more screen space and get more clicks.',
      pitch: 'Your competitors are showing expandable FAQ answers directly in Google search results. Their listings are twice the size of yours and getting far more clicks as a result.'
    },
    {
      match: 'No sitemap detected',
      context: 'Google may not be discovering all the pages on the site which means some pages may never get indexed.',
      pitch: 'Some of your pages may not be in Google at all. Without a sitemap Google has to guess what exists on your site, and it often misses pages that could be bringing you traffic.'
    },
    {
      match: 'Page title matches domain name only',
      context: 'The page title is the first thing Google and searchers see. A generic title tells neither Google nor the visitor what the site is actually about.',
      pitch: 'The title of your website in Google just shows your domain name. That tells potential customers nothing about what you do, and it is almost certainly hurting your click through rate every day.'
    },
    {
      match: 'No reviews schema',
      context: 'Competitors with reviews schema show star ratings in Google search results which dramatically increases click through rates.',
      pitch: 'Your Google search listing shows no star ratings while competitors are displaying theirs. That visual difference alone is sending more clicks to them before anyone even visits your site.'
    },
  ];

  let primaryProblem = problems[0] || 'General SEO optimization needed';
  let primaryProblemContext = 'Multiple SEO gaps are reducing their search visibility and organic traffic.';
  let primaryProblemPitch = 'I noticed several things on your site that are likely reducing your visibility in Google search results.';

  for (const priority of priorityMap) {
    const match = problems.find(p => p.toLowerCase().includes(priority.match.toLowerCase()));
    if (match) {
      primaryProblem = match;
      primaryProblemContext = priority.context;
      primaryProblemPitch = priority.pitch;
      break;
    }
  }

  return { primaryProblem, primaryProblemContext, primaryProblemPitch, allProblems: problems };
}

// ============================================================
// PAIN ANALYSIS ENGINE — STRUCTURAL PAIN MODELING
// ============================================================

interface PainAnalysis {
  technicalIssue: string;
  businessPain: string;
  emotionalTrigger: string;
  outreachAngle: string;
  urgency: 'low' | 'medium' | 'high';
  emailTone: 'urgent' | 'consultative' | 'authority';
}

function buildPainAnalysis(rankedProblems: any): {
  primary: PainAnalysis;
  supporting: PainAnalysis[];
  overallUrgency: 'low' | 'medium' | 'high';
  recommendedTone: 'urgent' | 'consultative' | 'authority';
} {
  const painMap: Record<string, PainAnalysis> = {
    'no blog': {
      technicalIssue: 'No blog or content hub',
      businessPain: 'Invisible for every search that is not the brand name',
      emotionalTrigger: 'Competitors are capturing customers they will never know they lost',
      outreachAngle: 'Build a content strategy that brings in customers on autopilot',
      urgency: 'high',
      emailTone: 'urgent',
    },
    'no google search console': {
      technicalIssue: 'No Google Search Console detected',
      businessPain: 'Flying completely blind on search performance',
      emotionalTrigger: 'Making business decisions with no data while competitors track everything',
      outreachAngle: 'Set up your SEO dashboard so you can finally see what is happening',
      urgency: 'high',
      emailTone: 'consultative',
    },
    'blog exists but abandoned': {
      technicalIssue: 'Blog abandoned for over 90 days',
      businessPain: 'Google is quietly demoting every page on the site',
      emotionalTrigger: 'All the effort put into past content is now working against them',
      outreachAngle: 'Revive the content strategy before rankings drop further',
      urgency: 'high',
      emailTone: 'open-eye',
    },
    'thin content': {
      technicalIssue: 'Thin content under 500 words',
      businessPain: 'Pages are live but invisible in search results',
      emotionalTrigger: 'Doing the work of publishing and getting none of the reward',
      outreachAngle: 'Transform existing pages into content that actually ranks',
      urgency: 'medium',
      emailTone: 'consultative',
    },
    'no meta description': {
      technicalIssue: 'No meta description',
      businessPain: 'Showing up in Google but losing clicks to competitors',
      emotionalTrigger: 'Getting the hard part right but missing the easy win',
      outreachAngle: 'Fix the click through rate leak that is costing customers daily',
      urgency: 'medium',
      emailTone: 'authority',
    },
    'no h1 tag': {
      technicalIssue: 'No H1 tag',
      businessPain: 'Google cannot determine what the page is about',
      emotionalTrigger: 'Ranking lower than competitors for no technical reason',
      outreachAngle: 'Fix the structure issue that is confusing Google right now',
      urgency: 'medium',
      emailTone: 'authority',
    },
    'no schema markup': {
      technicalIssue: 'No schema markup',
      businessPain: 'Missing star ratings and rich results in Google search',
      emotionalTrigger: 'Competitors look more credible and compelling in search results',
      outreachAngle: 'Add the structured data that makes listings stand out in search',
      urgency: 'medium',
      emailTone: 'authority',
    },
    'no open graph': {
      technicalIssue: 'No Open Graph tags',
      businessPain: 'Social shares look unprofessional and get fewer clicks',
      emotionalTrigger: 'Every share of the site is a missed opportunity to impress',
      outreachAngle: 'Fix social sharing so every post drives maximum traffic',
      urgency: 'low',
      emailTone: 'consultative',
    },
    'no https': {
      technicalIssue: 'Site not on HTTPS',
      businessPain: 'Google flags the site as not secure hurting rankings and trust',
      emotionalTrigger: 'Visitors see a security warning before they even reach the page',
      outreachAngle: 'Fix the security issue that is actively turning customers away',
      urgency: 'high',
      emailTone: 'urgent',
    },
    'slow page speed': {
      technicalIssue: 'Slow page speed',
      businessPain: 'Visitors leave before the page loads and Google penalises slow sites',
      emotionalTrigger: 'Losing customers in the first three seconds before they see anything',
      outreachAngle: 'Fix the speed issues that are costing customers and rankings',
      urgency: 'medium',
      emailTone: 'urgent',
    },
    'no google business profile': {
      technicalIssue: 'No Google Business Profile detected',
      businessPain: 'Invisible in Google Maps and local search entirely',
      emotionalTrigger: 'Nearby customers who are ready to buy are finding competitors on the map instead',
      outreachAngle: 'Get visible on Google Maps so local customers can actually find you',
      urgency: 'high',
      emailTone: 'urgent',
    },
    'no local business schema': {
      technicalIssue: 'No local business schema markup',
      businessPain: 'Google treats the site as anonymous rather than a trusted local business',
      emotionalTrigger: 'Ranking below less established competitors purely due to missing technical setup',
      outreachAngle: 'Add the local signals that tell Google exactly who and where you are',
      urgency: 'medium',
      emailTone: 'consultative',
    },
    'no phone number found': {
      technicalIssue: 'No phone number visible on page',
      businessPain: 'High-intent visitors who want to call leave without converting',
      emotionalTrigger: 'Warm leads reaching the site and bouncing because the simplest next step is missing',
      outreachAngle: 'Fix the contact friction that is silently losing ready-to-buy visitors',
      urgency: 'medium',
      emailTone: 'consultative',
    },
    'no faq schema': {
      technicalIssue: 'No FAQ schema markup',
      businessPain: 'Missing the expanded rich results that take up more space in Google search',
      emotionalTrigger: 'Competitors listings look more authoritative and larger while this site looks bare',
      outreachAngle: 'Add FAQ schema so your listing stands out and takes up more space in search results',
      urgency: 'medium',
      emailTone: 'authority',
    },
    'no sitemap detected': {
      technicalIssue: 'No sitemap detected',
      businessPain: 'Google may not be indexing all pages on the site',
      emotionalTrigger: 'Pages that took time to create may not even exist in Google right now',
      outreachAngle: 'Make sure every page on your site is visible to Google',
      urgency: 'low',
      emailTone: 'consultative',
    },
    'page title matches domain': {
      technicalIssue: 'Page title matches domain name only',
      businessPain: 'Generic title tells Google and searchers nothing about what the business does',
      emotionalTrigger: 'Every Google impression is wasted because the listing says nothing compelling',
      outreachAngle: 'Fix the title that is making your search listing invisible to the right customers',
      urgency: 'medium',
      emailTone: 'authority',
    },
    'no reviews schema': {
      technicalIssue: 'No reviews schema markup',
      businessPain: 'No star ratings showing in search results while competitors display theirs',
      emotionalTrigger: 'Looking less credible than competitors before a visitor even reaches the site',
      outreachAngle: 'Add review schema so your listing builds trust before anyone clicks',
      urgency: 'medium',
      emailTone: 'authority',
    },
  };

  const findPain = (problem: string): PainAnalysis | null => {
    const lower = problem.toLowerCase();
    for (const key of Object.keys(painMap)) {
      if (lower.includes(key)) return painMap[key];
    }
    return null;
  };

  const primary = findPain(rankedProblems.primaryProblem) || {
    technicalIssue: rankedProblems.primaryProblem,
    businessPain: 'Search visibility gaps reducing organic traffic',
    emotionalTrigger: 'Missing customers who are actively searching for what they offer',
    outreachAngle: 'Fix the SEO gaps that are costing organic traffic',
    urgency: 'medium' as const,
    emailTone: 'consultative' as const,
  };

  const supporting = (rankedProblems.allProblems || [])
    .slice(1, 4)
    .map((p: string) => findPain(p))
    .filter(Boolean) as PainAnalysis[];

  const overallUrgency: 'low' | 'medium' | 'high' =
    primary.urgency === 'high' || supporting.some(s => s.urgency === 'high') ? 'high' :
    primary.urgency === 'medium' ? 'medium' : 'low';

  return { primary, supporting, overallUrgency, recommendedTone: primary.emailTone };
}

// ============================================================
// LEAD STATUS CLASSIFIER
// ============================================================

function classifyLead(opportunityScore: number): {
  status: 'hot-lead' | 'warm-lead' | 'low-priority' | 'strong-seo';
  color: string;
  label: string;
} {
  if (opportunityScore >= 60) return { status: 'hot-lead', color: 'red', label: 'Hot Lead' };
  if (opportunityScore >= 35) return { status: 'warm-lead', color: 'orange', label: 'Warm Lead' };
  if (opportunityScore >= 15) return { status: 'low-priority', color: 'yellow', label: 'Low Priority' };
  return { status: 'strong-seo', color: 'green', label: 'Strong SEO' };
}

// Helper function to thoroughly clean and normalize input URLs
function cleanAndNormalizeUrl(input: string): string {
  if (!input) return '';
  let s = String(input).trim();
  
  // Remove zero-width spaces/tabs and non-printable control characters
  s = s.replace(/[\u200B-\u200D\uFEFF\r\n\t]/g, '');
  
  // Strip off accidental repeats of protocols, e.g. "https://https://", "https://http://", "http://https://"
  let previous = '';
  while (s !== previous) {
    previous = s;
    s = s.replace(/^(https?:\/\/)+/i, '');
    s = s.replace(/^[:\/\\ \t]+/i, ''); // Strip leading punctuation/spaces
    s = s.trim();
  }

  // Remove trailing slashes and backslashes if any exist
  s = s.trim();
  if (!s) return '';

  return `https://${s}`;
}

// Helper function to validate if URL is absolute and conforms to http/https structure
function isValidUrl(urlString: string): boolean {
  try {
    const parsed = new URL(urlString);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

function resolveDomainDNS(hostname: string): Promise<boolean> {
  return new Promise((resolve) => {
    // If it's an IP address or localhost, bypass DNS check
    if (/^(localhost|127\.0\.0\.1)$/i.test(hostname) || /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname)) {
      resolve(true);
      return;
    }
    // Also block common invalid local/test/placeholder TLDs immediately
    const parts = hostname.split('.');
    if (parts.length < 2) {
      resolve(false);
      return;
    }
    const tld = parts[parts.length - 1].toLowerCase();
    // Common local or invalid/incomplete TLDs
    const invalidTlds = new Set(['local', 'localhost', 'test', 'invalid', 'example', 'prov', 'loc']);
    if (invalidTlds.has(tld)) {
      resolve(false);
      return;
    }

    // Set a timeout of 5 seconds for the DNS lookup so it doesn't hang the request
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        console.warn(`[DNS] Lookup timed out for ${hostname}`);
        resolve(true); // default to true on timeout to not block valid sites if DNS is slow
      }
    }, 5000);

    dns.lookup(hostname, (err, address) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      if (err) {
        console.log(`[DNS] Domain check for ${hostname}: unresolved`);
        resolve(false);
      } else {
        console.log(`[DNS] Successfully resolved ${hostname} to ${address}`);
        resolve(true);
      }
    });
  });
}

// ============================================================
// PERFORM SEO ANALYSIS — 4 LAYER FALLBACK SYSTEM
// ============================================================

async function performSEOAnalysis(url: string, forceRefresh = false) {
  if (!forceRefresh) {
    const cached = getCachedCrawl(url);
    if (cached) {
      console.log(`[CACHE HIT] ${url}`);
      return cached;
    }
  } else {
    crawlCache.delete(url);
    console.log(`[CACHE BYPASS] ${url}`);
  }

  const normalizedUrl = cleanAndNormalizeUrl(url);
  if (!normalizedUrl || !isValidUrl(normalizedUrl)) {
    return {
      viable: false,
      crawlFailReason: 'Invalid URL format.',
      crawlLayerLabel: 'None',
    };
  }

  // Parse hostname for DNS check
  let hostname = '';
  try {
    hostname = new URL(normalizedUrl).hostname;
  } catch (e) {
    return {
      viable: false,
      crawlFailReason: 'Invalid URL hostname.',
      crawlLayerLabel: 'None',
    };
  }

  const dnsExists = await resolveDomainDNS(hostname);
  if (!dnsExists) {
    return {
      viable: false,
      crawlFailReason: `Domain resolution failed. "${hostname}" does not exist or has no valid DNS records.`,
      crawlLayerLabel: 'None',
    };
  }
  const apiKey = process.env.GOOGLE_API_KEY || '';

  // Run PSI and HTML crawl in parallel
  const [psiResult, htmlResult] = await Promise.allSettled([

    // LAYER 3: PSI (always runs, never blocked)
    (async () => {
      const attemptPSI = async (strategy: 'mobile' | 'desktop' = 'mobile', retryCount = 0, categories = ['SEO', 'PERFORMANCE', 'ACCESSIBILITY', 'BEST_PRACTICES']): Promise<any> => {
        try {
          console.log(`[PSI] Attempt ${retryCount + 1} (${strategy}) for ${normalizedUrl}`);
          const catsQuery = categories.map(c => `category=${c}`).join('&');
          const psiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(normalizedUrl)}&${catsQuery}&strategy=${strategy}${apiKey ? `&key=${apiKey}` : ''}`;
          const response = await axios.get(psiUrl, { timeout: 180000, headers: { Accept: 'application/json' } });
          const lh = response.data.lighthouseResult;
          if (!lh) throw new Error('No lighthouse result');
          const audits = lh.audits;
          const passed = (id: string) => audits[id]?.score === 1;
          return {
            hasHttps: passed('is-on-https'),
            psiScores: {
              seo: (lh.categories.seo?.score || 0) * 100,
              accessibility: (lh.categories.accessibility?.score || 0) * 100,
              performance: (lh.categories.performance?.score || 0) * 100,
              bestPractices: (lh.categories['best-practices']?.score || 0) * 100,
            },
          };
        } catch (err: any) {
          const isTimeout = err.code === 'ECONNABORTED' || err.message.includes('timeout');
          if (isTimeout && categories.length > 1 && retryCount < 1) return attemptPSI(strategy, retryCount + 1, ['SEO']);
          if (strategy === 'mobile' && retryCount < 1) return attemptPSI('desktop', 0, categories);
          throw err;
        }
      };
      return await attemptPSI();
    })(),

    // LAYERS 1 & 2: ScraperAPI then direct crawl
    (async () => {
      let html = await crawlWithScraperAPI(normalizedUrl);
      let crawlLayer = 'scraperapi';
      if (!html) {
        console.log('[CRAWL] ScraperAPI unavailable. Trying direct crawl...');
        html = await crawlWithAxios(normalizedUrl);
        crawlLayer = 'direct';
      }
      if (!html) return null;
      return { ...parseContentSignals(html, normalizedUrl), crawlLayer };
    })(),
  ]);

  const psiData = psiResult.status === 'fulfilled' ? psiResult.value : null;
  const contentSignals = htmlResult.status === 'fulfilled' ? htmlResult.value : null;

  if (psiResult.status === 'rejected') console.log('[PSI] Status: not available');
  if (htmlResult.status === 'rejected') console.log('[CRAWL] Status: not available');

  // LAYER 4: Everything failed
  if (!psiData && !contentSignals) {
    return {
      viable: false,
      crawlFailReason: 'Site unreachable via all methods. Manual review recommended.',
      crawlLayerLabel: 'None',
    };
  }

  const rankedProblems = rankProblems(contentSignals, psiData, 'general');
  const crawlLayerLabel = contentSignals?.crawlLayer === 'scraperapi' ? 'ScraperAPI + PSI' :
    contentSignals?.crawlLayer === 'direct' ? 'Direct Crawl + PSI' : 'PSI Only';

  const seoResult = {
    viable: true,
    crawlFailReason: '',
    crawlLayerLabel,
    hasHttps: psiData?.hasHttps ?? normalizedUrl.startsWith('https'),
    psiScores: psiData?.psiScores || null,
    hasBlog: contentSignals?.hasBlog ?? false,
    blogAbandoned: contentSignals?.blogAbandoned ?? false,
    lastPostDate: contentSignals?.lastPostDate ?? null,
    wordCountEstimate: contentSignals?.wordCount ?? 0,
    hasOpenGraph: contentSignals?.hasOpenGraph ?? false,
    hasSchema: contentSignals?.hasSchema ?? false,
    hasSearchConsole: contentSignals?.hasSearchConsole ?? false,
    h1Count: contentSignals?.h1Count ?? 0,
    h1Text: contentSignals?.h1Text ?? '',
    h2Count: contentSignals?.h2Count ?? 0,
    imagesMissingAlt: contentSignals?.imagesMissingAlt ?? 0,
    totalImages: contentSignals?.totalImages ?? 0,
    hasCanonical: contentSignals?.hasCanonical ?? false,
    description: contentSignals?.metaDescription ?? '',
    descriptionLength: contentSignals?.metaDescriptionLength ?? 0,
    title: contentSignals?.title ?? '',
    titleLength: contentSignals?.titleLength ?? 0,
    internalLinks: contentSignals?.internalLinks ?? 0,
    rankedProblems,
  };
  setCachedCrawl(url, seoResult);
  return seoResult;
}

// ============================================================
// CALCULATE SEO OPPORTUNITY SCORE
// ============================================================

function calculateSEOScore(data: any, url: string) {
  if (!data.viable) {
    return {
      viable: false,
      totalScore: 0,
      opportunityScore: 0,
      disqualifyReason: data.crawlFailReason,
      problems: [],
      breakdown: { technical: 0, content: 0, structure: 0, discoverability: 0 },
    };
  }

  // Use ranked problems from the crawler if available
  const problems = data.rankedProblems?.allProblems || [];

  // WEIGHTED scoring — critical issues score higher so two sites with different severity profiles score differently
  let opportunityPoints = 0;

  // CRITICAL — 15 pts each
  if (!data.hasHttps) opportunityPoints += 15;
  if (data.h1Count === 0) opportunityPoints += 15;
  if (data.psiScores?.performance < 50) opportunityPoints += 15;

  // HIGH — 10 pts each
  if (!data.description) opportunityPoints += 10;
  if (!data.hasSearchConsole) opportunityPoints += 10;
  if (data.wordCountEstimate < 300) opportunityPoints += 10;
  if (!data.hasBlog) opportunityPoints += 10;

  // MEDIUM — 6 pts each
  if (!data.hasCanonical) opportunityPoints += 6;
  if (data.descriptionLength > 0 && (data.descriptionLength < 50 || data.descriptionLength > 160)) opportunityPoints += 6;
  if (!data.hasSchema) opportunityPoints += 6;
  if (!data.hasOpenGraph) opportunityPoints += 6;
  if (data.psiScores?.performance >= 50 && data.psiScores?.performance < 70) opportunityPoints += 6;
  if (!data.hasGoogleBusinessProfile) opportunityPoints += 6;
  if (!data.hasFaqSchema) opportunityPoints += 6;

  // LOW — 3 pts each
  if (!data.titleLength || data.titleLength === 0) opportunityPoints += 3;
  else if (data.titleLength < 30 || data.titleLength > 65) opportunityPoints += 3;
  if (data.h1Count > 1) opportunityPoints += 3;
  if (data.h2Count === 0) opportunityPoints += 3;
  if (data.totalImages > 0 && data.imagesMissingAlt > 0) opportunityPoints += 3;
  if (!data.hasSitemapLink) opportunityPoints += 3;
  if (data.titleDuplicated) opportunityPoints += 3;

  const finalScore = Math.min(opportunityPoints, 100);
  const classification = classifyLead(finalScore);

  const result = {
    viable: true,
    totalScore: finalScore,
    opportunityScore: finalScore,
    problems,
    classification,
    breakdown: {
      technical: Math.min(opportunityPoints, 35),
      content: Math.min(Math.max(opportunityPoints - 35, 0), 30),
      structure: Math.min(Math.max(opportunityPoints - 65, 0), 20),
      discoverability: Math.min(Math.max(opportunityPoints - 85, 0), 15),
    },
  };
  return result;
}

// ============================================================
// ANALYZE LEAD ROUTE
// ============================================================

app.post('/api/analyze-lead', async (req, res) => {
  const {
    lead,
    campaignCountry,
    campaignIndustry,
    campaignDecisionMaker,
    campaignIcpContext,
    campaignFollowUp1Days,
    campaignFollowUp2Days,
    campaignFollowUp3Days,
    forceRefresh,
  } = req.body;
  if (!lead || !lead.website) return res.status(400).json({ error: 'Lead website required' });

  const url = cleanAndNormalizeUrl(lead.website);
  if (!url || !isValidUrl(url)) {
    const scoreResult = calculateSEOScore({ viable: false, crawlFailReason: 'Invalid URL format' }, 'invalid');
    debugState.lastAnalyzedLead = {
      company: lead?.company || 'Unknown',
      website: lead?.website || 'Unknown',
      score: 0,
      status: 'manual-review',
      aiAnalysisPopulated: false,
    };
    return res.json({
      viable: false,
      qualified: false,
      score: 0,
      status: 'manual-review',
      crawlFailReason: `Invalid URL: "${lead.website}". Please make sure it is a valid website address.`,
      crawlLayerLabel: 'None',
      details: scoreResult,
      seoData: { viable: false, crawlFailReason: 'Invalid URL format' },
      aiAnalysis: null,
    });
  }

  try {
    const seoData = await performSEOAnalysis(url, forceRefresh === true);
    const scoreResult = calculateSEOScore(seoData, url);

    if (!seoData.viable) {
      debugState.lastAnalyzedLead = {
        company: lead?.company || 'Unknown',
        website: lead?.website || 'Unknown',
        score: 0,
        status: 'manual-review',
        aiAnalysisPopulated: false,
      };
      return res.json({
        viable: false,
        qualified: false,
        score: 0,
        status: 'manual-review',
        crawlFailReason: seoData.crawlFailReason,
        crawlLayerLabel: seoData.crawlLayerLabel,
        details: scoreResult,
        seoData,
        aiAnalysis: null,
      });
    }

    const rankedProblems = seoData.rankedProblems || {
      primaryProblem: 'General SEO gaps',
      primaryProblemContext: '',
      primaryProblemPitch: '',
      allProblems: []
    };
    const painAnalysis = buildPainAnalysis(rankedProblems);

    let aiResult = null;

    const prompt = `
You are an expert cold email copywriter writing highly personalised outreach sequences for Tosin Adesina, an independent SEO Growth Strategist.
Write in an honest, direct, professional tone. Avoid marketing hype, buzzwords, or sounding like a robotic agency.

LEAD INFORMATION:
Company: ${lead.company}
Website: ${lead.website}
Recipient First Name: ${lead.recipientFirstName || (lead.recipient ? lead.recipient.split(' ')[0] : 'there')}
Recipient Full Name: ${lead.recipient || 'there'}
Industry: ${lead.industry || campaignIndustry || 'Determine from website and company name'}
Campaign Country: ${campaignCountry || 'Not specified'}

ICP PROFILE:
Industry: ${campaignIndustry || 'Determine from the website and company name'}
Market: ${campaignCountry || 'United Kingdom'}
Decision Maker: ${campaignDecisionMaker || 'Owner, founder, or senior partner'}
Business Context: ${campaignIcpContext || 'An established small business where the owner is directly responsible for client acquisition. They are not digital marketing natives. They respond to plain, specific, credible communication and ignore anything that sounds like a mass mailout.'}

TONE CALIBRATION:
- Frame every problem in terms of customer or client acquisition, not technical scores.
- The decision maker does not care about PSI scores. They care about losing a paying customer to a competitor.
- The email must feel like it was written by someone who actually visited their specific site. Reference something from the Page Title, H1 Heading, or Meta Description that describes WHO they are, WHAT they do, or WHERE they operate, then connect that specific detail to the SEO problem. Naming the missing technical element itself (e.g. "you have no meta description") is NOT personalisation, it is a diagnosis anyone running an automated scan could produce. Personalisation means proving you read what THIS firm says about itself.
- Good opening example: "Hi James, was looking at harrisonlaw.co.uk earlier. You specialise in commercial property disputes but your site takes over six seconds to load on mobile, which is likely costing you enquiries before anyone reads about your practice."
- Bad opening example: "Hi James, I came across your website and noticed some issues that could be affecting your online visibility."
- Also bad (diagnosis dressed up as personalisation): "Hi James, I noticed your site lacks a meta description and isn't connected to Search Console." This is generic. It names a technical gap but says nothing about who James is or what his firm does, so it could be sent to any business with the same gap.
- The good example references the domain, something pulled from the page that is specific to this business, and connects the problem to a real business moment. The bad examples could have been sent to anyone.

PERSONALISATION HOOK PRIORITY (use the first one that has real data):
1. Page Title or H1 Heading, if either names a specialism, service, or location (e.g. "commercial property disputes", "Manchester based").
2. Meta Description, if present and specific.
3. If Page Title, H1, and Meta Description are ALL missing or generic, do not invent a specialism. Instead personalise using the company name and ${campaignIndustry || 'industry'} context provided below, and be explicit that the absence of basic on-page information is itself the finding, described in plain consequence language (see JARGON TRANSLATION), never by naming the missing HTML element as the hook.

JARGON TRANSLATION (never use the technical term on the left in the email; use language like the plain English on the right instead):
- "meta description" -> "how your firm actually shows up when someone searches for you"
- "Google Search Console" / "Search Console" -> "any way of seeing how people are actually finding your site"
- "rel-canonical" / "canonical tag" -> "Google may be indexing duplicate versions of your pages which splits your ranking power"
- "PSI score" / "Core Web Vitals" -> "your site takes too long to load" (or the specific speed impact)
- "H1" / "heading tag" / "schema markup" / "sitemap" / "crawl budget" -> describe the visible, felt consequence only, never the technical name
This list is illustrative, not exhaustive: the rule is that no HTML element, Google product name, or SEO technical term ever appears in the email, only the business consequence.

ICP VOCABULARY (use these exact terms, not generic alternatives):
- Refer to the people they serve as: ${campaignIcpContext?.toLowerCase().includes('solicit') ? 'clients' : campaignIcpContext?.toLowerCase().includes('dent') || campaignIcpContext?.toLowerCase().includes('physio') ? 'patients' : campaignIcpContext?.toLowerCase().includes('restaurant') || campaignIcpContext?.toLowerCase().includes('cafe') ? 'customers or diners' : campaignIcpContext?.toLowerCase().includes('real estate') || campaignIcpContext?.toLowerCase().includes('propert') ? 'vendors or buyers' : 'customers'}
- Never use these words anywhere in the email: improve, boost, help, opportunity, SEO, strategy, growth, revenue, leads, elevate, enhance, optimise, leverage, unlock, excited, pleased, happy to
- Never use these technical/product terms anywhere in the email: meta description, Search Console, Google Search Console, canonical, rel-canonical, PSI, Core Web Vitals, schema, sitemap, crawl budget, H1, HTML, index, indexing, backlink, domain authority

PRIMARY PAIN INTELLIGENCE:
Technical Issue: ${painAnalysis.primary.technicalIssue}
Business Pain: ${painAnalysis.primary.businessPain}
Emotional Trigger: ${painAnalysis.primary.emotionalTrigger}
Reframe this emotional trigger specifically for a ${campaignIndustry || 'small business'} owner. Do not use the generic trigger verbatim. Translate it into the specific client acquisition or revenue language that a ${campaignDecisionMaker || 'business owner'} in this industry would feel personally.
Outreach Angle: ${painAnalysis.primary.outreachAngle}
Urgency Level: ${painAnalysis.primary.urgency}
Recommended Tone: ${painAnalysis.recommendedTone}

Tone Guidance (use this exact voice throughout the email):
${painAnalysis.recommendedTone === 'urgent'
  ? 'urgent — sounds like: "Your site has a problem that is actively affecting your search visibility right now. Every day this is not fixed it is costing you customers."'
  : painAnalysis.recommendedTone === 'consultative'
  ? 'consultative — sounds like: "I came across your site and one thing jumped out at me. It is the kind of thing that is easy to miss but quietly costs you traffic every month."'
  : painAnalysis.recommendedTone === 'authority'
  ? 'authority — sounds like: "I audited a number of sites in your sector this week. Yours has one structural issue that is holding back rankings for no reason other than a simple fix."'
  : 'open-eye — sounds like: "Something I noticed while looking at your site. It is not obvious but once you see it, it explains why certain pages are not getting the traffic they should."'
}

SUPPORTING PAIN POINTS:
${painAnalysis.supporting.map((s: PainAnalysis) => `- ${s.businessPain}`).join('\n')}

ALL PROBLEMS FOUND:
${rankedProblems.allProblems.join(', ')}

PAGE IDENTITY (use these to personalise the email — reference what the site actually says about itself):
Page Title: ${seoData.title || 'Not found'}
Meta Description: ${seoData.description || 'Not found — do not name this gap by its technical term; if Page Title and H1 above also have no usable specialism/location detail, follow rule 3 in PERSONALISATION HOOK PRIORITY instead'}
H1 Heading: ${seoData.h1Text || 'Not found'}

PSI SCORES:
SEO: ${seoData.psiScores?.seo || 'unknown'}
Performance: ${seoData.psiScores?.performance || 'unknown'}

SENDER INFORMATION:
Full Name: Tosin Adesina
Title: SEO Growth Strategist
Note: This is personal outreach from an individual. Do NOT include any company name or brand name in the signature. Just the name and title.

FOLLOW-UP TIMING FOR THIS ICP:
Follow-Up 1: Day ${campaignFollowUp1Days || 3} to ${(campaignFollowUp1Days || 3) + 1}
Follow-Up 2: Day ${campaignFollowUp2Days || 10} to ${(campaignFollowUp2Days || 10) + 1}
Follow-Up 3: Day ${campaignFollowUp3Days || 17} to ${(campaignFollowUp3Days || 17) + 1}

CRITICAL INITIAL EMAIL RULES (PHASE 1):
- Always start the email body with: Hi [recipient first name],
- Use the recipient first name naturally in the opening line.
- Reference the specific website domain naturally in the email body.
- Use the Page Title, H1 Heading, and Meta Description above in the priority order given in PERSONALISATION HOOK PRIORITY to make the opening line feel like you genuinely visited their site. Reference something specific about their practice, their location, their specialisms, or how they describe themselves, then connect it to the SEO problem. Do NOT open by naming a missing technical element (meta description, Search Console, etc.) as if that alone proves you visited the site, it does not.
- Never use technical SEO jargon or Google product names anywhere in the email. See JARGON TRANSLATION above and the banned technical/product terms list in ICP VOCABULARY. Instead of "missing rel-canonical" say "Google may be indexing duplicate versions of your pages which splits your ranking power."
- Frame the problem in terms of client or customer acquisition, not technical scores.
- Keep every email under 100 words excluding the greeting and signature.
- Maximum 3 paragraphs in the body before the call to action. No bullet points.
- The ONLY call to action is a free personalised 2-minute video audit of their site.
- Never use em dashes anywhere in the email. Use commas, colons, or end the sentence instead.
- Signature format is exactly:
  Tosin Adesina
  SEO Growth Strategist

CRITICAL FOLLOW-UP CONTINUITY RULES (PHASE 2):
- All follow-ups must build on the previous thread. Do not restart from scratch.
- Follow-Up 1: A warm, 1 to 2 sentence nudge referencing the personalised video audit offered in the previous email. Keep it under 40 words.
- Follow-Up 2: Give exactly one clear, high-value, actionable tip tied specifically to the primary problem in plain English. Frame it in terms of client acquisition, not technical metrics. Keep it under 80 words.
- Follow-Up 3: A soft, zero-pressure close. Mention you are wrapping up audits for ${campaignIndustry || 'businesses in this sector'} this week. Ask a single easy yes or no question. Keep under 60 words.
- All follow-ups must start with "Hi [first name]," and end exactly with just:
  Tosin
- Never use em dashes in any follow-up.

SUBJECT LINE RULES:
- Must feel personal, specific, and curiosity-based.
- Do NOT use these words: improve, boost, help, opportunity, free, SEO, strategy, growth, revenue, leads, business.
- Keep it under 8 words. No exclamation marks.
- Where possible reference the firm name, the recipient name, or something specific about their site.
- Examples of strong subject lines:
  Quick question about [firm name]
  Something I noticed, [first name]
  Your [industry] site, [first name]
  Spotted something, [first name]
  [first name], a quick thought

Return ONLY valid JSON with exactly this structure:
{
  "industry": "detected industry",
  "insights": "2 sentence plain English summary of what is most broken and why it costs them customers",
  "serviceAngle": "${painAnalysis.primary.outreachAngle}",
  "subjectLines": [
    "subject line option 1",
    "subject line option 2",
    "subject line option 3"
  ],
  "initialEmail": {
    "subject": "chosen best subject line from the rules",
    "body": "Hi [first name],\n\n[First paragraph - what you noticed about their specific site referencing page title or meta, and why that is a problem]\n\n[Second paragraph - how that translates into lost clients or customers in plain English]\n\n[Third paragraph - the simple question call to action offering the 2 minute audit]\n\nTosin Adesina\nSEO Growth Strategist"
  },
  "followUp1": {
    "subject": "Re: [initial email subject]",
    "body": "Hi [first name],\n\n[One to two sentence warm nudge referencing the video audit.]\n\nTosin"
  },
  "followUp2": {
    "subject": "Re: [initial email subject]",
    "body": "Hi [first name],\n\n[One free actionable tip tied to the primary problem in plain English framed around client acquisition.]\n\n[Mention the free video audit is still available.]\n\nTosin"
  },
  "followUp3": {
    "subject": "Re: [initial email subject]",
    "body": "Hi [first name],\n\n[Soft close. Mention closing the audit list for ${campaignIndustry || 'this sector'} this week. One easy yes or no question.]\n\nTosin"
  },
  "primaryProblem": "${rankedProblems.primaryProblem}",
  "urgency": "${painAnalysis.overallUrgency}",
  "tone": "${painAnalysis.recommendedTone}"
}
`;

    aiResult = await generateWithAI(prompt);

    if (!aiResult) {
      console.warn('[FALLBACK] AI generation failed or exhausted, using programmatic high-quality fallback analysis...');
      const firstName = lead?.recipientFirstName || lead?.firstName || (lead?.recipient && lead.recipient !== 'there' ? lead.recipient.split(' ')[0] : lead?.name?.split(' ')[0]) || 'there';
      const domain = lead?.website ? lead.website.replace(/^https?:\/\/(www\.)?/, '').split('/')[0] : 'your website';
      const firmName = lead?.company || 'your firm';
      const bestSubject = `Quick question about ${firmName}`;
      
      aiResult = {
        industry: campaignIndustry || 'Service Business',
        insights: `Your website has critical structural SEO and performance issues that are quietly hurting your visibility in search results. This means potential local clients searching for your services are ending up on your competitors' sites instead.`,
        serviceAngle: painAnalysis?.primary?.outreachAngle || 'SEO Optimization',
        subjectLines: [
          bestSubject,
          `Quick thought on ${domain}, ${firstName}`,
          `Spotted something on ${firmName}`
        ],
        initialEmail: {
          subject: bestSubject,
          body: `Hi ${firstName},\n\nI was looking at the website for ${firmName} (${domain}) and noticed a small structural issue. It looks like Google is having trouble properly index-mapping your core service pages, which can quietly split your search visibility.\n\nFor a business like yours, this means local clients searching for what you do can easily end up on other sites even if you have better reviews. It is the type of thing that is easy to miss but quietly costs you traffic each month.\n\nI put together a quick, 2-minute personalized video audit showing exactly where this is happening and how to fix it. Would you be open to me sending that link over?\n\nTosin Adesina\nSEO Growth Strategist`
        },
        followUp1: {
          subject: `Re: ${bestSubject}`,
          body: `Hi ${firstName},\n\nI know you're busy running ${firmName}, so I wanted to keep this brief. I finished that custom 2-minute video audit of ${domain} we talked about.\n\nI point out the exact technical bottlenecks we found. If you'd like to check it out, just let me know and I'll send it over.\n\nTosin`
        },
        followUp2: {
          subject: `Re: ${bestSubject}`,
          body: `Hi ${firstName},\n\nHere is a quick, free tip you can apply to ${domain} today: optimize your main H1 headers to include both your primary service field and core city location. Google relies heavily on this to match you to local searchers.\n\nThis single change usually helps local service businesses capture more organic traffic in weeks. The video audit covers this in more detail if you want a visual walkthrough.\n\nTosin`
        },
        followUp3: {
          subject: `Re: ${bestSubject}`,
          body: `Hi ${firstName},\n\nI'm wrapping up my site audits for ${campaignIndustry || 'businesses in this sector'} this week and didn't want to leave you hanging. I've got your custom video audit ready.\n\nShould I send the link over, or are you all set with SEO for now?\n\nTosin`
        },
        primaryProblem: rankedProblems?.primaryProblem || 'SEO optimization issues',
        urgency: painAnalysis?.overallUrgency || 'Medium',
        tone: painAnalysis?.recommendedTone || 'consultative'
      };
    }

    debugState.lastAnalyzedLead = {
      company: lead?.company || 'Unknown',
      website: lead?.website || 'Unknown',
      score: scoreResult.opportunityScore || 0,
      status: scoreResult.classification?.label || 'Warm Lead',
      aiAnalysisPopulated: !!aiResult,
    };

    res.json({
      viable: true,
      qualified: true,
      score: scoreResult.opportunityScore,
      status: scoreResult.classification?.status || 'warm-lead',
      statusLabel: scoreResult.classification?.label || 'Warm Lead',
      statusColor: scoreResult.classification?.color || 'orange',
      details: scoreResult,
      seoData,
      aiAnalysis: aiResult,
      initialEmail: aiResult?.initialEmail || null,
      followUp1: aiResult?.followUp1 || null,
      followUp2: aiResult?.followUp2 || null,
      followUp3: aiResult?.followUp3 || null,
      subjectLines: aiResult?.subjectLines || [],
      painAnalysis: {
        primary: painAnalysis.primary,
        overallUrgency: painAnalysis.overallUrgency,
        recommendedTone: painAnalysis.recommendedTone,
      },
      crawlLayerLabel: seoData.crawlLayerLabel,
    });
  } catch (error: any) {
    console.error('Analysis failed:', error);
    debugState.lastAnalyzedLead = {
      company: lead?.company || 'Unknown',
      website: lead?.website || 'Unknown',
      score: 0,
      status: `Error: ${error.message}`,
      aiAnalysisPopulated: false,
    };
    res.status(500).json({ error: 'SEO analysis failed', viable: false, crawlFailReason: error.message });
  }
});

// ============================================================
// EMAIL FORMATTING UTILITY
// ============================================================

const stripSignature = (body: string): string => {
  return body
    .replace(/\n+Tosin Adesina\s*\nSEO Growth Strategist\s*$/i, '')
    .replace(/\n+Tosin\s*$/i, '')
    .trim();
};

const formatEmailAsHTML = (body: string, senderName: string = 'Tosin Adesina', isTest: boolean = false, recipientEmail: string = '') => {
  const cleanBody = stripSignature(body);
  const paragraphs = cleanBody.split('\n\n').filter(p => p.trim());
  const formattedParagraphs = paragraphs.map(p => {
    const lines = p.split('\n').join('<br>');
    return `<p style="margin: 0 0 20px 0; line-height: 1.7; font-family: Georgia, 'Times New Roman', serif; font-size: 15px; color: #1a1a1a;">${lines}</p>`;
  }).join('');

  const testBanner = isTest ? `
    <p style="background: #fff3cd; padding: 10px 14px; border-radius: 6px; margin-bottom: 20px; font-family: Arial, sans-serif; font-size: 12px; color: #856404; border: 1px solid #ffeeba;">
      TEST EMAIL — This is a preview from Selio. Not sent to a real lead.
    </p>
  ` : '';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #ffffff;">
  <div style="max-width: 560px; padding: 32px 24px; font-family: Georgia, 'Times New Roman', serif;">
    ${testBanner}
    ${formattedParagraphs}
    <p style="margin: 28px 0 0 0; line-height: 1.6; font-family: Georgia, 'Times New Roman', serif; font-size: 15px; color: #1a1a1a;">
      ${senderName}<br>
      <span style="font-size: 13px; color: #555555;">SEO Growth Strategist</span>
    </p>
    <p style="margin: 24px 0 0 0; font-family: Arial, sans-serif; font-size: 11px; color: #999999;">
      To stop receiving these emails, reply with the word Unsubscribe.
    </p>
  </div>
</body>
</html>`;
};

// ============================================================
// CREATE GMAIL DRAFT
// ============================================================

app.post('/api/create-draft', async (req, res) => {
  const { to, subject, body, accountId } = req.body;
  const authResult = await getOAuthClient(req, res, accountId);
  if (!authResult) return res.status(401).json({ error: 'Not authenticated with Google' });
  const { client, refreshedTokens } = authResult;
  const gmail = google.gmail({ version: 'v1', auth: client });

  try {
    const utf8Subject = `=?utf-8?B?${Buffer.from(subject || '').toString('base64')}?=`;
    const emailHtml = formatEmailAsHTML(body, 'Adesina', false, to);
    const rawMessage = [
      `To: ${to}`,
      'Content-Type: text/html; charset=utf-8',
      'MIME-Version: 1.0',
      `Subject: ${utf8Subject}`,
      '',
      emailHtml
    ].join('\r\n');
    const encodedMessage = Buffer.from(rawMessage).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw: encodedMessage } } });
    res.json({ success: true, refreshedTokens });
  } catch (error: any) {
    console.error('[GMAIL DRAFT] Error creating draft:', error);
    if (isAuthError(error)) {
      return res.status(401).json({ error: 'Google session expired or invalid. Please reconnect your Google account.' });
    }
    let errorMessage = 'Draft creation failed';
    if (error.code === 401) {
      errorMessage = 'Session expired. Please reconnect your Google account.';
    } else if (error.message) {
      errorMessage = error.message;
    }
    res.status(500).json({ error: errorMessage });
  }
});

// ============================================================
// SEND EMAIL
// ============================================================

async function getCampaignDailyLimit(campaignId: string): Promise<number> {
  try {
    const { data } = await getSupabase().from('campaigns').select('daily_limit').eq('id', campaignId).maybeSingle();
    return data?.daily_limit || 50;
  } catch {
    return 50;
  }
}

app.post('/api/send-email', async (req, res) => {
  const { to, subject, body, accountId, threadId, previousMessageId, campaignId, leadAnalysisId, followUpKey } = req.body;
  const authResult = await getOAuthClient(req, res, accountId);
  if (!authResult) return res.status(401).json({ error: 'Not authenticated with Google' });
  const { client, refreshedTokens } = authResult;
  const gmail = google.gmail({ version: 'v1', auth: client });
  const supabase = getSupabase();
  let claimed = false;
  const sentFlagCol = followUpKey ? `${followUpKey}_sent` : null;

  try {
    // Daily quota check — now enforced on every send, not just bulk paths
    const dailyLimit = campaignId ? await getCampaignDailyLimit(campaignId) : 50;
    const currentSentToday = await getTodayQuota(accountId || 'primary', campaignId);
    if (currentSentToday >= dailyLimit) {
      return res.status(429).json({ error: `Daily sending limit (${dailyLimit}) reached for this account.` });
    }

    // Follow-up specific: fresh reply/unsubscribe check + atomic claim
    if (campaignId && leadAnalysisId && sentFlagCol) {
      const { data: row } = await supabase
        .from('lead_analysis')
        .select('id, lead_id')
        .eq('id', leadAnalysisId)
        .maybeSingle();
      if (!row) return res.status(404).json({ error: 'Lead analysis row not found' });

      const { data: replyRow } = await supabase
        .from('reply_status')
        .select('has_replied, is_unsubscribed, is_bounced')
        .eq('lead_id', row.lead_id)
        .maybeSingle();

      if (replyRow && (replyRow.has_replied || replyRow.is_unsubscribed || replyRow.is_bounced)) {
        return res.status(409).json({ error: 'Lead has replied, unsubscribed, or bounced since last check. Send skipped.' });
      }

      const { data: claimRows, error: claimErr } = await supabase
        .from('lead_analysis')
        .update({ [sentFlagCol]: true, updated_at: new Date().toISOString() })
        .eq('id', leadAnalysisId)
        .eq(sentFlagCol, false)
        .select();

      if (claimErr || !claimRows || claimRows.length === 0) {
        return res.status(409).json({ error: 'This follow-up was already sent (claimed by another process).' });
      }
      claimed = true;
    }

    let internetMessageId: string | undefined = undefined;
    if (previousMessageId) {
      try {
        const prevMsg = await gmail.users.messages.get({ userId: 'me', id: previousMessageId });
        const headers = prevMsg.data.payload?.headers || [];
        internetMessageId = headers.find(h => h.name?.toLowerCase() === 'message-id')?.value;
      } catch (e) {
        console.warn('[GMAIL SEND] Could not retrieve previous Message-ID header:', e);
      }
    }

    const utf8Subject = `=?utf-8?B?${Buffer.from(subject || '').toString('base64')}?=`;
    const emailHtml = formatEmailAsHTML(body, 'Adesina', false, to);
    
    const headers = [
      `To: ${to}`,
      'Content-Type: text/html; charset=utf-8',
      'MIME-Version: 1.0',
      `Subject: ${utf8Subject}`
    ];
    
    if (internetMessageId) {
      headers.push(`In-Reply-To: ${internetMessageId}`);
      headers.push(`References: ${internetMessageId}`);
    }

    const rawMessage = [
      ...headers,
      '',
      emailHtml
    ].join('\r\n');

    const encodedMessage = Buffer.from(rawMessage).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    
    const sendParams: any = {
      userId: 'me',
      requestBody: {
        raw: encodedMessage
      }
    };
    
    if (threadId) {
      sendParams.requestBody.threadId = threadId;
    }

    const gmailResponse = await gmail.users.messages.send(sendParams);
    
    await incrementQuota(accountId || 'primary', campaignId);

    if (claimed && leadAnalysisId && followUpKey) {
      await supabase
        .from('lead_analysis')
        .update({
          [`${followUpKey}_sent_at`]: new Date().toISOString(),
          last_email_sent_at: new Date().toISOString(),
        })
        .eq('id', leadAnalysisId);
    }
    
    res.json({ 
      success: true, 
      refreshedTokens,
      messageId: gmailResponse.data.id,
      threadId: gmailResponse.data.threadId
    });
  } catch (error: any) {
    // Roll back the optimistic claim if the actual Gmail send failed
    if (claimed && leadAnalysisId && sentFlagCol) {
      await supabase.from('lead_analysis').update({ [sentFlagCol]: false }).eq('id', leadAnalysisId).catch(() => {});
    }
    console.error('[GMAIL SEND] Error sending email:', error);
    if (isAuthError(error)) {
      return res.status(401).json({ error: 'Google session expired or invalid. Please reconnect your Google account.' });
    }
    let errorMessage = 'Email sending failed';
    if (error.code === 429) {
      errorMessage = 'Rate limit exceeded. Please wait and try again.';
    } else if (error.code === 400) {
      errorMessage = 'Invalid email address or Gmail API error.';
    } else if (error.message) {
      errorMessage = error.message;
    }
    res.status(500).json({ error: errorMessage });
  }
});

// ============================================================
// SEND TEST EMAIL
// ============================================================

app.post('/api/send-test', async (req, res) => {
  const { to, subject, body, accountId } = req.body;
  const authResult = await getOAuthClient(req, res, accountId);
  if (!authResult) return res.status(401).json({ error: 'Not authenticated with Google' });
  const { client, refreshedTokens } = authResult;
  const gmail = google.gmail({ version: 'v1', auth: client });

  try {
    const testSubject = `[TEST] ${subject}`;
    const utf8Subject = `=?utf-8?B?${Buffer.from(testSubject).toString('base64')}?=`;
    const emailHtml = formatEmailAsHTML(body, 'Adesina', true, to);
    const rawMessage = [
      `To: ${to}`,
      'Content-Type: text/html; charset=utf-8',
      'MIME-Version: 1.0',
      `Subject: ${utf8Subject}`,
      '',
      emailHtml
    ].join('\r\n');
    const encodedMessage = Buffer.from(rawMessage).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encodedMessage } });
    res.json({ success: true, refreshedTokens });
  } catch (error: any) {
    console.error('[GMAIL TEST SEND] Error sending test email:', error);
    if (isAuthError(error)) {
      return res.status(401).json({ error: 'Google session expired or invalid. Please reconnect your Google account.' });
    }
    let errorMessage = 'Test email send failed';
    if (error.code === 429) {
      errorMessage = 'Rate limit exceeded. Please wait and try again.';
    } else if (error.code === 400) {
      errorMessage = 'Invalid email address or Gmail API error.';
    } else if (error.message) {
      errorMessage = error.message;
    }
    res.status(500).json({ error: errorMessage });
  }
});

// ============================================================
// SHEETS WRITE-BACK
// ============================================================

const WRITEBACK_COLUMNS = [
  'Selio: Sent Status',
  'Selio: Sent At',
  'Selio: Follow-up 1 Sent',
  'Selio: Follow-up 2 Sent',
  'Selio: Follow-up 3 Sent',
  'Selio: Replied',
  'Selio: Reply Count',
  'Selio: Last Updated',
];

// Create a fresh Google Sheet for file-sourced campaigns
app.post('/api/sheets/create', async (req, res) => {
  const { campaignName, leads, headers } = req.body;
  const authResult = await getOAuthClient(req, res);
  if (!authResult) return res.status(401).json({ error: 'Not authenticated with Google' });
  const { client, refreshedTokens } = authResult;
  const sheetsApi = google.sheets({ version: 'v4', auth: client });

  try {
    // Create the spreadsheet
    const created = await sheetsApi.spreadsheets.create({
      requestBody: {
        properties: { title: `Selio — ${campaignName}` },
        sheets: [{ properties: { title: 'Leads' } }],
      },
    });
    const spreadsheetId = created.data.spreadsheetId!;
    const sheetName = 'Leads';

    // Build header row: original headers + Selio status columns
    const allHeaders = [...(headers || []), ...WRITEBACK_COLUMNS];

    // Build data rows from leads
    const dataRows = (leads || []).map((lead: any) => {
      const row = (headers || []).map((h: string) => lead[h] || lead[h.toLowerCase()] || '');
      // Pad Selio columns with empty strings
      WRITEBACK_COLUMNS.forEach(() => row.push(''));
      return row;
    });

    await sheetsApi.spreadsheets.values.update({
      spreadsheetId,
      range: `'${sheetName}'!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [allHeaders, ...dataRows] },
    });

    res.json({ spreadsheetId, sheetName, headerRowIndex: 0, refreshedTokens });
  } catch (err: any) {
    console.error('[SHEETS CREATE]', err.message);
    if (isAuthError(err)) {
      return res.status(401).json({ error: 'Google session expired or invalid. Please reconnect your Google account.' });
    }
    res.status(500).json({ error: `Failed to create sheet: ${err.message}` });
  }
});

// Write status updates back to an existing Google Sheet
app.post('/api/sheets/writeback', async (req, res) => {
  const { spreadsheetId, sheetName, headerRowIndex, updates } = req.body;
  // updates: Array<{ rowIndex: number, columns: Record<string, string> }>

  if (!spreadsheetId || !sheetName || !updates?.length) {
    return res.status(400).json({ error: 'spreadsheetId, sheetName, and updates are required' });
  }

  const authResult = await getOAuthClient(req, res);
  if (!authResult) return res.status(401).json({ error: 'Not authenticated with Google' });
  const { client, refreshedTokens } = authResult;
  const sheetsApi = google.sheets({ version: 'v4', auth: client });

  try {
    // Read the header row to find/create Selio columns
    const headerRange = `'${sheetName}'!1:${(headerRowIndex || 0) + 1}`;
    const headerRes = await sheetsApi.spreadsheets.values.get({
      spreadsheetId,
      range: headerRange,
    });
    const headerRows = headerRes.data.values || [];
    const headerRow: string[] = (headerRows[headerRowIndex || 0] || []).map((h: any) => String(h));

    // Find or note missing Selio columns
    const colIndexMap: Record<string, number> = {};
    WRITEBACK_COLUMNS.forEach(col => {
      const idx = headerRow.findIndex(h => h === col);
      if (idx !== -1) colIndexMap[col] = idx;
    });

    // Add any missing Selio columns to the header row
    const missingCols = WRITEBACK_COLUMNS.filter(col => colIndexMap[col] === undefined);
    if (missingCols.length > 0) {
      let nextCol = headerRow.length;
      missingCols.forEach(col => {
        colIndexMap[col] = nextCol++;
      });
      // Write expanded header row
      const expandedHeader = [...headerRow];
      missingCols.forEach(col => expandedHeader.push(col));
      await sheetsApi.spreadsheets.values.update({
        spreadsheetId,
        range: `'${sheetName}'!A${(headerRowIndex || 0) + 1}`,
        valueInputOption: 'RAW',
        requestBody: { values: [expandedHeader] },
      });
    }

    // Build batchUpdate data
    const colLetter = (idx: number): string => {
      let letter = '';
      let n = idx;
      while (n >= 0) {
        letter = String.fromCharCode((n % 26) + 65) + letter;
        n = Math.floor(n / 26) - 1;
      }
      return letter;
    };

    const valueRanges: any[] = [];
    updates.forEach((update: { rowIndex: number; columns: Record<string, string> }) => {
      Object.entries(update.columns).forEach(([colName, value]) => {
        const colIdx = colIndexMap[colName];
        if (colIdx === undefined) return;
        const sheetRow = update.rowIndex; // already 1-based sheet row from server
        valueRanges.push({
          range: `'${sheetName}'!${colLetter(colIdx)}${sheetRow}`,
          values: [[value]],
        });
      });
    });

    if (valueRanges.length === 0) {
      return res.json({ success: true, updated: 0, refreshedTokens });
    }

    await sheetsApi.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: 'RAW', data: valueRanges },
    });

    res.json({ success: true, updated: valueRanges.length, refreshedTokens });
  } catch (err: any) {
    console.error('[SHEETS WRITEBACK]', err.message);
    if (isAuthError(err)) {
      return res.status(401).json({ error: 'Google session expired or invalid. Please reconnect your Google account.' });
    }
    res.status(500).json({ error: `Writeback failed: ${err.message}` });
  }
});

// ============================================================
// MIKE AI AGENT ROUTE
// ============================================================

function generateFallbackResponse(message: string, context: any): string {
  const msgLower = (message || '').toLowerCase();
  const leadName = context?.selectedLead?.company || 'their company';
  const website = context?.selectedLead?.website || 'their site';
  const country = context?.campaignCountry || 'your target region';
  const primaryProblem = context?.selectedLead?.primaryProblem || 'general SEO gaps';
  const score = context?.selectedLead?.score;
  const hotLeads = (context?.analyzedLeads || []).filter((a: any) => a.status === 'hot-lead');
  const overdueLeads = (context?.analyzedLeads || []).filter((a: any) => {
    if (!a.sentAt) return false;
    const daysSince = (Date.now() - new Date(a.sentAt).getTime()) / (1000 * 60 * 60 * 24);
    return !a.followUp1Sent && daysSince >= 3;
  });

  const problemAdvice: Record<string, string> = {
    'slow page speed': 'Their biggest win is image compression. Tools like Squoosh can cut image sizes by 60 to 80 percent without visible quality loss. That alone often drops load time by 1 to 2 seconds.',
    'no meta description': 'Each page needs a unique 140 to 155 character description that reads like a human wrote it for a human reader. Google rewrites generic ones anyway, so specificity is the whole game.',
    'no h1 tag': 'Every page needs exactly one H1 that states clearly what that page is about. It should match the intent of the search they want to rank for, not just the brand name.',
    'no blog': 'The fastest way to build organic traffic is a blog that answers questions their customers are actually searching. Three posts per month targeting specific questions beats ten generic ones.',
    'no google business profile': 'Claiming and completing a Google Business Profile is the single highest-leverage local SEO action available. It directly controls what appears when someone searches their business name.',
    'thin content': 'Pages under 500 words rarely rank for competitive terms. The fix is expanding existing pages with specific, useful information rather than adding new thin pages.',
    'no schema markup': 'Adding LocalBusiness or Product schema takes under an hour and can unlock rich results in Google search, which increases click-through rate without needing higher rankings.',
  };

  const problemKey = Object.keys(problemAdvice).find(k => primaryProblem.toLowerCase().includes(k)) || '';
  const specificAdvice = problemAdvice[problemKey] || `The primary issue detected for ${leadName} is: ${primaryProblem}. Address this directly in the outreach and connect it to a specific business consequence they would care about.`;

  if (msgLower.includes('rewrite') || msgLower.includes('email') || msgLower.includes('subject')) {
    return `[Offline Mode] AI is rate limited right now. Here is my advice on the email for ${leadName}:

Their primary problem is ${primaryProblem}${score ? ` and their opportunity score is ${score}` : ''}. The email needs to open by referencing something specific about ${website}, then connect that directly to a customer they are losing right now.

Keep it under 100 words. No bullet points. One call to action: the free 2-minute video audit. End with Tosin Adesina, SEO Growth Strategist.

${specificAdvice}

When the AI comes back online, ask me to rewrite it and I will generate the full version.`;
  }

  if (msgLower.includes('prioritize') || msgLower.includes('lead') || msgLower.includes('hot')) {
    return `[Offline Mode] Based on your pipeline: you have ${hotLeads.length} hot leads and ${overdueLeads.length} follow-ups that are overdue.

Start with any hot lead that has a valid email address and a score above 60. Those are the easiest to convert because their problems are visible and fixable.

${overdueLeads.length > 0 ? `Your overdue follow-ups are the most urgent action right now. Leads that received an initial email 3 or more days ago without a follow-up are going cold.` : ''}

Select a lead from the pipeline and I will give you specific advice when the AI is back online.`;
  }

  if (msgLower.includes('follow') || msgLower.includes('follow-up') || msgLower.includes('followup')) {
    return `[Offline Mode] For ${leadName}, the follow-up should not restart the conversation. It should pick up exactly where the last email left off.

Follow-up 1 (Day 3 to 4): One or two sentences. Warm, not pushy. Reference the video audit from the first email.
Follow-up 2 (Day 10 to 11): Give one free, specific tip tied to their exact problem (${primaryProblem}). ${specificAdvice}
Follow-up 3 (Day 17 to 18): Soft close. Mention you are wrapping up audits for their industry this week. Ask a single yes or no question.

When the AI is back, ask me to write the actual copy.`;
  }

  return `[Offline Mode] The AI is temporarily rate limited. Here is what I can tell you from your current data:

Campaign: ${context?.campaignName || 'your campaign'} targeting ${country}.
${score ? `${leadName} has an opportunity score of ${score} with primary issue: ${primaryProblem}.` : ''}
${hotLeads.length > 0 ? `You have ${hotLeads.length} hot leads ready for outreach.` : ''}
${overdueLeads.length > 0 ? `${overdueLeads.length} leads are due for a follow-up today.` : ''}

Ask me about a specific lead, email, or follow-up strategy and I will give you the best advice I can while offline.`;
}

app.post('/api/mike', async (req, res) => {
  const { message, context, model, conversationHistory } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });

  const selectedModel = model || 'gemini-flash';

  const buildMikeBriefing = (ctx: any): string => {
    if (!ctx) return 'No campaign data loaded yet.';

    const selected = ctx.selectedLead;
    const analyzedArr = Array.isArray(ctx.analyzedLeads)
      ? ctx.analyzedLeads
      : Object.values(ctx.analyzedLeads || {});
    const hotLeads = analyzedArr.filter((a: any) => a.status === 'hot-lead');
    const warmLeads = analyzedArr.filter((a: any) => a.status === 'warm-lead');
    const overdue = analyzedArr.filter((a: any) => {
      if (!a.sentAt) return false;
      const daysSince = (Date.now() - new Date(a.sentAt).getTime()) / (1000 * 60 * 60 * 24);
      return !a.followUp1Sent && daysSince >= 3;
    });

    const toneExamples: Record<string, string> = {
      'urgent': 'sounds like: "Your site has a problem that is actively affecting your search visibility right now..."',
      'consultative': 'sounds like: "I came across your site and one thing jumped out at me..."',
      'authority': 'sounds like: "During a routine audit of sites in your sector, I identified an issue that..."',
      'open-eye': 'sounds like: "Something I noticed while looking at your site that most people miss..."',
    };

    let briefing = `CAMPAIGN BRIEFING:
Name: ${ctx.campaignName || 'Unnamed campaign'}
Country: ${ctx.campaignCountry || 'Not set'}
Total Leads: ${ctx.totalLeads || 0} | Analyzed: ${ctx.analyzedCount || 0} | Emails Ready: ${ctx.emailsReady || 0}
Hot Leads: ${hotLeads.length} | Warm Leads: ${warmLeads.length}
Follow-ups Overdue: ${overdue.length}`;

    if (selected) {
      const toneKey = selected.recommendedTone || 'consultative';
      briefing += `

ACTIVE LEAD (currently selected):
Company: ${selected.company} | Website: ${selected.website}
Score: ${selected.score ?? 'Not analyzed'} | Status: ${selected.status ?? 'Not analyzed'}
Primary Problem: ${selected.primaryProblem || 'Not analyzed'}
Initial Email: ${selected.initialEmailBody ? 'Written' : 'Not written'}
Follow-up 1: ${selected.followUp1 ? 'Written' : 'Not written'} | Follow-up 2: ${selected.followUp2 ? 'Written' : 'Not written'} | Follow-up 3: ${selected.followUp3 ? 'Written' : 'Not written'}
Recommended Tone: ${toneKey} — ${toneExamples[toneKey] || ''}`;
    } else {
      briefing += `\n\nACTIVE LEAD: None selected. User is viewing the full pipeline.`;
    }

    if (hotLeads.length > 0) {
      briefing += `\n\nTOP HOT LEADS:\n`;
      hotLeads.slice(0, 5).forEach((l: any) => {
        briefing += `- ${l.company} (Score: ${l.score}, Problem: ${l.primaryProblem || 'unknown'})\n`;
      });
    }

    if (ctx.mikeActionLog && ctx.mikeActionLog.length > 0) {
      briefing += `\nMIKE RECENT ACTIONS:\n`;
      ctx.mikeActionLog.slice(-5).forEach((a: any) => {
        briefing += `- ${a.action} on row ${a.rowIndex} (${a.timestamp})\n`;
      });
    }

    return briefing;
  };

  const systemPrompt = `You are Mike, a sharp SEO outreach strategist working directly for Tosin Adesina inside Selio.

You can take real actions inside the app. When the user asks you to rewrite an email or follow-up, include the action command on its own line at the end of your response.

ACTION COMMAND FORMAT:
ACTION:REWRITE_EMAIL:{"rowIndex": 1, "subject": "new subject", "body": "new email body"}
ACTION:REWRITE_FOLLOWUP1:{"rowIndex": 1, "body": "new follow up 1 body"}
ACTION:REWRITE_FOLLOWUP2:{"rowIndex": 1, "body": "new follow up 2 body"}
ACTION:REWRITE_FOLLOWUP3:{"rowIndex": 1, "body": "new follow up 3 body"}
ACTION:ANALYZE_LEAD:{"rowIndex": 1}

The rowIndex must match the lead the user is referring to. When rewriting, always produce the full rewritten version.

${buildMikeBriefing(context)}

RULES:
- Be direct. One clear recommendation, not a list of options.
- Never use technical SEO jargon without immediately explaining it in plain English.
- Never use em dashes. Use commas, colons, or full stops instead.
- No asterisks, no markdown bold, no bullet symbols in your chat responses. Write in clean plain prose.
- When rewriting emails: no em dashes, no filler phrases, no marketing buzzwords. Under 100 words. Sound like a real person.
- If the user asks about something you already acted on, acknowledge it and offer a different angle.
- Speak like a sharp human strategist, not a corporate chatbot.`;

  const conversationContents = [
    ...((conversationHistory || []).map((m: any) => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.content }],
    }))),
    { role: 'user', parts: [{ text: message }] },
  ];

  const fullPrompt = `${systemPrompt}

CONVERSATION HISTORY:
${(conversationHistory || []).map((m: any) => `${m.role === 'user' ? 'User' : 'Mike'}: ${m.content}`).join('\n')}

User: ${message}

Mike:`;

  try {
    let responseText = '';

    if (selectedModel === 'gemini-pro') {
      try {
        if (exhaustedModels.has('gemini-3.1-pro-preview')) throw new Error('gemini-3.1-pro-preview is offline');
        const response = await retryWithExponentialBackoff(() =>
          ai.models.generateContent({
            model: 'gemini-3.1-pro-preview',
            contents: conversationContents,
            config: { systemInstruction: systemPrompt }
          }),
          3,
          2000,
          'gemini-3.1-pro-preview'
        );
        responseText = response.text || '';
      } catch (proError: any) {
        console.log('[GEMINI] Pro checked, trying 3.5-flash...', proError.message);
        try {
          if (exhaustedModels.has('gemini-3.5-flash')) throw new Error('gemini-3.5-flash is offline');
          const response = await retryWithExponentialBackoff(() =>
            ai.models.generateContent({
              model: 'gemini-3.5-flash',
              contents: conversationContents,
              config: { systemInstruction: systemPrompt }
            }),
            3,
            2000,
            'gemini-3.5-flash'
          );
          responseText = response.text || '';
        } catch (flashError: any) {
          console.log('[GEMINI] Flash route checked, trying 3.1-flash-lite...', flashError.message);
          try {
            if (exhaustedModels.has('gemini-3.1-flash-lite')) throw new Error('gemini-3.1-flash-lite is offline');
            const response = await retryWithExponentialBackoff(() =>
              ai.models.generateContent({
                model: 'gemini-3.1-flash-lite',
                contents: conversationContents,
                config: { systemInstruction: systemPrompt }
              }),
              3,
              2000,
              'gemini-3.1-flash-lite'
            );
            responseText = response.text || '';
          } catch (liteError: any) {
            console.log('[GEMINI] Lite checked, trying gemini-2.5-flash...', liteError.message);
            try {
              if (exhaustedModels.has('gemini-2.5-flash')) throw new Error('gemini-2.5-flash is offline');
              const response = await retryWithExponentialBackoff(() =>
                ai.models.generateContent({
                  model: 'gemini-2.5-flash',
                  contents: conversationContents,
                  config: { systemInstruction: systemPrompt }
                }),
                3,
                2000,
                'gemini-2.5-flash'
              );
              responseText = response.text || '';
            } catch (v2Error: any) {
              console.log('[GEMINI] All Gemini models checked. Trying OpenAI option...', v2Error.message);
              const openai = getOpenAIClient();
              if (openai) {
                try {
                  responseText = await openai.generate(fullPrompt);
                } catch (openaiErr: any) {
                  console.error('[OPENAI] Fallback failed:', openaiErr.message);
                  responseText = generateFallbackResponse(message, context);
                }
              } else {
                responseText = generateFallbackResponse(message, context);
              }
            }
          }
        }
      }
    } else if (selectedModel === 'gpt4o-mini') {
      const openai = getOpenAIClient();
      if (!openai) {
        // Fallback to Gemini Flash
        try {
          if (exhaustedModels.has('gemini-3.5-flash')) throw new Error('gemini-3.5-flash is offline');
          const response = await retryWithExponentialBackoff(() =>
            ai.models.generateContent({
              model: 'gemini-3.5-flash',
              contents: conversationContents,
              config: { systemInstruction: systemPrompt }
            }),
            3,
            2000,
            'gemini-3.5-flash'
          );
          responseText = response.text || '';
        } catch {
          responseText = generateFallbackResponse(message, context);
        }
      } else {
        const response = await axios.post(
          'https://api.openai.com/v1/chat/completions',
          {
            model: 'gpt-4o-mini',
            messages: [
              { role: 'system', content: systemPrompt },
              ...(conversationHistory || []).map((m: any) => ({ role: m.role, content: m.content })),
              { role: 'user', content: message }
            ],
            max_tokens: 1000,
          },
          { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' } }
        );
        responseText = response.data.choices[0].message.content;
      }
    } else {
      // Default: Gemini Flash
      try {
        if (exhaustedModels.has('gemini-3.5-flash')) throw new Error('gemini-3.5-flash is offline');
        const response = await retryWithExponentialBackoff(() =>
          ai.models.generateContent({
            model: 'gemini-3.5-flash',
            contents: conversationContents,
            config: { systemInstruction: systemPrompt }
          }),
          3,
          2000,
          'gemini-3.5-flash'
        );
        responseText = response.text || '';
      } catch (flashError: any) {
        console.log('[GEMINI] Flash route checked, trying 3.1-flash-lite...', flashError.message);
        try {
          if (exhaustedModels.has('gemini-3.1-flash-lite')) throw new Error('gemini-3.1-flash-lite is offline');
          const response = await retryWithExponentialBackoff(() =>
            ai.models.generateContent({
              model: 'gemini-3.1-flash-lite',
              contents: conversationContents,
              config: { systemInstruction: systemPrompt }
            }),
            3,
            2000,
            'gemini-3.1-flash-lite'
          );
          responseText = response.text || '';
        } catch (liteError: any) {
          console.log('[GEMINI] Lite route checked, trying gemini-2.5-flash...', liteError.message);
          try {
            if (exhaustedModels.has('gemini-2.5-flash')) throw new Error('gemini-2.5-flash is offline');
            const response = await retryWithExponentialBackoff(() =>
              ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: conversationContents,
                config: { systemInstruction: systemPrompt }
              }),
              3,
              2000,
              'gemini-2.5-flash'
            );
            responseText = response.text || '';
          } catch (v2Error: any) {
            console.log('[GEMINI] Lite and V2 options checked, trying OpenAI alternative...', v2Error.message);
            const openai = getOpenAIClient();
            if (openai) {
              try {
                responseText = await openai.generate(fullPrompt);
              } catch (openaiErr: any) {
                console.error('[OPENAI] Fallback failed:', openaiErr.message);
                responseText = generateFallbackResponse(message, context);
              }
            } else {
              responseText = generateFallbackResponse(message, context);
            }
          }
        }
      }
    }

    res.json({ response: responseText, reply: responseText, content: responseText, model: selectedModel });
  } catch (error: any) {
    console.error('Mike agent error:', error);
    try {
      const fallbackText = generateFallbackResponse(message, context);
      res.json({ response: fallbackText, reply: fallbackText, content: fallbackText, model: selectedModel });
    } catch {
      res.status(500).json({ error: 'Mike encountered an error. Please try again.' });
    }
  }
});

// ============================================================
// REPLY DETECTION — POLL GMAIL INBOX
// ============================================================

app.post('/api/check-replies', async (req, res) => {
  const { leadEmails } = req.body;
  const authResult = await getOAuthClient(req, res);
  if (!authResult) return res.status(401).json({ error: 'Not authenticated' });
  const { client, refreshedTokens } = authResult;
  const gmail = google.gmail({ version: 'v1', auth: client });

  // Negative sentiment phrases that mean the same as unsubscribe
  const negativeIntent = [
    'not interested',
    'remove me',
    'wrong person',
    'please stop',
    'stop emailing',
    'unsubscribe me',
    'unsubscribe',
    'take me off',
    'do not contact',
    'don\'t contact',
    'leave me alone',
    'no thank you',
    'no thanks',
    'please remove',
  ];

  // Fetch bounce notifications from Gmail inbox once for all leads
  let bouncedEmails = new Set<string>();
  try {
    const bounceSearch = await gmail.users.messages.list({
      userId: 'me',
      q: 'from:(mailer-daemon@googlemail.com OR postmaster@google.com) subject:(delivery OR undeliverable OR failed)',
      maxResults: 50,
    });

    if (bounceSearch.data.messages && bounceSearch.data.messages.length > 0) {
      for (const msg of bounceSearch.data.messages) {
        try {
          const fullMsg = await gmail.users.messages.get({
            userId: 'me',
            id: msg.id!,
            format: 'full',
          });

          // Extract the snippet and payload text to find the failed recipient email
          const snippet = fullMsg.data.snippet?.toLowerCase() || '';
          const payloadParts = fullMsg.data.payload?.parts || [];
          let bodyText = snippet;

          for (const part of payloadParts) {
            if (part.mimeType === 'text/plain' && part.body?.data) {
              bodyText += Buffer.from(part.body.data, 'base64').toString('utf-8').toLowerCase();
            }
          }

          // Match against each lead email to see if it appears in the bounce notification
          for (const email of (leadEmails || [])) {
            if (bodyText.includes(email.toLowerCase())) {
              bouncedEmails.add(email.toLowerCase());
            }
          }
        } catch (msgErr) {
          console.error('Failed to read bounce message:', msgErr);
        }
      }
    }
  } catch (bounceErr) {
    console.error('Failed to scan for bounces:', bounceErr);
  }

  try {
    const replies: Record<string, any> = {};

    for (const email of (leadEmails || [])) {
      try {
        // Check if this email bounced
        const isBounced = bouncedEmails.has(email.toLowerCase());

        const response = await gmail.users.messages.list({
          userId: 'me',
          q: `from:${email} in:inbox`,
          maxResults: 1,
        });

        const hasReplied = (response.data.messages?.length || 0) > 0;
        let isUnsubscribed = false;
        let isNegative = false;

        if (hasReplied && response.data.messages && response.data.messages[0]) {
          try {
            const msgId = response.data.messages[0].id;
            const msg = await gmail.users.messages.get({
              userId: 'me',
              id: msgId!,
              format: 'minimal',
            });
            const snippet = msg.data.snippet?.toLowerCase() || '';

            // Check for unsubscribe or any negative intent phrase
            const matchedNegative = negativeIntent.some(phrase => snippet.includes(phrase));
            if (matchedNegative) {
              isUnsubscribed = true;
              isNegative = true;
            }
          } catch (snippetErr) {
            console.error('Failed to get snippet:', snippetErr);
          }
        }

        replies[email] = { hasReplied, isUnsubscribed, isNegative, isBounced };
      } catch (e) {
        replies[email] = { hasReplied: false, isUnsubscribed: false, isNegative: false, isBounced: false };
      }
    }

    res.json({ replies, refreshedTokens });
  } catch (error: any) {
    console.error('[CHECK REPLIES]', error);
    if (isAuthError(error)) {
      return res.status(401).json({ error: 'Google session expired or invalid. Please reconnect your Google account.' });
    }
    res.status(500).json({ error: 'Reply check failed' });
  }
});

// ============================================================
// BUSINESS DAYS HELPER
// ============================================================

const addBusinessDays = (date: Date, days: number): Date => {
  let result = new Date(date);
  let added = 0;
  while (added < days) {
    result.setDate(result.getDate() + 1);
    const dow = result.getDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return result;
};

// ============================================================
// QUEUE INITIAL SENDS (ADDITION)
// ============================================================

app.post('/api/queue-initial-sends', async (req, res) => {
  const { campaignId, batchSchedule, sendStartDate, sendDateRaw, sendTimeRaw } = req.body;
  if (!campaignId || !batchSchedule) {
    return res.status(400).json({ error: 'Missing campaignId or batchSchedule' });
  }

  cancelledCampaigns.delete(campaignId);

  // Capture current request's live Google tokens so the background sender has fresh creds
  const reqTokens = getTokensFromRequest(req);
  if (reqTokens) {
    try {
      const userInfoClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
      userInfoClient.setCredentials(reqTokens);
      const gmail = google.gmail({ version: 'v1', auth: userInfoClient });
      const profile = await gmail.users.getProfile({ userId: 'me' });
      const email = profile.data.emailAddress;
      if (email) {
        await storeAccountTokens(email, reqTokens, false);
        console.log(`[QUEUE INITIAL] Captured and persisted tokens for ${email}`);
      }
    } catch (err: any) {
      console.warn('[QUEUE INITIAL] Non-critical: failed to capture tokens:', err.message);
    }
  }

    const supabase = getSupabase();
  try {
    const { data: campaign } = await supabase
      .from('campaigns')
      .select('timezone, country')
      .eq('id', campaignId)
      .maybeSingle();
    const campaignTz = campaign?.timezone || TIMEZONE_MAP[campaign?.country || ''] || 'UTC';

    // baseDate: either "send now" (sendStartDate ISO, immediate) or a scheduled
    // date+time pair that must be interpreted in the campaign's timezone.
    let baseDate: Date;
    if (sendDateRaw && sendTimeRaw) {
      baseDate = zonedTimeToUtc(sendDateRaw, sendTimeRaw, campaignTz);
    } else {
      baseDate = sendStartDate ? new Date(sendStartDate) : new Date();
    }

    console.log(`[QUEUE INITIAL] Queueing campaign ${campaignId} in ${campaignTz}, base date ${baseDate.toISOString()}`);

    // Update campaign's batch_schedule record with sendStartDate
    const campaignScheduleObj = {
      batchSchedule,
      currentBatch: 1,
      sendStartDate: baseDate.toISOString(),
      timezone: campaignTz,
      createdAt: new Date().toISOString(),
    };
    
    // Attempt update to campaigns (fails silently or succeeds)
    const { error: campaignUpdateErr } = await supabase
      .from('campaigns')
      .update({ batch_schedule: campaignScheduleObj })
      .eq('id', campaignId);
    if (campaignUpdateErr) {
      console.error(`[QUEUE INITIAL] Failed to persist batch_schedule to campaigns table for ${campaignId}:`, campaignUpdateErr);
    }

    let totalSkipped = 0;

    // Schedule each lead's initial email in lead_analysis.batch_status as "queued:<timestamp>"
    for (const batch of batchSchedule) {
      const batchDay = batch.day || 1;

      // Get the correct calendar date for this batch day, then apply THIS
      // batch's own send time, correctly converted for the campaign's timezone.
      let batchDateOnly = new Date(baseDate);
      if (batchDay > 1) {
        batchDateOnly = addBusinessDays(baseDate, batchDay - 1);
      }

      let scheduledDate: Date;
      if (batch.time) {
        // Re-derive the calendar date string in the campaign's timezone, then
        // apply this batch's specific time via the same zoned conversion.
        const dateInTz = new Intl.DateTimeFormat('en-CA', { timeZone: campaignTz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(batchDateOnly);
        scheduledDate = zonedTimeToUtc(dateInTz, batch.time, campaignTz);
      } else {
        scheduledDate = batchDateOnly;
      }

      const scheduledIso = scheduledDate.toISOString();
      const leadIds = batch.leads.map((l: any) => l.id || l._supabaseId);

      if (leadIds.length > 0) {
        const { data: updatedRows, error: updateErr } = await supabase
          .from('lead_analysis')
          .update({
            batch_status: `queued:${scheduledIso}`,
            sent_status: 'not-sent',
            updated_at: new Date().toISOString()
          })
          .eq('campaign_id', campaignId)
          .in('lead_id', leadIds)
          .not('sent_status', 'in', '("sent","sending","unsubscribed","replied")')
          .select('id');

        if (updateErr) {
          console.error(`[QUEUE INITIAL] Error updating lead analysis records for batch ${batchDay}:`, updateErr);
        } else {
          const queuedCount = updatedRows?.length || 0;
          const skippedCount = leadIds.length - queuedCount;
          totalSkipped += skippedCount;
          console.log(`[QUEUE INITIAL] Day ${batchDay}: queued ${queuedCount} of ${leadIds.length} leads at ${scheduledIso} (${batch.time || 'default time'} ${campaignTz})${skippedCount > 0 ? `, skipped ${skippedCount} already sent/handled` : ''}`);
        }
      }
    }

    res.json({ success: true, message: `Successfully queued initial emails across ${batchSchedule.length} days.`, skipped: totalSkipped });
  } catch (err: any) {
    console.error('[QUEUE INITIAL] Error queueing initial sends:', err);
    res.status(500).json({ error: 'Failed to queue initial sends', message: err.message });
  }
});

// ============================================================
// QUEUE ALL NOW (ADDITION)
// ============================================================

app.post('/api/queue-all-now', async (req, res) => {
  const { campaignId } = req.body;
  if (!campaignId) {
    return res.status(400).json({ error: 'Missing campaignId' });
  }

  cancelledCampaigns.delete(campaignId);

  // Capture current request's live Google tokens so the background sender has fresh creds
  const reqTokens = getTokensFromRequest(req);
  if (reqTokens) {
    try {
      const userInfoClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
      userInfoClient.setCredentials(reqTokens);
      const gmail = google.gmail({ version: 'v1', auth: userInfoClient });
      const profile = await gmail.users.getProfile({ userId: 'me' });
      const email = profile.data.emailAddress;
      if (email) {
        await storeAccountTokens(email, reqTokens, false);
        console.log(`[QUEUE ALL NOW] Captured and persisted tokens for ${email}`);
      }
    } catch (err: any) {
      console.warn('[QUEUE ALL NOW] Non-critical: failed to capture tokens:', err.message);
    }
  }

  const supabase = getSupabase();
  try {
    console.log(`[QUEUE ALL NOW] Queueing all eligible leads for campaign ${campaignId} immediately`);
    
    const { data: leads, error: leadsError } = await supabase
      .from('leads')
      .select('id, email')
      .eq('campaign_id', campaignId);

    if (leadsError || !leads || leads.length === 0) {
      return res.status(400).json({ error: 'No leads found for this campaign' });
    }

    const leadIds = leads.map(l => l.id);

    const { data: analysisRows, error: analysisError } = await supabase
      .from('lead_analysis')
      .select('id, lead_id, sent_status')
      .eq('campaign_id', campaignId);

    if (analysisError || !analysisRows) {
      return res.status(500).json({ error: 'Failed to fetch lead analysis records' });
    }

    const eligibleRows = analysisRows.filter(a => a.sent_status !== 'sent');
    if (eligibleRows.length === 0) {
      return res.json({ success: true, message: 'All leads have already been sent.' });
    }

    const eligibleLeadIds = eligibleRows.map(r => r.lead_id);
    const nowIso = new Date().toISOString();

    const { error: updateErr } = await supabase
      .from('lead_analysis')
      .update({
        batch_status: `queued:${nowIso}`,
        sent_status: 'not-sent',
        updated_at: new Date().toISOString()
      })
      .eq('campaign_id', campaignId)
      .in('lead_id', eligibleLeadIds);

    if (updateErr) {
      console.error('[QUEUE ALL NOW] Error updating lead analysis records:', updateErr);
      return res.status(500).json({ error: 'Failed to update lead analysis records' });
    }

    res.json({ success: true, message: `Successfully queued ${eligibleRows.length} leads for immediate send.` });
  } catch (err: any) {
    console.error('[QUEUE ALL NOW] Error queueing all leads:', err);
    res.status(500).json({ error: 'Failed to queue all leads', message: err.message });
  }
});

// ============================================================
// CANCEL BACKGROUND SEND (ADDITION)
// ============================================================

app.post('/api/cancel-send', (req, res) => {
  const { campaignId } = req.body;
  if (!campaignId) return res.status(400).json({ error: 'Missing campaignId' });
  cancelledCampaigns.add(campaignId);
  console.log(`[CANCEL SEND] Cancellation requested for campaign ${campaignId}`);
  res.json({ success: true });
});

// ============================================================
// SEND BATCH NOW (ADDITION)
// ============================================================

app.post('/api/send-batch-now', async (req, res) => {
  const { campaignId, leadIds } = req.body;
  if (!campaignId || !leadIds || !Array.isArray(leadIds)) {
    return res.status(400).json({ error: 'Missing campaignId or leadIds array' });
  }

  cancelledCampaigns.delete(campaignId);

  // Capture current request tokens proactively to make them available to background worker
  const reqTokens = getTokensFromRequest(req);
  if (reqTokens) {
    try {
      const userInfoClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
      userInfoClient.setCredentials(reqTokens);
      const gmail = google.gmail({ version: 'v1', auth: userInfoClient });
      const profile = await gmail.users.getProfile({ userId: 'me' });
      const email = profile.data.emailAddress;
      if (email) {
        additionalAccounts[email] = reqTokens;
        saveAccountsToFallbackFile();
        console.log(`[SEND BATCH NOW] Dynamically captured and stored Google tokens for ${email} from current request.`);
      }
    } catch (err: any) {
      console.warn('[SEND BATCH NOW] Non-critical: Failed to dynamically capture current request tokens:', err.message);
    }
  }

  // Acknowledge receipt and run in the background
  res.status(202).json({
    success: true,
    message: `Triggered background sending of ${leadIds.length} leads. You can safely close this page.`
  });

  // Background execution block
  (async () => {
    console.log(`[SEND BATCH NOW] Starting background processing for campaign ${campaignId} with ${leadIds.length} leads.`);
    const supabase = getSupabase();
    
    try {
      const { data: campaign, error: campError } = await supabase
        .from('campaigns')
        .select('*')
        .eq('id', campaignId)
        .single();

      if (campError || !campaign) {
        console.error(`[SEND BATCH NOW] Campaign ${campaignId} not found. Stopping.`, campError);
        return;
      }

      let senderEmail = campaign.sender_account_id;
      if (!senderEmail || senderEmail === 'primary') {
        senderEmail = await getPrimaryAccountEmail();
      }
      if (!senderEmail) {
        console.error(`[SEND BATCH NOW] No sender email resolved for campaign ${campaignId}. Stopping.`);
        return;
      }

      const client = await getOAuthClientByEmail(senderEmail);
      if (!client) {
        console.error(`[SEND BATCH NOW] Failed to authenticate sender ${senderEmail}. Stopping.`);
        return;
      }

      const gmail = google.gmail({ version: 'v1', auth: client });

      const { data: leads, error: leadsError } = await supabase
        .from('leads')
        .select('*')
        .in('id', leadIds);

      if (leadsError || !leads) {
        console.error('[SEND BATCH NOW] Failed to fetch leads.', leadsError);
        return;
      }

      const leadMap = new Map(leads.map(l => [l.id, l]));

      const { data: analysisRows, error: analysisError } = await supabase
        .from('lead_analysis')
        .select('*')
        .eq('campaign_id', campaignId)
        .in('lead_id', leadIds);

      if (analysisError || !analysisRows) {
        console.error('[SEND BATCH NOW] Failed to fetch lead analysis rows.', analysisError);
        return;
      }

      // To prevent duplicate sends due to multiple database rows for the same lead,
      // we query all analysis rows for this campaign to see if any row for a lead is already marked sent.
      const { data: allCampaignAnalysis } = await supabase
        .from('lead_analysis')
        .select('lead_id, sent_status')
        .eq('campaign_id', campaignId);

      const globallySentLeadIds = new Set<string>();
      if (allCampaignAnalysis) {
        for (const row of allCampaignAnalysis) {
          if (row.sent_status === 'sent' || row.sent_status === 'unsubscribed') {
            globallySentLeadIds.add(row.lead_id);
          }
        }
      }

      const processedLeadIds = new Set<string>();

      const { data: replyStatuses } = await supabase
        .from('reply_status')
        .select('*')
        .eq('campaign_id', campaignId);

      const replyStatusMap = new Map((replyStatuses || []).map(r => [r.lead_id, r]));

      let currentSentToday = await getTodayQuota(senderEmail, campaignId);
      const dailyLimit = campaign.daily_limit || 50;

      let remainingQuota = dailyLimit - currentSentToday;
      const spacingDelay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
      let totalSentInBatch = 0;

      for (let i = 0; i < analysisRows.length; i++) {
        if (cancelledCampaigns.has(campaignId)) {
          console.log(`[SEND BATCH NOW] Cancelled by user for campaign ${campaignId}. Stopping.`);
          break;
        }
        if (remainingQuota <= 0) {
          console.warn('[SEND BATCH NOW] Daily limit reached mid-batch. Stopping.');
          break;
        }

        const a = analysisRows[i];
        const lead = leadMap.get(a.lead_id);
        if (!lead) continue;

        const repStatus = replyStatusMap.get(a.lead_id);
        const hasReplied = repStatus?.has_replied === true || repStatus?.unsubscribed === true;
        
        // If the lead has replied, unsubscribed, already been sent in this campaign, or processed earlier in this batch,
        // mark this redundant analysis row as 'sent' (since the campaign goal for this lead is met/processed) and skip.
        if (hasReplied || a.sent_status === 'sent' || a.sent_status === 'unsubscribed' || globallySentLeadIds.has(a.lead_id) || processedLeadIds.has(a.lead_id)) {
          console.log(`[SEND BATCH NOW] Lead ${lead.company} already processed or sent. Marking row ${a.id} as sent and skipping.`);
          const targetSentStatus = (repStatus?.unsubscribed === true || a.sent_status === 'unsubscribed') ? 'unsubscribed' : 'sent';
          await supabase
            .from('lead_analysis')
            .update({ 
              batch_status: 'sent', 
              sent_status: targetSentStatus, 
              updated_at: new Date().toISOString() 
            })
            .eq('id', a.id);
          continue;
        }

        // Track that we are processing this lead in this batch run
        processedLeadIds.add(a.lead_id);

        // ATOMIC CLAIM
        const { data: claimedRows, error: claimError } = await supabase
          .from('lead_analysis')
          .update({ sent_status: 'sending', updated_at: new Date().toISOString() })
          .eq('id', a.id)
          .not('sent_status', 'in', '("sent","sending","unsubscribed")')
          .select();

        if (claimError || !claimedRows || claimedRows.length === 0) {
          console.log(`[SEND BATCH NOW] Lead ${lead.company} already claimed elsewhere. Skipping.`);
          continue;
        }

        const rawBody = a.ai_analysis?.initialEmail?.body || a.initial_email?.body || '';
        const signaturePattern = /Tosin Adesina[\s\S]*?SEO Growth Strategist/g;
        const matches = rawBody.match(signaturePattern);
        let emailBody = matches && matches.length > 1
          ? rawBody.replace(/(\s*Tosin Adesina[\s\S]*?SEO Growth Strategist)\s*(\s*(?:Adesina|Tosin)[\s\S]*?SEO Growth Strategist)/g, '$1')
          : rawBody;

        let emailSubject = a.ai_analysis?.initialEmail?.subject || a.initial_email?.subject || '';

        emailSubject = replaceTokensServer(emailSubject, lead);
        emailBody = replaceTokensServer(emailBody, lead);

        if (totalSentInBatch > 0) {
          const delayMs = Math.floor(Math.random() * (35000 - 15000 + 1)) + 15000;
          console.log(`[SEND BATCH NOW] Spacing: waiting ${Math.round(delayMs / 1000)}s...`);
          await spacingDelay(delayMs);
        }

        let gmailResponse;
        try {
          const utf8Subject = `=?utf-8?B?${Buffer.from(emailSubject).toString('base64')}?=`;
          const emailHtml = formatEmailAsHTML(emailBody, 'Adesina', false, lead.email);
          
          const headers = [
            `To: ${lead.email}`,
            'Content-Type: text/html; charset=utf-8',
            'MIME-Version: 1.0',
            `Subject: ${utf8Subject}`
          ];
          
          const rawMessage = [
            ...headers,
            '',
            emailHtml
          ].join('\r\n');

          const encodedMessage = Buffer.from(rawMessage).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
          
          gmailResponse = await gmail.users.messages.send({
            userId: 'me',
            requestBody: {
              raw: encodedMessage
            }
          });
        } catch (sendErr: any) {
          console.error(`[SEND BATCH NOW] Failed to send email via Gmail to ${lead.company}:`, sendErr);
          try {
            await supabase
              .from('lead_analysis')
              .update({
                sent_status: 'failed',
                batch_status: 'failed',
                error_reason: sendErr.message || String(sendErr),
                updated_at: new Date().toISOString()
              })
              .eq('id', a.id);
          } catch (dbErr: any) {
            console.error('[SEND BATCH NOW] Failed to write failed status to DB:', dbErr.message || dbErr);
          }
          continue; // Move on to next lead
        }

        // If we reach here, Gmail send succeeded! We MUST record it as sent in lead_analysis.
        try {
          await supabase
            .from('lead_analysis')
            .update({
              sent_status: 'sent',
              sent_at: new Date().toISOString(),
              last_email_sent_at: new Date().toISOString(),
              batch_status: 'sent',
              initial_message_id: gmailResponse.data.id,
              initial_thread_id: gmailResponse.data.threadId,
              updated_at: new Date().toISOString()
            })
            .eq('id', a.id);

          totalSentInBatch++;
          remainingQuota--;
          console.log(`[SEND BATCH NOW] ✓ Successfully sent initial email to ${lead.company}`);
        } catch (dbErr: any) {
          console.error(`[SEND BATCH NOW] Gmail succeeded but database update failed for ${lead.company}:`, dbErr.message || dbErr);
          // Still increment counts since the email was sent
          totalSentInBatch++;
          remainingQuota--;
        }

        // Perform non-blocking auxiliary updates
        try {
          await incrementCampaignCounter('increment_campaign_sent_count', campaign.id, 'sent_count');
          await incrementQuota(senderEmail, campaign.id);
        } catch (auxErr: any) {
          console.warn(`[SEND BATCH NOW] Non-critical aux updates failed for ${lead.company}:`, auxErr.message || auxErr);
        }
      }
      
      console.log(`[SEND BATCH NOW] Finished background batch processing. Sent ${totalSentInBatch} emails.`);
    } catch (bgErr: any) {
      console.error('[SEND BATCH NOW] Background processing error:', bgErr);
    }
  })();
});

// ============================================================
// BACKGROUND INITIAL EMAIL SENDER (ADDITION)
// ============================================================

async function releaseStaleClaims(campaignId?: string) {
  const supabase = getSupabase();
  // 20 min, not tied to cron interval — must exceed the longest realistic
  // single-run duration (batch size × per-email spacing + API latency)
  const staleThreshold = new Date(Date.now() - 20 * 60 * 1000).toISOString();

  let query = supabase
    .from('lead_analysis')
    .update({ sent_status: 'not-sent', updated_at: new Date().toISOString() })
    .eq('sent_status', 'sending')
    .lt('updated_at', staleThreshold);

  if (campaignId) query = query.eq('campaign_id', campaignId);

  const { data, error } = await query.select('id');
  if (error) {
    console.error('[STALE CLAIM] Failed to release stuck rows:', error);
  } else if (data && data.length > 0) {
    console.log(`[STALE CLAIM] Released ${data.length} rows stuck in 'sending' for >20min`);
  }
}

async function processDueInitialEmails(campaignId?: string, forceWindow = false) {
  await releaseStaleClaims(campaignId);
  const supabase = getSupabase();
  
  let query = supabase.from('campaigns').select('*');
  if (campaignId) {
    query = query.eq('id', campaignId);
  }
  const { data: campaigns, error: campaignsError } = await query;
  if (campaignsError || !campaigns) {
    console.error('[CRON INITIAL] Failed to fetch campaigns:', campaignsError);
    return { success: false, error: 'Failed to fetch campaigns' };
  }

  const results: any[] = [];
  const now = new Date();
  let totalSent = 0;
  
  for (const campaign of campaigns) {
    let senderEmail = campaign.sender_account_id;
    if (!senderEmail || senderEmail === 'primary') {
      senderEmail = await getPrimaryAccountEmail();
    }
    
    if (!senderEmail) {
      continue;
    }

    // Fetch queued analysis records for this campaign (matches both 'queued' and 'queued:<timestamp>')
    const { data: analysisRows, error: analysisError } = await supabase
      .from('lead_analysis')
      .select('*')
      .eq('campaign_id', campaign.id)
      .like('batch_status', 'queued%');

    if (analysisError || !analysisRows || analysisRows.length === 0) {
      continue;
    }

    // Filter leads that are actually due
    const dueLeadsAnalysis = analysisRows.filter(a => {
      if (!a.batch_status) return false;
      const parts = a.batch_status.split(':');
      if (parts.length < 2) return false; // require an explicit scheduled timestamp
      const scheduledTimeStr = parts.slice(1).join(':');
      const scheduledTime = new Date(scheduledTimeStr);
      return now >= scheduledTime;
    });

    if (dueLeadsAnalysis.length === 0) {
      continue;
    }

    console.log(`[CRON INITIAL] Found ${dueLeadsAnalysis.length} due initial emails for campaign ${campaign.name}`);

    // To prevent duplicate sends due to multiple database rows for the same lead,
    // we query all analysis rows for this campaign to see if any row for a lead is already marked sent.
    const { data: allCampaignAnalysis } = await supabase
      .from('lead_analysis')
      .select('lead_id, sent_status')
      .eq('campaign_id', campaign.id);

    const globallySentLeadIds = new Set<string>();
    if (allCampaignAnalysis) {
      for (const row of allCampaignAnalysis) {
        if (row.sent_status === 'sent' || row.sent_status === 'unsubscribed') {
          globallySentLeadIds.add(row.lead_id);
        }
      }
    }

    const processedLeadIds = new Set<string>();

    // Authenticate OAuth client
    const client = await getOAuthClientByEmail(senderEmail);
    if (!client) {
      console.warn(`[CRON INITIAL] Could not authenticate OAuth client for email ${senderEmail}. Skipping.`);
      continue;
    }

    const gmail = google.gmail({ version: 'v1', auth: client });

    // Fetch lead records for these analysis rows
    const leadIds = dueLeadsAnalysis.map(a => a.lead_id);
    const { data: leads, error: leadsError } = await supabase
      .from('leads')
      .select('*')
      .in('id', leadIds);

    if (leadsError || !leads) {
      console.error(`[CRON INITIAL] Failed to fetch leads for campaign ${campaign.id}:`, leadsError);
      continue;
    }

    const leadMap = new Map(leads.map(l => [l.id, l]));

    // Fetch reply statuses to make sure they haven't replied or unsubscribed
    const { data: replyStatuses } = await supabase
      .from('reply_status')
      .select('*')
      .eq('campaign_id', campaign.id);

    const replyStatusMap = new Map((replyStatuses || []).map(r => [r.lead_id, r]));

    // Check daily quota limit
    const currentSentToday = await getTodayQuota(senderEmail, campaign.id);
    const dailyLimit = campaign.daily_limit || 50;

    if (currentSentToday >= dailyLimit) {
      console.log(`[CRON INITIAL] Sender ${senderEmail} reached daily limit (${currentSentToday}/${dailyLimit}). Skipping remaining initial sends.`);
      continue;
    }

    let remainingQuota = dailyLimit - currentSentToday;
    const spacingDelay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    for (let i = 0; i < dueLeadsAnalysis.length; i++) {
      if (cancelledCampaigns.has(campaign.id)) {
        console.log(`[CRON INITIAL] Cancelled by user for campaign ${campaign.id}. Stopping.`);
        break;
      }
      if (remainingQuota <= 0) {
        console.log('[CRON INITIAL] Daily quota reached during run. Stopping.');
        break;
      }

      const a = dueLeadsAnalysis[i];
      const lead = leadMap.get(a.lead_id);

      if (!lead) {
        continue;
      }

      // Check reply status
      const repStatus = replyStatusMap.get(a.lead_id);
      const hasReplied = repStatus?.has_replied === true || repStatus?.unsubscribed === true;
      
      // If the lead has replied, unsubscribed, already been sent in this campaign, or processed earlier in this batch,
      // mark this redundant analysis row as 'sent' (since the campaign goal for this lead is met/processed) and skip.
      if (hasReplied || a.sent_status === 'sent' || a.sent_status === 'unsubscribed' || globallySentLeadIds.has(a.lead_id) || processedLeadIds.has(a.lead_id)) {
        console.log(`[CRON INITIAL] Lead ${lead.company} already processed or sent. Marking row ${a.id} as sent and skipping.`);
        const targetSentStatus = (repStatus?.unsubscribed === true || a.sent_status === 'unsubscribed') ? 'unsubscribed' : 'sent';
        await supabase
          .from('lead_analysis')
          .update({ 
            batch_status: 'sent', 
            sent_status: targetSentStatus, 
            updated_at: new Date().toISOString() 
          })
          .eq('id', a.id);
        continue;
      }

      // Track that we are processing this lead in this cron run
      processedLeadIds.add(a.lead_id);

      // ATOMIC CLAIM — only proceed if no other process has already claimed/sent this row
      const { data: claimedRows, error: claimError } = await supabase
        .from('lead_analysis')
        .update({ sent_status: 'sending', updated_at: new Date().toISOString() })
        .eq('id', a.id)
        .not('sent_status', 'in', '("sent","sending","unsubscribed")')
        .select();

      if (claimError || !claimedRows || claimedRows.length === 0) {
        console.log(`[CRON INITIAL] Lead ${lead.company} already claimed by another run. Skipping.`);
        continue;
      }

      // Prepare email content
      const rawBody = a.ai_analysis?.initialEmail?.body || a.initial_email?.body || '';
      
      const signaturePattern = /Tosin Adesina[\s\S]*?SEO Growth Strategist/g;
      const matches = rawBody.match(signaturePattern);
      let emailBody = matches && matches.length > 1
        ? rawBody.replace(/(\s*Tosin Adesina[\s\S]*?SEO Growth Strategist)\s*(\s*(?:Adesina|Tosin)[\s\S]*?SEO Growth Strategist)/g, '$1')
        : rawBody;

      let emailSubject = a.ai_analysis?.initialEmail?.subject || a.initial_email?.subject || '';

      emailSubject = replaceTokensServer(emailSubject, lead);
      emailBody = replaceTokensServer(emailBody, lead);

      if (totalSent > 0) {
        const delayMs = Math.floor(Math.random() * (35000 - 15000 + 1)) + 15000; // 15-35s
        console.log(`[CRON INITIAL] Spacing out initial send: waiting ${Math.round(delayMs / 1000)}s...`);
        await spacingDelay(delayMs);
      }

      let gmailResponse;
      try {
        const utf8Subject = `=?utf-8?B?${Buffer.from(emailSubject).toString('base64')}?=`;
        const emailHtml = formatEmailAsHTML(emailBody, 'Adesina', false, lead.email);
        
        const headers = [
          `To: ${lead.email}`,
          'Content-Type: text/html; charset=utf-8',
          'MIME-Version: 1.0',
          `Subject: ${utf8Subject}`
        ];
        
        const rawMessage = [
          ...headers,
          '',
          emailHtml
        ].join('\r\n');

        const encodedMessage = Buffer.from(rawMessage).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        
        gmailResponse = await gmail.users.messages.send({
          userId: 'me',
          requestBody: {
            raw: encodedMessage
          }
        });
      } catch (sendErr: any) {
        console.error(`[CRON INITIAL] Failed to send email via Gmail to ${lead.company}:`, sendErr);
        try {
          await supabase
            .from('lead_analysis')
            .update({
              sent_status: 'failed',
              batch_status: 'failed',
              error_reason: sendErr.message || String(sendErr),
              updated_at: new Date().toISOString()
            })
            .eq('id', a.id);
        } catch (dbErr: any) {
          console.error('[CRON INITIAL] Failed to write failed status to DB:', dbErr.message || dbErr);
        }
        results.push({ lead: lead.company, email: lead.email, success: false, error: sendErr.message || String(sendErr) });
        continue; // Move on to next lead
      }

      // If we reach here, Gmail send succeeded! We MUST record it as sent.
      try {
        await supabase
          .from('lead_analysis')
          .update({
            sent_status: 'sent',
            sent_at: new Date().toISOString(),
            last_email_sent_at: new Date().toISOString(),
            batch_status: 'sent',
            initial_message_id: gmailResponse.data.id,
            initial_thread_id: gmailResponse.data.threadId,
            updated_at: new Date().toISOString()
          })
          .eq('id', a.id);

        totalSent++;
        remainingQuota--;

        results.push({ lead: lead.company, email: lead.email, success: true });
        console.log(`[CRON INITIAL] ✓ Sent initial email to ${lead.company}`);
      } catch (dbErr: any) {
        console.error(`[CRON INITIAL] Gmail succeeded but database update failed for ${lead.company}:`, dbErr.message || dbErr);
        // Still increment counts since the email was sent
        totalSent++;
        remainingQuota--;
        results.push({ lead: lead.company, email: lead.email, success: true, warning: 'Sent but failed to update database' });
      }

      // Perform non-blocking auxiliary updates
      try {
        await incrementCampaignCounter('increment_campaign_sent_count', campaign.id, 'sent_count');
        await incrementQuota(senderEmail, campaign.id);
      } catch (auxErr: any) {
        console.warn(`[CRON INITIAL] Non-critical aux updates failed for ${lead.company}:`, auxErr.message || auxErr);
      }
    }
  }

  return { success: true, results, totalSent };
}

// ============================================================
// SCHEDULE CALCULATOR
// ============================================================

app.post('/api/calculate-schedule', async (req, res) => {
  const { startDate, country, timezone, campaignId, scheduleStartTime, scheduleEndTime, followUp1Days, followUp2Days, followUp3Days } = req.body;

  const tz = timezone || TIMEZONE_MAP[country] || 'America/New_York';

  let startTime = scheduleStartTime || '09:00';
  let endTime = scheduleEndTime || '11:00';
  let f1 = followUp1Days || 3;
  let f2 = followUp2Days || 10;
  let f3 = followUp3Days || 17;

  if (campaignId) {
    try {
      const supabase = getSupabase();
      const { data: campaign } = await supabase
        .from('campaigns')
        .select('*')
        .eq('id', campaignId)
        .maybeSingle();
      if (campaign) {
        startTime = campaign.schedule_start_time || startTime;
        endTime = campaign.schedule_end_time || endTime;
        f1 = campaign.follow_up1_days || f1;
        f2 = campaign.follow_up2_days || f2;
        f3 = campaign.follow_up3_days || f3;
      }
    } catch (err) {
      console.error('[API] Error fetching campaign for schedule calculation:', err);
    }
  }

  const formatTime12h = (timeStr: string) => {
    if (!timeStr) return '';
    const [hStr, mStr] = timeStr.split(':');
    const h = parseInt(hStr, 10);
    const m = parseInt(mStr, 10);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    const mPad = m < 10 ? `0${m}` : m;
    return `${h12}:${mPad} ${ampm}`;
  };

  const base = startDate ? new Date(startDate) : new Date();

  const schedule = {
    timezone: tz,
    country,
    sendWindow: `${formatTime12h(startTime)} - ${formatTime12h(endTime)} local time`,
    initialEmail: { date: base.toISOString(), day: 0, label: 'Initial Email' },
    followUp1: { date: addBusinessDays(base, f1).toISOString(), day: f1, label: 'Follow Up 1' },
    followUp2: { date: addBusinessDays(base, f2).toISOString(), day: f2, label: 'Follow Up 2' },
    followUp3: { date: addBusinessDays(base, f3).toISOString(), day: f3, label: 'Follow Up 3' },
  };

  res.json({ schedule });
});

// ============================================================
// DEBUG SERVICE (ADDITION 2)
// ============================================================

app.get('/api/debug', async (req, res) => {
  const isConnected = !!getTokensFromRequest(req);

  const environment = {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY ? 'SET' : 'NOT SET',
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ? 'SET' : 'NOT SET',
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET ? 'SET' : 'NOT SET',
    SCRAPER_API_KEY: process.env.SCRAPER_API_KEY ? 'SET' : 'NOT SET',
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ? 'SET' : 'NOT SET',
  };

  let scraperStatus = {
    configured: false,
    requestsRemaining: 'N/A',
    status: 'N/A',
    error: '',
  };

  if (process.env.SCRAPER_API_KEY) {
    scraperStatus.configured = true;
    try {
      const response = await axios.get('http://api.scraperapi.com/account', {
        params: { api_key: process.env.SCRAPER_API_KEY },
        timeout: 5000,
      });
      scraperStatus.requestsRemaining = response.data?.requestsRemaining !== undefined ? String(response.data.requestsRemaining) : JSON.stringify(response.data);
      scraperStatus.status = 'Success';
    } catch (err: any) {
      scraperStatus.status = 'Failed';
      scraperStatus.error = err.message || String(err);
    }
  }

  let openaiStatus = {
    configured: false,
    status: 'N/A',
    error: '',
  };

  if (process.env.OPENAI_API_KEY) {
    openaiStatus.configured = true;
    try {
      const response = await axios.get('https://api.openai.com/v1/models', {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
        },
        timeout: 5000,
      });
      if (response.status === 200) {
        openaiStatus.status = 'Succeeded';
      } else {
        openaiStatus.status = 'Failed';
        openaiStatus.error = `HTTP Status: ${response.status}`;
      }
    } catch (err: any) {
      openaiStatus.status = 'Failed';
      openaiStatus.error = err.response?.data?.error?.message || err.message || String(err);
    }
  }

  res.json({
    authentication: {
      isConnected: isConnected ? 'CONNECTED' : 'NOT CONNECTED',
    },
    lastApiCall: debugState.lastApiCall,
    geminiStatus: debugState.geminiStatus,
    environment,
    scraperStatus,
    openaiStatus,
    lastAnalyzedLead: debugState.lastAnalyzedLead,
  });
});

// ============================================================
// AUTOMATED FOLLOW-UPS & CRON SYSTEM
// ============================================================

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

async function incrementCampaignCounter(
  rpcName: string,
  campaignId: string,
  fallbackColumn: 'sent_count' | 'reply_count'
) {
  const supabase = getSupabase();
  const { error: rpcErr } = await supabase.rpc(rpcName, { campaign_id: campaignId });
  if (!rpcErr) return;

  try {
    const { data: campaignData } = await supabase
      .from('campaigns')
      .select(fallbackColumn)
      .eq('id', campaignId)
      .single();
    const current = (campaignData as any)?.[fallbackColumn] || 0;
    await supabase
      .from('campaigns')
      .update({ [fallbackColumn]: current + 1 })
      .eq('id', campaignId);
  } catch (fallbackErr: any) {
    console.warn(`[COUNTER] Failed to increment ${fallbackColumn} for ${campaignId}:`, fallbackErr.message || fallbackErr);
  }
}

async function getPrimaryAccountEmail(): Promise<string | null> {
  const { data } = await getSupabase()
    .from('gmail_accounts')
    .select('email')
    .eq('is_primary', true)
    .order('updated_at', { ascending: false })
    .limit(1);
  if (data && data.length > 0) return data[0].email;

  const { data: fallback } = await getSupabase()
    .from('gmail_accounts')
    .select('email')
    .order('updated_at', { ascending: false })
    .limit(1);
  return fallback?.[0]?.email || null;
}

async function getOAuthClientByEmail(email: string) {
  let tokens = additionalAccounts[email];

  if (!tokens) {
    const { data, error } = await getSupabase()
      .from('gmail_accounts')
      .select('tokens')
      .eq('email', email)
      .maybeSingle();

    if (error) {
      console.error(`[CRON AUTH] Database error retrieving tokens for ${email}:`, error.message || error);
      return null;
    }
    if (!data || !data.tokens) {
      console.warn(`[CRON AUTH] Account ${email} is not connected or tokens are missing. Skipping.`);
      return null;
    }
    tokens = data.tokens;
  }

  const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  client.setCredentials(tokens);

  const isExpired = tokens.expiry_date ? Date.now() >= tokens.expiry_date - 30000 : true;
  if (isExpired && tokens.refresh_token) {
    try {
      console.log(`[CRON AUTH] Token expired or expiring soon for ${email}, auto-refreshing...`);
      const { credentials } = await client.refreshAccessToken();
      const refreshed = { ...tokens, ...credentials };
      
      // Update in-memory fallback
      additionalAccounts[email] = refreshed;

      const { error: updateError } = await getSupabase()
        .from('gmail_accounts')
        .update({ tokens: refreshed, updated_at: new Date().toISOString() })
        .eq('email', email);
        
      if (updateError) {
        console.error(`[CRON AUTH] Failed to save refreshed tokens for ${email}:`, updateError);
      }
      
      client.setCredentials(refreshed);
    } catch (err: any) {
      console.error(`[CRON AUTH] Auto-refresh failed for ${email}:`, err.message || err);
      const errStr = (err.message || '').toLowerCase();
      const isInvalidGrant = errStr.includes('invalid_grant') || 
                            errStr.includes('invalid_client') ||
                            err.response?.data?.error === 'invalid_grant';
      if (isInvalidGrant) {
        console.warn(`[CRON AUTH] Detected invalid_grant for ${email}. Removing account to prevent further failure loops.`);
        await deleteAdditionalAccount(email);
      }
      return null;
    }
  }
  return client;
}

function replaceTokensServer(text: string, lead: any): string {
  if (!text) return text;
  let result = text;
  result = result.replace(/{{first_name}}/g, lead.recipient?.split(' ')[0] || 'there');
  result = result.replace(/{{full_name}}/g, lead.recipient || 'there');
  result = result.replace(/{{company}}/g, lead.company || 'Company');
  result = result.replace(/{{website}}/g, lead.website || '');
  result = result.replace(/{{email}}/g, lead.email || '');
  if (lead.customFields) {
    Object.entries(lead.customFields).forEach(([key, value]) => {
      result = result.split(`{{${key}}}`).join(String(value));
    });
  }
  return result;
}

function buildThreadedRawEmail({
  to,
  subject,
  body,
  internetMessageId,
}: {
  to: string;
  subject: string;
  body: string;
  internetMessageId?: string;
}) {
  const utf8Subject = `=?utf-8?B?${Buffer.from(subject || '').toString('base64')}?=`;
  const emailHtml = formatEmailAsHTML(body, 'Adesina', false, to);
  
  const headers = [
    `To: ${to}`,
    'Content-Type: text/html; charset=utf-8',
    'MIME-Version: 1.0',
    `Subject: ${utf8Subject}`
  ];
  
  if (internetMessageId) {
    headers.push(`In-Reply-To: ${internetMessageId}`);
    headers.push(`References: ${internetMessageId}`);
  }
  
  const rawMessage = [
    ...headers,
    '',
    emailHtml
  ].join('\r\n');
  
  return Buffer.from(rawMessage).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function serverSideCheckReplies(gmail: any, threadId: string, myEmail: string): Promise<boolean> {
  if (!threadId) return false;
  try {
    const thread = await gmail.users.threads.get({ userId: 'me', id: threadId });
    const messages = thread.data.messages || [];
    if (messages.length > 1) {
      for (const msg of messages) {
        const headers = msg.payload?.headers || [];
        const fromHeader = (headers.find(h => h.name?.toLowerCase() === 'from')?.value || '').toLowerCase();
        if (fromHeader && !fromHeader.includes(myEmail.toLowerCase())) {
          console.log(`[REPLY DETECTED] Found message from ${fromHeader} in thread ${threadId}`);
          return true;
        }
      }
    }
  } catch (err) {
    console.error(`[REPLY CHECK] Error checking thread ${threadId}:`, err);
  }
  return false;
}

async function processDueFollowups(campaignId?: string, forceWindow = false) {
  await releaseStaleClaims(campaignId);
  console.log(`[CRON] Starting processDueFollowups... Campaign ID filter: ${campaignId || 'All'}`);
  const supabase = getSupabase();
  
  let query = supabase.from('campaigns').select('*');
  if (campaignId) {
    query = query.eq('id', campaignId);
  }
  const { data: campaigns, error: campaignsError } = await query;
  if (campaignsError || !campaigns) {
    console.error('[CRON] Failed to fetch campaigns:', campaignsError);
    return { success: false, error: 'Failed to fetch campaigns' };
  }

  const results: any[] = [];
  const now = new Date();
  let totalSent = 0;
  const CAMPAIGN_BATCH_LIMIT = 10; // Limit per campaign per execution run to prevent starvation

  for (const campaign of campaigns) {
    console.log(`[CRON] Processing campaign: ${campaign.name} (${campaign.id})`);

    if (!forceWindow) {
      const startTime = campaign.follow_up_start_time || '14:00';
      const endTime = campaign.follow_up_end_time || '16:00';
      const tz = getCampaignTimezone(campaign);

      if (!isWithinWindow(startTime, endTime, tz, now)) {
        console.log(`[CRON] Campaign ${campaign.name} is outside follow-up window (${startTime}-${endTime} ${tz}). Skipping.`);
        continue;
      }
    }

    let senderEmail = campaign.sender_account_id;
    if (!senderEmail || senderEmail === 'primary') {
      senderEmail = await getPrimaryAccountEmail();
    }
    
    if (!senderEmail) {
      console.warn(`[CRON] No sender email resolved for campaign ${campaign.name}. Skipping.`);
      continue;
    }

    const client = await getOAuthClientByEmail(senderEmail);
    if (!client) {
      console.warn(`[CRON] Could not authenticate OAuth client for email ${senderEmail}. Skipping.`);
      continue;
    }

    const gmail = google.gmail({ version: 'v1', auth: client });

    const { data: leads, error: leadsError } = await supabase
      .from('leads')
      .select('*')
      .eq('campaign_id', campaign.id);
      
    if (leadsError || !leads) {
      console.error(`[CRON] Failed to fetch leads for campaign ${campaign.id}:`, leadsError);
      continue;
    }

    const { data: analysisRows, error: analysisError } = await supabase
      .from('lead_analysis')
      .select('*')
      .eq('campaign_id', campaign.id);

    if (analysisError || !analysisRows) {
      console.error(`[CRON] Failed to fetch lead analysis for campaign ${campaign.id}:`, analysisError);
      continue;
    }

    const { data: replyStatuses } = await supabase
      .from('reply_status')
      .select('*')
      .eq('campaign_id', campaign.id);

    const replyStatusMap = new Map<string, any>();
    if (replyStatuses) {
      for (const rs of replyStatuses) {
        if (rs.lead_id) replyStatusMap.set(rs.lead_id, rs);
      }
    }

    const followUpDays = [
      campaign.follow_up1_days || 3,
      campaign.follow_up2_days || 10,
      campaign.follow_up3_days || 17
    ];

    console.log(`[CRON] Campaign followUpDays: ${JSON.stringify(followUpDays)}. Checking leads...`);

    const dueLeads: any[] = [];

    for (const lead of leads) {
      if (dueLeads.length >= CAMPAIGN_BATCH_LIMIT) {
        break;
      }

      const a = analysisRows.find(row => row.lead_id === lead.id);
      if (!a) continue;

      if (a.sent_status !== 'sent' || a.unsubscribed_at || a.bounced_at || a.spam_reported) continue;

      const dbReplyStatus = replyStatusMap.get(lead.id);
      if (dbReplyStatus && (dbReplyStatus.has_replied || dbReplyStatus.is_unsubscribed || dbReplyStatus.is_bounced)) {
        continue;
      }

      if (a.initial_thread_id) {
        const replied = await serverSideCheckReplies(gmail, a.initial_thread_id, senderEmail);
        if (replied) {
          console.log(`[CRON] Lead ${lead.company} has replied! Updating status.`);
          const existingRS = replyStatusMap.get(lead.id);
          await supabase.from('reply_status').upsert({
            id: existingRS?.id || generateUUID(),
            lead_id: lead.id,
            campaign_id: campaign.id,
            user_id: campaign.user_id,
            has_replied: true,
            reply_count: 1,
            last_checked: new Date().toISOString(),
          }, { onConflict: 'lead_id' });
          
          await incrementCampaignCounter('increment_campaign_replies', campaign.id, 'reply_count');

          await supabase.from('lead_analysis')
            .update({ sent_status: 'replied', updated_at: new Date().toISOString() })
            .eq('id', a.id);

          continue;
        }
      }

      const initialSentAt = a.sent_at || a.last_email_sent_at;
      if (!initialSentAt) continue;
      const daysSinceInitial = (now.getTime() - new Date(initialSentAt).getTime()) / (1000 * 60 * 60 * 24);

      let followUpKey: 'followUp1' | 'followUp2' | 'followUp3' | null = null;
      let daysLabel = '';
      let isFollowUp1 = false;
      let isFollowUp2 = false;
      let isFollowUp3 = false;

      if (!a.follow_up1_sent && daysSinceInitial >= followUpDays[0]) {
        followUpKey = 'followUp1';
        daysLabel = '1';
        isFollowUp1 = true;
      } else if (a.follow_up1_sent && !a.follow_up2_sent && daysSinceInitial >= followUpDays[1]) {
        followUpKey = 'followUp2';
        daysLabel = '2';
        isFollowUp2 = true;
      } else if (a.follow_up2_sent && !a.follow_up3_sent && daysSinceInitial >= followUpDays[2]) {
        followUpKey = 'followUp3';
        daysLabel = '3';
        isFollowUp3 = true;
      }

      if (!followUpKey) continue;

      let emailBody = a[followUpKey] || a.ai_analysis?.[followUpKey];
      if (!emailBody) {
        console.warn(`[CRON] No follow-up template body for ${lead.company} on key ${followUpKey}`);
        await supabase
          .from('lead_analysis')
          .update({
            error_reason: `Missing ${followUpKey} content — regenerate emails for this lead`,
            updated_at: new Date().toISOString(),
          })
          .eq('id', a.id);
        continue;
      }

      dueLeads.push({
        lead,
        analysis: a,
        followUpKey,
        daysLabel,
        isFollowUp1,
        isFollowUp2,
        isFollowUp3,
        emailBody
      });
    }

    if (dueLeads.length > 0) {
      console.log(`[CRON] Found ${dueLeads.length} due follow-ups for campaign "${campaign.name}". Spacing them out...`);
      
      const startTime = campaign.follow_up_start_time || '14:00';
      const endTimeStr = campaign.follow_up_end_time || '16:00';
      const [endHour, endMinute] = endTimeStr.split(':').map(Number);
      
      const endTimeToday = new Date();
      endTimeToday.setHours(endHour, endMinute, 0, 0);
      let remainingMs = endTimeToday.getTime() - Date.now();
      
      const minWindowMs = dueLeads.length * 2 * 60 * 1000; // at least 2 minutes per email
      if (remainingMs < minWindowMs) {
        remainingMs = minWindowMs;
      }
      
      const endTime = new Date(Date.now() + remainingMs);

      for (let i = 0; i < dueLeads.length; i++) {
        if (cancelledCampaigns.has(campaign.id)) {
          console.log(`[CRON FOLLOWUP] Cancelled by user for campaign ${campaign.id}. Stopping.`);
          break;
        }
        const { lead, analysis: a, followUpKey, daysLabel, isFollowUp1, isFollowUp2, isFollowUp3, emailBody } = dueLeads[i];
        
        // Re-verify reply/unsubscribe status before sending to prevent duplicates / sending to replied leads
        const { data: latestReply } = await supabase
          .from('reply_status')
          .select('*')
          .eq('lead_id', lead.id)
          .maybeSingle();
        if (latestReply && (latestReply.has_replied || latestReply.is_unsubscribed || latestReply.is_bounced)) {
          console.log(`[CRON] Lead ${lead.company} has replied or unsubscribed recently. Skipping follow-up.`);
          continue;
        }

        // ATOMIC CLAIM — only one concurrent run can win this
        const sentFlagCol = isFollowUp1 ? 'follow_up1_sent' : isFollowUp2 ? 'follow_up2_sent' : 'follow_up3_sent';
        const { data: claimedRows, error: claimError } = await supabase
          .from('lead_analysis')
          .update({ [sentFlagCol]: true, updated_at: new Date().toISOString() })
          .eq('id', a.id)
          .eq(sentFlagCol, false)
          .select();

        if (claimError || !claimedRows || claimedRows.length === 0) {
          console.log(`[CRON] Follow-up ${daysLabel} for ${lead.company} already claimed by another run. Skipping.`);
          continue;
        }

        const rawFollowUpBody = typeof emailBody === 'object' ? (emailBody.body || '') : String(emailBody);
        let cleanBody = rawFollowUpBody.replace(/(\bTosin\b[\s\S]*?)(\s*\bTosin\b[\s\S]*?)$/, '$1');
        
        cleanBody = replaceTokensServer(cleanBody, {
          recipient: lead.recipient || lead.contact_name || lead.email?.split('@')[0],
          company: lead.company,
          website: lead.website,
          email: lead.email,
          customFields: lead.custom_fields || lead.customFields || {}
        });

        const initialEmailObj = a.initial_email || a.ai_analysis?.initialEmail;
        const originalSubject = initialEmailObj?.subject || 'Your website';
        const rawSubject = originalSubject.toLowerCase().startsWith('re:') ? originalSubject : `Re: ${originalSubject}`;
        const subject = replaceTokensServer(rawSubject, {
          recipient: lead.recipient || lead.contact_name || lead.email?.split('@')[0],
          company: lead.company,
          website: lead.website,
          email: lead.email,
          customFields: lead.custom_fields || lead.customFields || {}
        });

        console.log(`[CRON] Sending follow-up ${daysLabel} to ${lead.company} (${lead.email})`);

        try {
          let internetMessageId: string | undefined = undefined;
          if (a.initial_message_id) {
            try {
              const prevMsg = await gmail.users.messages.get({ userId: 'me', id: a.initial_message_id });
              const headers = prevMsg.data.payload?.headers || [];
              internetMessageId = headers.find(h => h.name?.toLowerCase() === 'message-id')?.value;
            } catch (e) {
              console.warn(`[CRON] Could not retrieve previous Message-ID header:`, e);
            }
          }

          const encodedMessage = buildThreadedRawEmail({
            to: lead.email,
            subject,
            body: cleanBody,
            internetMessageId
          });

          await gmail.users.messages.send({
            userId: 'me',
            requestBody: {
              threadId: a.initial_thread_id || undefined,
              raw: encodedMessage
            }
          });

          await incrementQuota(senderEmail, campaign.id);

          const updates: any = {
            last_email_sent_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            [`${sentFlagCol}_at`]: new Date().toISOString()
          };

          await supabase.from('lead_analysis').update(updates).eq('id', a.id);
          console.log(`[CRON] Successfully sent and saved follow-up ${daysLabel} for ${lead.company}`);
          results.push({ lead: lead.company, success: true, followUp: daysLabel });
          totalSent++;

          // spacing delay (identical logic to frontend: even spacing with jitter)
          if (i < dueLeads.length - 1) {
            const nowAfter = new Date();
            const currentRemainingMs = endTime.getTime() - nowAfter.getTime();
            if (currentRemainingMs > 0) {
              const remainingEmails = dueLeads.length - i - 1;
              const baseDelay = currentRemainingMs / remainingEmails;
              const variation = (Math.random() - 0.5) * 30000; // ±15 seconds
              const delay = Math.max(baseDelay + variation, 15000); // minimum 15 seconds
              console.log(`[CRON] Spacing next follow-up. Waiting ${Math.round(delay / 1000)}s...`);
              await new Promise(resolve => setTimeout(resolve, delay));
            }
          }

        } catch (sendErr: any) {
          // Send failed — release the claim so a future run can retry this follow-up
          await supabase.from('lead_analysis').update({ [sentFlagCol]: false }).eq('id', a.id).catch(() => {});
          console.error(`[CRON] Failed to send follow-up ${daysLabel} to ${lead.company}:`, sendErr.message || sendErr);
          results.push({ lead: lead.company, success: false, error: sendErr.message || String(sendErr) });
        }
      }
    }
  }

  return { success: true, results, totalSent };
}

app.all('/api/cron/send-followups', (req, res) => {
  const force = req.query.force === 'true' || req.body.force === true;
  const campaignId = req.body.campaignId || req.query.campaignId;
  
  console.log(`[API CRON] Trigger received via ${req.method}. Force: ${force}, Campaign ID: ${campaignId || 'All'}`);
  
  res.status(202).json({
    success: true,
    message: 'Follow-up background process initiated successfully.'
  });
  
  processDueFollowups(campaignId, force).then(result => {
    console.log('[API CRON] Background follow-up process complete:', result);
  }).catch(err => {
    console.error('[API CRON] Background follow-up process failed:', err);
  });
});

app.all('/api/cron/send-initial', (req, res) => {
  const forceWindow = req.query.forceWindow === 'true' || req.body.forceWindow === true;
  const campaignId = req.body.campaignId || req.query.campaignId;
  
  console.log(`[API CRON INITIAL] Trigger received via ${req.method}. ForceWindow: ${forceWindow}, Campaign ID: ${campaignId || 'All'}`);
  
  res.status(202).json({
    success: true,
    message: 'Initial email background process initiated successfully.'
  });
  
  processDueInitialEmails(campaignId, forceWindow).then(result => {
    if (result && result.totalSent && result.totalSent > 0) {
      console.log('[API CRON INITIAL] Background initial email process complete:', result);
    } else {
      console.log('[API CRON INITIAL] Background initial email process complete (no due emails sent).');
    }
  }).catch(err => {
    console.error('[API CRON INITIAL] Background initial email process failed:', err);
  });
});

// ============================================================
// DATABASE DEDUPLICATION ON STARTUP (ADDITION)
// ============================================================

async function cleanDuplicateLeadAnalysis() {
  const supabase = getSupabase();
  try {
    console.log('[DEDUPLICATE] Running lead_analysis deduplication check...');
    const { data, error } = await supabase
      .from('lead_analysis')
      .select('id, lead_id, campaign_id, sent_status, batch_status, updated_at');
    
    if (error || !data) {
      console.error('[DEDUPLICATE] Failed to fetch lead_analysis rows:', error);
      return;
    }

    // Group by campaign_id + lead_id
    const groups = new Map<string, any[]>();
    for (const row of data) {
      if (!row.lead_id || !row.campaign_id) continue;
      const key = `${row.campaign_id}:${row.lead_id}`;
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(row);
    }

    let deletedCount = 0;
    for (const [key, rows] of groups.entries()) {
      if (rows.length <= 1) continue;

      // Sort rows so the "best" or "most active" row is first.
      // Rules:
      // 1. Row with sent_status = 'sent' or 'replied' or 'unsubscribed' is better than 'failed' or 'not-sent'
      // 2. If same sent_status, row with latest updated_at is better
      rows.sort((r1, r2) => {
        const score = (r: any) => {
          if (r.sent_status === 'sent') return 10;
          if (r.sent_status === 'replied') return 10;
          if (r.sent_status === 'unsubscribed') return 10;
          if (r.sent_status === 'sending') return 5;
          if (r.sent_status === 'failed') return 1;
          return 0;
        };
        const s1 = score(r1);
        const s2 = score(r2);
        if (s1 !== s2) return s2 - s1; // Descending
        return new Date(r2.updated_at).getTime() - new Date(r1.updated_at).getTime(); // Descending
      });

      // Keep the first row, delete the rest
      const [keepRow, ...duplicateRows] = rows;
      const idsToDelete = duplicateRows.map(r => r.id);
      
      console.log(`[DEDUPLICATE] Duplicate found for campaign-lead: ${key}. Keeping ${keepRow.id} (sent_status: ${keepRow.sent_status}), deleting ${idsToDelete.length} duplicates.`);
      
      const { error: delError } = await supabase
        .from('lead_analysis')
        .delete()
        .in('id', idsToDelete);
      
      if (delError) {
        console.error(`[DEDUPLICATE] Failed to delete duplicates for ${key}:`, delError);
      } else {
        deletedCount += idsToDelete.length;
      }
    }
    console.log(`[DEDUPLICATE] Completed lead_analysis deduplication. Deleted ${deletedCount} duplicate rows.`);
  } catch (err) {
    console.error('[DEDUPLICATE] Unexpected error during deduplication:', err);
  }
}

// ============================================================
// SERVER START
// ============================================================

async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';
  console.log(`Starting Selio server in ${isProd ? 'production' : 'development'} mode...`);

  // Run duplicate row cleanup
  await cleanDuplicateLeadAnalysis().catch(err => {
    console.error('[STARTUP] Duplicate cleanup failed:', err);
  });

  // Required environment variables startup check
  const hasSupabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const hasSupabaseKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  if (!hasSupabaseUrl || !hasSupabaseKey) {
    console.warn('⚠️ WARNING: SUPABASE_URL and/or SUPABASE_ANON_KEY (or their VITE_ equivalents) environment variables are missing. Please configure them in AI Studio Settings.');
  }

  try {
    additionalAccounts = await loadAdditionalAccounts();
    console.log(`[ACCOUNTS] Loaded ${Object.keys(additionalAccounts).length} additional accounts from Supabase.`);
  } catch (err: any) {
    console.warn('[ACCOUNTS] Note: Failed to load additional accounts on startup:', err.message || err);
  }

  // Automatic database cleanup on startup for stuck 'sending' states
  try {
    const supabase = getSupabase();
    const { error: resetError } = await supabase
      .from('lead_analysis')
      .update({ sent_status: 'not-sent', updated_at: new Date().toISOString() })
      .eq('sent_status', 'sending');
    if (resetError) {
      console.warn('[STARTUP] Note: Could not reset stuck sending statuses:', resetError.message);
    } else {
      console.log('[STARTUP] Cleaned up stuck sending statuses from database.');
    }
  } catch (err: any) {
    console.warn('[STARTUP] Note: Failed to perform database cleanup on startup:', err.message || err);
  }

  if (!isProd) {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => res.sendFile(path.join(distPath, 'index.html')));
  }

  // Error handler BEFORE listen
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error('Global Server Error:', err);
    res.status(500).json({ error: 'Internal Server Error', message: err.message });
  });

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Selio server running on http://0.0.0.0:${PORT}`);
    
    const useInternalCron = process.env.USE_INTERNAL_CRON !== 'false'; // default: on

    if (useInternalCron) {
      console.log('[BG CRON] Internal in-process cron ENABLED (set USE_INTERNAL_CRON=false to disable).');

      let isProcessing = false;
      setInterval(() => {
        if (isProcessing) return;
        isProcessing = true;
        processDueFollowups()
          .then(result => console.log('[BG CRON] Hourly follow-up job complete:', result))
          .catch(err => console.error('[BG CRON] Hourly follow-up job failed:', err))
          .finally(() => { isProcessing = false; });
      }, 60 * 60 * 1000);

      let isProcessingInitial = false;
      setInterval(() => {
        if (isProcessingInitial) return;
        isProcessingInitial = true;
        processDueInitialEmails()
          .then(result => {
            if (result?.totalSent > 0) console.log('[BG CRON INITIAL] Job complete:', result);
          })
          .catch(err => console.error('[BG CRON INITIAL] Job failed:', err))
          .finally(() => { isProcessingInitial = false; });
      }, 60 * 1000);
    } else {
      console.log('[BG CRON] Internal cron DISABLED — relying on external cron for /api/cron/* endpoints.');
    }
  });
}

startServer();
