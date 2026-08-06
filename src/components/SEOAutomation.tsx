import React, { useState, useEffect, useRef, useCallback } from 'react';
import * as XLSX from 'xlsx';
import Papa from 'papaparse';
import { toast } from 'react-hot-toast';
import { getCampaigns, saveCampaign, deleteCampaign, getLastOpenedCampaign, updateCampaignLastOpened, getLeads, saveLeads, reconcileLeadDeletions, deleteCampaignLeads, getAnalysis, saveAnalysis, saveBulkAnalysis, deleteCampaignAnalysis, getReplyStatus, saveReplyStatus, deleteCampaignReplyStatus, getReputation, saveReputation, getEmailTemplates, saveEmailTemplate, deleteEmailTemplate, getBatchSchedule, saveBatchSchedule, SERVER_OWNED_DB_TO_CLIENT_FIELD, checkCrossCampaignDuplicates, deleteLead } from '../lib/db';
import { supabase } from '../lib/supabase';

// Custom Fetch Wrapper to automatically sync refreshed Google tokens from the server
const customFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const response = await window.fetch(input, init);
  try {
    const refreshed = response.headers.get('x-refreshed-tokens');
    if (refreshed) {
      localStorage.setItem('google_tokens', refreshed);
    } else {
      // Also check response body if it's JSON and has refreshedTokens
      const cloned = response.clone();
      const contentType = cloned.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        const data = await cloned.json();
        if (data && data.refreshedTokens) {
          localStorage.setItem('google_tokens', typeof data.refreshedTokens === 'string' ? data.refreshedTokens : JSON.stringify(data.refreshedTokens));
        }
      }
    }
  } catch (e) {}
  return response;
};

// Shadow global fetch with our customFetch wrapper within this file
const fetch = customFetch;

// Campaign type
interface Campaign {
  id: string;
  name: string;
  country: string;
  timezone?: string;
  createdAt: string;
  lastOpened?: string;
  leadCount?: number;
  analyzedCount?: number;
  sentCount?: number;
  replyCount?: number;
  followUpStartTime?: string;
  followUpEndTime?: string;
  senderAccountId?: string; // email of the Gmail account to use (blank = use primary)
  industry?: string;
  decisionMakerTitle?: string;
  icpContext?: string;
  followUp1Days?: number;
  followUp2Days?: number;
  followUp3Days?: number;
  scheduleStartTime?: string;
  scheduleEndTime?: string;
  dailyLimit?: number;
}

const FOLLOW_UP_DAYS = [3, 10, 17]; // days after last email to send follow‑up 1,2,3
const GEMINI_RATE_LIMIT = 14; // 1 below Gemini's 15 req/min limit
const BATCH_WINDOW_MS = 62000; // 62 seconds per batch window

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

// Mirrors server's zonedTimeToUtc — converts a wall-clock date+time, entered
// as "in the campaign's local timezone", into the correct UTC instant.
// Needed client-side because this file can't import server code.
const zonedTimeToUtc = (dateStr: string, timeStr: string, timeZone: string): Date => {
  const [year, month, day] = dateStr.split('-').map(Number);
  const [hour, minute] = (timeStr || '09:00').split(':').map(Number);
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const tzString = utcGuess.toLocaleString('en-US', { timeZone });
  const tzDate = new Date(tzString);
  const offsetMs = utcGuess.getTime() - tzDate.getTime();
  return new Date(utcGuess.getTime() + offsetMs);
};

const generateUUID = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
};

// Storage keys
const CAMPAIGNS_STORAGE_KEY = 'selio_campaigns';
const getCampaignLeadsKey = (campaignId: string) => `selio_campaign_${campaignId}_leads`;

const exportAllData = () => {
  const allData: Record<string, any> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith('selio_')) {
      try {
        allData[key] = JSON.parse(localStorage.getItem(key) || '');
      } catch {
        allData[key] = localStorage.getItem(key);
      }
    }
  }
  const blob = new Blob([JSON.stringify(allData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `selio-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast.success('Data exported. Keep this file safe.');
};

const importAllData = (file: File) => {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target?.result as string);
      Object.entries(data).forEach(([key, value]) => {
        localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
      });
      toast.success('Data restored. Refreshing...');
      setTimeout(() => window.location.reload(), 1000);
    } catch {
      toast.error('Invalid backup file. Could not restore data.');
    }
  };
  reader.readAsText(file);
};

const getCampaignResultsKey = (campaignId: string) => `selio_campaign_${campaignId}_results`;
const getCampaignRepliesKey = (campaignId: string) => `selio_campaign_${campaignId}_replies`;

// ============================================================
// CONSTANTS
// ============================================================

const APP_URL = 'https://ais-dev-f6ny6jzkhehm2w4pcukekx-205557446103.europe-west2.run.app';
const STORAGE_KEY = 'selio_pipeline_results';
const COUNTRIES = ['United Kingdom','United States','Nigeria','Canada','Australia','South Africa','Ghana','Kenya','India','Germany','France','Other'];

const COLORS = {
  navy: '#0A0F1E', navyLight: '#111827', navyBorder: '#1E293B',
  white: '#FFFFFF', offWhite: '#F8FAFC',
  amber: '#F59E0B', amberLight: '#FEF3C7', amberDark: '#D97706',
  slate: '#64748B', slateLight: '#94A3B8',
  red: '#EF4444', redLight: '#FEE2E2',
  orange: '#F97316', orangeLight: '#FFEDD5',
  yellow: '#EAB308', yellowLight: '#FEF9C3',
  green: '#22C55E', greenLight: '#DCFCE7',
  blue: '#3B82F6', blueLight: '#DBEAFE',
};

const STATUS_CONFIG: Record<string, any> = {
  'hot-lead': { bg: '#FEE2E2', text: '#EF4444', label: 'Hot Lead' },
  'warm-lead': { bg: '#FFEDD5', text: '#F97316', label: 'Warm Lead' },
  'cold-lead': { bg: '#F1F5F9', text: '#64748B', label: 'Cold Lead' },
  'low-priority': { bg: '#FEF9C3', text: '#EAB308', label: 'Low Priority' },
  'strong-seo': { bg: '#DCFCE7', text: '#22C55E', label: 'Strong SEO' },
  'manual-review': { bg: '#DBEAFE', text: '#3B82F6', label: 'Manual Review' },
  'analyzed': { bg: '#DCFCE7', text: '#22C55E', label: 'Analyzed' },
  'disqualified': { bg: '#F1F5F9', text: '#94A3B8', label: 'Disqualified' },
  'error': { bg: '#FEF9C3', text: '#EAB308', label: 'Retry' },
};

// ============================================================
// LOCAL STORAGE HELPERS
// ============================================================

const clearSession = () => {
  try {
    ['selio_pipeline_results','seo_pipeline_results','seo_leads','seo_spreadsheet_id','seo_sheet_name'].forEach(k => localStorage.removeItem(k));
  } catch (e) {}
};

const buildLeadResult = (lead: any, result: any, campaignIndustry?: string) => {
  const ai = result.aiAnalysis;
  const score = result.score !== undefined ? result.score : (result.details?.opportunityScore || 0);
  const originalStatus = result.status || 'analyzed';
  const finalStatus = ['disqualified', 'manual-review', 'error'].includes(originalStatus)
    ? originalStatus
    : getLeadStatus(score, campaignIndustry);
  return {
    ...result,
    status: finalStatus,
    initialEmail: result.initialEmail || ai?.initialEmail || null,
    followUp1: result.followUp1 || ai?.followUp1 || null,
    followUp2: result.followUp2 || ai?.followUp2 || null,
    followUp3: result.followUp3 || ai?.followUp3 || null,
    subjectLines: result.subjectLines || ai?.subjectLines || [],
    insights: ai?.insights || result.insights || '',
    primaryProblem: ai?.primaryProblem || result.primaryProblem || '',
    sentStatus: result.sentStatus || 'not-sent',
    sentAt: result.sentAt || null,
    sentTo: result.sentTo || null,
    followUp1Sent: result.followUp1Sent || false,
    followUp1SentAt: result.followUp1SentAt || null,
    followUp2Sent: result.followUp2Sent || false,
    followUp2SentAt: result.followUp2SentAt || null,
    followUp3Sent: result.followUp3Sent || false,
    followUp3SentAt: result.followUp3SentAt || null,
    lastEmailSentAt: result.lastEmailSentAt || result.sentAt || null,
    customFields: lead.customFields || {},
  };
};

// ============================================================
// SMALL REUSABLE COMPONENTS
// ============================================================

const StatusBadge = ({ status }: { status: string }) => {
  const config = STATUS_CONFIG[status] || STATUS_CONFIG['warm-lead'];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 20, fontSize: 10, fontWeight: 700, background: config.bg, color: config.text, textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: config.text, display: 'inline-block', flexShrink: 0 }} />
      {config.label}
    </span>
  );
};

const ScoreRing = ({ score, size = 56, campaignIndustry }: { score: any; size?: number; campaignIndustry?: string }) => {
  const num = parseInt(score) || 0;
  const template = campaignIndustry ? ICP_TEMPLATES[campaignIndustry] : null;
  const hotThreshold = template?.hotThreshold ?? 70;
  const warmThreshold = template?.warmThreshold ?? 40;

  const color = num >= hotThreshold 
    ? COLORS.red 
    : num >= warmThreshold 
    ? COLORS.orange 
    : num >= 15 
    ? COLORS.yellow 
    : COLORS.green;

  const r = (size - 8) / 2;
  const circ = 2 * Math.PI * r;
  const dash = (num / 100) * circ;
  const tooltipText = template 
    ? `Opportunity Score: ${num} (Hot: ${hotThreshold}+, Warm: ${warmThreshold}+ for ${campaignIndustry})`
    : `Opportunity Score: ${num}`;

  return (
    <div title={tooltipText} style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="#E2E8F0" strokeWidth={5} />
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={5} strokeDasharray={`${dash} ${circ}`} strokeLinecap="round" />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ fontSize: size > 50 ? 14 : 10, fontWeight: 900, color, fontFamily: 'monospace', lineHeight: 1 }}>{isNaN(num) ? '?' : num}</span>
      </div>
    </div>
  );
};

const PSIBar = ({ label, score }: { label: string; score: number }) => {
  const color = score >= 85 ? COLORS.green : score >= 50 ? COLORS.amber : COLORS.red;
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
        <span style={{ fontSize: 11, color: COLORS.slate, fontWeight: 600 }}>{label}</span>
        <span style={{ fontSize: 11, fontWeight: 700, color, fontFamily: 'monospace' }}>{Math.round(score)}</span>
      </div>
      <div style={{ height: 4, background: '#E2E8F0', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${score}%`, background: color, borderRadius: 4 }} />
      </div>
    </div>
  );
};

const SignalPill = ({ label, good }: { label: string; good: boolean }) => (
  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', background: good ? COLORS.greenLight : COLORS.redLight, borderRadius: 8 }}>
    <span style={{ fontSize: 11, fontWeight: 700, color: COLORS.navy }}>{label}</span>
    <span style={{ fontSize: 11, fontWeight: 700, color: good ? COLORS.green : COLORS.red }}>{good ? '✓' : '✗'}</span>
  </div>
);

const CopyBtn = ({ text, label = 'Copy' }: { text: string; label?: string }) => {
  const [copied, setCopied] = useState(false);
  return (
    <button onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
      style={{ padding: '4px 10px', borderRadius: 6, fontSize: 10, fontWeight: 700, border: `1px solid ${copied ? COLORS.green : '#E2E8F0'}`, background: copied ? COLORS.greenLight : 'white', color: copied ? COLORS.green : COLORS.slate, cursor: 'pointer', whiteSpace: 'nowrap' }}>
      {copied ? '✓ Copied' : label}
    </button>
  );
};

const EmailBlock = ({ label, day, body, subject, onSave, onPreview, lead }: { 
  label: string; 
  day?: string; 
  body: string; 
  subject?: string; 
  onSave?: (newBody: string) => void;
  onPreview?: () => void;
  lead?: any;
}) => {
  const [open, setOpen] = useState(label === 'Initial Email');
  const [isEditing, setIsEditing] = useState(false);
  const [editBody, setEditBody] = useState(body || '');

  useEffect(() => {
    setEditBody(body || '');
  }, [body]);

  if (!body) return null;
  
  const allTokens = ['first_name', 'company', 'website', ...Object.keys(lead?.customFields || {})];

  return (
    <div style={{ border: `1px solid ${COLORS.navyBorder}`, borderRadius: 12, overflow: 'hidden', marginBottom: 10 }}>
      <button onClick={() => setOpen(!open)} style={{ width: '100%', padding: '12px 16px', background: open ? COLORS.navyLight : 'white', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: open ? COLORS.amber : COLORS.navy, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</span>
          {day && <span style={{ fontSize: 10, color: COLORS.slateLight, background: '#F1F5F9', padding: '2px 6px', borderRadius: 4 }}>{day}</span>}
        </div>
        <span style={{ fontSize: 12, color: COLORS.slateLight }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div style={{ padding: 16, background: 'white', borderTop: `1px solid ${COLORS.navyBorder}` }}>
          {subject && (
            <div style={{ marginBottom: 12, padding: '8px 12px', background: COLORS.amberLight, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 9, fontWeight: 700, color: COLORS.amberDark, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>Subject</div>
                <div style={{ fontSize: 12, fontWeight: 600, color: COLORS.navy, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{subject}</div>
              </div>
              <CopyBtn text={subject} />
            </div>
          )}
          {isEditing && (
            <div style={{ marginBottom: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {allTokens.map(token => (
                <button
                  key={token}
                  onClick={() => {
                    const textarea = document.querySelector(`textarea[data-email-edit="${label}"]`) as HTMLTextAreaElement;
                    if (textarea) {
                      const start = textarea.selectionStart;
                      const end = textarea.selectionEnd;
                      const newText = editBody.substring(0, start) + `{{${token}}}` + editBody.substring(end);
                      setEditBody(newText);
                      setTimeout(() => {
                        textarea.focus();
                        textarea.setSelectionRange(start + token.length + 4, start + token.length + 4);
                      }, 10);
                    }
                  }}
                  style={{ padding: '2px 8px', fontSize: 10, background: '#F1F5F9', border: 'none', borderRadius: 12, cursor: 'pointer' }}
                >
                  {`{{${token}}}`}
                </button>
              ))}
            </div>
          )}
          {isEditing ? (
            <textarea
              data-email-edit={label}
              value={editBody || ''}
              onChange={e => setEditBody(e.target.value)}
              style={{
                width: '100%',
                minHeight: 200,
                fontSize: 13,
                lineHeight: 1.8,
                color: '#1E293B',
                backgroundColor: 'white',
                fontFamily: 'Georgia, serif',
                border: '1px solid #CBD5E1',
                borderRadius: 8,
                padding: 12,
                boxSizing: 'border-box',
                outline: 'none'
              }}
            />
          ) : (
            <div style={{ fontSize: 13, lineHeight: 1.8, color: '#374151', whiteSpace: 'pre-wrap', fontFamily: 'Georgia, serif' }}>{body}</div>
          )}
          <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            {isEditing ? (
              <>
                <button onClick={() => { setEditBody(body); setIsEditing(false); }} style={{ padding: '4px 10px', borderRadius: 6, fontSize: 10, fontWeight: 700, border: '1px solid #E2E8F0', background: '#F1F5F9', color: COLORS.slate, cursor: 'pointer' }}>Cancel</button>
                <button onClick={() => { onSave?.(editBody); setIsEditing(false); }} style={{ padding: '4px 10px', borderRadius: 6, fontSize: 10, fontWeight: 700, border: 'none', background: COLORS.green, color: 'white', cursor: 'pointer' }}>Save</button>
              </>
            ) : (
              <>
                <CopyBtn text={body} label="Copy Email" />
                {onPreview && <button onClick={onPreview} style={{ padding: '4px 10px', borderRadius: 6, fontSize: 10, fontWeight: 700, border: '1px solid #E2E8F0', background: COLORS.amberLight, color: COLORS.amberDark, cursor: 'pointer' }}>👁️ Preview</button>}
                {onSave && <button onClick={() => { setEditBody(body); setIsEditing(true); }} style={{ padding: '4px 10px', borderRadius: 6, fontSize: 10, fontWeight: 700, border: '1px solid #E2E8F0', background: 'white', color: COLORS.slate, cursor: 'pointer' }}>✏️ Edit</button>}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

const EmailPreviewModal = ({ isOpen, onClose, subject, body, recipientName, leadCompany }: { 
  isOpen: boolean; 
  onClose: () => void; 
  subject: string; 
  body: string; 
  recipientName?: string;
  leadCompany?: string;
}) => {
  if (!isOpen) return null;

  const renderEmailHTML = () => {
    const stripSig = (text: string) => text
      .replace(/\n+Tosin Adesina\s*\nSEO Growth Strategist\s*$/i, '')
      .replace(/\n+Tosin\s*$/i, '')
      .trim();

    const cleanBody = stripSig(body);
    const paragraphs = cleanBody.split('\n\n').filter(p => p.trim());
    const formattedParagraphs = paragraphs.map(p => {
      const lines = p.split('\n').join('<br>');
      return `<p style="margin: 0 0 20px 0; line-height: 1.7; font-family: Georgia, 'Times New Roman', serif; font-size: 15px; color: #1a1a1a;">${lines}</p>`;
    }).join('');

    return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin: 0; padding: 0; background-color: #ffffff;">
  <div style="max-width: 560px; padding: 32px 24px; font-family: Georgia, 'Times New Roman', serif;">
    ${formattedParagraphs}
    <p style="margin: 28px 0 0 0; line-height: 1.6; font-family: Georgia, 'Times New Roman', serif; font-size: 15px; color: #1a1a1a;">
      Tosin Adesina<br>
      <span style="font-size: 13px; color: #555555;">SEO Growth Strategist</span>
    </p>
    <p style="margin: 24px 0 0 0; font-family: Arial, sans-serif; font-size: 11px; color: #999999;">
      To stop receiving these emails, reply with the word Unsubscribe.
    </p>
  </div>
</body>
</html>`;
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10000, padding: 16 }}>
      <div style={{ background: 'white', borderRadius: 20, width: '100%', maxWidth: 700, maxHeight: '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '16px 20px', borderBottom: `1px solid ${COLORS.navyBorder}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 900, color: COLORS.navy }}>Email Preview</div>
            <div style={{ fontSize: 11, color: COLORS.slate }}>To: {recipientName || 'Lead'} • {leadCompany || ''}</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 24, cursor: 'pointer', color: COLORS.slate }}>&times;</button>
        </div>
        <div style={{ padding: '12px 20px', background: COLORS.amberLight, borderBottom: `1px solid ${COLORS.navyBorder}` }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: COLORS.amberDark, textTransform: 'uppercase' }}>Subject Line</div>
          <div style={{ fontSize: 14, fontWeight: 600, color: COLORS.navy }}>{subject || '(No subject)'}</div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
          <iframe srcDoc={renderEmailHTML()} title="Email Preview" style={{ width: '100%', minHeight: 400, border: 'none', background: 'white', borderRadius: 8 }} sandbox="allow-same-origin" />
        </div>
        <div style={{ padding: '16px 20px', borderTop: `1px solid ${COLORS.navyBorder}`, display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
          <button onClick={onClose} style={{ padding: '8px 16px', borderRadius: 8, fontSize: 12, fontWeight: 700, background: '#F1F5F9', color: COLORS.slate, border: 'none', cursor: 'pointer' }}>Close</button>
          <button onClick={() => { navigator.clipboard.writeText(body); toast.success('Email body copied'); }} style={{ padding: '8px 16px', borderRadius: 8, fontSize: 12, fontWeight: 700, background: COLORS.blueLight, color: COLORS.blue, border: 'none', cursor: 'pointer' }}>📋 Copy Body</button>
        </div>
      </div>
    </div>
  );
};

const replaceTokens = (text: string, lead: any): string => {
  if (!text) return text;
  let result = text;
  result = result.replace(/{{first_name}}/g, lead.recipient?.split(' ')[0] || 'there');
  result = result.replace(/{{full_name}}/g, lead.recipient || 'there');
  result = result.replace(/{{company}}/g, lead.company || 'Company');
  result = result.replace(/{{website}}/g, lead.website || '');
  result = result.replace(/{{email}}/g, lead.email || '');
  if (lead.customFields) {
    Object.entries(lead.customFields).forEach(([key, value]) => {
      result = result.replaceAll(`{{${key}}}`, String(value));
    });
  }
  return result;
};

const TITLES_TO_STRIP = ['dr', 'prof', 'mr', 'mrs', 'ms', 'miss', 'sir', 'rev', 'qc', 'cbe', 'obe', 'mbe'];

const extractFirstName = (fullName: string): string => {
  if (!fullName || !fullName.trim()) return 'there';
  const parts = fullName.trim().split(/\s+/);
  const filtered = parts.filter(p => !TITLES_TO_STRIP.includes(p.toLowerCase().replace(/\./g, '')));
  const first = filtered[0] || parts[0] || 'there';
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
};

const getHeaderFingerprint = (headers: string[]): string => {
  return [...headers].sort().join('|').toLowerCase();
};

const getSavedMapping = (headers: string[]) => {
  const fingerprint = getHeaderFingerprint(headers);
  const saved = localStorage.getItem(`selio_mapping_${fingerprint}`);
  return saved ? JSON.parse(saved) : null;
};

const saveMapping = (headers: string[], mapping: any) => {
  const fingerprint = getHeaderFingerprint(headers);
  localStorage.setItem(`selio_mapping_${fingerprint}`, JSON.stringify(mapping));
};

const ICP_TEMPLATES: Record<string, {
  decisionMaker: string;
  icpContext: string;
  followUp1Days: number;
  followUp2Days: number;
  followUp3Days: number;
  hotThreshold: number;
  warmThreshold: number;
}> = {
  'Solicitor firms': {
    decisionMaker: 'Founding partner, managing partner, or owner',
    icpContext: 'Partner-led firms where client acquisition is the owner personal responsibility. Analytical, reads carefully, dismisses anything vague immediately. Responds to specific provable claims. Frame everything around losing a client to a competing firm.',
    followUp1Days: 4, followUp2Days: 11, followUp3Days: 19,
    hotThreshold: 45, warmThreshold: 25,
  },
  'Dental clinics': {
    decisionMaker: 'Practice owner or principal dentist',
    icpContext: 'Owner is usually the lead practitioner. Time-poor and patient-focused. Does not think about marketing until a chair is empty. Frame everything around missed appointments and patients choosing a competitor based on what they found online first.',
    followUp1Days: 3, followUp2Days: 9, followUp3Days: 16,
    hotThreshold: 50, warmThreshold: 30,
  },
  'Physiotherapy practices': {
    decisionMaker: 'Practice owner or clinic director',
    icpContext: 'Owner is the lead therapist in most cases. Referral-dependent but increasingly reliant on online search. Frame everything around a patient choosing a competing clinic they found first on Google.',
    followUp1Days: 3, followUp2Days: 9, followUp3Days: 16,
    hotThreshold: 50, warmThreshold: 30,
  },
  'Accountancy firms': {
    decisionMaker: 'Founding partner or managing director',
    icpContext: 'Partner-led, risk-averse, and highly sceptical of anything that sounds like a sales pitch. They trust numbers and specifics. Frame everything around a prospective client researching them online and choosing a firm that appeared more credible.',
    followUp1Days: 4, followUp2Days: 11, followUp3Days: 19,
    hotThreshold: 45, warmThreshold: 25,
  },
  'Real estate agencies': {
    decisionMaker: 'Agency owner or director',
    icpContext: 'Commission-driven and competitive. They understand that losing a listing to a competitor is a direct hit to income. Frame everything around vendors or landlords finding a competitor first during their online search.',
    followUp1Days: 3, followUp2Days: 8, followUp3Days: 14,
    hotThreshold: 55, warmThreshold: 35,
  },
  'Restaurants and cafes': {
    decisionMaker: 'Owner or general manager',
    icpContext: 'Owner-operated, margin-thin, and overwhelmed. Cares about footfall and bookings above everything else. Frame everything around someone searching for a place to eat nearby and choosing a restaurant they found instead.',
    followUp1Days: 2, followUp2Days: 6, followUp3Days: 12,
    hotThreshold: 60, warmThreshold: 40,
  },
  'Home services': {
    decisionMaker: 'Business owner or sole trader',
    icpContext: 'Mostly word of mouth but increasingly dependent on Google searches. Owner does everything. Frame everything around a homeowner searching for their service in their area and calling a competitor who appeared higher in the results.',
    followUp1Days: 3, followUp2Days: 8, followUp3Days: 14,
    hotThreshold: 55, warmThreshold: 35,
  },
};

const getLeadStatus = (score: number, campaignIndustry?: string): string => {
  const template = campaignIndustry ? ICP_TEMPLATES[campaignIndustry] : null;
  const hotThreshold = template?.hotThreshold ?? 70;
  const warmThreshold = template?.warmThreshold ?? 40;

  if (score >= hotThreshold) return 'hot-lead';
  if (score >= warmThreshold) return 'warm-lead';
  return 'cold-lead';
};

const isWithinCampaignWindow = (startTime: string, endTime: string, timezone: string): boolean => {
  const nowInTz = new Date(new Date().toLocaleString('en-US', { timeZone: timezone }));
  const [startHour, startMinute] = (startTime || '09:00').split(':').map(Number);
  const [endHour, endMinute] = (endTime || '17:00').split(':').map(Number);
  const startTimeToday = new Date(nowInTz);
  startTimeToday.setHours(startHour, startMinute, 0, 0);
  const endTimeToday = new Date(nowInTz);
  endTimeToday.setHours(endHour, endMinute, 0, 0);
  return nowInTz >= startTimeToday && nowInTz <= endTimeToday;
};

// ============================================================
// MAIN COMPONENT
// ============================================================

export default function SEOAutomation() {
  const userId = 'tosin'; // single user for now

  // Campaign management state
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(null);
  const [localCampaignName, setLocalCampaignName] = useState('');

  // Load campaigns on mount
  useEffect(() => {
    const initCampaigns = async () => {
      try {
        const dbCampaigns = await getCampaigns(userId);
        setCampaigns(dbCampaigns || []);
        
        const lastId = await getLastOpenedCampaign(userId);
        if (lastId && dbCampaigns && dbCampaigns.some((c: any) => c.id === lastId)) {
          setSelectedCampaignId(lastId);
        } else if (dbCampaigns && dbCampaigns.length > 0) {
          setSelectedCampaignId(dbCampaigns[0].id);
        }
      } catch (e) {
        console.error('Error loading campaigns on mount:', e);
      }
    };
    initCampaigns();
  }, []);

  // Derived campaign data
  const currentCampaign = campaigns.find(c => c.id === selectedCampaignId);
  const campaignName = currentCampaign?.name ?? 'My Campaign';
  const campaignCountry = currentCampaign?.country ?? 'United Kingdom';

  // Synchronize local campaign name with the active campaign's name
  useEffect(() => {
    if (currentCampaign) {
      setLocalCampaignName(currentCampaign.name || '');
    } else {
      setLocalCampaignName('');
    }
  }, [selectedCampaignId, currentCampaign?.name, currentCampaign]);

  const resolveStatus = (a: any) => {
    if (!a) return 'cold-lead';
    if (['disqualified', 'manual-review', 'error'].includes(a.status)) return a.status;
    return getLeadStatus(a.score, currentCampaign?.industry);
  };

  const getAnalysisRequestBody = (lead: any, extraFields: any = {}) => {
    return JSON.stringify({
      lead,
      campaignCountry,
      campaignIndustry: currentCampaign?.industry || '',
      campaignDecisionMaker: currentCampaign?.decisionMakerTitle || '',
      campaignIcpContext: currentCampaign?.icpContext || '',
      campaignFollowUp1Days: currentCampaign?.followUp1Days || 3,
      campaignFollowUp2Days: currentCampaign?.followUp2Days || 10,
      campaignFollowUp3Days: currentCampaign?.followUp3Days || 17,
      ...extraFields
    });
  };

  const setCampaignName = (newName: string) => {
    if (!selectedCampaignId) return;
    setCampaigns(prev => prev.map(c => 
      c.id === selectedCampaignId ? { ...c, name: newName } : c
    ));
  };

  const setCampaignCountry = (newCountry: string) => {
    if (!selectedCampaignId) return;
    setCampaigns(prev => prev.map(c => 
      c.id === selectedCampaignId ? { ...c, country: newCountry } : c
    ));
  };

  const setCampaignSenderAccountId = (senderId: string) => {
    if (!selectedCampaignId) return;
    setCampaigns(prev => prev.map(c => 
      c.id === selectedCampaignId ? { ...c, senderAccountId: senderId } : c
    ));
  };

  const setCampaignDailyLimit = (limit: number) => {
    if (!selectedCampaignId) return;
    setDailyLimit(limit); // keep local state in sync for immediate UI feedback
    setCampaigns(prev => prev.map(c =>
      c.id === selectedCampaignId ? { ...c, dailyLimit: limit } : c
    ));
  };

  const setCampaignScheduleStartTime = (time: string) => {
    if (!selectedCampaignId) return;
    setCampaigns(prev => prev.map(c => 
      c.id === selectedCampaignId ? { ...c, scheduleStartTime: time } : c
    ));
  };

  const setCampaignScheduleEndTime = (time: string) => {
    if (!selectedCampaignId) return;
    setCampaigns(prev => prev.map(c => 
      c.id === selectedCampaignId ? { ...c, scheduleEndTime: time } : c
    ));
  };

  // Core state
  const [activeSection, setActiveSection] = useState<'pipeline' | 'intel' | 'emails' | 'reports' | 'schedule'>('pipeline');
  const [activeTab, setActiveTab] = useState<'sheet' | 'file'>('sheet');
  const [spreadsheetId, setSpreadsheetId] = useState(() => localStorage.getItem('seo_spreadsheet_id') || '');
  const [sheetName, setSheetName] = useState(() => localStorage.getItem('seo_sheet_name') || 'Sheet1');
  const [leads, setLeads] = useState<any[]>([]);
  const [pendingRows, setPendingRows] = useState<any[]>([]);
  const [detectedHeaders, setDetectedHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState({ company: '', website: '', email: '', recipient: '' });
  const [customMappings, setCustomMappings] = useState<Array<{ sourceColumn: string; fieldName: string }>>([]);
  const [showMapper, setShowMapper] = useState(false);
  const [reviewLeads, setReviewLeads] = useState<any[]>([]);
  const [showLeadReview, setShowLeadReview] = useState(false);
  const [pendingReviewLeads, setPendingReviewLeads] = useState<any[]>([]);
  const [duplicateCheck, setDuplicateCheck] = useState<{ count: number; matchKeys: string[]; campaignNames: string[] } | null>(null);
  const [showDuplicateModal, setShowDuplicateModal] = useState(false);
  const [analyzedLeads, setAnalyzedLeads] = useState<Record<number, any>>({});
  const [manualEmailInputs, setManualEmailInputs] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(false);
  const [currentLeadIndex, setCurrentLeadIndex] = useState(-1);
  const [analyzingRows, setAnalyzingRows] = useState<Set<number>>(new Set());
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(() => {
    try {
      const tokens = localStorage.getItem('google_tokens');
      if (!tokens) return false;
      const parsed = JSON.parse(tokens);
      if (parsed.expiry_date && parsed.expiry_date < Date.now()) {
        if (parsed.refresh_token) {
          return true; // Keep expired tokens if there's a refresh token so they can be auto-refreshed
        }
        localStorage.removeItem('google_tokens');
        return false;
      }
      return true;
    } catch (e) {
      return false;
    }
  });
  const [hasLocalTokens, setHasLocalTokens] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<any>(null);
  const [showInstallBanner, setShowInstallBanner] = useState(false);

  // Loading states for async actions
  const [runningAnalysis, setRunningAnalysis] = useState(false);
  const [retryingAnalysis, setRetryingAnalysis] = useState(false);
  const [retryingEmails, setRetryingEmails] = useState(false);
  const [sendingFollowUps, setSendingFollowUps] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [bulkDrafting, setBulkDrafting] = useState(false);
  const [sendingTest, setSendingTest] = useState(false);
  const [retryingSends, setRetryingSends] = useState(false);
  const [exportingCSV, setExportingCSV] = useState(false);
  const [cancelBatch, setCancelBatch] = useState(false);
  const cancelBatchRef = useRef(false);
  const [backendStatus, setBackendStatus] = useState<'online' | 'offline' | 'checking'>('checking');

  // Email Templates Library states
  const [templates, setTemplates] = useState<Array<{ id: string; name: string; subject: string; body: string; createdAt: string }>>(() => {
    try {
      const saved = localStorage.getItem('selio_email_templates');
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [currentTemplateId, setCurrentTemplateId] = useState<string | null>(null);

  // Per-Campaign Sender Accounts states
  const [connectedAccounts, setConnectedAccounts] = useState<Array<{ email: string; active: boolean }>>([]);
  const [showAccountManager, setShowAccountManager] = useState(false);

  // Create Campaign Modal state
  const [showCreateCampaignModal, setShowCreateCampaignModal] = useState(false);
  const [newCampaignSenderAccountId, setNewCampaignSenderAccountId] = useState('');
  const [newCampaignName, setNewCampaignName] = useState('');
  const [newCampaignCountry, setNewCampaignCountry] = useState('United Kingdom');
  const [newCampaignIndustry, setNewCampaignIndustry] = useState('');
  const [newCampaignDecisionMaker, setNewCampaignDecisionMaker] = useState('');
  const [newCampaignIcpContext, setNewCampaignIcpContext] = useState('');
  const [newCampaignFollowUp1Days, setNewCampaignFollowUp1Days] = useState(3);
  const [newCampaignFollowUp2Days, setNewCampaignFollowUp2Days] = useState(10);
  const [newCampaignFollowUp3Days, setNewCampaignFollowUp3Days] = useState(17);
  const [isOtherCountrySelected, setIsOtherCountrySelected] = useState(false);

  // Unified Custom Confirm Dialog state
  const [confirmDialog, setConfirmDialog] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    onConfirm: () => void | Promise<void>;
  }>({
    isOpen: false,
    title: '',
    message: '',
    onConfirm: () => {},
  });

  // Search, sort, bulk selection
  const [searchTerm, setSearchTerm] = useState('');
  const [sortBy, setSortBy] = useState<'score' | 'status' | 'sentDate' | 'company'>('score');
  const [selectedLeadRows, setSelectedLeadRows] = useState<Set<number>>(new Set());

  const fetchConfig = async () => {
    try {
      const response = await fetch('/api/auth/config');
      const data = await response.json();
      setServerConfig(data);
    } catch (e) {}
  };

  const getAuthHeaders = useCallback((): Record<string, string> => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    try {
      const tokens = localStorage.getItem('google_tokens');
      if (tokens) headers['x-google-tokens'] = tokens;
    } catch (e) {}
    return headers;
  }, []);

  const fetchWithGoogleAuth = useCallback(async (url: string, options: RequestInit = {}) => {
    const headers = {
      ...getAuthHeaders(),
      ...(options.headers || {})
    };
    const res = await fetch(url, {
      ...options,
      headers
    });
    
    if (res.status === 401) {
      localStorage.removeItem('google_tokens');
      setIsAuthenticated(false);
      setHasLocalTokens(false);
      toast.error('Google session expired or invalid. Please reconnect your Google account.');
      return res;
    }

    const clone = res.clone();
    try {
      const data = await clone.json();
      if (data && data.refreshedTokens) {
        localStorage.setItem('google_tokens', JSON.stringify(data.refreshedTokens));
        setIsAuthenticated(true);
        setHasLocalTokens(true);
      }
    } catch (e) {}

    return res;
  }, [getAuthHeaders]);
  const [serverConfig, setServerConfig] = useState<any>(null);
  const [selectedLead, setSelectedLead] = useState<any>(null);
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [debugLog, setDebugLog] = useState<string[]>([]);
  const [showSetup, setShowSetup] = useState(false);
  // Campaign
  const [sentFilter, setSentFilter] = useState<'all' | 'sent' | 'not-sent' | 'failed'>('all');
  const [replyStatus, setReplyStatus] = useState<Record<number, { hasReplied: boolean; lastChecked: string | null; replyCount: number; unsubscribed?: boolean }>>({});
  const [checkingReplies, setCheckingReplies] = useState(false);

  // Preview modal state
  const [previewModal, setPreviewModal] = useState<{
    isOpen: boolean;
    subject: string;
    body: string;
    recipientName?: string;
    leadCompany?: string;
  }>({
    isOpen: false,
    subject: '',
    body: '',
    recipientName: '',
    leadCompany: '',
  });

  // Reputation data per campaign
  const [reputationData, setReputationData] = useState<{
    bounces: number;
    spamReports: number;
    sentCount: number;
    lastUpdated: string;
  }>({ bounces: 0, spamReports: 0, sentCount: 0, lastUpdated: new Date().toISOString() });

  const loadedCampaignIdRef = useRef<string | null>(null);
  const isLoadingRef = useRef(false);
  const lastSavedLeadsJsonRef = useRef<string>('');
  const lastSavedAnalyzedLeadsRef = useRef<string>('');
  const lastSavedReplyStatusRef = useRef<string>('');
  const skipNextAnalyzedSaveRef = useRef(false);
  const skipNextReplyStatusSaveRef = useRef(false);

  const saveToSession = useCallback(async (results: Record<number, any>) => {
    if (selectedCampaignId) {
      await saveBulkAnalysis(selectedCampaignId, userId, results, leads);
    }
  }, [selectedCampaignId, leads]);

  // We'll add a useEffect to load campaign data when selectedCampaignId changes
  useEffect(() => {
    if (!selectedCampaignId) {
      loadedCampaignIdRef.current = null;
      return;
    }
    
    // Load leads, results, replies, and reputation for this campaign from DB
    const loadCampaignData = async () => {
      isLoadingRef.current = true;
      try {
        const leadsData = await getLeads(selectedCampaignId);
        lastSavedLeadsJsonRef.current = JSON.stringify(leadsData || []);
        setLeads(leadsData || []);
        
        const resultsData = await getAnalysis(selectedCampaignId);
        lastSavedAnalyzedLeadsRef.current = JSON.stringify(resultsData || {});
        setAnalyzedLeads(resultsData || {});
        
        const repliesData = await getReplyStatus(selectedCampaignId);
        lastSavedReplyStatusRef.current = JSON.stringify(repliesData || {});
        setReplyStatus(repliesData || {});

        const repData = await getReputation(selectedCampaignId);
        setReputationData({
          bounces: repData?.bounces || 0,
          spamReports: repData?.spamReports || 0,
          sentCount: repData?.sentCount || 0,
          lastUpdated: repData?.lastUpdated || new Date().toISOString(),
        });
        
        // Update last opened
        setCampaigns(prev => prev.map(c => 
          c.id === selectedCampaignId ? { ...c, lastOpened: new Date().toISOString() } : c
        ));
        await updateCampaignLastOpened(selectedCampaignId);
        loadedCampaignIdRef.current = selectedCampaignId;
      } catch (e) {
        console.error('Error loading campaign data from DB:', e);
      } finally {
        isLoadingRef.current = false;
      }
    };
    loadCampaignData();
  }, [selectedCampaignId]);
  
  // Live-sync server-owned fields (sent status, follow-up flags, etc.) so the
  // UI reflects sends that happened via cron while this tab was just sitting
  // open with stale local state — without touching any client-owned fields
  // the user might be actively editing (email body, analysis data, etc.)
  useEffect(() => {
    if (!selectedCampaignId) return;

    const channel = supabase
      .channel(`lead_analysis_live_${selectedCampaignId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'lead_analysis', filter: `campaign_id=eq.${selectedCampaignId}` },
        (payload) => {
          const newRow = payload.new as any;
          if (!newRow?.lead_id) return;

          setLeads(currentLeads => {
            const lead = currentLeads.find(l => l._supabaseId === newRow.lead_id);
            if (!lead) return currentLeads; // lead not loaded locally yet, nothing to merge into

            setAnalyzedLeads(prev => {
              const existing = prev[lead.rowIndex];
              if (!existing) return prev; // no local analysis to merge into

              const serverPatch: any = {};
              for (const [dbCol, clientField] of Object.entries(SERVER_OWNED_DB_TO_CLIENT_FIELD)) {
                if (newRow[dbCol] !== undefined) serverPatch[clientField] = newRow[dbCol];
              }

              skipNextAnalyzedSaveRef.current = true;
              return {
                ...prev,
                [lead.rowIndex]: { ...existing, ...serverPatch },
              };
            });

            return currentLeads; // this setter is just for the read, no actual leads change
          });
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'reply_status', filter: `campaign_id=eq.${selectedCampaignId}` },
        (payload) => {
          const newRow = payload.new as any;
          if (!newRow?.lead_id) return;

          setLeads(currentLeads => {
            const lead = currentLeads.find(l => l._supabaseId === newRow.lead_id);
            if (!lead) return currentLeads;

            setReplyStatus(prev => {
              skipNextReplyStatusSaveRef.current = true;
              return {
                ...prev,
                [lead.rowIndex]: {
                  hasReplied: newRow.has_replied,
                  unsubscribed: newRow.is_unsubscribed,
                  replyCount: newRow.reply_count,
                  lastChecked: newRow.last_checked,
                },
              };
            });

            return currentLeads;
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [selectedCampaignId]);

  // Fallback slow poll for reliability in case WebSocket disconnects
  useEffect(() => {
    if (!selectedCampaignId) return;
    const interval = setInterval(async () => {
      try {
        const fresh = await getAnalysis(selectedCampaignId);
        skipNextAnalyzedSaveRef.current = true;
        setAnalyzedLeads(prev => {
          const merged = { ...prev };
          for (const [rowIndex, freshRow] of Object.entries(fresh)) {
            const rx = Number(rowIndex);
            if (!merged[rx]) continue;
            const serverPatch: any = {};
            for (const clientField of Object.values(SERVER_OWNED_DB_TO_CLIENT_FIELD)) {
              if ((freshRow as any)[clientField] !== undefined) serverPatch[clientField] = (freshRow as any)[clientField];
            }
            merged[rx] = { ...merged[rx], ...serverPatch };
          }
          return merged;
        });
      } catch (e) {
        console.error('[LIVE SYNC] Fallback poll failed:', e);
      }
    }, 90 * 1000); // 90s — realtime should beat this most of the time, this is just a safety net
    return () => clearInterval(interval);
  }, [selectedCampaignId]);
  
  // Save leads when they change and sync back _supabaseId
  useEffect(() => {
    if (isLoadingRef.current) return;
    if (!selectedCampaignId || selectedCampaignId !== loadedCampaignIdRef.current) return;
    if (!leads.length) return;

    const leadsJson = JSON.stringify(leads);
    if (leadsJson === lastSavedLeadsJsonRef.current) return;

    const persist = async () => {
      try {
        lastSavedLeadsJsonRef.current = leadsJson;
        await saveLeads(selectedCampaignId, userId, leads);
        const freshLeads = await getLeads(selectedCampaignId);
        if (freshLeads && freshLeads.length) {
          const freshLeadsJson = JSON.stringify(freshLeads);
          lastSavedLeadsJsonRef.current = freshLeadsJson;
          setLeads(freshLeads);
        }
      } catch (err) {
        console.error('[PERSIST] leads error:', err);
      }
    };
    persist();
  }, [leads, selectedCampaignId]);

  // Save analysis using the current leads state with _supabaseId
  useEffect(() => {
    console.log('[PERSIST CHECK]', { 
      selectedCampaignId, 
      loadedRef: loadedCampaignIdRef.current, 
      match: selectedCampaignId === loadedCampaignIdRef.current,
      analyzedCount: Object.keys(analyzedLeads).length 
    });
    if (!selectedCampaignId || selectedCampaignId !== loadedCampaignIdRef.current) return;
    if (!Object.keys(analyzedLeads).length) return;

    if (skipNextAnalyzedSaveRef.current) {
      skipNextAnalyzedSaveRef.current = false;
      lastSavedAnalyzedLeadsRef.current = JSON.stringify(analyzedLeads);
      return;
    }

    const serializeAnalyzed = JSON.stringify(analyzedLeads);
    if (serializeAnalyzed === lastSavedAnalyzedLeadsRef.current) return;

    const persist = async () => {
      try {
        console.log('[PERSIST] saving analysis for', Object.keys(analyzedLeads).length, 'leads');
        lastSavedAnalyzedLeadsRef.current = serializeAnalyzed;
        await saveBulkAnalysis(selectedCampaignId, userId, analyzedLeads, leads);
      } catch (err) {
        console.error('[PERSIST] analysis error:', err);
      }
    };
    persist();
  }, [analyzedLeads, leads, selectedCampaignId]);

  // Save reply status when it changes
  useEffect(() => {
    if (!selectedCampaignId || selectedCampaignId !== loadedCampaignIdRef.current) return;
    if (!Object.keys(replyStatus).length) return;

    if (skipNextReplyStatusSaveRef.current) {
      skipNextReplyStatusSaveRef.current = false;
      lastSavedReplyStatusRef.current = JSON.stringify(replyStatus);
      return;
    }

    const serializeReplyStatus = JSON.stringify(replyStatus);
    if (serializeReplyStatus === lastSavedReplyStatusRef.current) return;

    const persist = async () => {
      try {
        lastSavedReplyStatusRef.current = serializeReplyStatus;
        await Promise.all(Object.entries(replyStatus).map(([rowIndex, status]: [string, any]) => {
          const lead = leads.find(l => l.rowIndex === parseInt(rowIndex));
          if (!lead?._supabaseId) return Promise.resolve();
          return saveReplyStatus(selectedCampaignId, userId, lead._supabaseId, status);
        }));
      } catch (err) {
        console.error('[PERSIST] reply status error:', err);
      }
    };
    persist();
  }, [replyStatus, leads, selectedCampaignId]);

  // Persist reputation data
  useEffect(() => {
    if (selectedCampaignId && selectedCampaignId === loadedCampaignIdRef.current) {
      const persistReputation = async () => {
        try {
          await saveReputation(selectedCampaignId, userId, reputationData);
        } catch (err) {
          console.error('Error saving reputation:', err);
        }
      };
      persistReputation();
    }
  }, [reputationData, selectedCampaignId]);
  
  // Replace the "save all campaigns on any change" effect with a diff-aware
  // save — track which campaign id actually changed and save only that one.
  const prevCampaignsRef = useRef<Campaign[]>([]);
  useEffect(() => {
    const prev = prevCampaignsRef.current;
    const changed = campaigns.filter(c => {
      const old = prev.find(p => p.id === c.id);
      return !old || JSON.stringify(old) !== JSON.stringify(c);
    });

    const persistCampaign = async (campaign: Campaign) => {
      try {
        await saveCampaign(campaign, userId);
      } catch (err) {
        console.error('Error saving campaign:', err);
      }
    };

    changed.forEach(persistCampaign);
    prevCampaignsRef.current = campaigns;
  }, [campaigns]);

  const createCampaign = async (name: string, country: string) => {
    const newId = generateUUID();
    const newCampaign: Campaign = {
      id: newId,
      name,
      country,
      senderAccountId: newCampaignSenderAccountId,
      timezone: TIMEZONE_MAP[country] || 'UTC',
      industry: newCampaignIndustry,
      decisionMakerTitle: newCampaignDecisionMaker,
      icpContext: newCampaignIcpContext,
      followUp1Days: newCampaignFollowUp1Days,
      followUp2Days: newCampaignFollowUp2Days,
      followUp3Days: newCampaignFollowUp3Days,
      createdAt: new Date().toISOString(),
      followUpStartTime: '14:00', // default 2 PM
      followUpEndTime: '16:00',   // default 4 PM
    };
    
    try {
      // 1. Save the campaign to the database first so it exists in Supabase before any references
      await saveCampaign(newCampaign, userId);
      
      // 2. Pre-initialize empty leads list in DB to avoid any foreign key issues later
      try {
        await saveLeads(newId, userId, []);
      } catch (leadErr) {
        console.warn('[DB] Non-blocking warning pre-initializing leads:', leadErr);
      }

      // 3. Update the UI state
      setCampaigns(prev => {
        if (prev.some(c => c.id === newId)) return prev;
        return [...prev, newCampaign];
      });
      setSelectedCampaignId(newId);
      
      // Reset current lead and status data
      setLeads([]);
      setAnalyzedLeads({});
      setReplyStatus({});
      
      toast.success(`Campaign "${name}" created`);
    } catch (err) {
      console.error('[DB] Error creating campaign:', err);
      toast.error('Failed to create campaign in database. Please try again.');
    }
  };

  const handleDeleteCampaign = (id: string) => {
    const campaign = campaigns.find(c => c.id === id);
    const campaignName = campaign ? campaign.name : '';
    setConfirmDialog({
      isOpen: true,
      title: '🗑️ Delete Campaign',
      message: `Delete campaign "${campaignName}"? All leads, analysis, and emails will be permanently lost. This cannot be undone.`,
      onConfirm: async () => {
        try {
          await deleteCampaignLeads(id);
          await deleteCampaignAnalysis(id);
          await deleteCampaignReplyStatus(id);
          await deleteCampaign(id);
        } catch (e) {
          console.error(e);
        }
        setCampaigns(prev => prev.filter(c => c.id !== id));
        if (selectedCampaignId === id) {
          const nextCampaign = campaigns.find(c => c.id !== id);
          setSelectedCampaignId(nextCampaign?.id || null);
        }
        toast.success('Campaign deleted');
      }
    });
  };

  const handleDeleteLead = (lead: any) => {
    setConfirmDialog({
      isOpen: true,
      title: '🗑️ Delete Lead',
      message: `Delete "${lead.company || lead.website}"? Its analysis and email history will be permanently lost. This cannot be undone.`,
      onConfirm: async () => {
        try {
          if (lead._supabaseId) {
            await deleteLead(lead._supabaseId);
          }
          const updatedLeads = leads.filter(l => l.rowIndex !== lead.rowIndex);
          setLeads(updatedLeads);
          setAnalyzedLeads(prev => {
            const next = { ...prev };
            delete next[lead.rowIndex];
            return next;
          });
          if (selectedCampaignId) {
            localStorage.setItem(getCampaignLeadsKey(selectedCampaignId), JSON.stringify(updatedLeads));
          } else {
            localStorage.setItem('seo_leads', JSON.stringify(updatedLeads));
          }
          toast.success('Lead deleted');
        } catch (e) {
          console.error(e);
          toast.error('Failed to delete lead.');
        }
      }
    });
  };

  const handleDeleteSelectedLeads = () => {
    const count = selectedLeadRows.size;
    if (count === 0) return;
    setConfirmDialog({
      isOpen: true,
      title: '🗑️ Delete Leads',
      message: `Delete ${count} selected lead${count === 1 ? '' : 's'}? Their analysis and email history will be permanently lost. This cannot be undone.`,
      onConfirm: async () => {
        try {
          const toDelete = leads.filter(l => selectedLeadRows.has(l.rowIndex));
          await Promise.all(toDelete.filter(l => l._supabaseId).map(l => deleteLead(l._supabaseId)));
          const updatedLeads = leads.filter(l => !selectedLeadRows.has(l.rowIndex));
          setLeads(updatedLeads);
          setAnalyzedLeads(prev => {
            const next = { ...prev };
            toDelete.forEach(l => delete next[l.rowIndex]);
            return next;
          });
          setSelectedLeadRows(new Set());
          if (selectedCampaignId) {
            localStorage.setItem(getCampaignLeadsKey(selectedCampaignId), JSON.stringify(updatedLeads));
          } else {
            localStorage.setItem('seo_leads', JSON.stringify(updatedLeads));
          }
          toast.success(`${toDelete.length} lead${toDelete.length === 1 ? '' : 's'} deleted`);
        } catch (e) {
          console.error(e);
          toast.error('Failed to delete some leads.');
        }
      }
    });
  };

  const duplicateCampaign = async (campaign: Campaign) => {
    const newId = generateUUID();
    const newName = `${campaign.name} (Copy)`;
    const newCampaign: Campaign = {
      ...campaign,
      id: newId,
      name: newName,
      createdAt: new Date().toISOString(),
    };
    // Copy leads, results, and replies if they exist
    const oldLeads = await getLeads(campaign.id);
    const oldAnalysis = await getAnalysis(campaign.id);
    const oldReplies = await getReplyStatus(campaign.id);

    if (oldLeads && oldLeads.length > 0) {
      await saveLeads(newId, userId, oldLeads);
      const freshLeads = await getLeads(newId);
      setLeads(freshLeads || []);
    }
    await saveBulkAnalysis(newId, userId, oldAnalysis || {}, oldLeads || []);
    
    if (oldReplies && Object.keys(oldReplies).length > 0) {
      const newLeadsFromDb = await getLeads(newId);
      await Promise.all(Object.entries(oldReplies).map(([rowIndex, status]: [string, any]) => {
        const lead = newLeadsFromDb.find((l: any) => l.rowIndex === parseInt(rowIndex));
        if (!lead?._supabaseId) return Promise.resolve();
        return saveReplyStatus(newId, userId, lead._supabaseId, status);
      }));
    }
    
    setCampaigns(prev => [...prev, newCampaign]);
    toast.success(`Campaign duplicated as "${newName}"`);
    setSelectedCampaignId(newId);
  };

  // Migration from old flat storage (run once)
  useEffect(() => {
    const oldLeads = localStorage.getItem('seo_leads');
    const oldResults = localStorage.getItem('seo_pipeline_results');
    const runMigration = async () => {
      if (oldLeads && campaigns.length === 0) {
        const defaultCampaign: Campaign = {
          id: 'default',
          name: 'My First Campaign',
          country: 'United Kingdom',
          createdAt: new Date().toISOString(),
        };
        await saveCampaign(defaultCampaign, userId);
        const parsedLeads = JSON.parse(oldLeads);
        await saveLeads('default', userId, parsedLeads);
        const freshLeads = await getLeads('default');
        setLeads(freshLeads || []);
        if (oldResults) {
          const parsedResults = JSON.parse(oldResults);
          await saveBulkAnalysis('default', userId, parsedResults, freshLeads || parsedLeads);
        }
        // Clean old keys
        localStorage.removeItem('seo_leads');
        localStorage.removeItem('seo_pipeline_results');
        
        const dbCampaigns = await getCampaigns(userId);
        setCampaigns(dbCampaigns);
        setSelectedCampaignId('default');
        toast('Migrated your existing leads to a new campaign');
      }
    };
    runMigration();
  }, [campaigns.length]);
  // Mike
  const [mikeOpen, setMikeOpen] = useState(false);
  const [mikeMessages, setMikeMessages] = useState<any[]>([{ role: 'mike', content: "Hi! I'm Mike, your SEO outreach strategist. I can rewrite emails, prioritize leads, or help plan your campaign. What do you need?" }]);
  const [mikeInput, setMikeInput] = useState('');
  const [mikeModel, setMikeModel] = useState('gemini-flash');
  const [mikeLoading, setMikeLoading] = useState(false);
  const [mikeActionLog, setMikeActionLog] = useState<any[]>([]);
  // Test email
  const [showTestModal, setShowTestModal] = useState(false);
  const [testEmailTo, setTestEmailTo] = useState('');
  const [testLead, setTestLead] = useState<any>(null);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    setIsMobile(window.innerWidth < 768);
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const [generatingEmails, setGeneratingEmails] = useState(false);
  const [sendingQueue, setSendingQueue] = useState(false);
  const [queueProgress, setQueueProgress] = useState({ current: 0, total: 0 });
  const [dailyLimit, setDailyLimit] = useState(30);

  // Load/synchronize dailyLimit with active campaign
  useEffect(() => {
    if (currentCampaign) {
      setDailyLimit(currentCampaign.dailyLimit ?? 50);
    }
  }, [selectedCampaignId, currentCampaign]);
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [showBatchScheduleModal, setShowBatchScheduleModal] = useState(false);
  const [batchDays, setBatchDays] = useState(3);
  const [batchSplitMode, setBatchSplitMode] = useState<'even' | 'manual'>('even');
  const [batchOrderMode, setBatchOrderMode] = useState<'priority' | 'list'>('priority');
  const [manualBatchSizes, setManualBatchSizes] = useState<number[]>([]);
  const [batchTimes, setBatchTimes] = useState<string[]>([]);
  const [batchPreview, setBatchPreview] = useState<any[]>([]);
  const [showBatchPreview, setShowBatchPreview] = useState(false);
  const [activeBatchBanner, setActiveBatchBanner] = useState<any>(null);
  const [scheduleSettings, setScheduleSettings] = useState({
    sendDate: new Date().toISOString().split('T')[0],
    startTime: '09:00',
    endTime: '11:00',
  });
  const [failedAnalysis, setFailedAnalysis] = useState<number[]>([]);
  const [failedEmails, setFailedEmails] = useState<number[]>([]);

  // DEBUG STATES AND HELPER (ADDITION 1)
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugData, setDebugData] = useState<any>(null);
  const [debugLoading, setDebugLoading] = useState(false);
  const [debugError, setDebugError] = useState<string | null>(null);

  // Restore Batch Banner on mount or selectedCampaignId / dependencies change
  useEffect(() => {
    if (!selectedCampaignId) return;

    const restoreBatchBanner = async () => {
      try {
        if (activeBatchBanner) return; // already showing

        const schedule = await getBatchSchedule(selectedCampaignId);
        if (!schedule || !schedule.batchSchedule) return;

        const currentBatchData = schedule.batchSchedule.find(
          (b: any) => b.day === schedule.currentBatch
        );
        if (!currentBatchData) return;

        // Check if all batches already sent
        const allSent = schedule.currentBatch > schedule.batchSchedule.length;
        if (allSent) return;

        const cleanLeads = currentBatchData.leads.filter((l: any) => {
          return (
            !replyStatus[l.rowIndex]?.hasReplied &&
            !replyStatus[l.rowIndex]?.unsubscribed &&
            analyzedLeads[l.rowIndex]?.sentStatus !== 'bounced'
          );
        });

        const removedCount =
          currentBatchData.leads.length - cleanLeads.length;

        setActiveBatchBanner({
          day: schedule.currentBatch,
          count: cleanLeads.length,
          hotCount: cleanLeads.filter(
            (l: any) => analyzedLeads[l.rowIndex]?.status === 'hot-lead'
          ).length,
          warmCount: cleanLeads.filter(
            (l: any) => analyzedLeads[l.rowIndex]?.status === 'warm-lead'
          ).length,
          time: currentBatchData.time,
          leads: cleanLeads,
          totalBatches: schedule.batchSchedule.length,
          removedCount,
        });
      } catch (e) {
        console.error('Failed to restore batch banner:', e);
      }
    };

    restoreBatchBanner();
  }, [selectedCampaignId, activeBatchBanner, analyzedLeads, replyStatus]);

  const fetchDebugData = async () => {
    setDebugLoading(true);
    setDebugError(null);
    try {
      const response = await fetch('/api/debug', {
        headers: {
          'X-Google-Tokens': localStorage.getItem('google_tokens') || ''
        }
      });
      if (!response.ok) {
        throw new Error(`HTTP Error: ${response.status}`);
      }
      const data = await response.json();
      setDebugData(data);
    } catch (err: any) {
      setDebugError(err.message || String(err));
    } finally {
      setDebugLoading(false);
    }
  };

  const mikeEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const refreshGoogleToken = async () => {
      try {
        const currentTokens = localStorage.getItem('google_tokens');
        const res = await fetch('/api/auth/refresh', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'X-Google-Tokens': currentTokens || '',
            'Content-Type': 'application/json'
          }
        });
        const data = await res.json();
        if (data.tokens) {
          localStorage.setItem('google_tokens', JSON.stringify(data.tokens));
          setIsAuthenticated(true);
          return true;
        } else if (res.status === 401 || (data.error && (data.error.includes('refresh') || data.error.includes('invalid_grant')))) {
          localStorage.removeItem('google_tokens');
          setIsAuthenticated(false);
        }
      } catch (e) {}
      return false;
    };

    const checkAuth = async () => {
      try {
        const localTokens = localStorage.getItem('google_tokens');
        let isValid = false;
        if (localTokens) {
          try {
            const tokens = JSON.parse(localTokens);
            if (tokens) {
              if (tokens.expiry_date && Date.now() >= tokens.expiry_date) {
                isValid = false;
              } else {
                isValid = !!(tokens.access_token || tokens.refresh_token);
              }
            }
          } catch {
            isValid = false;
          }
        }
        
        let authenticated = isValid;
        if (!isValid && localTokens) {
          const refreshed = await refreshGoogleToken();
          if (refreshed) {
            authenticated = true;
          }
        }

        if (authenticated) {
          setIsAuthenticated(true);
        } else {
          setIsAuthenticated(false);
          // Only clear if JSON parsing is completely corrupt, to prevent loss of setup on transient 500s
          if (localTokens) {
            try {
              JSON.parse(localTokens);
            } catch {
              localStorage.removeItem('google_tokens');
            }
          }
        }

        const currentTokens = localStorage.getItem('google_tokens');
        const response = await fetch('/api/auth/status', {
          headers: { 'X-Google-Tokens': currentTokens || '' }
        });
        const res = await response.json();
        
        if (res.isAuthenticated) {
          setIsAuthenticated(true);
        } else if (currentTokens) {
          const refreshed = await refreshGoogleToken();
          if (refreshed) {
            setIsAuthenticated(true);
          } else {
            setIsAuthenticated(false);
          }
        } else {
          setIsAuthenticated(false);
        }
      } catch (e) {
        console.error(e);
      } finally {
        setIsInitialLoading(false);
      }
    };
    checkAuth();

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').then(() => {
        console.log('[SELIO] Service worker registered');
      }).catch(e => console.warn('[SELIO] SW registration failed:', e));
    }

    const handleBeforeInstall = (e: any) => {
      e.preventDefault();
      setInstallPrompt(e);
      setShowInstallBanner(true);
    };
    window.addEventListener('beforeinstallprompt', handleBeforeInstall);
    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstall);
    };
  }, []);

  const checkBackendHealth = async () => {
    setBackendStatus('checking');
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const response = await fetch('/api/health', { signal: controller.signal });
      clearTimeout(timeoutId);
      if (response.ok) {
        setBackendStatus('online');
      } else {
        setBackendStatus('offline');
      }
    } catch (err) {
      setBackendStatus('offline');
    }
  };

  useEffect(() => {
    checkBackendHealth();
    const interval = setInterval(checkBackendHealth, 60 * 1000); // every minute
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'GOOGLE_AUTH_SUCCESS' && event.data.tokens) {
        try {
          const currentTokens = localStorage.getItem('google_tokens');
          let merged = event.data.tokens;
          if (currentTokens) {
            try {
              const parsed = JSON.parse(currentTokens);
              if (parsed?.refresh_token && !merged.refresh_token) {
                merged = { ...merged, refresh_token: parsed.refresh_token };
              }
            } catch (e) {}
          }
          localStorage.setItem('google_tokens', JSON.stringify(merged));
          setIsAuthenticated(true);
          setHasLocalTokens(true);
          toast.success('Connected to Google!');
        } catch (e) {
          toast.error('Could not save credentials');
        }
        setTimeout(() => fetchConfig(), 600);
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem('selio_email_templates', JSON.stringify(templates));
    } catch {}
  }, [templates]);

  const fetchAccounts = async () => {
    try {
      const res = await fetch('/api/accounts', { headers: getAuthHeaders() });
      const data = await res.json();
      setConnectedAccounts(data.accounts || []);
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    fetchAccounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'ADDITIONAL_ACCOUNT_ADDED' && event.data.accountEmail) {
        toast.success(`Account ${event.data.accountEmail} connected`);
        fetchAccounts();
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    if (mikeOpen) {
      setTimeout(() => {
        mikeEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      }, 100);
    }
  }, [mikeMessages, mikeOpen]);

  const handleConnect = async () => {
    try {
      const response = await fetch('/api/auth/google/url');
      const data = await response.json();
      if (data.url) {
        const width = 500;
        const height = 600;
        const left = window.screen.width / 2 - width / 2;
        const top = window.screen.height / 2 - height / 2;
        window.open(data.url, 'Google Auth', `width=${width},height=${height},left=${left},top=${top}`);
      } else {
        throw new Error('Could not fetch OAuth URL');
      }
    } catch (err: any) {
      toast.error('Authentication error: ' + err.message);
    }
  };

  const handleLogout = async () => {
    try {
      await fetch(`${APP_URL}/api/auth/logout`, { method: 'POST', credentials: 'include' });
    } catch (e) {}
    localStorage.removeItem('google_tokens');
    setIsAuthenticated(false);
    setHasLocalTokens(false);
    toast.success('Disconnected');
  };

  const parseFileResults = (headers: string[], rows: any[]) => {
    setDetectedHeaders(headers);
    setPendingRows(rows);
    
    const saved = getSavedMapping(headers);
    if (saved && saved.website) {
      // Test if mapping actually yields any mapped leads with websites
      const testLeads = rows.map(row => {
        const getRowVal = (colKey?: string) => {
          if (!colKey) return '';
          return String(row[colKey] || row[colKey.toLowerCase()] || '').trim();
        };
        return {
          website: getRowVal(saved.website)
        };
      }).filter(l => l.website);

      if (testLeads.length > 0) {
        setMapping(saved);
        finalizeMapping(saved, rows, headers);
        toast.success(`Applying remembered column mapping for this file format! (${testLeads.length} leads matched)`);
        return;
      }
    }
    
    // Try to find auto-mappings
    const autoMap = { company: '', website: '', email: '', recipient: '' };
    headers.forEach(h => {
      const hl = h.toLowerCase();
      if (hl.includes('company') || hl.includes('business') || hl.includes('name')) autoMap.company = h;
      if (hl.includes('website') || hl.includes('url') || hl.includes('site') || hl.includes('link')) autoMap.website = h;
      if (hl.includes('email') || hl.includes('mail')) autoMap.email = h;
      if (hl.includes('recipient') || hl.includes('contact') || hl.includes('person') || hl.includes('name')) autoMap.recipient = h;
    });
    setMapping(autoMap);
    setShowMapper(true);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    readFile(file);
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    readFile(file);
  };

  const readFile = (file: File) => {
    const name = file.name.toLowerCase();
    if (name.endsWith('.csv')) {
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => {
          if (results.meta.fields && results.data.length > 0) {
            const rowsWithIndex = results.data.map((row: any, i) => ({ ...row, rowIndex: i + 2 }));
            parseFileResults(results.meta.fields, rowsWithIndex);
          } else {
            toast.error('Could not find fields in CSV');
          }
        },
        error: (err) => {
          toast.error('Failed to parse CSV: ' + err.message);
        }
      });
    } else if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const data = e.target?.result;
          const workbook = XLSX.read(data, { type: 'binary' });
          const sheetName = workbook.SheetNames[0];
          const sheet = workbook.Sheets[sheetName];
          const json = XLSX.utils.sheet_to_json<any>(sheet);
          if (json.length > 0) {
            const headers = Object.keys(json[0]);
            const rowsWithIndex = json.map((row, i) => ({ ...row, rowIndex: i + 2 }));
            parseFileResults(headers, rowsWithIndex);
          } else {
            toast.error('The spreadsheet of leads is empty.');
          }
        } catch (err: any) {
          toast.error('Failed to parse Excel file: ' + err.message);
        }
      };
      reader.readAsBinaryString(file);
    } else {
      toast.error('Unsupported file format. Please upload CSV or Excel/XLSX.');
    }
  };

  const finalizeMapping = async (customMappingToUse?: any, customRowsToUse?: any[], customHeadersToUse?: string[]) => {
    try {
      let isMappingObject = false;
      if (customMappingToUse && typeof customMappingToUse === 'object') {
        const hasEventProp = 'nativeEvent' in customMappingToUse || 'target' in customMappingToUse || 'preventDefault' in customMappingToUse;
        if (!hasEventProp && (customMappingToUse.website !== undefined || customMappingToUse.company !== undefined)) {
          isMappingObject = true;
        }
      }
      const rawMapping = isMappingObject ? customMappingToUse : mapping;
      const activeMapping = {
        company: '',
        website: '',
        email: '',
        recipient: '',
        ...rawMapping
      };
      const activeRows = (customRowsToUse && Array.isArray(customRowsToUse)) ? customRowsToUse : pendingRows;
      const activeHeaders = (customHeadersToUse && Array.isArray(customHeadersToUse)) ? customHeadersToUse : detectedHeaders;

      if (!activeMapping.website) {
        toast.error('Please map at least the Website URL column');
        return;
      }
      const mappedLeads = activeRows.map(row => {
        const getRowVal = (colKey?: string) => {
          if (!colKey) return '';
          return String(row[colKey] || row[colKey.toLowerCase()] || '').trim();
        };

        const emailValue = getRowVal(activeMapping.email);
        const isValidEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailValue);

        const customFields: Record<string, string> = {};
        customMappings.forEach(map => {
          if (map.sourceColumn && map.fieldName) {
            customFields[map.fieldName] = getRowVal(map.sourceColumn);
          }
        });
        const recipientVal = getRowVal(activeMapping.recipient) || 'there';
        return {
          rowIndex: row.rowIndex,
          company: getRowVal(activeMapping.company) || 'Company',
          website: getRowVal(activeMapping.website) || '',
          email: isValidEmail ? emailValue : '',
          emailStatus: isValidEmail ? 'ready' : 'needs-email',
          recipient: recipientVal,
          recipientFirstName: extractFirstName(recipientVal),
          customFields,
        };
      }).filter(l => l.website);

      if (mappedLeads.length === 0) {
        toast.error('No valid leads found (missing website).');
        return;
      }

      if (activeHeaders && activeHeaders.length > 0) {
        saveMapping(activeHeaders, activeMapping);
      }
      localStorage.setItem('seo_spreadsheet_id', spreadsheetId);
      localStorage.setItem('seo_sheet_name', sheetName);

      if (selectedCampaignId && userId) {
        try {
          const dupCheck = await checkCrossCampaignDuplicates(userId, selectedCampaignId, mappedLeads);
          if (dupCheck.count > 0) {
            setDuplicateCheck(dupCheck);
            setPendingReviewLeads(mappedLeads);
            setShowMapper(false);
            setShowDuplicateModal(true);
            return;
          }
        } catch (dupErr) {
          console.error('Duplicate check failed, continuing without it:', dupErr);
        }
      }

      setShowMapper(false);
      openLeadReview(mappedLeads);
    } catch (err: any) {
      console.error(err);
      toast.error('Error in mapping leads columns: ' + err.message);
    }
  };

  const handleDuplicateDecision = (includeThem: boolean) => {
    let finalLeads = pendingReviewLeads;
    if (!includeThem && duplicateCheck) {
      const keys = new Set(duplicateCheck.matchKeys);
      finalLeads = pendingReviewLeads.filter(l =>
        !keys.has((l.website || '').trim().toLowerCase()) &&
        !keys.has((l.email || '').trim().toLowerCase())
      );
      toast.success(`Excluded ${pendingReviewLeads.length - finalLeads.length} already-contacted lead${pendingReviewLeads.length - finalLeads.length === 1 ? '' : 's'}.`);
    }
    setShowDuplicateModal(false);
    setDuplicateCheck(null);
    setPendingReviewLeads([]);
    openLeadReview(finalLeads);
  };

  const openLeadReview = (leads: any[]) => {
    setReviewLeads(leads.map(l => ({ ...l, _reviewId: l.rowIndex })));
    setShowLeadReview(true);
  };

  const removeReviewLead = (reviewId: number) => {
    setReviewLeads(prev => prev.filter(l => l._reviewId !== reviewId));
  };

  const confirmLeadImport = async () => {
    const leadsToSave = reviewLeads.map(({ _reviewId, ...l }) => l);
    if (leadsToSave.length === 0) {
      toast.error('No leads left to import.');
      return;
    }
    setShowLeadReview(false);

    let savedLeads: any[] = [];
    if (selectedCampaignId) {
      try {
        savedLeads = await saveLeads(selectedCampaignId, userId, leadsToSave);
        await reconcileLeadDeletions(selectedCampaignId, savedLeads);
        setLeads(savedLeads);
        localStorage.setItem(getCampaignLeadsKey(selectedCampaignId), JSON.stringify(savedLeads));
      } catch (saveErr) {
        console.error('Failed to save leads to Supabase:', saveErr);
        toast.error('Failed to save leads. Please try again.');
        return;
      }
    } else {
      localStorage.setItem('seo_leads', JSON.stringify(leadsToSave));
      savedLeads = leadsToSave;
      setLeads(leadsToSave);
    }

    toast.success(`Imported ${leadsToSave.length} leads. Starting analysis...`);
    setTimeout(() => runAllAnalysis(savedLeads), 500);
  };

  const fetchLeads = async () => {
    if (!spreadsheetId || !sheetName) {
      toast.error('Please enter Google Sheets URL/ID and Sheet Name.');
      return;
    }
    setLoading(true);
    try {
      const response = await fetchWithGoogleAuth('/api/process-leads', {
        method: 'POST',
        body: JSON.stringify({ spreadsheetId, sheetName })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to initialize leads');
      if (data.leads && data.leads.length > 0) {
        setDetectedHeaders(data.foundHeaders);
        setPendingRows(data.leads);
        // Default mapping fields
        const auto = { company: '', website: '', email: '', recipient: '' };
        data.foundHeaders.forEach((h: string) => {
          const hl = h.toLowerCase();
          if (hl.includes('company') || hl.includes('business') || hl.includes('name')) auto.company = h;
          if (hl.includes('website') || hl.includes('url') || hl.includes('site') || hl.includes('link')) auto.website = h;
          if (hl.includes('email') || hl.includes('mail')) auto.email = h;
          if (hl.includes('recipient') || hl.includes('contact') || hl.includes('person') || hl.includes('name')) auto.recipient = h;
        });
        setMapping(auto);
        setShowMapper(true);
      } else {
        toast.error('No leads found in spreadsheet');
      }
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  };

  const analyzeSingleLead = async (lead: any) => {
    console.log('[DEBUG] analyzeSingleLead triggered for lead:', lead);
    if (lead.emailStatus === 'needs-email' || !lead.email) {
      toast.error(`Please enter a valid email for ${lead.company} before analyzing.`);
      return;
    }
    if (loading) return;
    setLoading(true);
    setAnalyzingRows(prev => new Set(prev).add(lead.rowIndex));
    try {
      const response = await fetch('/api/analyze-lead', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Google-Tokens': localStorage.getItem('google_tokens') || ''
        },
        body: getAnalysisRequestBody(lead)
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || 'Failed to analyze lead');
      }
      setBackendStatus('online');
      const updated = {
        ...analyzedLeads,
        [lead.rowIndex]: buildLeadResult(lead, result, currentCampaign?.industry)
      };
      setAnalyzedLeads(updated);
      saveToSession(updated);
      setSelectedLead(lead);
      toast.success(`Analysis complete for ${lead.company}!`);
      return result;
    } catch (err: any) {
      if (err.name === 'TypeError' || err.message?.includes('fetch') || err.message?.includes('network')) {
        setBackendStatus('offline');
      }
      console.error(err);
      let errorMsg = err.message || 'Analysis failed';
      if (err.message?.includes('429')) errorMsg = 'Rate limit exceeded. Please wait a minute and retry.';
      if (err.message?.includes('timeout')) errorMsg = 'Request timed out. The server may be busy.';
      toast.error(`Error: ${errorMsg}`);
      const errorState = {
        ...analyzedLeads,
        [lead.rowIndex]: { status: 'error', error: errorMsg, score: 0 }
      };
      setAnalyzedLeads(errorState);
      saveToSession(errorState);
    } finally {
      setLoading(false);
      setAnalyzingRows(prev => {
        const next = new Set(prev);
        next.delete(lead.rowIndex);
        return next;
      });
    }
  };

  const analyzeLeadsSequentially = async () => {
    if (leads.length === 0) return;
    toast.success('Starting batch pipeline analysis...');
    for (let i = 0; i < leads.length; i++) {
      if (analyzedLeads[leads[i].rowIndex]?.status && analyzedLeads[leads[i].rowIndex].status !== 'error') {
        continue;
      }
      setCurrentLeadIndex(i);
      await analyzeSingleLead(leads[i]);
    }
    setCurrentLeadIndex(-1);
    toast.success('Batch pipeline completed!');
  };

  const handleCreateDraft = async (lead: any) => {
    if (lead.emailStatus === 'needs-email' || !lead.email) {
      toast.error(`Please provide a valid email before drafting for ${lead.company}.`);
      return;
    }
    const analysis = analyzedLeads[lead.rowIndex];
    const initialEmail = analysis?.aiAnalysis?.initialEmail || analysis?.initialEmail;
    if (!initialEmail || !initialEmail.body) {
      toast.error('No generated initial email found for this lead');
      return;
    }
    setSavingDraft(true);
    try {
      const response = await fetchWithGoogleAuth('/api/create-draft', {
        method: 'POST',
        body: JSON.stringify({
          to: lead.email || '',
          subject: replaceTokens(initialEmail.subject, lead),
          body: replaceTokens(initialEmail.body, lead),
          accountId: currentCampaign?.senderAccountId || undefined
        })
      });
      const res = await response.json();
      if (!response.ok) throw new Error(res.error || 'Failed to create Gmail draft');
      toast.success(`Draft created in Gmail for ${lead.company}!`);
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setSavingDraft(false);
    }
  };

  const handleBulkDraft = async () => {
    const analyzedKeys = Object.keys(analyzedLeads);
    if (analyzedKeys.length === 0) {
      toast.error('No analyzed leads to draft');
      return;
    }
    const pendingDrafts = leads.filter(lead => {
      const analysis = analyzedLeads[lead.rowIndex];
      const hasEmail = lead.emailStatus !== 'needs-email' && lead.email;
      return hasEmail && (analysis?.aiAnalysis?.initialEmail?.body || analysis?.initialEmail?.body);
    });
    if (pendingDrafts.length === 0) {
      toast.error('No emails ready for drafting');
      return;
    }
    setBulkDrafting(true);
    setCancelBatch(false);
    cancelBatchRef.current = false;
    let completed = 0;
    toast(`Drafting ${pendingDrafts.length} emails to Gmail...`);
    for (const lead of pendingDrafts) {
      if (cancelBatchRef.current) {
        toast(`Cancelled. Created ${completed} of ${pendingDrafts.length} drafts.`);
        break;
      }
      await handleCreateDraft(lead);
      completed++;
    }
    setBulkDrafting(false);
    if (!cancelBatchRef.current) toast.success('Successfully finished drafting batch!');
  };

  const handleSendTest = async () => {
    if (!testEmailTo) {
      toast.error('Please enter a test email address');
      return;
    }
    const targetLead = testLead || selectedLead;
    if (!targetLead) {
      toast.error('No lead selected for test send');
      return;
    }
    const analysis = analyzedLeads[targetLead.rowIndex];
    const initialEmail = analysis?.aiAnalysis?.initialEmail || analysis?.initialEmail;
    if (!initialEmail || !initialEmail.body) {
      toast.error('No email body generated yet');
      return;
    }
    try {
      const response = await fetchWithGoogleAuth('/api/send-test', {
        method: 'POST',
        body: JSON.stringify({
          to: testEmailTo,
          subject: initialEmail.subject,
          body: initialEmail.body,
          accountId: currentCampaign?.senderAccountId || undefined
        })
      });
      const res = await response.json();
      if (!response.ok) throw new Error(res.error || 'Failed to send test email');
      toast.success(`Test email sent successfully to ${testEmailTo}!`);
      setShowTestModal(false);
    } catch (err: any) {
      toast.error(err.message);
    }
  };

  const cancelBatchOperation = () => {
    setCancelBatch(true);
    cancelBatchRef.current = true;
    toast('Cancelling batch operation...');
  };

  // FUNCTION 1: Run all analysis - skips already analyzed leads
  const runAllAnalysis = async (customLeadsOrEvent?: any[] | React.MouseEvent) => {
    let leadsToAnalyze = Array.isArray(customLeadsOrEvent) ? customLeadsOrEvent : leads;

    // If leadsToAnalyze lack _supabaseId, fetch fresh from DB
    if (leadsToAnalyze.length > 0 && !leadsToAnalyze[0]._supabaseId && selectedCampaignId) {
      const freshLeads = await getLeads(selectedCampaignId);
      if (freshLeads && freshLeads.length) {
        leadsToAnalyze = freshLeads;
        setLeads(freshLeads);
      }
    }

    const hasMissingEmails = leadsToAnalyze.some(
      l => l.emailStatus === 'needs-email' || !l.email
    );
    const pending = leadsToAnalyze.filter(
      l =>
        l.emailStatus !== 'needs-email' &&
        l.email
    );
  
    if (pending.length === 0) {
      if (hasMissingEmails) {
        toast.error(
          'All remaining leads are missing valid emails. Please add emails first.'
        );
      } else {
        toast('No leads to analyze.');
      }
      return;
    }
  
    if (hasMissingEmails) {
      toast('Skipping leads missing valid email addresses.');
    }
  
    // IMPROVEMENT 5 — skip already analyzed leads
    const trulyPending = pending.filter(l => !analyzedLeads[l.rowIndex]);
    const alreadyDone = pending.length - trulyPending.length;
  
    if (trulyPending.length === 0) {
      toast(
        'All leads already analyzed. Use Re-analyze on individual leads to refresh.'
      );
      return;
    }
  
    if (alreadyDone > 0) {
      toast(
        `Skipping ${alreadyDone} already analyzed. Analyzing ${trulyPending.length} remaining...`
      );
    } else {
      toast(`Analyzing ${trulyPending.length} leads...`);
    }
  
    setRunningAnalysis(true);
    setCancelBatch(false);
    cancelBatchRef.current = false;
  
    let completed = 0;
    const totalBatches = Math.ceil(trulyPending.length / GEMINI_RATE_LIMIT);
  
    // IMPROVEMENT 4 — batched parallel queue with rate limiter
    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
      if (cancelBatchRef.current) {
        toast(`Cancelled. ${completed} of ${trulyPending.length} analyzed.`);
        break;
      }
  
      const batchStart = batchIndex * GEMINI_RATE_LIMIT;
      const batchLeads = trulyPending.slice(
        batchStart,
        batchStart + GEMINI_RATE_LIMIT
      );
      const batchStartTime = Date.now();
  
      toast(
        totalBatches > 1
          ? `Batch ${batchIndex + 1} of ${totalBatches} — ${batchLeads.length} leads running...`
          : `Analyzing ${batchLeads.length} leads...`,
        { duration: 3000 }
      );
  
      // Run all leads in this batch with staggering to avoid burst limit
      const batchResults = await Promise.allSettled(
        batchLeads.map(async (lead, idx) => {
          if (idx > 0) {
            await new Promise(resolve => setTimeout(resolve, idx * 800));
          }
          setCurrentLeadIndex(leads.indexOf(lead));
          setAnalyzingRows(prev => new Set(prev).add(lead.rowIndex));
          const res = await fetch('/api/analyze-lead', {
            method: 'POST',
            headers: getAuthHeaders(),
            credentials: 'include',
            body: getAnalysisRequestBody(lead, { forceRefresh: false }), // cache honored
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const result = await res.json();
          return { lead, result };
        })
      );
  
      // Process results as they come in
      batchResults.forEach((outcome, idx) => {
        if (outcome.status === 'fulfilled') {
          const { lead, result } = outcome.value;
          const leadResult = buildLeadResult(
            lead,
            result,
            currentCampaign?.industry
          );
          if (!result.viable && result.crawlFailReason) {
            setFailedAnalysis(prev => [...prev, lead.rowIndex]);
          }
          setAnalyzedLeads(prev => {
            const updated = { ...prev, [lead.rowIndex]: leadResult };
            saveToSession(updated);
            return updated;
          });
          setAnalyzingRows(prev => { const next = new Set(prev); next.delete(lead.rowIndex); return next; });
          completed++;
        } else {
          const lead = batchLeads[idx];
          console.error(`Failed: ${lead.company}`, outcome.reason);
          setFailedAnalysis(prev => [...prev, lead.rowIndex]);
        }
      });
  
      toast(`${completed} of ${trulyPending.length} analyzed`, {
        duration: 1500,
      });
  
      // Wait out remaining window before next batch
      if (batchIndex < totalBatches - 1 && !cancelBatchRef.current) {
        const elapsed = Date.now() - batchStartTime;
        const remaining = BATCH_WINDOW_MS - elapsed;
        if (remaining > 0) {
          const secondsLeft = Math.ceil(remaining / 1000);
          toast(
            `Batch ${batchIndex + 1} done. Next batch in ${secondsLeft}s...`,
            { duration: remaining }
          );
          await new Promise(resolve => setTimeout(resolve, remaining));
        }
      }
    }
  
    setRunningAnalysis(false);
    setCurrentLeadIndex(-1);
    setAnalyzingRows(new Set());
  
    if (!cancelBatchRef.current) {
      toast.success(
        `Done. ${completed} analyzed${
          alreadyDone > 0 ? `, ${alreadyDone} skipped (already done)` : ''
        }.`
      );
    }
  };
  
  // ============================================================
  // handleReanalyzeLead — forceRefresh: true, bypasses cache
  // ============================================================
  const handleReanalyzeLead = async (lead: any) => {
    try {
      setAnalyzingRows(prev => new Set(prev).add(lead.rowIndex));
      const res = await fetch('/api/analyze-lead', {
        method: 'POST',
        headers: getAuthHeaders(),
        credentials: 'include',
        body: getAnalysisRequestBody(lead, { forceRefresh: true }), // forceRefresh: true
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = await res.json();
      const leadResult = buildLeadResult(lead, result, currentCampaign?.industry);
      setAnalyzedLeads(prev => {
        const updated = { ...prev, [lead.rowIndex]: leadResult };
        saveToSession(updated);
        return updated;
      });
      toast.success(`Re-analyzed ${lead.company}`);
    } catch (err) {
      toast.error(`Re-analysis failed for ${lead.company}`);
    } finally {
      setAnalyzingRows(prev => {
        const next = new Set(prev);
        next.delete(lead.rowIndex);
        return next;
      });
    }
  };

  // FUNCTION 2: Retry failed analysis only
  const retryFailedAnalysis = async () => {
    const toRetry = leads.filter(l => 
       failedAnalysis.includes(l.rowIndex) || 
       analyzedLeads[l.rowIndex]?.status === 'disqualified' ||
       analyzedLeads[l.rowIndex]?.status === 'manual-review' ||
       analyzedLeads[l.rowIndex]?.viable === false
    );
    if (toRetry.length === 0) { toast('No failed analyses to retry'); return; }
    setRetryingAnalysis(true);
    setCancelBatch(false);
    cancelBatchRef.current = false;
    setFailedAnalysis([]);
    let completed = 0;
    toast(`Retrying ${toRetry.length} failed leads...`);
    for (const lead of toRetry) {
       if (cancelBatchRef.current) {
         toast(`Cancelled. ${completed} of ${toRetry.length} retried.`);
         break;
       }
       setCurrentLeadIndex(leads.indexOf(lead));
       try {
         const res = await fetch('/api/analyze-lead', {
           method: 'POST', headers: getAuthHeaders(), credentials: 'include',
           body: getAnalysisRequestBody(lead)
         });
         const result = await res.json();
         const leadResult = buildLeadResult(lead, result, currentCampaign?.industry);
         if (!result.viable) setFailedAnalysis(prev => [...prev, lead.rowIndex]);
         setAnalyzedLeads(prev => {
           const updated = { ...prev, [lead.rowIndex]: leadResult };
           saveToSession(updated);
           return updated;
         });
         completed++;
         toast(`Retried ${completed}/${toRetry.length}`, { duration: 1000 });
       } catch (e) {
         setFailedAnalysis(prev => [...prev, lead.rowIndex]);
       }
    }
    setRetryingAnalysis(false);
    setCurrentLeadIndex(-1);
    if (!cancelBatchRef.current) toast.success('Retry complete!');
  };

  // FUNCTION 3: Generate emails for all analyzed leads that have no email yet
  const generateAllEmails = async () => {
    const needsEmail = leads.filter(l => {
       const a = analyzedLeads[l.rowIndex];
       return a && a.viable !== false && !a.initialEmail?.body && !a.aiAnalysis?.initialEmail?.body;
    });
    if (needsEmail.length === 0) { toast('All analyzed leads already have emails'); return; }
    setGeneratingEmails(true);
    setCancelBatch(false);
    cancelBatchRef.current = false;
    let completed = 0;
    toast(`Generating emails for ${needsEmail.length} leads...`);
    for (const lead of needsEmail) {
       if (cancelBatchRef.current) {
         toast(`Cancelled. ${completed} of ${needsEmail.length} emails generated.`);
         break;
       }
       try {
         const res = await fetch('/api/analyze-lead', {
           method: 'POST', headers: getAuthHeaders(), credentials: 'include',
           body: getAnalysisRequestBody(lead, { generateEmailOnly: true })
         });
         const result = await res.json();
         const leadResult = buildLeadResult(lead, result, currentCampaign?.industry);
         if (!result.aiAnalysis?.initialEmail?.body && !result.initialEmail?.body) {
           setFailedEmails(prev => [...prev, lead.rowIndex]);
         }
         setAnalyzedLeads(prev => {
           const updated = { ...prev, [lead.rowIndex]: { ...prev[lead.rowIndex], ...leadResult } };
           saveToSession(updated);
           return updated;
         });
         completed++;
         toast(`Generated ${completed}/${needsEmail.length}`, { duration: 1000 });
       } catch (e) {
         setFailedEmails(prev => [...prev, lead.rowIndex]);
       }
    }
    setGeneratingEmails(false);
    if (!cancelBatchRef.current) toast.success('Email generation complete!');
  };

  // FUNCTION 4: Retry failed email generation only
  const retryFailedEmails = async () => {
    const toRetry = leads.filter(l =>
       failedEmails.includes(l.rowIndex) ||
       (analyzedLeads[l.rowIndex]?.viable !== false && 
        !analyzedLeads[l.rowIndex]?.initialEmail?.body && 
        !analyzedLeads[l.rowIndex]?.aiAnalysis?.initialEmail?.body &&
        analyzedLeads[l.rowIndex]?.score)
    );
    if (toRetry.length === 0) { toast('No failed email generations to retry'); return; }
    setRetryingEmails(true);
    setCancelBatch(false);
    cancelBatchRef.current = false;
    setFailedEmails([]);
    let completed = 0;
    toast(`Retrying email generation for ${toRetry.length} leads...`);
    for (const lead of toRetry) {
       if (cancelBatchRef.current) {
         toast(`Cancelled. ${completed} of ${toRetry.length} retried.`);
         break;
       }
       try {
         const res = await fetch('/api/analyze-lead', {
           method: 'POST', headers: getAuthHeaders(), credentials: 'include',
           body: getAnalysisRequestBody(lead, { generateEmailOnly: true })
         });
         const result = await res.json();
         const leadResult = buildLeadResult(lead, result, currentCampaign?.industry);
         if (!result.aiAnalysis?.initialEmail?.body && !result.initialEmail?.body) {
           setFailedEmails(prev => [...prev, lead.rowIndex]);
         }
         setAnalyzedLeads(prev => {
           const updated = { ...prev, [lead.rowIndex]: { ...prev[lead.rowIndex], ...leadResult } };
           saveToSession(updated);
           return updated;
         });
         completed++;
         toast(`Retried ${completed}/${toRetry.length}`, { duration: 1000 });
       } catch (e) {
         setFailedEmails(prev => [...prev, lead.rowIndex]);
       }
    }
    setRetryingEmails(false);
    if (!cancelBatchRef.current) toast.success('Retry complete!');
  };

  const handleSaveInitialEmail = (newBody: string) => {
    if (!selectedLead) return;
    setAnalyzedLeads(prev => {
      const leadIndex = selectedLead.rowIndex;
      const currentItem = prev[leadIndex] || {};
      const updatedItem = { ...currentItem };
      
      if (updatedItem.initialEmail) {
        updatedItem.initialEmail = { ...updatedItem.initialEmail, body: newBody };
      } else {
        updatedItem.initialEmail = { body: newBody };
      }
      
      if (updatedItem.aiAnalysis) {
        if (updatedItem.aiAnalysis.initialEmail) {
          updatedItem.aiAnalysis.initialEmail = { ...updatedItem.aiAnalysis.initialEmail, body: newBody };
        } else {
          updatedItem.aiAnalysis.initialEmail = { body: newBody };
        }
      }
      
      const updated = { ...prev, [leadIndex]: updatedItem };
      saveToSession(updated);
      return updated;
    });
  };

  const saveCurrentEmailAsTemplate = () => {
    if (!selectedLead) {
      toast.error('No lead selected');
      return;
    }
    const emailBody = selectedAnalysis?.initialEmail?.body || selectedAnalysis?.aiAnalysis?.initialEmail?.body;
    const emailSubject = selectedAnalysis?.initialEmail?.subject || selectedAnalysis?.aiAnalysis?.initialEmail?.subject;
    if (!emailBody) {
      toast.error('No email content to save');
      return;
    }
    setTemplateName('');
    setCurrentTemplateId(null);
    setShowTemplateModal(true);
  };

  const confirmSaveTemplate = () => {
    if (!templateName.trim()) {
      toast.error('Please enter a template name');
      return;
    }
    const emailBody = selectedAnalysis?.initialEmail?.body || selectedAnalysis?.aiAnalysis?.initialEmail?.body;
    const emailSubject = selectedAnalysis?.initialEmail?.subject || selectedAnalysis?.aiAnalysis?.initialEmail?.subject;
    if (!emailBody) return;
    
    if (currentTemplateId) {
      // Update existing template
      setTemplates(prev => prev.map(t =>
        t.id === currentTemplateId
          ? { ...t, name: templateName, subject: emailSubject || '', body: emailBody, createdAt: new Date().toISOString() }
          : t
      ));
      toast.success('Template updated');
    } else {
      // Create new template
      const newTemplate = {
        id: Date.now().toString(),
        name: templateName,
        subject: emailSubject || '',
        body: emailBody,
        createdAt: new Date().toISOString(),
      };
      setTemplates(prev => [...prev, newTemplate]);
      toast.success('Template saved');
    }
    setShowTemplateModal(false);
    setTemplateName('');
    setCurrentTemplateId(null);
  };

  const loadTemplate = (templateId: string) => {
    const template = templates.find(t => t.id === templateId);
    if (!template) return;
    if (!selectedLead) {
      toast.error('Select a lead first');
      return;
    }
    // Update current email (initial email only for now)
    setAnalyzedLeads(prev => {
      const leadIndex = selectedLead.rowIndex;
      const current = prev[leadIndex] || {};
      const updated = {
        ...prev,
        [leadIndex]: {
          ...current,
          initialEmail: { subject: template.subject, body: template.body },
          aiAnalysis: {
            ...current.aiAnalysis,
            initialEmail: { subject: template.subject, body: template.body }
          }
        }
      };
      saveToSession(updated);
      return updated;
    });
    toast.success(`Loaded template: ${template.name}`);
  };

  const deleteTemplate = (templateId: string) => {
    setConfirmDialog({
      isOpen: true,
      title: '🗑️ Delete Template',
      message: 'Are you sure you want to delete this email template?',
      onConfirm: () => {
        setTemplates(prev => prev.filter(t => t.id !== templateId));
        toast.success('Template deleted');
      }
    });
  };

  const handleSaveFollowUp = (key: 'followUp1' | 'followUp2' | 'followUp3', newBody: string) => {
    if (!selectedLead) return;
    setAnalyzedLeads(prev => {
      const leadIndex = selectedLead.rowIndex;
      const currentItem = prev[leadIndex] || {};
      const updatedItem = { ...currentItem };

      const existingFollowUp = updatedItem[key];
      const existingSubject = typeof existingFollowUp === 'object' && existingFollowUp !== null
        ? existingFollowUp.subject
        : undefined;

      updatedItem[key] = existingSubject
        ? { subject: existingSubject, body: newBody }
        : newBody;

      if (updatedItem.aiAnalysis) {
        const existingAiFollowUp = updatedItem.aiAnalysis[key];
        const existingAiSubject = typeof existingAiFollowUp === 'object' && existingAiFollowUp !== null
          ? existingAiFollowUp.subject
          : undefined;

        updatedItem.aiAnalysis = {
          ...updatedItem.aiAnalysis,
          [key]: existingAiSubject
            ? { subject: existingAiSubject, body: newBody }
            : newBody,
        };
      }

      const updated = { ...prev, [leadIndex]: updatedItem };
      saveToSession(updated);
      return updated;
    });
  };

  const pollIntervalRef = useRef<any>(null);

  const stopProgressPolling = () => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  };

  const startProgressPolling = (targetRowIndexes: number[], campaignId: string) => {
    if (targetRowIndexes.length === 0) return;
    stopProgressPolling();
    setQueueProgress({ current: 0, total: targetRowIndexes.length });
    setSendingQueue(true);
    const targetSet = new Set(targetRowIndexes);

    pollIntervalRef.current = setInterval(async () => {
      try {
        const fresh = await getAnalysis(campaignId);
        let sentCount = 0;
        let doneCount = 0;
        targetSet.forEach(rowIndex => {
          const status = fresh[rowIndex]?.sentStatus;
          const bStatus = fresh[rowIndex]?.batchStatus;
          if (status === 'sent') sentCount++;
          if (
            ['sent', 'failed', 'bounced', 'unsubscribed'].includes(status) || 
            ['sent', 'failed'].includes(bStatus)
          ) {
            doneCount++;
          }
        });
        setQueueProgress({ current: sentCount, total: targetSet.size });
        setAnalyzedLeads(prev => ({ ...prev, ...fresh }));

        if (doneCount >= targetSet.size) {
          stopProgressPolling();
          setSendingQueue(false);
          toast.success(`Done: ${sentCount} of ${targetSet.size} sent.`);
        }
      } catch (err) {
        console.error('[PROGRESS POLL] error:', err);
      }
    }, 4000);
  };

  const cancelSendInProgress = async () => {
    if (!selectedCampaignId) return;
    try {
      await fetchWithGoogleAuth('/api/cancel-send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campaignId: selectedCampaignId })
      });
      toast('Stopping — leads already sent will not be undone.');
    } catch {
      toast.error('Cancel signal failed to send, stopping tracking locally anyway.');
    }
    stopProgressPolling();
    setSendingQueue(false);
  };

  useEffect(() => {
    return () => stopProgressPolling();
  }, []);

  // FUNCTION 5: Send queue now (completely delegated to server background runner!)
  const sendQueueNow = async () => {
    if (!isAuthenticated) {
      toast.error('Connect your Google account first');
      return;
    }
    if (!currentCampaign?.senderAccountId) {
      toast.error('This campaign has no sender account set. Set one in the Schedule tab first.');
      return;
    }

    const targetRows = leads
      .filter(l => {
        const a = analyzedLeads[l.rowIndex];
        return a && (a.initialEmail?.body || a.aiAnalysis?.initialEmail?.body || a.initial_email?.body || a.ai_analysis?.initialEmail?.body)
          && a.sentStatus !== 'sent' && a.sentStatus !== 'unsubscribed'
          && l.email;
      })
      .map(l => l.rowIndex);

    if (targetRows.length === 0) {
      toast.error('No emails ready to send');
      return;
    }

    try {
      toast.loading('Queueing emails for background sending...');
      const response = await fetchWithGoogleAuth('/api/queue-all-now', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          campaignId: selectedCampaignId,
        })
      });

      toast.dismiss();

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || 'Server error');
      }

      // Update UI state
      const updatedAnalyzed = { ...analyzedLeads };
      const nowIso = new Date().toISOString();
      targetRows.forEach(rowIndex => {
        const a = updatedAnalyzed[rowIndex];
        if (a) {
          updatedAnalyzed[rowIndex] = {
            ...a,
            batchStatus: `queued:${nowIso}`,
            sentStatus: 'not-sent'
          };
        }
      });
      setAnalyzedLeads(updatedAnalyzed);
      saveToSession(updatedAnalyzed);

      if (selectedCampaignId) {
        startProgressPolling(targetRows, selectedCampaignId);
      }
      toast.success('Sending started.');
    } catch (err: any) {
      toast.dismiss();
      console.error('Failed to queue on server:', err);
      toast.error(`Queueing failed: ${err.message || 'Server error'}`);
    }
  };

  const sendFollowUpEmail = async (lead: any, followUpKey: 'followUp1' | 'followUp2' | 'followUp3', daysLabel: string) => {
    const analysis = analyzedLeads[lead.rowIndex];
    if (!analysis) return false;

    let emailBody = analysis[followUpKey] || analysis.aiAnalysis?.[followUpKey];
    if (!emailBody) {
      console.warn(`No ${followUpKey} content for ${lead.company}`);
      toast.error(`${lead.company}: no ${followUpKey} content generated. Regenerate emails for this lead.`);
      return false;
    }

    const rawFollowUpBody = emailBody;
    emailBody = rawFollowUpBody?.replace(/(\bTosin\b[\s\S]*?)(\s*\bTosin\b[\s\S]*?)$/, '$1') || rawFollowUpBody;
    emailBody = replaceTokens(emailBody, lead);

    const originalSubject = analysis.initialEmail?.subject || analysis.aiAnalysis?.initialEmail?.subject || 'Your website';
    const rawSubject = originalSubject.toLowerCase().startsWith('re:') ? originalSubject : `Re: ${originalSubject}`;
    const subject = replaceTokens(rawSubject, lead);

    const serverFollowUpKey = followUpKey.replace('followUp', 'follow_up'); // followUp1 -> follow_up1

    try {
      const res = await fetchWithGoogleAuth('/api/send-email', {
        method: 'POST',
        body: JSON.stringify({
          to: lead.email,
          subject,
          body: emailBody,
          accountId: currentCampaign?.senderAccountId || undefined,
          threadId: analysis.initialThreadId || undefined,
          previousMessageId: analysis.initialMessageId || undefined,
          campaignId: selectedCampaignId,
          leadAnalysisId: analysis._supabaseId,
          followUpKey: serverFollowUpKey,
        })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setBackendStatus('online');
        setAnalyzedLeads(prev => {
          const updated = {
            ...prev,
            [lead.rowIndex]: {
              ...prev[lead.rowIndex],
              [`${followUpKey}Sent`]: true,
              [`${followUpKey}SentAt`]: new Date().toISOString(),
              lastEmailSentAt: new Date().toISOString()
            }
          };
          saveToSession(updated);
          return updated;
        });
        toast.success(`📨 Follow-up ${daysLabel} sent to ${lead.company}`);
        return true;
      } else if (res.status === 409) {
        // Already claimed by the server cron, or lead replied/unsubscribed since last check — not an error
        console.log(`[FOLLOWUP] Skipped ${lead.company}: ${data.error}`);
        return false;
      } else {
        toast.error(`Failed to send follow-up to ${lead.company}: ${data.error || 'Server error'}`);
      }
    } catch (err: any) {
      if (err.name === 'TypeError' || err.message?.includes('fetch') || err.message?.includes('network')) {
        setBackendStatus('offline');
      }
      console.error(err);
      let errorMsg = err.message || 'Send failed';
      if (err.message?.includes('429')) errorMsg = 'Gmail rate limit. Wait a few minutes.';
      if (err.message?.includes('invalid')) errorMsg = 'Invalid email address.';
      toast.error(`Failed: ${errorMsg}`);
    }
    return false;
  };

  const sendDueFollowUps = async (silent = false) => {
    if (!selectedCampaignId || !isAuthenticated) {
      if (!silent) toast.error('No active campaign or not authenticated');
      return;
    }
    if (sendingQueue) {
      if (!silent) toast('Already sending emails, try again later');
      return;
    }

    const now = new Date(); // computed fresh at call time — do NOT hoist to component scope

    // Use follow-up window from campaign (default 14:00-16:00)
    const followUpStart = currentCampaign?.followUpStartTime || '14:00';
    const followUpEnd = currentCampaign?.followUpEndTime || '16:00';
    const campaignCountry = currentCampaign?.country || 'US';
    const tz = currentCampaign?.timezone || TIMEZONE_MAP[campaignCountry] || 'UTC';

    if (!isWithinCampaignWindow(followUpStart, followUpEnd, tz)) {
      if (!silent) toast(`Follow-up window is ${followUpStart} - ${followUpEnd} in campaign timezone (${tz}).`);
      return;
    }

    const campaignFollowUpDays = [
      currentCampaign?.followUp1Days || currentCampaign?.follow_up1_days || 3,
      currentCampaign?.followUp2Days || currentCampaign?.follow_up2_days || 10,
      currentCampaign?.followUp3Days || currentCampaign?.follow_up3_days || 17
    ];

    const leadsToFollowUp = leads.filter(lead => {
      const a = analyzedLeads[lead.rowIndex];
      if (!a || a.sentStatus !== 'sent' || a.sentStatus === 'unsubscribed') return false;
      if (replyStatus[lead.rowIndex]?.hasReplied || replyStatus[lead.rowIndex]?.unsubscribed === true) return false;
      const initialSentAt = a.sentAt || a.lastEmailSentAt;
      if (!initialSentAt) return false;
      const daysSinceInitial = (now.getTime() - new Date(initialSentAt).getTime()) / (1000 * 60 * 60 * 24);
      if (!a.followUp1Sent && daysSinceInitial >= campaignFollowUpDays[0]) return true;
      if (a.followUp1Sent && !a.followUp2Sent && daysSinceInitial >= campaignFollowUpDays[1]) return true;
      if (a.followUp2Sent && !a.followUp3Sent && daysSinceInitial >= campaignFollowUpDays[2]) return true;
      return false;
    });

    if (leadsToFollowUp.length === 0) {
      if (!silent) toast('No follow-ups due at this time');
      return;
    }

    if (!silent) toast(`Sending ${leadsToFollowUp.length} follow-up(s)...`);
    setSendingQueue(true);
    
    for (let i = 0; i < leadsToFollowUp.length; i++) {
      const lead = leadsToFollowUp[i];
      const a = analyzedLeads[lead.rowIndex];
      const initialSentAt = a.sentAt || a.lastEmailSentAt;
      if (!initialSentAt) continue;
      const daysSinceInitial = (now.getTime() - new Date(initialSentAt).getTime()) / (1000 * 60 * 60 * 24);
      
      if (!a.followUp1Sent && daysSinceInitial >= campaignFollowUpDays[0]) {
        await sendFollowUpEmail(lead, 'followUp1', '1');
      } else if (a.followUp1Sent && !a.followUp2Sent && daysSinceInitial >= campaignFollowUpDays[1]) {
        await sendFollowUpEmail(lead, 'followUp2', '2');
      } else if (a.followUp2Sent && !a.followUp3Sent && daysSinceInitial >= campaignFollowUpDays[2]) {
        await sendFollowUpEmail(lead, 'followUp3', '3');
      }
      
      if (i < leadsToFollowUp.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 60000)); // 1 min delay
      }
    }
    
    setSendingQueue(false);
    if (!silent) toast.success('Follow-up batch completed');
  };

  const exportCampaignToCSV = () => {
    if (leads.length === 0) {
      toast.error('No leads to export');
      return;
    }
    const rows = leads.map(lead => {
      const a = analyzedLeads[lead.rowIndex];
      const reply = replyStatus[lead.rowIndex];
      return {
        'Company': lead.company,
        'Website': lead.website,
        'Email': lead.email,
        'Recipient': lead.recipient,
        'SEO Score': a?.score || '',
        'Status': a?.status || '',
        'Primary Problem': a?.aiAnalysis?.primaryProblem || '',
        'Sent Status': a?.sentStatus || '',
        'Sent At': a?.sentAt ? new Date(a.sentAt).toLocaleString() : '',
        'Replied': reply?.hasReplied ? 'Yes' : 'No',
        'Reply Count': reply?.replyCount || 0,
        'Follow-up 1 Sent': a?.followUp1Sent ? 'Yes' : 'No',
        'Follow-up 2 Sent': a?.followUp2Sent ? 'Yes' : 'No',
        'Follow-up 3 Sent': a?.followUp3Sent ? 'Yes' : 'No',
        ...(lead.customFields || {}),
      };
    });
    const headers = Object.keys(rows[0]);
    const csvRows = [
      headers.join(','),
      ...rows.map(row => headers.map(h => JSON.stringify(row[h as keyof typeof row] || '')).join(','))
    ];
    const blob = new Blob([csvRows.join('\n')], { type: 'text/csv' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `${campaignName.replace(/[^a-z0-9]/gi, '_')}_${new Date().toISOString().slice(0,19)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    toast.success('CSV exported!');
  };

  const logBounce = (leadRowIndex: number) => {
    if (!window.confirm('Mark this lead as bounced? This can be undone from the lead detail panel.')) return;
    setReputationData(prev => ({
      ...prev,
      bounces: prev.bounces + 1,
      lastUpdated: new Date().toISOString()
    }));
    setAnalyzedLeads(prev => {
      const updated = {
        ...prev,
        [leadRowIndex]: { ...prev[leadRowIndex], sentStatus: 'bounced' }
      };
      saveToSession(updated);
      return updated;
    });
    toast('Bounce logged. Lead will not be contacted again.', { icon: '📬' });
  };

  const undoBounce = (leadRowIndex: number) => {
    setReputationData(prev => ({
      ...prev,
      bounces: Math.max(0, prev.bounces - 1),
      lastUpdated: new Date().toISOString()
    }));
    setAnalyzedLeads(prev => {
      const updated = {
        ...prev,
        [leadRowIndex]: { ...prev[leadRowIndex], sentStatus: 'sent' }
      };
      saveToSession(updated);
      return updated;
    });
    toast.success('Bounce removed. Lead restored to sent status.');
  };

  const logSpamReport = (leadRowIndex: number) => {
    if (!window.confirm('Log a spam report for this lead? This can be undone from the lead detail panel.')) return;
    setReputationData(prev => ({
      ...prev,
      spamReports: prev.spamReports + 1,
      lastUpdated: new Date().toISOString()
    }));
    setAnalyzedLeads(prev => {
      const updated = {
        ...prev,
        [leadRowIndex]: { ...prev[leadRowIndex], spamReported: true }
      };
      saveToSession(updated);
      return updated;
    });
    toast.error('Spam report logged. Review your content.');
  };

  const undoSpamReport = (leadRowIndex: number) => {
    setReputationData(prev => ({
      ...prev,
      spamReports: Math.max(0, prev.spamReports - 1),
      lastUpdated: new Date().toISOString()
    }));
    setAnalyzedLeads(prev => {
      const updated = {
        ...prev,
        [leadRowIndex]: { ...prev[leadRowIndex], spamReported: false }
      };
      saveToSession(updated);
      return updated;
    });
    toast.success('Spam report removed.');
  };

  const retryFailedSends = async () => {
    const failedLeads = leads.filter(l => {
      const a = analyzedLeads[l.rowIndex];
      return a && a.sentStatus === 'failed' && (a.initialEmail?.body || a.aiAnalysis?.initialEmail?.body);
    });
    
    if (failedLeads.length === 0) {
      toast('No failed sends to retry');
      return;
    }
    
    toast(`Retrying ${failedLeads.length} failed sends...`);
    
    for (const lead of failedLeads) {
      const analysis = analyzedLeads[lead.rowIndex];
      const emailBody = analysis.aiAnalysis?.initialEmail?.body || analysis.initialEmail?.body;
      const emailSubject = analysis.aiAnalysis?.initialEmail?.subject || analysis.initialEmail?.subject;
      
      try {
        const res = await fetchWithGoogleAuth('/api/send-email', {
          method: 'POST',
          body: JSON.stringify({
            to: lead.email,
            subject: emailSubject,
            body: emailBody,
            accountId: currentCampaign?.senderAccountId || undefined
          })
        });
        const data = await res.json();
        
        if (res.ok && data.success) {
          setBackendStatus('online');
          setAnalyzedLeads(prev => {
            const updated = { 
              ...prev, 
              [lead.rowIndex]: { 
                ...prev[lead.rowIndex], 
                sentStatus: 'sent', 
                sentAt: new Date().toISOString(),
                initialMessageId: data.messageId,
                initialThreadId: data.threadId,
              } 
            };
            saveToSession(updated);
            return updated;
          });
          toast.success(`✓ Retry succeeded for ${lead.company}`);
        } else {
          const errorMsg = data.error || 'Server error';
          toast.error(`Retry failed for ${lead.company}: ${errorMsg}`);
        }
      } catch (err: any) {
        if (err.name === 'TypeError' || err.message?.includes('fetch') || err.message?.includes('network')) {
          setBackendStatus('offline');
        }
        let errorMsg = err.message || 'Retry failed';
        if (err.message?.includes('429')) errorMsg = 'Gmail rate limit. Wait a few minutes.';
        if (err.message?.includes('invalid')) errorMsg = 'Invalid email address.';
        toast.error(`Retry failed for ${lead.company}: ${errorMsg}`);
      }
      
      await new Promise(resolve => setTimeout(resolve, 35000)); // 35 second delay between retries
    }
    
    toast.success('Retry complete!');
  };

  const checkRepliesForLeads = useCallback(async (leadSubset?: any[]) => {
    const leadsToCheck = leadSubset || leads.filter(l => {
      const analysis = analyzedLeads[l.rowIndex];
      // Only check leads that have been sent emails
      return analysis?.sentStatus === 'sent' && l.email;
    });
    
    if (leadsToCheck.length === 0) {
      toast('No sent leads to check for replies');
      return;
    }
    
    setCheckingReplies(true);
    toast(`Checking replies for ${leadsToCheck.length} leads...`, { duration: 3000 });
    
    // Process in batches of 10 to avoid rate limits
    const batchSize = 10;
    let totalReplies = 0;
    
    for (let i = 0; i < leadsToCheck.length; i += batchSize) {
      const batch = leadsToCheck.slice(i, i + batchSize);
      const emails = batch.map(l => l.email).filter(Boolean);
      
      try {
        const response = await fetchWithGoogleAuth('/api/check-replies', {
          method: 'POST',
          body: JSON.stringify({ leadEmails: emails })
        });
        const data = await response.json();
        
        if (data.replies) {
          batch.forEach(lead => {
            const replyVal = data.replies[lead.email];
            let hasReplied = false;
            let isUnsubscribed = false;
            
            if (replyVal && typeof replyVal === 'object') {
              hasReplied = !!replyVal.hasReplied;
              isUnsubscribed = !!replyVal.isUnsubscribed;

              // Auto-mark bounce if Gmail detected a delivery failure
              if (replyVal.isBounced) {
                setReputationData(prev => ({
                  ...prev,
                  bounces: prev.bounces + 1,
                  lastUpdated: new Date().toISOString(),
                }));
                setAnalyzedLeads(prev => {
                  const updated = {
                    ...prev,
                    [lead.rowIndex]: { ...prev[lead.rowIndex], sentStatus: 'bounced' },
                  };
                  saveToSession(updated);
                  return updated;
                });
                toast(`📬 ${lead.company} bounced — address invalid or unreachable.`);
              }

              // Auto-mark negative sentiment replies as unsubscribed
              if (replyVal.isNegative && !replyVal.isBounced) {
                toast(`⚠️ ${lead.company} replied negatively — marked as unsubscribed.`);
              }
            } else {
              hasReplied = replyVal === true;
            }

            if (hasReplied) totalReplies++;
            
            setReplyStatus(prev => {
              const updated = {
                ...prev,
                [lead.rowIndex]: {
                  hasReplied,
                  lastChecked: new Date().toISOString(),
                  replyCount: (prev[lead.rowIndex]?.replyCount || 0) + (hasReplied ? 1 : 0),
                  unsubscribed: isUnsubscribed
                }
              };
              if (selectedCampaignId) {
                localStorage.setItem(getCampaignRepliesKey(selectedCampaignId), JSON.stringify(updated));
              } else {
                localStorage.setItem('selio_replies', JSON.stringify(updated));
              }
              return updated;
            });

            if (isUnsubscribed) {
              setAnalyzedLeads(prev => {
                const updated = {
                  ...prev,
                  [lead.rowIndex]: {
                    ...prev[lead.rowIndex],
                    sentStatus: 'unsubscribed',
                    unsubscribedAt: new Date().toISOString()
                  }
                };
                saveToSession(updated);
                return updated;
              });
              if (!replyVal?.isNegative) {
                toast(`⚠️ ${lead.company} unsubscribed – no further emails.`);
              }
            }
          });
        }
      } catch (err) {
        console.error('Failed to check replies batch:', err);
      }
      
      // Small delay between batches
      if (i + batchSize < leadsToCheck.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    setCheckingReplies(false);
    toast.success(`Reply check complete! Found ${totalReplies} lead(s) who replied.`, { duration: 5000 });
  }, [leads, analyzedLeads, fetchWithGoogleAuth, selectedCampaignId, saveToSession]);

  // Auto-check replies every hour for sent leads
  useEffect(() => {
    if (!isAuthenticated) return;
    
    const interval = setInterval(() => {
      const sentLeads = leads.filter(l => analyzedLeads[l.rowIndex]?.sentStatus === 'sent');
      if (sentLeads.length > 0) {
        checkRepliesForLeads(sentLeads);
      }
    }, 60 * 60 * 1000); // Every hour
    
    return () => clearInterval(interval);
  }, [isAuthenticated, leads, analyzedLeads, checkRepliesForLeads]);

  // FUNCTION 6: Schedule send for a specific time
  const scheduleSend = () => {
    if (!currentCampaign?.senderAccountId) {
      toast.error('This campaign has no sender account set. Set one in the Schedule tab first.');
      return;
    }
    setScheduleSettings(prev => ({
      ...prev,
      sendDate: new Date().toISOString().split('T')[0], // refresh so a stale tab doesn't submit a past date
    }));
    setShowScheduleModal(true);
  };

  const executeScheduledSend = async () => {
    // Validate against the campaign's timezone, not the browser's
    const tz = currentCampaign?.timezone || TIMEZONE_MAP[campaignCountry] || 'UTC';
    const scheduledInstant = zonedTimeToUtc(scheduleSettings.sendDate, scheduleSettings.startTime, tz);

    if (scheduledInstant < new Date()) {
      toast.error('Scheduled time is in the past. Please choose a future time.');
      return;
    }

    const readyToSend = leads.filter(l => {
      const a = analyzedLeads[l.rowIndex];
      const hasEmailContent = a && (a.initialEmail?.body || a.aiAnalysis?.initialEmail?.body);
      const notSentYet = a && a.sentStatus !== 'sent' && a.sentStatus !== 'unsubscribed';
      const hasValidEmail = l.email;
      const hasReplied = replyStatus[l.rowIndex]?.hasReplied === true || replyStatus[l.rowIndex]?.unsubscribed === true;
      return hasEmailContent && notSentYet && hasValidEmail && !hasReplied;
    });

    if (readyToSend.length === 0) {
      toast.error('No leads ready to send.');
      return;
    }

    try {
      toast.loading(`Scheduling ${readyToSend.length} emails for server background send...`);

      const batchSchedule = [{
        day: 1,
        time: scheduleSettings.startTime,
        leads: readyToSend
      }];

      const response = await fetchWithGoogleAuth('/api/queue-initial-sends', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          campaignId: selectedCampaignId,
          batchSchedule,
          sendDateRaw: scheduleSettings.sendDate,   // e.g. '2026-07-20'
          sendTimeRaw: scheduleSettings.startTime,  // e.g. '09:00'
        })
      });

      toast.dismiss();
      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || 'Server error');
      }

      if (selectedCampaignId) {
        startProgressPolling(readyToSend.map(l => l.rowIndex), selectedCampaignId);
      }

      const updatedAnalyzed = { ...analyzedLeads };
      readyToSend.forEach((lead) => {
        updatedAnalyzed[lead.rowIndex] = {
          ...updatedAnalyzed[lead.rowIndex],
          batchStatus: `queued:pending-server-resolve`,
          sentStatus: 'not-sent'
        };
      });
      setAnalyzedLeads(updatedAnalyzed);
      saveToSession(updatedAnalyzed);

      toast.success(`Autopilot Active! Queue scheduled on the server for ${scheduleSettings.sendDate} at ${scheduleSettings.startTime} (${tz}). You can safely close this tab.`);
      setShowScheduleModal(false);
    } catch (err: any) {
      toast.dismiss();
      console.error('Failed to schedule send on server:', err);
      toast.error(`Scheduling failed: ${err.message || 'Server error'}`);
    }
  };

  const parseAndExecuteMikeActions = (response: string) => {
    if (!response) return;
    const lines = response.split('\n');
    lines.forEach(line => {
      const cleanLine = line.trim();
      if (cleanLine.startsWith('ACTION:REWRITE_EMAIL:')) {
        try {
          const data = JSON.parse(cleanLine.replace('ACTION:REWRITE_EMAIL:', ''));
          setAnalyzedLeads(prev => {
            const updated = {
              ...prev,
              [data.rowIndex]: {
                ...prev[data.rowIndex],
                initialEmail: { subject: data.subject, body: data.body },
                aiAnalysis: {
                  ...prev[data.rowIndex]?.aiAnalysis,
                  initialEmail: { subject: data.subject, body: data.body }
                }
              }
            };
            saveToSession(updated);
            return updated;
          });
          toast.success(`Mike updated email for ${leads.find(l => l.rowIndex === data.rowIndex)?.company}`);
          setMikeActionLog(prev => [...prev.slice(-19), { action: 'REWRITE_EMAIL', rowIndex: data.rowIndex, timestamp: new Date().toLocaleTimeString() }]);
        } catch (e) {}
      }
      if (cleanLine.startsWith('ACTION:REWRITE_FOLLOWUP1:')) {
        try {
          const data = JSON.parse(cleanLine.replace('ACTION:REWRITE_FOLLOWUP1:', ''));
          setAnalyzedLeads(prev => {
            const updated = { ...prev, [data.rowIndex]: { 
              ...prev[data.rowIndex], 
              followUp1: { 
                subject: prev[data.rowIndex]?.followUp1?.subject || prev[data.rowIndex]?.aiAnalysis?.followUp1?.subject,
                body: data.body 
              }, 
              aiAnalysis: { 
                ...prev[data.rowIndex]?.aiAnalysis, 
                followUp1: { 
                  subject: prev[data.rowIndex]?.aiAnalysis?.followUp1?.subject,
                  body: data.body 
                } 
              } 
            }};
            saveToSession(updated);
            return updated;
          });
          toast.success(`Mike updated Follow Up 1 for ${leads.find(l => l.rowIndex === data.rowIndex)?.company}`);
          setMikeActionLog(prev => [...prev.slice(-19), { action: 'REWRITE_FOLLOWUP1', rowIndex: data.rowIndex, timestamp: new Date().toLocaleTimeString() }]);
        } catch (e) {}
      }
      if (cleanLine.startsWith('ACTION:REWRITE_FOLLOWUP2:')) {
        try {
          const data = JSON.parse(cleanLine.replace('ACTION:REWRITE_FOLLOWUP2:', ''));
          setAnalyzedLeads(prev => {
            const updated = { ...prev, [data.rowIndex]: { 
              ...prev[data.rowIndex], 
              followUp2: { 
                subject: prev[data.rowIndex]?.followUp2?.subject || prev[data.rowIndex]?.aiAnalysis?.followUp2?.subject,
                body: data.body 
              }, 
              aiAnalysis: { 
                ...prev[data.rowIndex]?.aiAnalysis, 
                followUp2: { 
                  subject: prev[data.rowIndex]?.aiAnalysis?.followUp2?.subject,
                  body: data.body 
                } 
              } 
            }};
            saveToSession(updated);
            return updated;
          });
          toast.success(`Mike updated Follow Up 2 for ${leads.find(l => l.rowIndex === data.rowIndex)?.company}`);
          setMikeActionLog(prev => [...prev.slice(-19), { action: 'REWRITE_FOLLOWUP2', rowIndex: data.rowIndex, timestamp: new Date().toLocaleTimeString() }]);
        } catch (e) {}
      }
      if (cleanLine.startsWith('ACTION:REWRITE_FOLLOWUP3:')) {
        try {
          const data = JSON.parse(cleanLine.replace('ACTION:REWRITE_FOLLOWUP3:', ''));
          setAnalyzedLeads(prev => {
            const updated = { ...prev, [data.rowIndex]: { 
              ...prev[data.rowIndex], 
              followUp3: { 
                subject: prev[data.rowIndex]?.followUp3?.subject || prev[data.rowIndex]?.aiAnalysis?.followUp3?.subject,
                body: data.body 
              }, 
              aiAnalysis: { 
                ...prev[data.rowIndex]?.aiAnalysis, 
                followUp3: { 
                  subject: prev[data.rowIndex]?.aiAnalysis?.followUp3?.subject,
                  body: data.body 
                } 
              } 
            }};
            saveToSession(updated);
            return updated;
          });
          toast.success(`Mike updated Follow Up 3 for ${leads.find(l => l.rowIndex === data.rowIndex)?.company}`);
          setMikeActionLog(prev => [...prev.slice(-19), { action: 'REWRITE_FOLLOWUP3', rowIndex: data.rowIndex, timestamp: new Date().toLocaleTimeString() }]);
        } catch (e) {}
      }
      if (cleanLine.startsWith('ACTION:ANALYZE_LEAD:')) {
        try {
          const data = JSON.parse(cleanLine.replace('ACTION:ANALYZE_LEAD:', ''));
          const lead = leads.find(l => l.rowIndex === data.rowIndex);
          if (lead) {
            analyzeSingleLead(lead);
            setMikeActionLog(prev => [...prev.slice(-19), { action: 'ANALYZE_LEAD', rowIndex: data.rowIndex, timestamp: new Date().toLocaleTimeString() }]);
          }
        } catch (e) {}
      }
    });
  };

  const handleMikeMessage = async () => {
    if (!mikeInput.trim()) return;
    const userMsg = { role: 'user', content: mikeInput };
    const updatedMsgs = [...mikeMessages, userMsg];
    setMikeMessages(updatedMsgs);
    setMikeInput('');
    setMikeLoading(true);

    try {
      const selectedAnalysis = selectedLead ? analyzedLeads[selectedLead.rowIndex] : null;
      const context = {
        leads: leads.map(l => ({
          rowIndex: l.rowIndex,
          company: l.company,
          website: l.website,
          email: l.email,
          recipient: l.recipient,
          analyzed: !!analyzedLeads[l.rowIndex],
          score: analyzedLeads[l.rowIndex]?.score || null,
          status: analyzedLeads[l.rowIndex]?.status || null,
          primaryProblem: analyzedLeads[l.rowIndex]?.aiAnalysis?.primaryProblem || null,
          hasEmail: !!analyzedLeads[l.rowIndex]?.initialEmail?.body,
        })),
        analyzedLeads: Object.entries(analyzedLeads).map(([rowIndex, a]: any) => ({
          rowIndex,
          company: leads.find(l => l.rowIndex === parseInt(rowIndex))?.company,
          score: a.score,
          status: a.status,
          primaryProblem: a.aiAnalysis?.primaryProblem || a.primaryProblem,
          urgency: a.painAnalysis?.overallUrgency,
          initialEmailSubject: a.aiAnalysis?.initialEmail?.subject || a.initialEmail?.subject,
          initialEmailBody: a.aiAnalysis?.initialEmail?.body || a.initialEmail?.body,
          followUp1: a.aiAnalysis?.followUp1?.body || a.aiAnalysis?.followUp1 || a.followUp1?.body || a.followUp1,
          followUp2: a.aiAnalysis?.followUp2?.body || a.aiAnalysis?.followUp2 || a.followUp2?.body || a.followUp2,
          followUp3: a.aiAnalysis?.followUp3?.body || a.aiAnalysis?.followUp3 || a.followUp3?.body || a.followUp3,
          subjectLines: a.aiAnalysis?.subjectLines || [],
          insights: a.aiAnalysis?.insights || a.insights,
          problems: a.details?.problems || [],
        })),
        selectedLead: selectedLead ? {
          company: selectedLead.company,
          website: selectedLead.website,
          score: selectedAnalysis?.score,
          status: selectedAnalysis?.status,
          primaryProblem: selectedAnalysis?.aiAnalysis?.primaryProblem,
          initialEmailBody: selectedAnalysis?.aiAnalysis?.initialEmail?.body || selectedAnalysis?.initialEmail?.body,
          followUp1: selectedAnalysis?.aiAnalysis?.followUp1?.body || selectedAnalysis?.aiAnalysis?.followUp1 || selectedAnalysis?.followUp1?.body || selectedAnalysis?.followUp1,
          followUp2: selectedAnalysis?.aiAnalysis?.followUp2?.body || selectedAnalysis?.aiAnalysis?.followUp2 || selectedAnalysis?.followUp2?.body || selectedAnalysis?.followUp2,
          followUp3: selectedAnalysis?.aiAnalysis?.followUp3?.body || selectedAnalysis?.aiAnalysis?.followUp3 || selectedAnalysis?.followUp3?.body || selectedAnalysis?.followUp3,
          problems: selectedAnalysis?.details?.problems || [],
        } : null,
        campaignCountry,
        campaignName,
        totalLeads: leads.length,
        analyzedCount: Object.keys(analyzedLeads).length,
        hotLeads: Object.values(analyzedLeads).filter((a: any) => a.status === 'hot-lead').length,
        warmLeads: Object.values(analyzedLeads).filter((a: any) => a.status === 'warm-lead').length,
        emailsReady: Object.values(analyzedLeads).filter((a: any) => 
          (a.initialEmail?.body || a.aiAnalysis?.initialEmail?.body || a.initial_email?.body || a.ai_analysis?.initialEmail?.body)
          && a.sentStatus !== 'sent'
          && a.sentStatus !== 'unsubscribed'
        ).length,
        mikeActionLog: mikeActionLog,
      };

      const response = await fetch('/api/mike', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Google-Tokens': localStorage.getItem('google_tokens') || ''
        },
        body: JSON.stringify({
          message: userMsg.content,
          context,
          model: mikeModel,
          conversationHistory: mikeMessages
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to get answer from Mike');
      parseAndExecuteMikeActions(data.response);
      setMikeMessages([...updatedMsgs, { role: 'mike', content: data.reply || data.content || data.response }]);
    } catch (err: any) {
      toast.error(err.message);
      setMikeMessages([...updatedMsgs, { role: 'mike', content: `Sorry, I encountered an error: ${err.message}` }]);
    } finally {
      setMikeLoading(false);
    }
  };

// COMPUTE BATCH PREVIEW
const computeBatchPreview = () => {
  const unsentLeads = leads.filter(l => {
    const a = analyzedLeads[l.rowIndex];
    return a && (a.initialEmail?.body || a.aiAnalysis?.initialEmail?.body)
      && (!a.sentStatus || a.sentStatus === 'not-sent')
      && l.emailStatus !== 'needs-email';
  });

  const ordered = batchOrderMode === 'priority'
    ? [...unsentLeads].sort((a, b) => {
        const scoreA = analyzedLeads[a.rowIndex]?.score ?? 0;
        const scoreB = analyzedLeads[b.rowIndex]?.score ?? 0;
        return scoreB - scoreA;
      })
    : unsentLeads;

  const total = ordered.length;
  const days = Math.min(batchDays, total);
  const batches: any[] = [];

  if (batchSplitMode === 'even') {
    const base = Math.floor(total / days);
    const remainder = total % days;
    let cursor = 0;
    for (let i = 0; i < days; i++) {
      const count = base + (i < remainder ? 1 : 0);
      const batchLeads = ordered.slice(cursor, cursor + count);
      cursor += count;
      const hotCount = batchLeads.filter(l => analyzedLeads[l.rowIndex]?.status === 'hot-lead').length;
      const warmCount = batchLeads.filter(l => analyzedLeads[l.rowIndex]?.status === 'warm-lead').length;
      batches.push({
        day: i + 1,
        count,
        hotCount,
        warmCount,
        time: batchTimes[i] || '09:00',
        leads: batchLeads,
        status: i === 0 ? 'ready' : 'locked',
      });
    }
  } else {
    let cursor = 0;
    for (let i = 0; i < days; i++) {
      const count = Math.min(manualBatchSizes[i] || 0, total - cursor);
      const batchLeads = ordered.slice(cursor, cursor + count);
      cursor += count;
      const hotCount = batchLeads.filter(l => analyzedLeads[l.rowIndex]?.status === 'hot-lead').length;
      const warmCount = batchLeads.filter(l => analyzedLeads[l.rowIndex]?.status === 'warm-lead').length;
      batches.push({
        day: i + 1,
        count,
        hotCount,
        warmCount,
        time: batchTimes[i] || '09:00',
        leads: batchLeads,
        status: i === 0 ? 'ready' : 'locked',
      });
    }
  }

  return { batches, total };
};

// CONFIRM BATCH SCHEDULE
const confirmBatchSchedule = () => {
  if (!currentCampaign?.senderAccountId) {
    toast.error('This campaign has no sender account set. Set one in the Schedule tab first.');
    setShowBatchScheduleModal(false);
    return;
  }
  const { batches, total } = computeBatchPreview();

  const manualTotal = batchSplitMode === 'manual'
    ? manualBatchSizes.slice(0, batchDays).reduce((a, b) => a + (b || 0), 0)
    : total;

  if (batchSplitMode === 'manual' && manualTotal !== total) {
    toast.error(`Your batch sizes add up to ${manualTotal} but you have ${total} leads ready. Adjust the numbers.`);
    return;
  }

  setBatchPreview(batches);
  setShowBatchPreview(true);
};

// LOCK IN BATCH SCHEDULE
const lockBatchSchedule = async () => {
  const updatedLeads = [...leads];
  const updatedAnalyzed = { ...analyzedLeads };

  const startIso = new Date().toISOString();

  try {
    toast.loading('Activating automated background campaign batches on the server...');

    const response = await fetchWithGoogleAuth('/api/queue-initial-sends', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        campaignId: selectedCampaignId,
        batchSchedule: batchPreview,
        sendStartDate: startIso
      })
    });

    toast.dismiss();

    if (!response.ok) {
      const errData = await response.json();
      throw new Error(errData.error || 'Server error');
    }

    const day1Leads = batchPreview[0]?.leads || [];
    if (selectedCampaignId) {
      startProgressPolling(day1Leads.map((l: any) => l.rowIndex), selectedCampaignId);
    }

    batchPreview.forEach(batch => {
      const batchDay = batch.day || 1;
      let scheduledDate = new Date(startIso);
      if (batchDay > 1) {
        scheduledDate = addBusinessDays(startIso ? new Date(startIso) : new Date(), batchDay - 1);
      }
      const scheduledIso = scheduledDate.toISOString();

      batch.leads.forEach((lead: any) => {
        updatedAnalyzed[lead.rowIndex] = {
          ...updatedAnalyzed[lead.rowIndex],
          batchNumber: batch.day,
          batchStatus: `queued:${scheduledIso}`,
          sentStatus: 'not-sent'
        };
      });
    });

    setAnalyzedLeads(updatedAnalyzed);
    if (selectedCampaignId) {
      await saveLeads(selectedCampaignId, userId, updatedLeads);
      const freshLeads = await getLeads(selectedCampaignId);
      setLeads(freshLeads || []);
      await saveBatchSchedule(selectedCampaignId, {
        batchSchedule: batchPreview,
        currentBatch: 1,
        sendStartDate: startIso,
        createdAt: new Date().toISOString(),
      });
    }

    setShowBatchPreview(false);
    setShowBatchScheduleModal(false);

    const day1 = batchPreview[0];
    setActiveBatchBanner({
      day: 1,
      count: day1.count,
      hotCount: day1.hotCount,
      warmCount: day1.warmCount,
      time: day1.time,
      leads: day1.leads,
      totalBatches: batchPreview.length,
    });

    toast.success(`Autopilot Active! Server is now scheduling and sending your ${batchPreview.length}-day campaign in the background (times shown are in ${currentCampaign?.timezone || campaignCountry} local time). You can safely close this tab.`);
  } catch (err: any) {
    toast.dismiss();
    console.error('Failed to schedule batch on server:', err);
    toast.error(`Scheduling failed: ${err.message || 'Server error'}`);
  }
};

// SEND ACTIVE BATCH
const sendActiveBatch = async () => {
  if (!activeBatchBanner || !selectedCampaignId) return;
  if (!currentCampaign?.senderAccountId) {
    toast.error('This campaign has no sender account set. Set one in the Schedule tab first.');
    return;
  }

  const batchLeads = activeBatchBanner.leads;

  if (batchLeads.length === 0) {
    toast.error('No leads in this batch.');
    return;
  }

  if (!isAuthenticated) {
    toast.error('Connect your Google account first');
    return;
  }

  const leadIds = batchLeads.map((l: any) => l._supabaseId);

  try {
    toast.loading(`Triggering background batch send for Day ${activeBatchBanner.day} (${batchLeads.length} leads)...`);
    
    const response = await fetchWithGoogleAuth('/api/send-batch-now', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        campaignId: selectedCampaignId,
        leadIds: leadIds
      })
    });

    toast.dismiss();

    if (!response.ok) {
      const errData = await response.json();
      throw new Error(errData.error || 'Server error');
    }

    // Update UI state to reflect queued/not-sent status on server
    const updatedAnalyzed = { ...analyzedLeads };
    const nowIso = new Date().toISOString();
    batchLeads.forEach((lead: any) => {
      updatedAnalyzed[lead.rowIndex] = {
        ...updatedAnalyzed[lead.rowIndex],
        batchStatus: `queued:${nowIso}`,
        sentStatus: 'not-sent'
      };
    });
    setAnalyzedLeads(updatedAnalyzed);
    saveToSession(updatedAnalyzed);

    if (selectedCampaignId) {
      startProgressPolling(batchLeads.map((l: any) => l.rowIndex), selectedCampaignId);
    }

    toast.success(`Server is sending Day ${activeBatchBanner.day} in the background! You can safely close this tab.`);

    // ADVANCE TO NEXT BATCH
    try {
      const schedule = await getBatchSchedule(selectedCampaignId);
      if (!schedule) return;

      const nextBatch = schedule.currentBatch + 1;
      schedule.currentBatch = nextBatch;
      if (!schedule.sendStartDate) {
        schedule.sendStartDate = new Date().toISOString();
      }
      await saveBatchSchedule(selectedCampaignId, schedule);

      const nextBatchData = schedule.batchSchedule.find(
        (b: any) => b.day === nextBatch
      );

      if (nextBatchData) {
        const removedLeads = nextBatchData.leads.filter((l: any) => {
          return (
            replyStatus[l.rowIndex]?.hasReplied === true ||
            replyStatus[l.rowIndex]?.unsubscribed === true ||
            analyzedLeads[l.rowIndex]?.sentStatus === 'bounced'
          );
        });
        const cleanLeads = nextBatchData.leads.filter((l: any) => {
          return (
            !replyStatus[l.rowIndex]?.hasReplied &&
            !replyStatus[l.rowIndex]?.unsubscribed &&
            analyzedLeads[l.rowIndex]?.sentStatus !== 'bounced'
          );
        });

        setActiveBatchBanner({
          day: nextBatch,
          count: cleanLeads.length,
          hotCount: cleanLeads.filter(
            (l: any) => analyzedLeads[l.rowIndex]?.status === 'hot-lead'
          ).length,
          warmCount: cleanLeads.filter(
            (l: any) => analyzedLeads[l.rowIndex]?.status === 'warm-lead'
          ).length,
          time: nextBatchData.time,
          leads: cleanLeads,
          totalBatches: schedule.batchSchedule.length,
          removedCount: removedLeads.length,
        });
      } else {
        setActiveBatchBanner(null);
        toast.success('All batches sent. Campaign complete.');
      }
    } catch (err) {
      console.error('Failed to advance batch:', err);
      toast.error('Batch triggered but failed to load next batch. Refresh the page.');
    }

  } catch (err: any) {
    toast.dismiss();
    console.error('Failed to trigger batch send on server:', err);
    toast.error(`Batch send failed: ${err.message || 'Server error'}`);
  }
};

  const checkProactiveTriggers = useCallback(() => {
    if (!mikeOpen) return;

    const overdueFollowUps = Object.entries(analyzedLeads).filter(([rowIndex, a]: any) => {
      if (!a.sentAt || a.followUp1Sent) return false;
      const daysSince = (Date.now() - new Date(a.sentAt).getTime()) / (1000 * 60 * 60 * 24);
      return daysSince >= 3;
    });

    const uncontactedHotLeads = Object.entries(analyzedLeads).filter(([rowIndex, a]: any) => {
      const lead = leads.find(l => l.rowIndex === parseInt(rowIndex));
      if (!lead) return false;
      const hoursSinceAnalysis = a.analyzedAt
        ? (Date.now() - new Date(a.analyzedAt).getTime()) / (1000 * 60 * 60)
        : 0;
      return a.status === 'hot-lead' && (!a.sentStatus || a.sentStatus === 'not-sent') && hoursSinceAnalysis >= 48;
    });

    const lastMikeMsg = mikeMessages[mikeMessages.length - 1];
    const isAlreadyProactive = lastMikeMsg?.proactive === true;
    if (isAlreadyProactive) return;

    if (overdueFollowUps.length > 0) {
      const names = overdueFollowUps.slice(0, 3).map(([rowIndex]) => {
        return leads.find(l => l.rowIndex === parseInt(rowIndex))?.company || 'a lead';
      }).join(', ');
      setMikeMessages(prev => [...prev, {
        role: 'mike',
        proactive: true,
        content: `${overdueFollowUps.length} lead${overdueFollowUps.length > 1 ? 's are' : ' is'} due for a follow-up today: ${names}. Want me to queue them?`,
      }]);
    } else if (uncontactedHotLeads.length > 0) {
      const [rowIndex] = uncontactedHotLeads[0];
      const lead = leads.find(l => l.rowIndex === parseInt(rowIndex));
      if (lead) {
        setMikeMessages(prev => [...prev, {
          role: 'mike',
          proactive: true,
          content: `${lead.company} has been analyzed as a hot lead but has not been contacted yet. Should I prep the email for sending?`,
        }]);
      }
    }
  }, [mikeOpen, analyzedLeads, leads, mikeMessages]);

  useEffect(() => {
    if (mikeOpen) {
      checkProactiveTriggers();
    }
  }, [mikeOpen, checkProactiveTriggers]);

  const selectedAnalysis = selectedLead ? analyzedLeads[selectedLead.rowIndex] : null;
  const hasReplied = selectedLead ? replyStatus[selectedLead.rowIndex]?.hasReplied : false;
  const analyzedCount = Object.keys(analyzedLeads).length;
  const hotLeads = Object.values(analyzedLeads).filter((a: any) => a.status === 'hot-lead').length;
  const emailsReady = Object.values(analyzedLeads).filter((a: any) => 
    (a.initialEmail?.body || a.aiAnalysis?.initialEmail?.body || a.initial_email?.body || a.ai_analysis?.initialEmail?.body)
    && a.sentStatus !== 'sent'
    && a.sentStatus !== 'unsubscribed'
  ).length;
  const sentCount = Object.values(analyzedLeads).filter((a: any) => a?.sentStatus === 'sent').length;
  const notSentCount = Object.values(analyzedLeads).filter((a: any) => a?.sentStatus === 'not-sent' || !a?.sentStatus).length;
  const failedCount = Object.values(analyzedLeads).filter((a: any) => a?.sentStatus === 'failed').length;
  const repliedCount = Object.values(replyStatus).filter(r => r.hasReplied === true).length;
  const needsEmailCount = leads.filter(l => l.emailStatus === 'needs-email' || !l.email).length;

  const addBusinessDays = (date: Date, days: number) => {
    const r = new Date(date); let a = 0;
    while (a < days) { r.setDate(r.getDate() + 1); if (r.getDay() !== 0 && r.getDay() !== 6) a++; }
    return r;
  };

  const now = new Date();
  const schedule = {
    'Initial Email': { date: now, day: 'Day 0' },
    'Follow Up 1': { date: addBusinessDays(now, 3), day: 'Day 3' },
    'Follow Up 2': { date: addBusinessDays(now, 10), day: 'Day 10' },
    'Follow Up 3': { date: addBusinessDays(now, 17), day: 'Day 17' },
  };

  const navItems = [
    { id: 'pipeline', icon: '⚡', label: 'Pipeline' },
    { id: 'intel', icon: '🔍', label: 'Intel' },
    { id: 'emails', icon: '✉️', label: 'Emails' },
    { id: 'reports', icon: '📊', label: 'Reports' },
    { id: 'schedule', icon: '📅', label: 'Schedule' },
  ];

  const NAVY = '#0A0F1E';
  const NAVY_LIGHT = '#111827';
  const NAVY_BORDER = '#1E293B';
  const AMBER = '#F59E0B';
  const AMBER_LIGHT = '#FEF3C7';
  const AMBER_DARK = '#D97706';
  const SLATE = '#64748B';
  const SLATE_LIGHT = '#94A3B8';
  const RED = '#EF4444';
  const RED_LIGHT = '#FEE2E2';
  const ORANGE = '#F97316';
  const GREEN = '#22C55E';
  const GREEN_LIGHT = '#DCFCE7';
  const BLUE = '#3B82F6';
  const BLUE_LIGHT = '#DBEAFE';
  const OFF_WHITE = '#F8FAFC';

  const CampaignsScreen = () => (
    <div style={{ padding: '32px 24px', maxWidth: 1200, margin: '0 auto', minHeight: '100vh' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 32 }}>
        <div>
          <h1 style={{ fontSize: 26, fontWeight: 900, color: NAVY, letterSpacing: '-0.02em', margin: 0 }}>SEO Campaigns</h1>
          <p style={{ fontSize: 13, color: SLATE, margin: '4px 0 0 0' }}>Manage outreach campaigns, analyze leads, and track replies in separate pipelines.</p>
        </div>
        <button
          onClick={() => {
            setNewCampaignName('');
            setNewCampaignSenderAccountId('');
            setNewCampaignCountry('United Kingdom');
            setIsOtherCountrySelected(false);
            setNewCampaignIndustry('');
            setNewCampaignDecisionMaker('');
            setNewCampaignIcpContext('');
            setNewCampaignFollowUp1Days(3);
            setNewCampaignFollowUp2Days(10);
            setNewCampaignFollowUp3Days(17);
            setShowCreateCampaignModal(true);
          }}
          style={{ padding: '10px 20px', borderRadius: 10, background: AMBER, color: NAVY, fontWeight: 800, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, boxShadow: '0 2px 4px rgba(245, 158, 11, 0.2)' }}
        >
          <span>+</span> New Campaign
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 24 }}>
        {campaigns.map(campaign => {
          // Compute stats from stored data or use cached
          let leadsCount = 0;
          let analyzedCount = 0;
          let sentCount = 0;
          try {
            const leadsData = localStorage.getItem(getCampaignLeadsKey(campaign.id));
            const resultsData = localStorage.getItem(getCampaignResultsKey(campaign.id));
            leadsCount = leadsData ? JSON.parse(leadsData).length : 0;
            analyzedCount = resultsData ? Object.keys(JSON.parse(resultsData)).length : 0;
            sentCount = resultsData ? Object.values(JSON.parse(resultsData)).filter((a: any) => a?.sentStatus === 'sent').length : 0;
          } catch (e) {
            console.error(e);
          }
          
          return (
            <div
              key={campaign.id}
              onClick={() => setSelectedCampaignId(campaign.id)}
              style={{
                background: 'white',
                border: `1px solid ${selectedCampaignId === campaign.id ? AMBER : NAVY_BORDER}`,
                borderRadius: 16,
                padding: 24,
                cursor: 'pointer',
                transition: 'all 0.2s ease',
                boxShadow: selectedCampaignId === campaign.id ? `0 4px 12px rgba(245, 158, 11, 0.08)` : '0 1px 3px rgba(0, 0, 0, 0.02)',
                position: 'relative'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: 16 }}>
                <div>
                  <div style={{ fontSize: 18, fontWeight: 900, color: NAVY, letterSpacing: '-0.01em' }}>{campaign.name}</div>
                  <div style={{ fontSize: 11, color: SLATE, marginTop: 4, fontWeight: 500 }}>
                    📍 {campaign.country} • {new Date(campaign.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    onClick={(e) => { e.stopPropagation(); duplicateCampaign(campaign); }}
                    title="Duplicate Campaign"
                    style={{ padding: '6px 10px', borderRadius: 8, background: '#F1F5F9', border: 'none', fontSize: 12, cursor: 'pointer', color: SLATE }}
                  >
                    📋
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDeleteCampaign(campaign.id); }}
                    title="Delete Campaign"
                    style={{ padding: '6px 10px', borderRadius: 8, background: RED_LIGHT, border: 'none', fontSize: 12, cursor: 'pointer', color: RED }}
                  >
                    🗑️
                  </button>
                </div>
              </div>
              
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, borderTop: `1px solid #F1F5F9`, borderBottom: `1px solid #F1F5F9`, padding: '16px 0', margin: '16px 0' }}>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 20, fontWeight: 900, color: BLUE, fontFamily: 'monospace' }}>{leadsCount}</div>
                  <div style={{ fontSize: 10, color: SLATE, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Leads</div>
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 20, fontWeight: 900, color: AMBER, fontFamily: 'monospace' }}>{analyzedCount}</div>
                  <div style={{ fontSize: 10, color: SLATE, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Analyzed</div>
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 20, fontWeight: 900, color: GREEN, fontFamily: 'monospace' }}>{sentCount}</div>
                  <div style={{ fontSize: 10, color: SLATE, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Sent</div>
                </div>
              </div>
              
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontSize: 10, color: SLATE_LIGHT, fontWeight: 500 }}>
                  {campaign.lastOpened ? `Active: ${new Date(campaign.lastOpened).toLocaleDateString()}` : 'Never opened'}
                </div>
                <span style={{ fontSize: 11, color: AMBER, fontWeight: 700 }}>Open Pipeline →</span>
              </div>
            </div>
          );
        })}
      </div>
      {campaigns.length === 0 && (
        <div style={{ textAlign: 'center', padding: '64px 32px', background: 'white', borderRadius: 20, border: `1px dashed ${NAVY_BORDER}`, color: SLATE, marginTop: 32 }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>📂</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: NAVY }}>No Campaigns Found</div>
          <div style={{ fontSize: 13, color: SLATE_LIGHT, marginTop: 4, marginBottom: 20 }}>Get started by creating your first outreach campaign!</div>
          <button
            onClick={() => {
              setNewCampaignName('');
              setNewCampaignSenderAccountId('');
              setNewCampaignCountry('United Kingdom');
              setIsOtherCountrySelected(false);
              setNewCampaignIndustry('');
              setNewCampaignDecisionMaker('');
              setNewCampaignIcpContext('');
              setNewCampaignFollowUp1Days(3);
              setNewCampaignFollowUp2Days(10);
              setNewCampaignFollowUp3Days(17);
              setShowCreateCampaignModal(true);
            }}
            style={{ padding: '8px 16px', borderRadius: 8, background: AMBER, color: NAVY, fontWeight: 700, border: 'none', cursor: 'pointer' }}
          >
            Create Your First Campaign
          </button>
        </div>
      )}
    </div>
  );

  return (
    <div style={{ fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", background: OFF_WHITE, height: '100dvh', display: 'flex', flexDirection: 'column', overflow: !selectedCampaignId ? 'auto' : 'hidden' }}>
      {backendStatus === 'offline' && (
        <div style={{ background: RED, padding: '10px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0, zIndex: 10000 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 16 }}>⚠️</span>
            <span style={{ fontSize: 12, color: 'white', fontWeight: 500 }}>Backend is unreachable. Some features may not work.</span>
          </div>
          <button onClick={checkBackendHealth} style={{ padding: '4px 12px', borderRadius: 6, fontSize: 11, fontWeight: 700, background: 'white', color: RED, border: 'none', cursor: 'pointer' }}>
            Retry
          </button>
        </div>
      )}

      {/* ACTIVE BATCH BANNER */}
      {activeBatchBanner && (
        <div style={{ margin: '0 0 16px 0', padding: '14px 16px', borderRadius: 14, background: AMBER_LIGHT, border: `1px solid ${AMBER}`, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 800, color: NAVY }}>
                Day {activeBatchBanner.day} of {activeBatchBanner.totalBatches} ready
                <span style={{ fontWeight: 400, color: SLATE, marginLeft: 8 }}>{activeBatchBanner.time} today</span>
              </div>
              <div style={{ fontSize: 11, color: SLATE, marginTop: 3 }}>
                {activeBatchBanner.count} leads queued
                {activeBatchBanner.removedCount > 0 && (
                  <span style={{ color: '#D97706', marginLeft: 6 }}>
                    ({activeBatchBanner.removedCount} removed: replied or bounced)
                  </span>
                )}
              </div>
              <div style={{ fontSize: 10, color: SLATE, marginTop: 2 }}>
                {activeBatchBanner.hotCount} hot, {activeBatchBanner.warmCount} warm
              </div>
            </div>
            <button onClick={() => setActiveBatchBanner(null)}
              style={{ background: 'none', border: 'none', color: SLATE, cursor: 'pointer', fontSize: 16 }}>✕</button>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => {
              const batchLeadRowIndexes = new Set(activeBatchBanner.leads.map((l: any) => l.rowIndex));
              const firstLead = leads.find(l => batchLeadRowIndexes.has(l.rowIndex));
              if (firstLead) setSelectedLead(firstLead);
            }}
              style={{ flex: 1, padding: '8px 0', borderRadius: 8, fontSize: 11, fontWeight: 700, background: 'white', color: NAVY, border: `1px solid ${NAVY_BORDER}`, cursor: 'pointer' }}>
              Review Leads
            </button>
            <button onClick={sendActiveBatch}
              style={{ flex: 2, padding: '8px 0', borderRadius: 8, fontSize: 11, fontWeight: 700, background: AMBER, color: NAVY, border: 'none', cursor: 'pointer' }}>
              Send {activeBatchBanner.count} Now
            </button>
          </div>
        </div>
      )}

      {!selectedCampaignId ? (
        <CampaignsScreen />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>

          {/* TOP BAR */}
          <div style={{ background: NAVY, padding: isMobile ? '10px 16px' : '12px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0, zIndex: 100 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 32, height: 32, borderRadius: 8, background: AMBER, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 900, color: NAVY, flexShrink: 0 }}>S</div>
              <div>
                <div style={{ fontSize: 16, fontWeight: 900, color: 'white', letterSpacing: '-0.03em', lineHeight: 1 }}>Selio</div>
                {!isMobile && <div style={{ fontSize: 9, color: SLATE_LIGHT, letterSpacing: '0.1em', textTransform: 'uppercase' }}>SEO OUTREACH INTELLIGENCE</div>}
              </div>
              {selectedCampaignId && currentCampaign && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: isMobile ? 8 : 16, paddingLeft: isMobile ? 8 : 16, borderLeft: `1px solid ${NAVY_BORDER}` }}>
                  <button
                    onClick={() => setSelectedCampaignId(null)}
                    style={{ background: 'transparent', border: 'none', color: '#FFFFFF', cursor: 'pointer', fontSize: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '4px 8px', borderRadius: 6, transition: 'background 0.2s' }}
                    title="Back to Campaigns"
                    onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.1)'}
                    onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                  >
                    ←
                  </button>
                  <span style={{ fontSize: 14, fontWeight: 700, color: AMBER, letterSpacing: '-0.01em' }}>{currentCampaign.name}</span>
                </div>
              )}
            </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {!isMobile && navItems.map(item => (
            <button key={item.id} onClick={() => setActiveSection(item.id as any)}
              style={{ padding: '6px 10px', borderRadius: 8, fontSize: 11, fontWeight: 700, background: activeSection === item.id ? AMBER : 'transparent', color: activeSection === item.id ? NAVY : SLATE_LIGHT, border: 'none', cursor: 'pointer' }}>
              {item.icon} {item.label}
            </button>
          ))}
          <button onClick={() => setMikeOpen(!mikeOpen)}
            style={{ padding: '7px 12px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: mikeOpen ? AMBER : NAVY_BORDER, color: mikeOpen ? NAVY : 'white', border: 'none', cursor: 'pointer' }}>
            🤖 Mike
          </button>
          {isAuthenticated ? (
            <button onClick={handleLogout} style={{ padding: '7px 12px', borderRadius: 20, fontSize: 10, fontWeight: 700, background: GREEN_LIGHT, color: GREEN, border: 'none', cursor: 'pointer' }}>🟢 Connected</button>
          ) : (
            <button onClick={handleConnect} style={{ padding: '7px 12px', borderRadius: 20, fontSize: 10, fontWeight: 700, background: AMBER, color: NAVY, border: 'none', cursor: 'pointer' }}>Connect Google</button>
          )}
        </div>
      </div>

      {showInstallBanner && (
        <div style={{ background: AMBER, padding: '10px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: NAVY }}>Install Selio</div>
            <div style={{ fontSize: 11, color: NAVY, opacity: 0.8 }}>Add to your home screen for the best experience</div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => setShowInstallBanner(false)}
              style={{ padding: '6px 12px', borderRadius: 6, fontSize: 11, fontWeight: 700, background: 'transparent', color: NAVY, border: `1px solid ${NAVY}`, cursor: 'pointer' }}>
              Later
            </button>
            <button onClick={() => { if (installPrompt) { installPrompt.prompt(); installPrompt.userChoice.then(() => setShowInstallBanner(false)); } }}
              style={{ padding: '6px 12px', borderRadius: 6, fontSize: 11, fontWeight: 700, background: NAVY, color: 'white', border: 'none', cursor: 'pointer' }}>
              Install
            </button>
          </div>
        </div>
      )}

      {/* MAIN CONTENT */}
      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: isMobile ? 68 : 0 }}>

        {/* PIPELINE */}
        {activeSection === 'pipeline' && (
          <div style={{ padding: isMobile ? 16 : '20px 24px' }}>
            <div style={{ background: NAVY_LIGHT, borderRadius: 16, padding: 18, marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 14 }}>
                <div>
                  <div style={{ fontSize: 9, color: AMBER, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 3 }}>Active Campaign</div>
                  <input 
                    value={localCampaignName || ''} 
                    onChange={e => setLocalCampaignName(e.target.value)}
                    onBlur={() => {
                      if (localCampaignName.trim() && localCampaignName.trim() !== currentCampaign?.name) {
                        setCampaignName(localCampaignName.trim());
                      } else {
                        setLocalCampaignName(currentCampaign?.name || '');
                      }
                    }}
                    style={{ fontSize: 16, fontWeight: 900, color: 'white', background: 'transparent', border: 'none', outline: 'none', width: '100%' }} 
                  />
                  <div style={{ fontSize: 11, color: SLATE_LIGHT, marginTop: 2 }}>{campaignCountry}  9-11 AM local</div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 16, width: '100%', maxWidth: '400px' }}>
                  
                  {/* Cancel batch button if any batch is running */}
                  {(runningAnalysis || generatingEmails || sendingQueue || bulkDrafting || checkingReplies || retryingAnalysis || retryingEmails) && (
                    <div style={{ background: '#FEE2E2', border: `1px solid ${COLORS.red}`, padding: '10px 14px', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                      <span style={{ fontSize: 11, color: COLORS.red, fontWeight: 700 }}>
                        ⚠️ {runningAnalysis ? 'Analyzing leads...' : generatingEmails ? 'Generating emails...' : sendingQueue ? 'Sending emails...' : bulkDrafting ? 'Creating drafts...' : checkingReplies ? 'Checking replies...' : 'Processing batch...'}
                      </span>
                      <button onClick={cancelBatchOperation} style={{ padding: '6px 12px', background: COLORS.red, color: 'white', borderRadius: 8, border: 'none', fontWeight: 700, fontSize: 11, cursor: 'pointer' }}>
                        🛑 STOP
                      </button>
                    </div>
                  )}

                  {/* Row 1: Analysis buttons */}
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={runAllAnalysis} disabled={runningAnalysis || currentLeadIndex !== -1 || leads.length === 0}
                      style={{ flex: 1, padding: '10px 8px', borderRadius: 10, fontSize: 11, fontWeight: 700, background: (runningAnalysis || currentLeadIndex !== -1) ? '#374151' : COLORS.amber, color: (runningAnalysis || currentLeadIndex !== -1) ? COLORS.slateLight : COLORS.navy, border: 'none', cursor: (runningAnalysis || currentLeadIndex !== -1) ? 'not-allowed' : 'pointer', textAlign: 'center' }}>
                      {runningAnalysis ? `⏳ Analyzing (${analyzedCount}/${leads.length})...` : '⚡ Run All Analysis'}
                    </button>
                    <button onClick={retryFailedAnalysis} disabled={retryingAnalysis || currentLeadIndex !== -1}
                      style={{ flex: 1, padding: '10px 8px', borderRadius: 10, fontSize: 11, fontWeight: 700, background: failedAnalysis.length > 0 || Object.values(analyzedLeads).some((a: any) => a && a.viable === false) ? '#FEE2E2' : '#F1F5F9', color: failedAnalysis.length > 0 || Object.values(analyzedLeads).some((a: any) => a && a.viable === false) ? COLORS.red : COLORS.slateLight, border: 'none', cursor: 'pointer', textAlign: 'center' }}>
                      {retryingAnalysis ? '⏳ Retrying...' : '🔄 Retry Failed'}
                      {(failedAnalysis.length > 0 || Object.values(analyzedLeads).some((a: any) => a && a.viable === false)) && !retryingAnalysis && (
                        <span style={{ marginLeft: 4, background: COLORS.red, color: 'white', borderRadius: 10, padding: '1px 5px', fontSize: 9 }}>
                          {failedAnalysis.length || Object.values(analyzedLeads).filter((a: any) => a && a.viable === false).length}
                        </span>
                      )}
                    </button>
                  </div>
 
                  {/* Row 2: Email generation buttons */}
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={generateAllEmails} disabled={generatingEmails || analyzedCount === 0}
                      style={{ flex: 1, padding: '10px 8px', borderRadius: 10, fontSize: 11, fontWeight: 700, background: analyzedCount > 0 && !generatingEmails ? '#EEF2FF' : '#F1F5F9', color: analyzedCount > 0 && !generatingEmails ? COLORS.blue : COLORS.slateLight, border: 'none', cursor: analyzedCount > 0 && !generatingEmails ? 'pointer' : 'not-allowed', textAlign: 'center' }}>
                      {generatingEmails ? '⏳ Generating...' : '✉️ Generate All Emails'}
                    </button>
                    <button onClick={retryFailedEmails} disabled={retryingEmails || generatingEmails}
                      style={{ flex: 1, padding: '10px 8px', borderRadius: 10, fontSize: 11, fontWeight: 700, background: failedEmails.length > 0 ? '#FEF9C3' : '#F1F5F9', color: failedEmails.length > 0 ? '#EAB308' : COLORS.slateLight, border: 'none', cursor: 'pointer', textAlign: 'center' }}>
                      {retryingEmails ? '⏳ Retrying...' : '🔄 Retry Failed Emails'}
                      {failedEmails.length > 0 && !retryingEmails && (
                        <span style={{ marginLeft: 4, background: '#EAB308', color: 'white', borderRadius: 10, padding: '1px 5px', fontSize: 9 }}>
                          {failedEmails.length}
                        </span>
                      )}
                    </button>
                  </div>
 
                  {/* Row 3: Send buttons */}
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={sendQueueNow} disabled={sendingQueue || emailsReady === 0 || !isAuthenticated}
                      style={{ flex: 1, padding: '10px 8px', borderRadius: 10, fontSize: 11, fontWeight: 700, background: emailsReady > 0 && isAuthenticated && !sendingQueue ? COLORS.green : '#F1F5F9', color: emailsReady > 0 && isAuthenticated && !sendingQueue ? 'white' : COLORS.slateLight, border: 'none', cursor: emailsReady > 0 && isAuthenticated && !sendingQueue ? 'pointer' : 'not-allowed', textAlign: 'center' }}>
                      {sendingQueue ? `⟳ Sending ${queueProgress.current}/${queueProgress.total}` : '📤 Send Queue Now'}
                    </button>
                    <button onClick={scheduleSend} disabled={emailsReady === 0 || !isAuthenticated}
                      style={{ flex: 1, padding: '10px 8px', borderRadius: 10, fontSize: 11, fontWeight: 700, background: emailsReady > 0 && isAuthenticated ? COLORS.navyLight : '#F1F5F9', color: emailsReady > 0 && isAuthenticated ? 'white' : COLORS.slateLight, border: 'none', cursor: emailsReady > 0 && isAuthenticated ? 'pointer' : 'not-allowed', textAlign: 'center' }}>
                      📅 Schedule Send
                    </button>
                    <button
                      onClick={() => {
                        if (!currentCampaign?.senderAccountId) {
                          toast.error('This campaign has no sender account set. Set one in the Schedule tab first.');
                          return;
                        }
                        setBatchDays(3);
                        setManualBatchSizes([0, 0, 0]);
                        setBatchTimes(['09:00', '09:00', '09:00']);
                        setBatchSplitMode('even');
                        setBatchOrderMode('priority');
                        setShowBatchScheduleModal(true);
                      }}
                      style={{ flex: 1, padding: '10px 8px', borderRadius: 10, fontSize: 11, fontWeight: 700, background: COLORS.navy, color: 'white', border: 'none', cursor: 'pointer', textAlign: 'center' }}>
                      📅 Batch Schedule
                    </button>
                    <button onClick={() => sendDueFollowUps(false)} disabled={sendingQueue}
                      style={{ flex: 1, padding: '10px 8px', borderRadius: 10, fontSize: 11, fontWeight: 700, background: BLUE_LIGHT, color: BLUE, border: 'none', cursor: 'pointer', textAlign: 'center' }}>
                      📨 Send Due Follow-ups
                    </button>
                  </div>
 
                  {/* Row 4: Check replies */}
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={() => checkRepliesForLeads()} disabled={checkingReplies || !isAuthenticated}
                      style={{ flex: 1, padding: '10px 8px', borderRadius: 10, fontSize: 11, fontWeight: 700, background: checkingReplies ? '#F1F5F9' : BLUE_LIGHT, color: checkingReplies ? COLORS.slateLight : BLUE, border: 'none', cursor: checkingReplies ? 'not-allowed' : 'pointer', textAlign: 'center' }}>
                      {checkingReplies ? '⏳ Checking...' : '💬 Check Replies'}
                    </button>
                  </div>

                  {/* Queue progress bar */}
                  {sendingQueue && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 12px', background: '#F0FDF4', border: `1px solid ${COLORS.green}`, borderRadius: 10 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: COLORS.green }}>
                          📤 Sending {queueProgress.current} of {queueProgress.total}
                        </span>
                        <button onClick={cancelSendInProgress}
                          style={{ padding: '4px 10px', background: COLORS.red, color: 'white', border: 'none', borderRadius: 6, fontSize: 10, fontWeight: 700, cursor: 'pointer' }}>
                          🛑 Stop Sending
                        </button>
                      </div>
                      <div style={{ background: '#DCFCE7', borderRadius: 8, overflow: 'hidden', height: 6 }}>
                        <div style={{ height: '100%', width: `${queueProgress.total ? (queueProgress.current / queueProgress.total) * 100 : 0}%`, background: COLORS.green, borderRadius: 8, transition: 'width 0.3s ease' }} />
                      </div>
                    </div>
                  )}

                  {/* Daily limit warning */}
                  {emailsReady > dailyLimit && (
                    <div style={{ padding: '8px 12px', background: COLORS.amberLight, borderRadius: 8, fontSize: 11, color: COLORS.amberDark }}>
                      ⚠️ You have {emailsReady} emails ready but your daily safe limit is {dailyLimit}. The queue will send the first {dailyLimit} only.
                    </div>
                  )}
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 10 }}>
                {[
                  ['Leads', leads.length, 'white'], 
                  ['Needs Email', needsEmailCount, needsEmailCount > 0 ? '#EAB308' : 'white'],
                  ['Analyzed', analyzedCount, AMBER], 
                  ['Hot', hotLeads, RED], 
                  ['Sent', sentCount, GREEN], 
                  ['Replied', repliedCount, BLUE],
                  ['Left', notSentCount, BLUE],
                  ['Failed', failedCount, ORANGE]
                ].map(([l, v, c]) => (
                  <div key={String(l)} style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: 22, fontWeight: 900, color: String(c), fontFamily: 'monospace' }}>{String(v)}</div>
                    <div style={{ fontSize: 9, color: SLATE_LIGHT, textTransform: 'uppercase' }}>{String(l)}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Reputation Row */}
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(3, 1fr)', gap: 12, marginBottom: 20 }}>
              <div style={{ background: 'white', border: `1px solid ${NAVY_BORDER}`, borderRadius: 16, padding: 16, textAlign: 'center' }}>
                <div style={{ fontSize: 28, marginBottom: 8 }}>📬</div>
                <div style={{ fontSize: 24, fontWeight: 900, color: reputationData.bounces > 0 ? RED : SLATE }}>
                  {reputationData.sentCount > 0 ? Math.round((reputationData.bounces / reputationData.sentCount) * 100) : 0}%
                </div>
                <div style={{ fontSize: 11, color: SLATE }}>Bounce Rate</div>
                <div style={{ fontSize: 10, color: SLATE_LIGHT }}>{reputationData.bounces} bounces / {reputationData.sentCount} sent</div>
              </div>
              <div style={{ background: 'white', border: `1px solid ${NAVY_BORDER}`, borderRadius: 16, padding: 16, textAlign: 'center' }}>
                <div style={{ fontSize: 28, marginBottom: 8 }}>⚠️</div>
                <div style={{ fontSize: 24, fontWeight: 900, color: reputationData.spamReports > 0 ? RED : GREEN }}>{reputationData.spamReports}</div>
                <div style={{ fontSize: 11, color: SLATE }}>Spam Reports</div>
              </div>
              <div style={{ background: 'white', border: `1px solid ${NAVY_BORDER}`, borderRadius: 16, padding: 16, textAlign: 'center' }}>
                <div style={{ fontSize: 28, marginBottom: 8 }}>✅</div>
                <div style={{ fontSize: 24, fontWeight: 900, color: BLUE }}>{reputationData.sentCount}</div>
                <div style={{ fontSize: 11, color: SLATE }}>Total Sent</div>
              </div>
            </div>

            <div style={{ background: 'white', border: `1px solid ${NAVY_BORDER}`, borderRadius: 16, padding: 16, marginBottom: 16 }}>
              <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
                {(['sheet', 'file'] as const).map(tab => (
                  <button key={tab} onClick={() => setActiveTab(tab)}
                    style={{ flex: 1, padding: 8, borderRadius: 8, fontSize: 11, fontWeight: 700, background: activeTab === tab ? AMBER : '#F1F5F9', color: activeTab === tab ? NAVY : SLATE, border: 'none', cursor: 'pointer', textTransform: 'uppercase' }}>
                    {tab === 'sheet' ? '🟢 Google Sheets' : '📁 CSV / Excel'}
                  </button>
                ))}
              </div>
              {activeTab === 'sheet' ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <input value={spreadsheetId || ''} onChange={e => setSpreadsheetId(e.target.value)} placeholder="Paste Google Sheets URL or ID..."
                    style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: `1px solid ${NAVY_BORDER}`, fontSize: 12, color: NAVY, boxSizing: 'border-box' }} />
                  <input value={sheetName || ''} onChange={e => setSheetName(e.target.value)} placeholder="Sheet name (e.g. Sheet1)"
                    style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: `1px solid ${NAVY_BORDER}`, fontSize: 12, color: NAVY, boxSizing: 'border-box' }} />
                  <button onClick={isAuthenticated ? fetchLeads : handleConnect} disabled={loading || !spreadsheetId}
                    style={{ padding: 12, borderRadius: 10, fontSize: 12, fontWeight: 700, background: AMBER, color: NAVY, border: 'none', cursor: 'pointer', opacity: (loading || !spreadsheetId) ? 0.6 : 1 }}>
                    {!isAuthenticated ? '🔑 Connect Google Account to Fetch' : loading ? '⏳ Loading...' : '⚡ Initialize Leads'}
                  </button>
                </div>
              ) : (
                <div onDragOver={e => e.preventDefault()} onDrop={onDrop}>
                  <input type="file" accept=".csv,.xlsx,.xls" onChange={handleFileUpload} id="file-upload" style={{ display: 'none' }} />
                  <label htmlFor="file-upload" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', border: `2px dashed ${NAVY_BORDER}`, borderRadius: 12, padding: 28, cursor: 'pointer' }}>
                    <div style={{ fontSize: 28, marginBottom: 8 }}>📁</div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: SLATE }}>Drop CSV or Excel here</div>
                    <div style={{ fontSize: 10, color: SLATE_LIGHT, marginTop: 4 }}>or tap to browse  XLSX, XLS, CSV</div>
                  </label>
                </div>
              )}
            </div>

            {leads.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: SLATE, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Leads ({leads.length})</div>
                  {analyzedCount > 0 && (
                    <button onClick={() => {
                      setConfirmDialog({
                        isOpen: true,
                        title: '⚠️ Reset Pipeline Results',
                        message: 'Are you sure? This will clear all analyzed results for the current campaign. Lead data will remain, but analysis and email status will be lost. This cannot be undone.',
                        onConfirm: () => {
                          clearSession();
                          setAnalyzedLeads({});
                          toast.success('Pipeline reset');
                        }
                      });
                    }} style={{ fontSize: 10, color: RED, background: 'none', border: 'none', cursor: 'pointer', fontWeight: 700 }}>
                      Reset
                    </button>
                  )}
                </div>

                {/* SEARCH, SORT, BULK SELECTION */}
                <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center', background: '#F8FAFC', padding: 12, borderRadius: 10, border: `1px solid ${NAVY_BORDER}` }}>
                  <div style={{ flex: 2, minWidth: '200px' }}>
                    <input
                      type="text"
                      placeholder="🔍 Search company, website, email..."
                      value={searchTerm || ''}
                      onChange={e => setSearchTerm(e.target.value)}
                      style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: `1px solid ${NAVY_BORDER}`, fontSize: 12, boxSizing: 'border-box' }}
                    />
                  </div>
                  <select value={sortBy} onChange={e => setSortBy(e.target.value as any)} style={{ padding: '8px 12px', borderRadius: 8, border: `1px solid ${NAVY_BORDER}`, fontSize: 12, background: 'white', color: NAVY, fontWeight: 600 }}>
                    <option value="score">🏆 Sort by Score</option>
                    <option value="status">🚦 Sort by Status</option>
                    <option value="sentDate">📅 Sort by Sent Date</option>
                    <option value="company">🏢 Sort by Company</option>
                  </select>
                  {selectedLeadRows.size > 0 && (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span style={{ fontSize: 12, color: SLATE, fontWeight: 700 }}>{selectedLeadRows.size} selected</span>
                      <button onClick={async () => {
                        const selectedLeads = leads.filter(l => selectedLeadRows.has(l.rowIndex));
                        const pending = selectedLeads.filter(l => !analyzedLeads[l.rowIndex]);
                        if (pending.length === 0) { toast('All selected leads already analyzed'); return; }
                        setRunningAnalysis(true);
                        setCancelBatch(false);
                        cancelBatchRef.current = false;
                        let completed = 0;
                        toast(`Analyzing ${pending.length} selected leads...`);
                        for (let i = 0; i < pending.length; i++) {
                          if (cancelBatchRef.current) {
                            toast(`Cancelled. ${completed} of ${pending.length} analyzed.`);
                            break;
                          }
                          const lead = pending[i];
                          setCurrentLeadIndex(leads.indexOf(lead));
                          try {
                            const res = await fetch('/api/analyze-lead', {
                              method: 'POST', headers: getAuthHeaders(), credentials: 'include',
                              body: getAnalysisRequestBody(lead)
                            });
                            const result = await res.json();
                            const leadResult = buildLeadResult(lead, result, currentCampaign?.industry);
                            if (!result.viable && result.crawlFailReason) {
                              setFailedAnalysis(prev => [...prev, lead.rowIndex]);
                            }
                            setAnalyzedLeads(prev => {
                              const updated = { ...prev, [lead.rowIndex]: leadResult };
                              saveToSession(updated);
                              return updated;
                            });
                            completed++;
                            toast(`Analyzed ${completed}/${pending.length}`, { duration: 1000 });
                          } catch (e) {
                            setFailedAnalysis(prev => [...prev, lead.rowIndex]);
                          }
                        }
                        setRunningAnalysis(false);
                        setCurrentLeadIndex(-1);
                        setSelectedLeadRows(new Set());
                        if (!cancelBatchRef.current) toast.success('Selected analysis complete!');
                      }} style={{ padding: '6px 12px', borderRadius: 6, fontSize: 11, background: AMBER, color: NAVY, fontWeight: 700, border: 'none', cursor: 'pointer' }}>Analyze Selected</button>
                      <button onClick={() => setSelectedLeadRows(new Set())} style={{ padding: '6px 12px', borderRadius: 6, fontSize: 11, background: '#E2E8F0', border: 'none', cursor: 'pointer', color: NAVY }}>Clear</button>
                      <button onClick={handleDeleteSelectedLeads} style={{ padding: '6px 12px', borderRadius: 6, fontSize: 11, background: '#FEE2E2', color: RED, fontWeight: 700, border: 'none', cursor: 'pointer' }}>🗑️ Delete Selected</button>
                    </div>
                  )}
                  {leads.length > 0 && (
                    <button 
                      onClick={() => {
                        if (selectedLeadRows.size === leads.length) {
                          setSelectedLeadRows(new Set());
                        } else {
                          setSelectedLeadRows(new Set(leads.map(l => l.rowIndex)));
                        }
                      }}
                      style={{ padding: '6px 12px', borderRadius: 6, fontSize: 11, background: '#F1F5F9', border: `1px solid ${NAVY_BORDER}`, cursor: 'pointer', color: NAVY, fontWeight: 700 }}
                    >
                      {selectedLeadRows.size === leads.length ? '🧹 Unselect All' : '✅ Select All'}
                    </button>
                  )}
                </div>

                <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                  <button onClick={() => setSentFilter('all')}
                    style={{ padding: '5px 12px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: sentFilter === 'all' ? AMBER : '#F1F5F9', color: sentFilter === 'all' ? NAVY : SLATE, border: 'none', cursor: 'pointer' }}>
                    All ({leads.length})
                  </button>
                  <button onClick={() => setSentFilter('not-sent')}
                    style={{ padding: '5px 12px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: sentFilter === 'not-sent' ? AMBER : '#F1F5F9', color: sentFilter === 'not-sent' ? NAVY : SLATE, border: 'none', cursor: 'pointer' }}>
                    Not Sent ({notSentCount})
                  </button>
                  <button onClick={() => setSentFilter('sent')}
                    style={{ padding: '5px 12px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: sentFilter === 'sent' ? AMBER : '#F1F5F9', color: sentFilter === 'sent' ? NAVY : SLATE, border: 'none', cursor: 'pointer' }}>
                    Sent ({sentCount})
                  </button>
                  <button onClick={() => setSentFilter('failed')}
                    style={{ padding: '5px 12px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: sentFilter === 'failed' ? AMBER : '#F1F5F9', color: sentFilter === 'failed' ? NAVY : SLATE, border: 'none', cursor: 'pointer' }}>
                    Failed ({failedCount})
                  </button>
                </div>

                {failedCount > 0 && (
                  <button onClick={retryFailedSends} 
                    style={{ marginBottom: 12, padding: '8px 12px', borderRadius: 8, fontSize: 11, fontWeight: 700, background: ORANGE, color: 'white', border: 'none', cursor: 'pointer', width: '100%' }}>
                    🔄 Retry {failedCount} Failed Sends
                  </button>
                )}

                {(() => {
                  const filteredLeads = leads.filter(lead => {
                    const matchesFilter = (sentFilter === 'all' || 
                      (sentFilter === 'sent' && analyzedLeads[lead.rowIndex]?.sentStatus === 'sent') ||
                      (sentFilter === 'not-sent' && (!analyzedLeads[lead.rowIndex]?.sentStatus || analyzedLeads[lead.rowIndex]?.sentStatus === 'not-sent')) ||
                      (sentFilter === 'failed' && analyzedLeads[lead.rowIndex]?.sentStatus === 'failed'));
                    if (!matchesFilter) return false;
                    if (!searchTerm) return true;
                    const term = searchTerm.toLowerCase();
                    return lead.company.toLowerCase().includes(term) ||
                           lead.website.toLowerCase().includes(term) ||
                           (lead.email && lead.email.toLowerCase().includes(term)) ||
                           (lead.recipient && lead.recipient.toLowerCase().includes(term));
                  });

                  const sortedLeads = [...filteredLeads].sort((a, b) => {
                    const aData = analyzedLeads[a.rowIndex];
                    const bData = analyzedLeads[b.rowIndex];
                    if (sortBy === 'score') return (bData?.score || 0) - (aData?.score || 0);
                    if (sortBy === 'status') return (aData?.status || '').localeCompare(bData?.status || '');
                    if (sortBy === 'sentDate') {
                      const aTime = aData?.sentAt ? new Date(aData.sentAt).getTime() : 0;
                      const bTime = bData?.sentAt ? new Date(bData.sentAt).getTime() : 0;
                      return bTime - aTime;
                    }
                    return a.company.localeCompare(b.company);
                  });

                  return sortedLeads.map((lead, i) => {
                    const analysis = analyzedLeads[lead.rowIndex];
                    const isAn = analyzingRows.has(lead.rowIndex) || currentLeadIndex === leads.indexOf(lead);
                    return (
                      <div key={lead.rowIndex} onClick={() => { setSelectedLead(lead); if (analysis) setActiveSection('intel'); }}
                        style={{ background: 'white', border: `1px solid ${selectedLead?.rowIndex === lead.rowIndex ? AMBER : NAVY_BORDER}`, borderRadius: 12, padding: '12px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12 }}>
                        
                        {/* Checkbox column element (ADDITION) */}
                        <input
                          type="checkbox"
                          checked={selectedLeadRows.has(lead.rowIndex)}
                          onChange={(e) => {
                            const newSet = new Set(selectedLeadRows);
                            if (e.target.checked) newSet.add(lead.rowIndex);
                            else newSet.delete(lead.rowIndex);
                            setSelectedLeadRows(newSet);
                          }}
                          onClick={e => e.stopPropagation()}
                          style={{ marginRight: 4, width: 16, height: 16, cursor: 'pointer', accentColor: AMBER }}
                        />

                        {analysis ? <ScoreRing score={analysis.score} size={48} campaignIndustry={currentCampaign?.industry} /> :
                          <div style={{ width: 48, height: 48, borderRadius: '50%', background: isAn ? AMBER_LIGHT : '#F1F5F9', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, flexShrink: 0 }}>
                            {isAn ? '⏳' : '🔍'}
                          </div>
                        }
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 2 }}>
                            <span style={{ fontSize: 13, fontWeight: 700, color: NAVY }}>{lead.company}</span>
                            {analysis && <StatusBadge status={resolveStatus(analysis)} />}
                            {/* ADD THIS SENT BADGE */}
                            {analysis?.sentStatus === 'sent' && (
                              <span style={{ fontSize: 10, fontWeight: 700, color: GREEN, background: GREEN_LIGHT, padding: '2px 8px', borderRadius: 20 }}>✅ SENT</span>
                            )}
                            {analysis?.sentStatus === 'failed' && (
                              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                <span style={{ fontSize: 10, fontWeight: 700, color: RED, background: RED_LIGHT, padding: '2px 8px', borderRadius: 20 }}>❌ FAILED</span>
                                <span style={{ fontSize: 9, color: RED, fontWeight: 600 }}>({analysis?.errorReason || 'Check logs'})</span>
                              </div>
                            )}
                            {analysis?.sentStatus === 'bounced' && (
                              <span style={{ fontSize: 10, fontWeight: 700, color: RED, background: RED_LIGHT, padding: '2px 8px', borderRadius: 20 }}>📬 BOUNCED</span>
                            )}
                            {analysis?.spamReported && (
                              <span style={{ fontSize: 10, fontWeight: 700, color: ORANGE, background: '#FEF3C7', padding: '2px 8px', borderRadius: 20 }}>⚠️ SPAM</span>
                            )}
                            {replyStatus[lead.rowIndex]?.hasReplied && (
                              <span style={{ fontSize: 10, fontWeight: 700, color: BLUE, background: BLUE_LIGHT, padding: '2px 8px', borderRadius: 20, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                                💬 Replied {replyStatus[lead.rowIndex]?.replyCount > 1 ? `(${replyStatus[lead.rowIndex].replyCount})` : ''}
                              </span>
                            )}
                          </div>
                          <div style={{ fontSize: 11, color: SLATE, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{lead.website}</div>
                          {lead.emailStatus === 'needs-email' ? (
                            <div style={{ display: 'flex', gap: 6, marginTop: 4, alignItems: 'center' }} onClick={e => e.stopPropagation()}>
                              <input
                                type="email"
                                placeholder="Enter email..."
                                value={manualEmailInputs[lead.rowIndex] || ''}
                                onChange={e => setManualEmailInputs(prev => ({ ...prev, [lead.rowIndex]: e.target.value }))}
                                style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid #E2E8F0', fontSize: 11, width: 140 }}
                              />
                              <button
                                onClick={() => {
                                  const val = manualEmailInputs[lead.rowIndex];
                                  if (val && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) {
                                    const updatedLeads = leads.map(l => l.rowIndex === lead.rowIndex ? { ...l, email: val, emailStatus: 'ready' } : l);
                                    setLeads(updatedLeads);
                                    if (selectedCampaignId) {
                                      localStorage.setItem(getCampaignLeadsKey(selectedCampaignId), JSON.stringify(updatedLeads));
                                    } else {
                                      localStorage.setItem('seo_leads', JSON.stringify(updatedLeads));
                                    }
                                    toast.success("Email saved locally!");
                                  } else {
                                    toast.error("Invalid email address.");
                                  }
                                }}
                                style={{ padding: '4px 8px', borderRadius: 6, background: AMBER, color: NAVY, fontSize: 10, fontWeight: '700', border: 'none', cursor: 'pointer' }}
                              >
                                Save
                              </button>
                            </div>
                          ) : (
                            <div style={{ fontSize: 10, color: SLATE_LIGHT, marginTop: 2 }}>{lead.email}</div>
                          )}
                          {analysis?.aiAnalysis?.primaryProblem && <div style={{ fontSize: 10, color: SLATE_LIGHT, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{analysis.aiAnalysis.primaryProblem}</div>}
                          {analysis && analysis.sentStatus === 'sent' && (
                            <div style={{ fontSize: 9, color: SLATE_LIGHT, marginTop: 2 }}>
                              {!analysis.followUp1Sent && '⏳ Follow-up 1 pending'}
                              {analysis.followUp1Sent && !analysis.followUp2Sent && '📨 Follow-up 1 sent'}
                              {analysis.followUp2Sent && !analysis.followUp3Sent && '📨 Follow-up 2 sent'}
                              {analysis.followUp3Sent && '✅ Sequence complete'}
                            </div>
                          )}
                          {analysis?.sentAt && (analysis.sentStatus === 'sent' || analysis.sentStatus === 'bounced') && (
                            <div style={{ fontSize: 9, color: analysis.sentStatus === 'bounced' ? RED : GREEN, marginTop: 2 }}>
                              {analysis.sentStatus === 'bounced' ? 'Bounced: ' : 'Sent: '}{new Date(analysis.sentAt).toLocaleString()}
                            </div>
                          )}
                        </div>
                        <div style={{ display: 'flex', gap: 5, flexShrink: 0, alignItems: 'center' }}>
                          {analysis?.sentStatus === 'sent' && (
                            <>
                              <button onClick={e => { e.stopPropagation(); logBounce(lead.rowIndex); }} style={{ padding: '5px 9px', borderRadius: 6, fontSize: 10, fontWeight: 700, background: '#FEE2E2', color: '#EF4444', border: 'none', cursor: 'pointer' }}>Bounce 📬</button>
                              <button onClick={e => { e.stopPropagation(); logSpamReport(lead.rowIndex); }} style={{ padding: '5px 9px', borderRadius: 6, fontSize: 10, fontWeight: 700, background: '#FEF3C7', color: '#D97706', border: 'none', cursor: 'pointer' }}>Spam ⚠️</button>
                            </>
                          )}
                          {analysis ? (
                            <button
                              disabled={isAn}
                              onClick={e => { e.stopPropagation(); handleReanalyzeLead(lead); }}
                              style={{
                                padding: '5px 12px',
                                borderRadius: 6,
                                fontSize: 10,
                                fontWeight: 700,
                                background: isAn ? '#FEF3C7' : '#F1F5F9',
                                color: isAn ? '#D97706' : SLATE,
                                border: isAn ? '1px solid #FCD34D' : `1px solid ${NAVY_BORDER}`,
                                cursor: isAn ? 'wait' : 'pointer',
                                transition: 'all 0.2s ease',
                              }}>
                              {isAn ? '⏳ Re-analyzing...' : 'Re-analyze'}
                            </button>
                          ) : (
                            <button 
                              disabled={isAn || runningAnalysis} 
                              onClick={e => { e.stopPropagation(); analyzeSingleLead(lead); }} 
                              style={{ 
                                padding: '5px 12px', 
                                borderRadius: 6, 
                                fontSize: 10, 
                                fontWeight: 700, 
                                background: (isAn || runningAnalysis) ? '#E2E8F0' : AMBER_LIGHT, 
                                color: (isAn || runningAnalysis) ? SLATE : AMBER_DARK, 
                                border: 'none', 
                                cursor: (isAn || runningAnalysis) ? 'not-allowed' : 'pointer',
                                transition: 'all 0.2s ease',
                              }}
                            >
                              {isAn ? '⏳ Analyzing...' : 'Analyze'}
                            </button>
                          )}
                          {analysis?.initialEmail?.body && <button onClick={e => { e.stopPropagation(); handleCreateDraft(lead); }} style={{ padding: '5px 9px', borderRadius: 6, fontSize: 10, fontWeight: 700, background: BLUE_LIGHT, color: BLUE, border: 'none', cursor: 'pointer' }}>Draft</button>}
                          {analysis && <button onClick={e => { e.stopPropagation(); setSelectedLead(lead); setActiveSection('intel'); }} style={{ padding: '5px 9px', borderRadius: 6, fontSize: 10, fontWeight: 700, background: NAVY_LIGHT, color: 'white', border: 'none', cursor: 'pointer' }}>Intel 🔍</button>}
                          <button onClick={e => { e.stopPropagation(); handleDeleteLead(lead); }} title="Delete this lead" style={{ padding: '5px 9px', borderRadius: 6, fontSize: 10, fontWeight: 700, background: '#FEE2E2', color: RED, border: 'none', cursor: 'pointer' }}>🗑️</button>
                        </div>
                      </div>
                    );
                  });
                })()}
                {analyzedCount === leads.length && leads.length > 0 && (
                  <button onClick={handleBulkDraft} disabled={bulkDrafting} style={{ marginTop: 8, padding: 14, borderRadius: 12, fontSize: 12, fontWeight: 700, background: bulkDrafting ? '#E2E8F0' : AMBER, color: bulkDrafting ? SLATE : NAVY, border: 'none', cursor: bulkDrafting ? 'not-allowed' : 'pointer', width: '100%', textAlign: 'center' }}>
                    {bulkDrafting ? '⏳ Creating Drafts in Gmail...' : '📝 Push All to Gmail Drafts'}
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* INTEL */}
        {activeSection === 'intel' && (
          <div style={{ padding: isMobile ? 16 : '20px 24px' }}>
            {!selectedLead ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 300, color: SLATE, gap: 10 }}>
                <div style={{ fontSize: 40 }}>🔍</div>
                <div style={{ fontSize: 14, fontWeight: 600 }}>Select a lead from Pipeline</div>
              </div>
            ) : !selectedAnalysis ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 300, gap: 10 }}>
                <div style={{ fontSize: 40 }}>⏳</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: SLATE }}>
                  {selectedLead && analyzingRows.has(selectedLead.rowIndex) ? 'Analyzing lead...' : 'Not analyzed yet'}
                </div>
                <button 
                  disabled={selectedLead && analyzingRows.has(selectedLead.rowIndex)}
                  onClick={() => analyzeSingleLead(selectedLead)} 
                  style={{ 
                    padding: '10px 20px', 
                    borderRadius: 8, 
                    fontSize: 12, 
                    fontWeight: 700, 
                    background: (selectedLead && analyzingRows.has(selectedLead.rowIndex)) ? '#E2E8F0' : AMBER, 
                    color: (selectedLead && analyzingRows.has(selectedLead.rowIndex)) ? SLATE : NAVY, 
                    border: 'none', 
                    cursor: (selectedLead && analyzingRows.has(selectedLead.rowIndex)) ? 'not-allowed' : 'pointer',
                    transition: 'all 0.2s ease',
                  }}
                >
                  {selectedLead && analyzingRows.has(selectedLead.rowIndex) ? '⏳ Analyzing...' : 'Run Analysis'}
                </button>
              </div>
            ) : (
              <>
                <div style={{ background: NAVY_LIGHT, borderRadius: 16, padding: 18, marginBottom: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
                    <ScoreRing score={selectedAnalysis.score} size={68} campaignIndustry={currentCampaign?.industry} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 18, fontWeight: 900, color: 'white', marginBottom: 4 }}>{selectedLead.company}</div>
                      <div style={{ fontSize: 12, color: AMBER, marginBottom: 8 }}>{selectedLead.website}</div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <StatusBadge status={resolveStatus(selectedAnalysis)} />
                        {selectedAnalysis.sentStatus === 'sent' && (
                          <span style={{ fontSize: 10, fontWeight: 700, color: GREEN, background: GREEN_LIGHT, padding: '2px 8px', borderRadius: 20 }}>✅ SENT</span>
                        )}
                        {selectedAnalysis.sentStatus === 'failed' && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <span style={{ fontSize: 10, fontWeight: 700, color: RED, background: RED_LIGHT, padding: '2px 8px', borderRadius: 20 }}>❌ FAILED</span>
                            <span style={{ fontSize: 9, color: RED, fontWeight: 600 }}>({selectedAnalysis?.errorReason || 'Check logs'})</span>
                          </div>
                        )}
                        {selectedAnalysis.sentStatus === 'bounced' && (
                          <span style={{ fontSize: 10, fontWeight: 700, color: RED, background: RED_LIGHT, padding: '2px 8px', borderRadius: 20 }}>📬 BOUNCED</span>
                        )}
                        {selectedAnalysis.spamReported && (
                          <span style={{ fontSize: 10, fontWeight: 700, color: ORANGE, background: '#FEF3C7', padding: '2px 8px', borderRadius: 20 }}>⚠️ SPAM</span>
                        )}
                        {selectedAnalysis.crawlLayerLabel && <span style={{ fontSize: 10, color: SLATE_LIGHT, background: NAVY_BORDER, padding: '2px 8px', borderRadius: 20, fontWeight: 600 }}>{selectedAnalysis.crawlLayerLabel}</span>}
                        {selectedAnalysis.painAnalysis?.overallUrgency && <span style={{ fontSize: 10, fontWeight: 700, color: selectedAnalysis.painAnalysis.overallUrgency === 'high' ? RED : AMBER, background: selectedAnalysis.painAnalysis.overallUrgency === 'high' ? RED_LIGHT : AMBER_LIGHT, padding: '2px 8px', borderRadius: 20 }}>{selectedAnalysis.painAnalysis.overallUrgency.toUpperCase()} URGENCY</span>}
                      </div>
                    </div>
                  </div>
                </div>

                {(selectedAnalysis?.sentStatus === 'sent' || selectedAnalysis?.sentStatus === 'bounced' || selectedAnalysis?.spamReported) && (
                  <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                    {selectedAnalysis?.sentStatus === 'bounced' ? (
                      <button 
                        onClick={() => undoBounce(selectedLead.rowIndex)} 
                        style={{ flex: 1, padding: 10, borderRadius: 10, fontSize: 11, fontWeight: 700, background: '#FEE2E2', color: '#EF4444', border: '1px dashed #EF4444', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}
                      >
                        ↩ Undo Bounce
                      </button>
                    ) : (
                      selectedAnalysis?.sentStatus === 'sent' && (
                        <button 
                          onClick={() => logBounce(selectedLead.rowIndex)} 
                          style={{ flex: 1, padding: 10, borderRadius: 10, fontSize: 11, fontWeight: 700, background: '#FEE2E2', color: '#EF4444', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}
                        >
                          📬 Flag as Bounce
                        </button>
                      )
                    )}

                    {selectedAnalysis?.spamReported ? (
                      <button 
                        onClick={() => undoSpamReport(selectedLead.rowIndex)} 
                        style={{ flex: 1, padding: 10, borderRadius: 10, fontSize: 11, fontWeight: 700, background: '#FEF3C7', color: '#D97706', border: '1px dashed #D97706', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}
                      >
                        ↩ Undo Spam
                      </button>
                    ) : (
                      (selectedAnalysis?.sentStatus === 'sent' || selectedAnalysis?.sentStatus === 'bounced') && (
                        <button 
                          onClick={() => logSpamReport(selectedLead.rowIndex)} 
                          style={{ flex: 1, padding: 10, borderRadius: 10, fontSize: 11, fontWeight: 700, background: '#FEF3C7', color: '#D97706', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}
                        >
                          ⚠️ Flag as Spam
                        </button>
                      )
                    )}
                  </div>
                )}

                {selectedAnalysis.aiAnalysis && (
                  <div style={{ background: 'white', border: `1px solid ${NAVY_BORDER}`, borderRadius: 16, padding: 18, marginBottom: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                      <div style={{ width: 30, height: 30, borderRadius: '50%', background: AMBER, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15 }}>🤖</div>
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: NAVY }}>Mike's Assessment</div>
                        {selectedAnalysis.aiAnalysis.industry && <div style={{ fontSize: 10, color: SLATE }}>{selectedAnalysis.aiAnalysis.industry}</div>}
                      </div>
                    </div>
                    <p style={{ fontSize: 13, lineHeight: 1.6, color: '#374151', marginBottom: 10 }}>{selectedAnalysis.aiAnalysis.insights || selectedAnalysis.insights}</p>
                    {selectedAnalysis.aiAnalysis.primaryProblem && (
                      <div style={{ padding: '10px 14px', background: AMBER_LIGHT, borderRadius: 10, marginBottom: 8 }}>
                        <div style={{ fontSize: 9, fontWeight: 700, color: AMBER_DARK, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>Primary Problem</div>
                        <div style={{ fontSize: 12, fontWeight: 600, color: NAVY }}>{selectedAnalysis.aiAnalysis.primaryProblem}</div>
                      </div>
                    )}
                    {selectedAnalysis.painAnalysis?.primary?.outreachAngle && (
                      <div style={{ padding: '10px 14px', background: '#F8FAFC', borderRadius: 10 }}>
                        <div style={{ fontSize: 9, fontWeight: 700, color: SLATE, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>Outreach Angle</div>
                        <div style={{ fontSize: 12, color: '#374151' }}>{selectedAnalysis.painAnalysis.primary.outreachAngle}</div>
                      </div>
                    )}
                    {replyStatus[selectedLead?.rowIndex]?.hasReplied && (
                      <div style={{ padding: '10px 14px', background: BLUE_LIGHT, borderRadius: 10, marginTop: 8 }}>
                        <div style={{ fontSize: 9, fontWeight: 700, color: BLUE, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>Reply Detected</div>
                        <div style={{ fontSize: 12, color: '#374151' }}>
                          This lead replied to your outreach on {replyStatus[selectedLead.rowIndex].lastChecked ? new Date(replyStatus[selectedLead.rowIndex].lastChecked!).toLocaleDateString() : 'recently'}.
                          {replyStatus[selectedLead.rowIndex].replyCount > 1 && ` (${replyStatus[selectedLead.rowIndex].replyCount} total replies)`}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {selectedAnalysis.seoData && (
                  <div style={{ background: 'white', border: `1px solid ${NAVY_BORDER}`, borderRadius: 16, padding: 18, marginBottom: 12 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: SLATE, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>SEO Signals</div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                      <SignalPill label="Blog Present" good={selectedAnalysis.seoData.hasBlog} />
                      <SignalPill label="Search Console" good={selectedAnalysis.seoData.hasSearchConsole} />
                      <SignalPill label="Meta Description" good={!!selectedAnalysis.seoData.description} />
                      <SignalPill label="HTTPS" good={selectedAnalysis.seoData.hasHttps} />
                      <SignalPill label="Schema Markup" good={selectedAnalysis.seoData.hasSchema} />
                      <SignalPill label="Open Graph" good={selectedAnalysis.seoData.hasOpenGraph} />
                    </div>
                  </div>
                )}

                {selectedAnalysis.seoData?.psiScores && (
                  <div style={{ background: 'white', border: `1px solid ${NAVY_BORDER}`, borderRadius: 16, padding: 18, marginBottom: 12 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: SLATE, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>Google PageSpeed</div>
                    <PSIBar label="SEO" score={selectedAnalysis.seoData.psiScores.seo} />
                    <PSIBar label="Performance" score={selectedAnalysis.seoData.psiScores.performance} />
                    <PSIBar label="Accessibility" score={selectedAnalysis.seoData.psiScores.accessibility} />
                    <PSIBar label="Best Practices" score={selectedAnalysis.seoData.psiScores.bestPractices} />
                  </div>
                )}

                {selectedAnalysis.details?.problems?.length > 0 && (
                  <div style={{ background: 'white', border: `1px solid ${NAVY_BORDER}`, borderRadius: 16, padding: 18, marginBottom: 12 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: SLATE, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>Problems Found ({selectedAnalysis.details.problems.length})</div>
                    {selectedAnalysis.details.problems.map((p: string, i: number) => (
                      <div key={i} style={{ display: 'flex', gap: 10, padding: '8px 0', borderBottom: i < selectedAnalysis.details.problems.length - 1 ? '1px solid #F8FAFC' : 'none' }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: AMBER, fontFamily: 'monospace', minWidth: 22 }}>#{i+1}</span>
                        <span style={{ fontSize: 12, color: '#374151' }}>{p}</span>
                      </div>
                    ))}
                  </div>
                )}

                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => setActiveSection('emails')} style={{ flex: 1, padding: 12, borderRadius: 10, fontSize: 12, fontWeight: 700, background: AMBER, color: NAVY, border: 'none', cursor: 'pointer' }}>View Emails ✉️</button>
                  <button 
                    disabled={selectedLead && analyzingRows.has(selectedLead.rowIndex)}
                    onClick={() => analyzeSingleLead(selectedLead)} 
                    style={{ 
                      padding: '12px 14px', 
                      borderRadius: 10, 
                      fontSize: 12, 
                      fontWeight: 700, 
                      background: (selectedLead && analyzingRows.has(selectedLead.rowIndex)) ? '#F1F5F9' : 'white', 
                      border: `1px solid ${NAVY_BORDER}`, 
                      color: SLATE, 
                      cursor: (selectedLead && analyzingRows.has(selectedLead.rowIndex)) ? 'wait' : 'pointer',
                      transition: 'all 0.2s ease'
                    }}
                  >
                    {selectedLead && analyzingRows.has(selectedLead.rowIndex) ? '⏳' : '🔄'}
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* EMAILS */}
        {activeSection === 'emails' && (
          <div style={{ padding: isMobile ? 16 : '20px 24px' }}>
            {!selectedLead ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 300, color: SLATE, gap: 10 }}>
                <div style={{ fontSize: 40 }}>✉️</div>
                <div style={{ fontSize: 14, fontWeight: 600 }}>Select a lead from Pipeline</div>
              </div>
            ) : (!selectedAnalysis?.initialEmail?.body && !selectedAnalysis?.aiAnalysis?.initialEmail?.body) ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 300, gap: 10 }}>
                <div style={{ fontSize: 40 }}>✉️</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: SLATE }}>No emails generated yet</div>
                <button onClick={() => analyzeSingleLead(selectedLead)} style={{ padding: '10px 20px', borderRadius: 8, fontSize: 12, fontWeight: 700, background: AMBER, color: NAVY, border: 'none', cursor: 'pointer' }}>Generate Emails</button>
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
                  <div>
                    <div style={{ fontSize: 16, fontWeight: 900, color: NAVY }}>{selectedLead.company}</div>
                    <div style={{ fontSize: 11, color: SLATE }}>4-touch outreach sequence</div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button onClick={() => handleCreateDraft(selectedLead)} style={{ padding: '7px 12px', borderRadius: 8, fontSize: 11, fontWeight: 700, background: BLUE_LIGHT, color: BLUE, border: 'none', cursor: 'pointer' }}>📝 Save Draft</button>
                    <button onClick={() => { setTestLead(selectedLead); setShowTestModal(true); }} style={{ padding: '7px 12px', borderRadius: 8, fontSize: 11, fontWeight: 700, background: GREEN_LIGHT, color: GREEN, border: 'none', cursor: 'pointer' }}>🧪 Send Test</button>
                    <button 
                      onClick={() => {
                        const emailBody = selectedAnalysis?.initialEmail?.body || selectedAnalysis?.aiAnalysis?.initialEmail?.body;
                        const emailSubject = selectedAnalysis?.initialEmail?.subject || selectedAnalysis?.aiAnalysis?.initialEmail?.subject;
                        if (emailBody) {
                          setPreviewModal({
                            isOpen: true,
                            subject: emailSubject || '',
                            body: emailBody,
                            recipientName: selectedLead?.recipient,
                            leadCompany: selectedLead?.company,
                          });
                        } else {
                          toast.error('No email body to preview');
                        }
                      }}
                      style={{ padding: '7px 12px', borderRadius: 8, fontSize: 11, fontWeight: 700, background: COLORS.amberLight, color: COLORS.amberDark, border: 'none', cursor: 'pointer' }}
                    >
                      👁️ Preview Email
                    </button>
                    <button onClick={saveCurrentEmailAsTemplate} style={{ padding: '7px 12px', borderRadius: 8, fontSize: 11, fontWeight: 700, background: '#E0E7FF', color: '#3730A3', border: 'none', cursor: 'pointer' }}>
                      💾 Save as Template
                    </button>
                    <select value="" onChange={e => { if (e.target.value) loadTemplate(e.target.value); }} style={{ padding: '7px 12px', borderRadius: 8, fontSize: 11, fontWeight: 700, background: 'white', border: `1px solid ${NAVY_BORDER}`, cursor: 'pointer', outline: 'none', color: NAVY }}>
                      <option value="">📋 Load Template</option>
                      {templates.map(t => (
                        <option key={t.id} value={t.id}>{t.name}</option>
                      ))}
                    </select>
                  </div>
                </div>

                {(selectedAnalysis?.subjectLines?.length > 0 || selectedAnalysis?.aiAnalysis?.subjectLines?.length > 0) && (
                  <div style={{ background: 'white', border: `1px solid ${NAVY_BORDER}`, borderRadius: 16, padding: 16, marginBottom: 14 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: SLATE, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>Subject Line Options</div>
                    {(selectedAnalysis?.subjectLines || selectedAnalysis?.aiAnalysis?.subjectLines || []).map((line: string, i: number) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 10px', background: '#F8FAFC', borderRadius: 8, marginBottom: 6 }}>
                        <span style={{ fontSize: 12, color: NAVY, flex: 1, marginRight: 8 }}>{line}</span>
                        <CopyBtn text={line} />
                      </div>
                    ))}
                  </div>
                )}

                <div style={{ background: NAVY_LIGHT, borderRadius: 16, padding: 16, marginBottom: 14 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: AMBER, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 12 }}>Send Schedule  {campaignCountry}</div>
                  {Object.entries(schedule).map(([label, item]: any) => (
                    <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                      <div style={{ width: 7, height: 7, borderRadius: '50%', background: AMBER, flexShrink: 0 }} />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: 'white' }}>{label}</div>
                        <div style={{ fontSize: 10, color: SLATE_LIGHT }}>{item.date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}  9-11 AM</div>
                      </div>
                      <span style={{ fontSize: 10, color: SLATE_LIGHT }}>{item.day}</span>
                    </div>
                  ))}
                </div>

                <EmailBlock 
                  label="Initial Email" 
                  body={selectedAnalysis?.initialEmail?.body || selectedAnalysis?.aiAnalysis?.initialEmail?.body || ''} 
                  subject={selectedAnalysis?.initialEmail?.subject || selectedAnalysis?.aiAnalysis?.initialEmail?.subject} 
                  onSave={handleSaveInitialEmail}
                  onPreview={() => setPreviewModal({
                    isOpen: true,
                    subject: selectedAnalysis?.initialEmail?.subject || selectedAnalysis?.aiAnalysis?.initialEmail?.subject || '',
                    body: selectedAnalysis?.initialEmail?.body || selectedAnalysis?.aiAnalysis?.initialEmail?.body || '',
                    recipientName: selectedLead?.recipient,
                    leadCompany: selectedLead?.company,
                  })}
                  lead={selectedLead}
                />
                {hasReplied && (
                  <div style={{ background: BLUE_LIGHT, padding: 12, borderRadius: 12, marginBottom: 14 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: BLUE, marginBottom: 4 }}>💬 Lead Replied</div>
                    <div style={{ fontSize: 11, color: '#374151' }}>
                      This lead has already replied to your outreach. Follow-up emails will not be sent automatically.
                    </div>
                  </div>
                )}
                <EmailBlock
                  label="Follow Up 1"
                  day="Day 3"
                  body={selectedAnalysis?.followUp1?.body || selectedAnalysis?.aiAnalysis?.followUp1?.body || selectedAnalysis?.followUp1 || selectedAnalysis?.aiAnalysis?.followUp1 || ''}
                  subject={selectedAnalysis?.followUp1?.subject || selectedAnalysis?.aiAnalysis?.followUp1?.subject}
                  onSave={(newBody) => handleSaveFollowUp('followUp1', newBody)}
                  onPreview={() => setPreviewModal({
                    isOpen: true,
                    subject: selectedAnalysis?.followUp1?.subject || selectedAnalysis?.aiAnalysis?.followUp1?.subject || (selectedAnalysis?.initialEmail?.subject ? `Re: ${selectedAnalysis.initialEmail.subject}` : selectedAnalysis?.aiAnalysis?.initialEmail?.subject ? `Re: ${selectedAnalysis.aiAnalysis.initialEmail.subject}` : 'Follow Up 1'),
                    body: selectedAnalysis?.followUp1?.body || selectedAnalysis?.aiAnalysis?.followUp1?.body || selectedAnalysis?.followUp1 || selectedAnalysis?.aiAnalysis?.followUp1 || '',
                    recipientName: selectedLead?.recipient,
                    leadCompany: selectedLead?.company,
                  })}
                  lead={selectedLead}
                />
                {!hasReplied && (
                  <>
                    <EmailBlock
                      label="Follow Up 2"
                      day="Day 10"
                      body={selectedAnalysis?.followUp2?.body || selectedAnalysis?.aiAnalysis?.followUp2?.body || selectedAnalysis?.followUp2 || selectedAnalysis?.aiAnalysis?.followUp2 || ''}
                      subject={selectedAnalysis?.followUp2?.subject || selectedAnalysis?.aiAnalysis?.followUp2?.subject}
                      onSave={(newBody) => handleSaveFollowUp('followUp2', newBody)}
                      onPreview={() => setPreviewModal({
                        isOpen: true,
                        subject: selectedAnalysis?.followUp2?.subject || selectedAnalysis?.aiAnalysis?.followUp2?.subject || (selectedAnalysis?.initialEmail?.subject ? `Re: ${selectedAnalysis.initialEmail.subject}` : selectedAnalysis?.aiAnalysis?.initialEmail?.subject ? `Re: ${selectedAnalysis.aiAnalysis.initialEmail.subject}` : 'Follow Up 2'),
                        body: selectedAnalysis?.followUp2?.body || selectedAnalysis?.aiAnalysis?.followUp2?.body || selectedAnalysis?.followUp2 || selectedAnalysis?.aiAnalysis?.followUp2 || '',
                        recipientName: selectedLead?.recipient,
                        leadCompany: selectedLead?.company,
                      })}
                      lead={selectedLead}
                    />
                    <EmailBlock
                      label="Follow Up 3"
                      day="Day 17"
                      body={selectedAnalysis?.followUp3?.body || selectedAnalysis?.aiAnalysis?.followUp3?.body || selectedAnalysis?.followUp3 || selectedAnalysis?.aiAnalysis?.followUp3 || ''}
                      subject={selectedAnalysis?.followUp3?.subject || selectedAnalysis?.aiAnalysis?.followUp3?.subject}
                      onSave={(newBody) => handleSaveFollowUp('followUp3', newBody)}
                      onPreview={() => setPreviewModal({
                        isOpen: true,
                        subject: selectedAnalysis?.followUp3?.subject || selectedAnalysis?.aiAnalysis?.followUp3?.subject || (selectedAnalysis?.initialEmail?.subject ? `Re: ${selectedAnalysis.initialEmail.subject}` : selectedAnalysis?.aiAnalysis?.initialEmail?.subject ? `Re: ${selectedAnalysis.aiAnalysis.initialEmail.subject}` : 'Follow Up 3'),
                        body: selectedAnalysis?.followUp3?.body || selectedAnalysis?.aiAnalysis?.followUp3?.body || selectedAnalysis?.followUp3 || selectedAnalysis?.aiAnalysis?.followUp3 || '',
                        recipientName: selectedLead?.recipient,
                        leadCompany: selectedLead?.company,
                      })}
                      lead={selectedLead}
                    />
                  </>
                )}
              </>
            )}
          </div>
        )}

        {/* REPORTS */}
        {activeSection === 'reports' && (
          <div style={{ padding: isMobile ? 16 : '20px 24px' }}>
            <div style={{ background: NAVY_LIGHT, borderRadius: 16, padding: 18, marginBottom: 16 }}>
              <div style={{ fontSize: 9, color: AMBER, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>Campaign Report</div>
              <div style={{ fontSize: 18, fontWeight: 900, color: 'white', marginBottom: 12 }}>{campaignName}</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 10 }}>
                {[
                  ['Total Leads', leads.length, 'white'], 
                  ['Needs Email', needsEmailCount, needsEmailCount > 0 ? '#EAB308' : 'white'],
                  ['Analyzed', analyzedCount, AMBER], 
                  ['Hot Leads', hotLeads, RED], 
                  ['Sent', sentCount, GREEN],
                  ['Replied', repliedCount, BLUE],
                  ['Remaining', notSentCount, ORANGE]
                ].map(([l, v, c]) => (
                  <div key={String(l)} style={{ background: NAVY_BORDER, borderRadius: 10, padding: 12, textAlign: 'center' }}>
                    <div style={{ fontSize: 22, fontWeight: 900, color: String(c), fontFamily: 'monospace' }}>{String(v)}</div>
                    <div style={{ fontSize: 9, color: SLATE_LIGHT, textTransform: 'uppercase' }}>{String(l)}</div>
                  </div>
                ))}
              </div>
            </div>
            <div style={{ background: 'white', border: `1px solid ${NAVY_BORDER}`, borderRadius: 16, overflow: 'hidden' }}>
              <div style={{ padding: '14px 18px', borderBottom: `1px solid ${NAVY_BORDER}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: SLATE, textTransform: 'uppercase', letterSpacing: '0.05em' }}>All Leads</div>
                <button onClick={exportCampaignToCSV} style={{ padding: '6px 12px', borderRadius: 6, fontSize: 10, fontWeight: 700, background: NAVY_LIGHT, color: 'white', border: 'none', cursor: 'pointer' }}>⬇️ Export CSV</button>
              </div>
              {leads.map((lead, i) => {
                const a = analyzedLeads[lead.rowIndex];
                return (
                  <div key={lead.rowIndex} onClick={() => { setSelectedLead(lead); setActiveSection('intel'); }}
                    style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 18px', borderBottom: i < leads.length - 1 ? '1px solid #F8FAFC' : 'none', cursor: 'pointer' }}>
                    {a ? <ScoreRing score={a.score} size={38} campaignIndustry={currentCampaign?.industry} /> : <div style={{ width: 38, height: 38, borderRadius: '50%', background: '#F1F5F9', flexShrink: 0 }} />}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: NAVY }}>{lead.company}</div>
                      <div style={{ fontSize: 10, color: SLATE, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a?.aiAnalysis?.primaryProblem || 'Not analyzed'}</div>
                    </div>
                    {a ? <StatusBadge status={resolveStatus(a)} /> : <span style={{ fontSize: 10, color: SLATE_LIGHT }}>Pending</span>}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* SCHEDULE */}
        {activeSection === 'schedule' && (
          <div style={{ padding: isMobile ? 16 : '20px 24px' }}>
            <div style={{ background: NAVY_LIGHT, borderRadius: 16, padding: 18, marginBottom: 16 }}>
              <div style={{ fontSize: 9, color: AMBER, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>Due Today</div>
              <div style={{ fontSize: 18, fontWeight: 900, color: 'white', marginBottom: 2 }}>{new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}</div>
              <div style={{ fontSize: 12, color: SLATE_LIGHT }}>Send window: {currentCampaign?.scheduleStartTime || '09:00'} - {currentCampaign?.scheduleEndTime || '11:00'}  {campaignCountry}</div>
            </div>
            <div style={{ background: 'white', border: `1px solid ${NAVY_BORDER}`, borderRadius: 16, padding: 18, marginTop: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: SLATE, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>Target Country</div>
              <select value={campaignCountry || ''} onChange={e => setCampaignCountry(e.target.value)}
                style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: `1px solid ${NAVY_BORDER}`, fontSize: 12, color: NAVY, background: 'white', marginBottom: 10 }}>
                {['United Kingdom','United States','Nigeria','Canada','Australia','South Africa','Ghana','Kenya','India','Germany','France','Other'].map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              <div style={{ padding: '12px 14px', background: AMBER_LIGHT, borderRadius: 10, fontSize: 12, color: NAVY }}>
                ✉️ Emails send between <strong>{currentCampaign?.scheduleStartTime || '09:00'} - {currentCampaign?.scheduleEndTime || '11:00'} AM</strong> local time in <strong>{campaignCountry}</strong> with randomised delays.
              </div>
            </div>
            <div style={{ background: 'white', border: `1px solid ${NAVY_BORDER}`, borderRadius: 16, padding: 18, marginTop: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: SLATE, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>Daily Sending Limit</div>
              <input 
                type="number" 
                min="1" 
                max="500" 
                value={dailyLimit !== undefined && dailyLimit !== null && !isNaN(dailyLimit) ? dailyLimit : ''} 
                onChange={e => setCampaignDailyLimit(Math.max(1, Math.min(500, parseInt(e.target.value) || 1)))}
                style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: `1px solid ${NAVY_BORDER}`, fontSize: 12, color: NAVY, boxSizing: 'border-box', marginBottom: 10, background: 'white' }} 
              />
              <div style={{ padding: '12px 14px', background: '#F1F5F9', borderRadius: 10, fontSize: 11, color: SLATE, lineHeight: 1.5 }}>
                ℹ️ Gmail allows up to 500 per day but 50 to 100 is the safe recommended range for cold outreach.
              </div>
            </div>

            <div style={{ background: 'white', border: `1px solid ${NAVY_BORDER}`, borderRadius: 16, padding: 18, marginTop: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: SLATE, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>Sending Window (Local Time)</div>
              <div style={{ display: 'flex', gap: 12, marginBottom: 10 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 10, color: SLATE, marginBottom: 4 }}>Start Time</div>
                  <input 
                    type="time" 
                    value={currentCampaign?.scheduleStartTime || '09:00'} 
                    onChange={e => setCampaignScheduleStartTime(e.target.value)}
                    style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: `1px solid ${NAVY_BORDER}`, fontSize: 12, color: NAVY, background: 'white' }} 
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 10, color: SLATE, marginBottom: 4 }}>End Time</div>
                  <input 
                    type="time" 
                    value={currentCampaign?.scheduleEndTime || '11:00'} 
                    onChange={e => setCampaignScheduleEndTime(e.target.value)}
                    style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: `1px solid ${NAVY_BORDER}`, fontSize: 12, color: NAVY, background: 'white' }} 
                  />
                </div>
              </div>
              <div style={{ padding: '12px 14px', background: '#F1F5F9', borderRadius: 10, fontSize: 11, color: SLATE, lineHeight: 1.5 }}>
                ℹ️ System will automatically queue and pace cold outreach sends within this window in the target campaign's timezone.
              </div>
            </div>

            <div style={{ background: 'white', border: `1px solid ${NAVY_BORDER}`, borderRadius: 16, padding: 18, marginTop: 16 }}>
              {!currentCampaign?.senderAccountId && (
                <div style={{ padding: '12px 14px', background: '#FEE2E2', border: '1px solid #FCA5A5', borderRadius: 10, fontSize: 12, color: RED, fontWeight: 700, marginBottom: 14 }}>
                  ⚠️ No sender account set for this campaign — nothing will send until you pick one below.
                </div>
              )}
              {currentCampaign?.senderAccountId && !connectedAccounts.some(acc => acc.email === currentCampaign.senderAccountId) && (
                <div style={{ padding: '12px 14px', background: '#FEE2E2', border: '1px solid #FCA5A5', borderRadius: 10, fontSize: 12, color: '#991B1B', fontWeight: 600, marginBottom: 14, lineHeight: 1.4 }}>
                  ⚠️ This campaign's sender account ({currentCampaign.senderAccountId}) is disconnected. Reconnect it to resume sending.
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: SLATE, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Campaign Sender Account</div>
                <button onClick={() => setShowAccountManager(true)} style={{ color: BLUE, background: 'none', border: 'none', fontSize: 11, fontWeight: 700, cursor: 'pointer', padding: 0 }}>
                  Manage Accounts
                </button>
              </div>
              {sentCount > 0 && currentCampaign?.senderAccountId ? (
                <div style={{ padding: '10px 14px', borderRadius: 8, border: `1px solid ${NAVY_BORDER}`, background: '#F8FAFC', fontSize: 13, color: NAVY, marginBottom: 10 }}>
                  {currentCampaign?.senderAccountId}
                  <div style={{ fontSize: 10, color: SLATE, marginTop: 4 }}>
                    Locked — this campaign has already sent from this account. Changing it now would break follow-up threading for leads already contacted.
                  </div>
                </div>
              ) : (
                <>
                  {sentCount > 0 && !currentCampaign?.senderAccountId && (
                    <div style={{ padding: '12px 14px', background: '#FFFBEB', border: '1px solid #FCD34D', borderRadius: 10, fontSize: 12, color: '#92400E', fontWeight: 600, marginBottom: 14, lineHeight: 1.4 }}>
                      ⚠️ This campaign has already sent emails but has no sender account recorded. Selecting one now won't retroactively fix which account sent past emails, but will determine which account sends all future follow-ups for it. Choose the account that was actually used previously if you know it, to keep the thread ID valid — otherwise Gmail will show broken/orphaned reply threads for leads already contacted.
                    </div>
                  )}
                  <select 
                    value={currentCampaign?.senderAccountId || ''} 
                    onChange={e => setCampaignSenderAccountId(e.target.value)}
                    style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: `1px solid ${NAVY_BORDER}`, fontSize: 12, color: NAVY, background: 'white', marginBottom: 10 }}
                  >
                    <option value="">-- Select an account (required) --</option>
                    {connectedAccounts.map(acc => (
                      <option key={acc.email} value={acc.email}>{acc.email}</option>
                    ))}
                  </select>
                </>
              )}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button 
                  onClick={async () => {
                    try {
                      const res = await fetch('/api/auth/google/url?type=additional');
                      const data = await res.json();
                      if (data.url) {
                        const h = 600;
                        const w = 500;
                        const left = (window.innerWidth / 2) - (w / 2);
                        const top = (window.innerHeight / 2) - (h / 2);
                        window.open(data.url, 'google_auth', `width=${w},height=${h},top=${top},left=${left}`);
                      }
                    } catch (e) {
                      toast.error('Could not generate signup URL');
                    }
                  }} 
                  style={{ flex: 1, padding: '10px 12px', borderRadius: 8, border: `1px solid ${NAVY_BORDER}`, fontSize: 11, fontWeight: 700, background: '#F8FAFC', color: NAVY, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                >
                  ➕ Connect Another Gmail Account
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* MOBILE BOTTOM NAV */}
      {isMobile && (
        <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, background: NAVY, display: 'flex', justifyContent: 'space-around', padding: '8px 0 10px', borderTop: `1px solid ${NAVY_BORDER}`, zIndex: 100 }}>
          {navItems.map(item => (
            <button key={item.id} onClick={() => setActiveSection(item.id as any)}
              style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, background: 'none', border: 'none', cursor: 'pointer', padding: '2px 8px' }}>
              <span style={{ fontSize: 18 }}>{item.icon}</span>
              <span style={{ fontSize: 9, fontWeight: 700, color: activeSection === item.id ? AMBER : SLATE_LIGHT, textTransform: 'uppercase' }}>{item.label}</span>
            </button>
          ))}
        </div>
      )}

      {/* MIKE PANEL */}
      {mikeOpen && (
        <div style={{ position: 'fixed', bottom: isMobile ? 76 : 24, right: 16, width: isMobile ? 'calc(100% - 32px)' : 380, height: 560, background: '#FFFFFF', border: `1px solid ${NAVY_BORDER}`, borderRadius: 20, boxShadow: '0 24px 80px rgba(0,0,0,0.18)', display: 'flex', flexDirection: 'column', zIndex: 1000, overflow: 'hidden' }}>

          {/* HEADER */}
          <div style={{ padding: '12px 16px', background: NAVY, borderRadius: '20px 20px 0 0', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 34, height: 34, borderRadius: '50%', background: AMBER, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, flexShrink: 0 }}>🤖</div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 800, color: '#FFFFFF', letterSpacing: '0.01em' }}>Mike</div>
                <div style={{ fontSize: 10, color: '#64748B', marginTop: 1 }}>SEO Strategist AI</div>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <select value={mikeModel || ''} onChange={e => setMikeModel(e.target.value)}
                style={{ fontSize: 10, padding: '4px 8px', borderRadius: 8, border: `1px solid #1E293B`, background: '#111827', color: '#94A3B8', cursor: 'pointer', outline: 'none' }}>
                <option value="gemini-flash">Gemini Flash</option>
                <option value="gemini-pro">Gemini Pro</option>
                <option value="gpt4o-mini">GPT-4o Mini</option>
              </select>
              <button onClick={() => setMikeOpen(false)} style={{ background: 'none', border: 'none', color: '#64748B', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: 2 }}>✕</button>
            </div>
          </div>

          {/* MESSAGES */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '16px 14px', display: 'flex', flexDirection: 'column', gap: 12, background: '#F8FAFC' }}>
            {mikeMessages.map((msg: any, i: number) => {
              const isUser = msg.role === 'user';
              const isProactive = msg.proactive === true;

              // Strip markdown symbols for clean plain text display
              const cleanContent = (msg.content || '')
                .replace(/\*\*(.+?)\*\*/g, '$1')
                .replace(/\*(.+?)\*/g, '$1')
                .replace(/#{1,3}\s/g, '')
                .replace(/^\s*[-*]\s/gm, '• ')
                .replace(/—/g, ',');

              return (
                <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: isUser ? 'flex-end' : 'flex-start', gap: 2 }}>
                  {!isUser && (
                    <div style={{ fontSize: 9, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.06em', paddingLeft: 4 }}>
                      {isProactive ? 'Mike — Just now' : 'Mike'}
                    </div>
                  )}
                  <div style={{
                    maxWidth: '86%',
                    padding: '10px 14px',
                    borderRadius: isUser ? '16px 16px 4px 16px' : '4px 16px 16px 16px',
                    background: isUser ? AMBER : '#FFFFFF',
                    color: isUser ? NAVY : '#1E293B',
                    fontSize: 12.5,
                    lineHeight: 1.65,
                    whiteSpace: 'pre-wrap',
                    boxShadow: isUser ? 'none' : '0 1px 4px rgba(0,0,0,0.07)',
                    border: isUser ? 'none' : `1px solid #E2E8F0`,
                    fontWeight: isUser ? 500 : 400,
                  }}>
                    {cleanContent}
                  </div>
                </div>
              );
            })}
            {mikeLoading && (
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <div style={{ padding: '10px 14px', borderRadius: '4px 16px 16px 16px', background: '#FFFFFF', border: '1px solid #E2E8F0', boxShadow: '0 1px 4px rgba(0,0,0,0.07)', display: 'flex', gap: 4, alignItems: 'center' }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: AMBER, display: 'inline-block', animation: 'pulse 1s infinite' }} />
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: AMBER, display: 'inline-block', animation: 'pulse 1s infinite 0.2s', opacity: 0.7 }} />
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: AMBER, display: 'inline-block', animation: 'pulse 1s infinite 0.4s', opacity: 0.4 }} />
                </div>
              </div>
            )}
            <div ref={mikeEndRef} />
          </div>

          {/* QUICK CHIPS */}
          <div style={{ padding: '8px 14px 4px', display: 'flex', gap: 6, overflowX: 'auto', background: '#F8FAFC', flexShrink: 0, borderTop: '1px solid #E2E8F0' }}>
            {[
              selectedLead ? `Rewrite email for ${selectedLead.company}` : 'Rewrite email',
              'Who should I contact first?',
              'Which follow-ups are overdue?',
              'Give me an outreach tip',
            ].map((a: string) => (
              <button key={a} onClick={() => setMikeInput(a)}
                style={{ padding: '5px 11px', borderRadius: 20, fontSize: 10, fontWeight: 600, background: '#FFFFFF', color: AMBER_DARK, border: `1px solid ${AMBER}`, cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0, transition: 'background 0.15s' }}>
                {a}
              </button>
            ))}
          </div>

          {/* INPUT */}
          <div style={{ padding: '10px 14px 14px', background: '#FFFFFF', borderTop: '1px solid #E2E8F0', display: 'flex', gap: 8, flexShrink: 0, alignItems: 'center' }}>
            <input
              value={mikeInput || ''}
              onChange={e => setMikeInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleMikeMessage()}
              placeholder="Ask Mike anything..."
              style={{ flex: 1, padding: '9px 13px', borderRadius: 10, border: `1px solid #E2E8F0`, fontSize: 12.5, outline: 'none', color: NAVY, background: '#F8FAFC', transition: 'border 0.15s' }}
              onFocus={e => e.target.style.borderColor = AMBER}
              onBlur={e => e.target.style.borderColor = '#E2E8F0'}
            />
            <button
              onClick={handleMikeMessage}
              disabled={mikeLoading || !mikeInput?.trim()}
              style={{ width: 36, height: 36, borderRadius: 10, background: mikeLoading || !mikeInput?.trim() ? '#E2E8F0' : AMBER, color: mikeLoading || !mikeInput?.trim() ? '#94A3B8' : NAVY, border: 'none', cursor: mikeLoading || !mikeInput?.trim() ? 'default' : 'pointer', fontWeight: 900, fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'background 0.15s' }}>
              ↑
            </button>
          </div>

        </div>
      )}

      {/* COLUMN MAPPER */}
      {showMapper && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 3000, padding: 16 }}>
          <div style={{ background: 'white', borderRadius: 20, padding: 28, width: '100%', maxWidth: 480, maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ fontSize: 18, fontWeight: 900, color: NAVY, marginBottom: 4 }}>Map Your Columns</div>
            <div style={{ fontSize: 12, color: SLATE, marginBottom: 20 }}>{pendingRows.length} rows loaded. Match your columns to the required fields.</div>
            {(['company', 'website', 'email', 'recipient'] as const).map(field => (
              <div key={field} style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 11, fontWeight: 700, color: SLATE, display: 'block', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  {field === 'website' ? '🔗 Website URL (required)' : field.charAt(0).toUpperCase() + field.slice(1)}
                </label>
                <select value={(mapping as any)[field] || ''} onChange={e => setMapping(prev => ({ ...prev, [field]: e.target.value }))}
                  style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: `1px solid ${field === 'website' && !mapping.website ? RED : '#E2E8F0'}`, fontSize: 12, color: NAVY, background: 'white' }}>
                  <option value="">-- Not mapped --</option>
                  {detectedHeaders.map((h: string) => <option key={h} value={h}>{h}</option>)}
                </select>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => setShowMapper(false)} style={{ flex: 1, padding: 12, borderRadius: 10, fontSize: 12, fontWeight: 700, background: '#F1F5F9', color: SLATE, border: 'none', cursor: 'pointer' }}>Cancel</button>
              <button onClick={() => finalizeMapping()} style={{ flex: 2, padding: 12, borderRadius: 10, fontSize: 12, fontWeight: 700, background: AMBER, color: NAVY, border: 'none', cursor: 'pointer' }}>Confirm Mapping</button>
            </div>
          </div>
        </div>
      )}

      {/* DUPLICATE MODAL */}
      {showDuplicateModal && duplicateCheck && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 3100, padding: 16 }}>
          <div style={{ background: 'white', borderRadius: 20, padding: 28, width: '100%', maxWidth: 440 }}>
            <div style={{ fontSize: 18, fontWeight: 900, color: NAVY, marginBottom: 8 }}>⚠️ Leads Already Contacted</div>
            <div style={{ fontSize: 13, color: SLATE, marginBottom: 16, lineHeight: 1.5 }}>
              {duplicateCheck.count} lead{duplicateCheck.count === 1 ? '' : 's'} in this import already received a sent email in {duplicateCheck.campaignNames.length ? duplicateCheck.campaignNames.join(', ') : 'another campaign'}. Do you want them to be part of this campaign too?
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => handleDuplicateDecision(false)} style={{ flex: 1, padding: 12, borderRadius: 10, fontSize: 12, fontWeight: 700, background: '#FEE2E2', color: RED, border: 'none', cursor: 'pointer' }}>No, exclude them</button>
              <button onClick={() => handleDuplicateDecision(true)} style={{ flex: 1, padding: 12, borderRadius: 10, fontSize: 12, fontWeight: 700, background: AMBER, color: NAVY, border: 'none', cursor: 'pointer' }}>Yes, include them</button>
            </div>
          </div>
        </div>
      )}

      {/* LEAD REVIEW MODAL */}
      {showLeadReview && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 3050, padding: 16 }}>
          <div style={{ background: 'white', borderRadius: 20, padding: 28, width: '100%', maxWidth: 560, maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}>
            <div style={{ fontSize: 18, fontWeight: 900, color: NAVY, marginBottom: 4 }}>Review Leads Before Import</div>
            <div style={{ fontSize: 12, color: SLATE, marginBottom: 16 }}>{reviewLeads.length} lead{reviewLeads.length === 1 ? '' : 's'} ready. Remove any you don't want before analysis starts.</div>
            <div style={{ flex: 1, overflowY: 'auto', border: '1px solid #E2E8F0', borderRadius: 10 }}>
              {reviewLeads.map(l => (
                <div key={l._reviewId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', borderBottom: '1px solid #F1F5F9' }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: NAVY, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.company || l.website}</div>
                    <div style={{ fontSize: 11, color: SLATE, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.website}{l.email ? ` · ${l.email}` : ''}</div>
                  </div>
                  <button onClick={() => removeReviewLead(l._reviewId)} title="Remove this lead" style={{ background: '#FEE2E2', color: RED, border: 'none', borderRadius: 8, width: 28, height: 28, cursor: 'pointer', fontWeight: 900, flexShrink: 0, marginLeft: 8 }}>&times;</button>
                </div>
              ))}
              {reviewLeads.length === 0 && (
                <div style={{ padding: 20, textAlign: 'center', fontSize: 12, color: SLATE }}>No leads left. Cancel and re-import.</div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button onClick={() => { setShowLeadReview(false); setReviewLeads([]); }} style={{ flex: 1, padding: 12, borderRadius: 10, fontSize: 12, fontWeight: 700, background: '#F1F5F9', color: SLATE, border: 'none', cursor: 'pointer' }}>Cancel</button>
              <button onClick={confirmLeadImport} disabled={reviewLeads.length === 0} style={{ flex: 2, padding: 12, borderRadius: 10, fontSize: 12, fontWeight: 700, background: AMBER, color: NAVY, border: 'none', cursor: reviewLeads.length === 0 ? 'not-allowed' : 'pointer', opacity: reviewLeads.length === 0 ? 0.5 : 1 }}>Import {reviewLeads.length} Lead{reviewLeads.length === 1 ? '' : 's'} & Analyze</button>
            </div>
          </div>
        </div>
      )}

      {/* TEST MODAL */}
      {showTestModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000, padding: 16 }}>
          <div style={{ background: 'white', borderRadius: 20, padding: 24, width: '100%', maxWidth: 400, maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: NAVY, marginBottom: 4 }}>🧪 Send Test Email</div>
            <div style={{ fontSize: 12, color: SLATE, marginBottom: 16 }}>Send the initial email to yourself to preview how it looks in a real inbox.</div>
            <input value={testEmailTo || ''} onChange={e => setTestEmailTo(e.target.value)} placeholder="your@email.com"
              style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: `1px solid ${NAVY_BORDER}`, fontSize: 12, marginBottom: 12, boxSizing: 'border-box' }} />
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => setShowTestModal(false)} style={{ flex: 1, padding: 10, borderRadius: 8, fontSize: 12, fontWeight: 700, background: '#F1F5F9', color: SLATE, border: 'none', cursor: 'pointer' }}>Cancel</button>
              <button onClick={handleSendTest} style={{ flex: 2, padding: 10, borderRadius: 8, fontSize: 12, fontWeight: 700, background: AMBER, color: NAVY, border: 'none', cursor: 'pointer' }}>Send Test 🧪</button>
            </div>
          </div>
        </div>
      )}

      {/* FLOATING DEBUG BUTTON (ADDITION 1) wrapped in environment check */}
      {process.env.NODE_ENV !== 'production' && (
        <>
          <button 
            onClick={() => {
              setDebugOpen(true);
              fetchDebugData();
            }}
            style={{ 
              position: 'fixed', 
              top: '70px', 
              left: '16px', 
              background: '#0F172A', 
              color: '#E2E8F0', 
              padding: '8px 12px', 
              borderRadius: 8, 
              border: '1px solid #475569', 
              fontSize: 11, 
              fontWeight: 800, 
              letterSpacing: '0.05em', 
              cursor: 'pointer', 
              zIndex: 999, 
              boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
              display: 'flex',
              alignItems: 'center',
              gap: 6
            }}
          >
            <span>🔧</span> DEBUG
          </button>

          {/* DEBUG PANEL MODAL (ADDITION 1) */}
          {debugOpen && (
            <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: 16 }}>
              <div style={{ background: '#1E293B', color: '#F8FAFC', borderRadius: 20, padding: 24, width: '100%', maxWidth: 640, maxHeight: '90vh', overflowY: 'auto', border: '1px solid #475569', boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)', boxSizing: 'border-box' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, borderBottom: '1px solid #475569', paddingBottom: 12 }}>
                  <div style={{ fontSize: 16, fontWeight: 900, color: '#38BDF8', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span>🔧</span> ENGINE DEBUG PANEL
                  </div>
                  <button onClick={() => setDebugOpen(false)} style={{ background: 'none', border: 'none', color: '#94A3B8', cursor: 'pointer', fontSize: 24, lineHeight: 1 }}>&times;</button>
                </div>

                {debugLoading && (
                  <div style={{ textAlign: 'center', padding: '24px 0', color: '#38BDF8', fontSize: 14 }}>
                    🔄 Loading current debug status from engine...
                  </div>
                )}

                {debugError && (
                  <div style={{ background: '#7F1D1D', border: '1px solid #F87171', color: '#FECACA', padding: 12, borderRadius: 8, fontSize: 12, marginBottom: 16 }}>
                    ⚠️ <strong>Error fetching debug data:</strong> {debugError}
                  </div>
                )}

                {!debugLoading && debugData && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    
                    {/* 1. AUTHENTICATION */}
                    <div style={{ background: '#0F172A', padding: 14, borderRadius: 10, border: '1px solid #334155' }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: '#F1F5F9', marginBottom: 8, borderBottom: '1px solid #1E293B', paddingBottom: 4 }}>🔐 Authentication</div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, fontSize: 12 }}>
                        <div>
                          <span style={{ color: '#94A3B8' }}>Google Connection:</span>{' '}
                          <strong style={{ color: debugData.authentication?.isConnected === 'CONNECTED' ? '#4ADE80' : '#F87171' }}>
                            {debugData.authentication?.isConnected}
                          </strong>
                        </div>
                        <div>
                          <span style={{ color: '#94A3B8' }}>Tokens in LocalStorage:</span>{' '}
                          <strong style={{ color: localStorage.getItem('google_tokens') ? '#4ADE80' : '#F87171' }}>
                            {localStorage.getItem('google_tokens') ? 'CONNECTED' : 'NOT CONNECTED'}
                          </strong>
                        </div>
                      </div>
                    </div>

                    {/* 2. LAST API CALL */}
                    <div style={{ background: '#0F172A', padding: 14, borderRadius: 10, border: '1px solid #334155' }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: '#F1F5F9', marginBottom: 8, borderBottom: '1px solid #1E293B', paddingBottom: 4 }}>🌐 Last API Call</div>
                      <div style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <div>
                          <span style={{ color: '#94A3B8' }}>URL:</span> <code style={{ color: '#38BDF8', background: '#1E293B', padding: '2px 4px', borderRadius: 4 }}>{debugData.lastApiCall?.url || 'None observed yet'}</code>
                        </div>
                        <div>
                          <span style={{ color: '#94A3B8' }}>Status:</span>{' '}
                          <strong style={{ color: debugData.lastApiCall?.statusCode >= 400 ? '#F87171' : debugData.lastApiCall?.statusCode ? '#4ADE80' : '#94A3B8' }}>
                            {debugData.lastApiCall?.statusCode || 'N/A'}
                          </strong>
                        </div>
                        {debugData.lastApiCall?.errorMessage && (
                          <div style={{ color: '#F87171', marginTop: 4 }}>
                            <span style={{ color: '#94A3B8' }}>Error:</span> {debugData.lastApiCall.errorMessage}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* 3. GEMINI STATUS */}
                    <div style={{ background: '#0F172A', padding: 14, borderRadius: 10, border: '1px solid #334155' }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: '#F1F5F9', marginBottom: 8, borderBottom: '1px solid #1E293B', paddingBottom: 4 }}>🤖 Gemini Status</div>
                      <div style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <div>
                          <span style={{ color: '#94A3B8' }}>Status:</span>{' '}
                          <strong style={{ color: debugData.geminiStatus?.success === true ? '#4ADE80' : debugData.geminiStatus?.success === false ? '#F87171' : '#94A3B8' }}>
                            {debugData.geminiStatus?.success === true ? 'SUCCESS' : debugData.geminiStatus?.success === false ? 'FAILED' : 'NO RUN YET'}
                          </strong>
                        </div>
                        <div>
                          <span style={{ color: '#94A3B8' }}>Model String:</span>{' '}
                          <code style={{ color: '#38BDF8', background: '#1E293B', padding: '2px 4px', borderRadius: 4 }}>{debugData.geminiStatus?.modelUsed || 'N/A'}</code>
                        </div>
                        {debugData.geminiStatus?.errorMessage && (
                          <div style={{ color: '#F87171', marginTop: 4 }}>
                            <span style={{ color: '#94A3B8' }}>Error:</span> {debugData.geminiStatus.errorMessage}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* 4. ENVIRONMENT CHECK */}
                    <div style={{ background: '#0F172A', padding: 14, borderRadius: 10, border: '1px solid #334155' }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: '#F1F5F9', marginBottom: 8, borderBottom: '1px solid #1E293B', paddingBottom: 4 }}>🌱 Environment Check</div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 8, fontSize: 11 }}>
                        {Object.entries(debugData.environment || {}).map(([key, value]) => (
                          <div key={key}>
                            <span style={{ color: '#94A3B8' }}>{key}:</span>{' '}
                            <strong style={{ color: value === 'SET' ? '#4ADE80' : '#F87171' }}>{value as string}</strong>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* 5. SCRAPERAPI STATUS */}
                    <div style={{ background: '#0F172A', padding: 14, borderRadius: 10, border: '1px solid #334155' }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: '#F1F5F9', marginBottom: 8, borderBottom: '1px solid #1E293B', paddingBottom: 4 }}>🕷️ ScraperAPI Status</div>
                      <div style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <div>
                          <span style={{ color: '#94A3B8' }}>Configured:</span>__{' '}
                          <strong style={{ color: debugData.scraperStatus?.configured ? '#4ADE80' : '#F87171' }}>
                            {debugData.scraperStatus?.configured ? 'YES' : 'NO'}
                          </strong>
                        </div>
                        {debugData.scraperStatus?.configured && (
                          <>
                            <div>
                              <span style={{ color: '#94A3B8' }}>Requests Remaining:</span>{' '}
                              <strong style={{ color: '#38BDF8' }}>{debugData.scraperStatus?.requestsRemaining}</strong>
                            </div>
                            <div>
                              <span style={{ color: '#94A3B8' }}>Connection Status:</span>{' '}
                              <strong style={{ color: debugData.scraperStatus?.status === 'Success' ? '#4ADE80' : '#F87171' }}>{debugData.scraperStatus?.status}</strong>
                            </div>
                            {debugData.scraperStatus?.error && (
                              <div style={{ color: '#F87171' }}>
                                <span style={{ color: '#94A3B8' }}>Error:</span> {debugData.scraperStatus.error}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    </div>

                    {/* 6. OPENAI STATUS */}
                    <div style={{ background: '#0F172A', padding: 14, borderRadius: 10, border: '1px solid #334155' }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: '#F1F5F9', marginBottom: 8, borderBottom: '1px solid #1E293B', paddingBottom: 4 }}>🧠 OpenAI Status</div>
                      <div style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <div>
                          <span style={{ color: '#94A3B8' }}>Configured:</span>{' '}
                          <strong style={{ color: debugData.openaiStatus?.configured ? '#4ADE80' : '#F87171' }}>
                            {debugData.openaiStatus?.configured ? 'YES' : 'NO'}
                          </strong>
                        </div>
                        {debugData.openaiStatus?.configured && (
                          <>
                            <div>
                              <span style={{ color: '#94A3B8' }}>Connection Status:</span>{' '}
                              <strong style={{ color: debugData.openaiStatus?.status === 'Succeeded' ? '#4ADE80' : '#F87171' }}>{debugData.openaiStatus?.status}</strong>
                            </div>
                            {debugData.openaiStatus?.error && (
                              <div style={{ color: '#F87171' }}>
                                <span style={{ color: '#94A3B8' }}>Error:</span> {debugData.openaiStatus.error}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    </div>

                    {/* 7. LAST ANALYZED LEAD */}
                    <div style={{ background: '#0F172A', padding: 14, borderRadius: 10, border: '1px solid #334155' }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: '#F1F5F9', marginBottom: 8, borderBottom: '1px solid #1E293B', paddingBottom: 4 }}>📋 Last Analyzed Lead</div>
                      <div style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <div><span style={{ color: '#94A3B8' }}>Company Name:</span> <strong>{debugData.lastAnalyzedLead?.company || 'None'}</strong></div>
                        <div><span style={{ color: '#94A3B8' }}>Website:</span> <strong>{debugData.lastAnalyzedLead?.website || 'None'}</strong></div>
                        <div><span style={{ color: '#94A3B8' }}>Score:</span> <strong style={{ color: '#F59E0B' }}>{debugData.lastAnalyzedLead?.score !== undefined ? debugData.lastAnalyzedLead.score : 'N/A'}</strong></div>
                        <div><span style={{ color: '#94A3B8' }}>Status:</span> <strong>{debugData.lastAnalyzedLead?.status || 'N/A'}</strong></div>
                        <div>
                          <span style={{ color: '#94A3B8' }}>aiAnalysis Field Is Populated:</span>{' '}
                          <strong style={{ color: debugData.lastAnalyzedLead?.aiAnalysisPopulated ? '#4ADE80' : '#F87171' }}>
                            {debugData.lastAnalyzedLead?.aiAnalysisPopulated ? 'Populated' : 'Null / Undefined'}
                          </strong>
                        </div>
                      </div>
                    </div>

                  </div>
                )}

                <div style={{ display: 'flex', gap: 12, marginTop: 24, borderTop: '1px solid #475569', paddingTop: 16 }}>
                  <button onClick={fetchDebugData} disabled={debugLoading} style={{ flex: 1, padding: '10px 16px', borderRadius: 8, fontSize: 13, fontWeight: 700, background: '#38BDF8', color: '#0F172A', border: 'none', cursor: 'pointer' }}>
                    {debugLoading ? 'Refreshing...' : '🔄 Refresh'}
                  </button>
                  <button onClick={() => setDebugOpen(false)} style={{ flex: 1, padding: '10px 16px', borderRadius: 8, fontSize: 13, fontWeight: 700, background: '#475569', color: '#F8FAFC', border: 'none', cursor: 'pointer' }}>
                    Close
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}

{/* BATCH SCHEDULE MODAL */}
{showBatchScheduleModal && !showBatchPreview && (
  <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000, padding: 16 }}>
    <div style={{ background: 'white', borderRadius: 20, padding: 24, width: '100%', maxWidth: 440, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 24px 80px rgba(0,0,0,0.2)' }}>
      <div style={{ fontSize: 16, fontWeight: 900, color: NAVY, marginBottom: 4 }}>📅 Batch Schedule</div>
      <div style={{ fontSize: 12, color: SLATE, marginBottom: 20 }}>Spread your campaign across multiple days to protect your sender reputation.</div>

      {/* NUMBER OF DAYS */}
      <div style={{ marginBottom: 16 }}>
        <label style={{ fontSize: 11, fontWeight: 700, color: SLATE, display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Number of Days</label>
        <div style={{ display: 'flex', gap: 8 }}>
          {[2, 3, 4, 5].map(d => (
            <button key={d} onClick={() => {
              setBatchDays(d);
              setManualBatchSizes(Array(d).fill(0));
              setBatchTimes(Array(d).fill('09:00'));
            }}
              style={{ flex: 1, padding: '10px 0', borderRadius: 8, fontSize: 13, fontWeight: 700, border: `2px solid ${batchDays === d ? AMBER : NAVY_BORDER}`, background: batchDays === d ? AMBER_LIGHT : 'white', color: batchDays === d ? NAVY : SLATE, cursor: 'pointer' }}>
              {d}
            </button>
          ))}
        </div>
      </div>

      {/* SPLIT MODE */}
      <div style={{ marginBottom: 16 }}>
        <label style={{ fontSize: 11, fontWeight: 700, color: SLATE, display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>How to Split</label>
        <div style={{ display: 'flex', gap: 8 }}>
          {(['even', 'manual'] as const).map(mode => (
            <button key={mode} onClick={() => setBatchSplitMode(mode)}
              style={{ flex: 1, padding: '10px 0', borderRadius: 8, fontSize: 12, fontWeight: 700, border: `2px solid ${batchSplitMode === mode ? AMBER : NAVY_BORDER}`, background: batchSplitMode === mode ? AMBER_LIGHT : 'white', color: batchSplitMode === mode ? NAVY : SLATE, cursor: 'pointer' }}>
              {mode === 'even' ? 'Even Split' : 'Manual Split'}
            </button>
          ))}
        </div>
      </div>

      {/* MANUAL SPLIT INPUTS */}
      {batchSplitMode === 'manual' && (
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 11, fontWeight: 700, color: SLATE, display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Emails Per Day</label>
          <div style={{ display: 'flex', gap: 8 }}>
            {Array.from({ length: batchDays }).map((_, i) => (
              <div key={i} style={{ flex: 1 }}>
                <div style={{ fontSize: 10, color: SLATE, marginBottom: 3, textAlign: 'center' }}>Day {i + 1}</div>
                <input type="number" min={0} value={manualBatchSizes[i] || ''}
                  onChange={e => {
                    const updated = [...manualBatchSizes];
                    updated[i] = Number(e.target.value);
                    setManualBatchSizes(updated);
                  }}
                  style={{ width: '100%', padding: '8px 6px', borderRadius: 8, border: `1px solid ${NAVY_BORDER}`, fontSize: 13, textAlign: 'center', boxSizing: 'border-box' }} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ORDER MODE */}
      <div style={{ marginBottom: 16 }}>
        <label style={{ fontSize: 11, fontWeight: 700, color: SLATE, display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Lead Order</label>
        <div style={{ display: 'flex', gap: 8 }}>
          {(['priority', 'list'] as const).map(mode => (
            <button key={mode} onClick={() => setBatchOrderMode(mode)}
              style={{ flex: 1, padding: '10px 0', borderRadius: 8, fontSize: 12, fontWeight: 700, border: `2px solid ${batchOrderMode === mode ? AMBER : NAVY_BORDER}`, background: batchOrderMode === mode ? AMBER_LIGHT : 'white', color: batchOrderMode === mode ? NAVY : SLATE, cursor: 'pointer' }}>
              {mode === 'priority' ? 'Top Priority First' : 'List Order'}
            </button>
          ))}
        </div>
        <div style={{ fontSize: 10, color: SLATE, marginTop: 6 }}>
          {batchOrderMode === 'priority' ? 'Highest scoring hot leads go into Day 1 first.' : 'Leads are batched in the order they appear in your pipeline.'}
        </div>
      </div>

      {/* TIME PER BATCH */}
      <div style={{ marginBottom: 20 }}>
        <label style={{ fontSize: 11, fontWeight: 700, color: SLATE, display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Send Time Per Day</label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {Array.from({ length: batchDays }).map((_, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: SLATE, width: 44, flexShrink: 0 }}>Day {i + 1}</span>
              <input type="time" value={batchTimes[i] || '09:00'}
                onChange={e => {
                  const updated = [...batchTimes];
                  updated[i] = e.target.value;
                  setBatchTimes(updated);
                }}
                style={{ flex: 1, padding: '8px 10px', borderRadius: 8, border: `1px solid ${NAVY_BORDER}`, fontSize: 12, boxSizing: 'border-box' }} />
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={() => setShowBatchScheduleModal(false)}
          style={{ flex: 1, padding: 12, borderRadius: 10, fontSize: 12, fontWeight: 700, background: '#F1F5F9', color: SLATE, border: 'none', cursor: 'pointer' }}>
          Cancel
        </button>
        <button onClick={confirmBatchSchedule}
          style={{ flex: 2, padding: 12, borderRadius: 10, fontSize: 12, fontWeight: 700, background: AMBER, color: NAVY, border: 'none', cursor: 'pointer' }}>
          Preview Batches →
        </button>
      </div>
    </div>
  </div>
)}

{/* BATCH PREVIEW MODAL */}
{showBatchPreview && (
  <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000, padding: 16 }}>
    <div style={{ background: 'white', borderRadius: 20, padding: 24, width: '100%', maxWidth: 440, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 24px 80px rgba(0,0,0,0.2)' }}>
      <div style={{ fontSize: 16, fontWeight: 900, color: NAVY, marginBottom: 4 }}>Batch Preview</div>
      <div style={{ fontSize: 12, color: SLATE, marginBottom: 16 }}>Review how your leads are distributed before confirming.</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 20 }}>
        {batchPreview.map(batch => (
          <div key={batch.day} style={{ padding: '12px 14px', borderRadius: 12, background: batch.day === 1 ? AMBER_LIGHT : '#F8FAFC', border: `1px solid ${batch.day === 1 ? AMBER : NAVY_BORDER}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 800, color: NAVY }}>Day {batch.day}</span>
              <span style={{ fontSize: 10, color: SLATE }}>{batch.time}</span>
            </div>
            <div style={{ fontSize: 12, color: NAVY, fontWeight: 600 }}>{batch.count} leads</div>
            <div style={{ fontSize: 10, color: SLATE, marginTop: 2 }}>
              {batch.hotCount} hot, {batch.warmCount} warm
              {batch.day === 1 ? ' — Ready to send' : ' — Locked until Day ' + batch.day}
            </div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={() => setShowBatchPreview(false)}
          style={{ flex: 1, padding: 12, borderRadius: 10, fontSize: 12, fontWeight: 700, background: '#F1F5F9', color: SLATE, border: 'none', cursor: 'pointer' }}>
          Back
        </button>
        <button onClick={lockBatchSchedule}
          style={{ flex: 2, padding: 12, borderRadius: 10, fontSize: 12, fontWeight: 700, background: AMBER, color: NAVY, border: 'none', cursor: 'pointer' }}>
          Confirm Schedule
        </button>
      </div>
    </div>
  </div>
)}

      {showScheduleModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000, padding: 16 }}>
          <div style={{ background: 'white', borderRadius: 20, padding: 24, width: '100%', maxWidth: 400, maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: COLORS.navy, marginBottom: 4 }}>📅 Schedule Send</div>
            <div style={{ fontSize: 12, color: COLORS.slate, marginBottom: 20 }}>Set when the queue should start sending. Emails will go out paced dynamically.</div>

            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: COLORS.slate, display: 'block', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Send Date</label>
              <input type="date" value={scheduleSettings.sendDate || ''} onChange={e => setScheduleSettings(prev => ({ ...prev, sendDate: e.target.value }))}
                style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: `1px solid ${COLORS.navyBorder}`, fontSize: 12, boxSizing: 'border-box' }} />
            </div>

            <div style={{ display: 'flex', gap: 10, marginBottom: 20 }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 11, fontWeight: 700, color: COLORS.slate, display: 'block', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Start Time</label>
                <input type="time" value={scheduleSettings.startTime || ''} onChange={e => setScheduleSettings(prev => ({ ...prev, startTime: e.target.value }))}
                  style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: `1px solid ${COLORS.navyBorder}`, fontSize: 12, boxSizing: 'border-box' }} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 11, fontWeight: 700, color: COLORS.slate, display: 'block', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>End Time</label>
                <input type="time" value={scheduleSettings.endTime || ''} onChange={e => setScheduleSettings(prev => ({ ...prev, endTime: e.target.value }))}
                  style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: `1px solid ${COLORS.navyBorder}`, fontSize: 12, boxSizing: 'border-box' }} />
              </div>
            </div>

            <div style={{ padding: '10px 14px', background: COLORS.amberLight, borderRadius: 10, marginBottom: 20, fontSize: 12, color: COLORS.navy }}>
              📍 Sending {emailsReady} emails to <strong>{campaignCountry}</strong> leads. The queue will automatically pace emails to finish by {scheduleSettings.endTime}.
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => setShowScheduleModal(false)} style={{ flex: 1, padding: 12, borderRadius: 10, fontSize: 12, fontWeight: 700, background: '#F1F5F9', color: COLORS.slate, border: 'none', cursor: 'pointer' }}>Cancel</button>
              <button onClick={executeScheduledSend} style={{ flex: 2, padding: 12, borderRadius: 10, fontSize: 12, fontWeight: 700, background: COLORS.amber, color: COLORS.navy, border: 'none', cursor: 'pointer' }}>Confirm Schedule →</button>
            </div>
          </div>
        </div>
      )}
        </div>
      )}

      {/* EMAIL TEMPLATE LIBRARY MODAL */}
      {showTemplateModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000, padding: 16 }}>
          <div style={{ background: 'white', borderRadius: 20, padding: 24, width: '100%', maxWidth: 400, maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: NAVY, marginBottom: 4 }}>Save Email Template</div>
            <div style={{ fontSize: 12, color: SLATE, marginBottom: 16 }}>Give this template a name for future use.</div>
            <input type="text" value={templateName || ''} onChange={e => setTemplateName(e.target.value)} placeholder="Template name e.g., SaaS Outreach v1" autoFocus
              style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: `1px solid ${NAVY_BORDER}`, fontSize: 12, marginBottom: 12, boxSizing: 'border-box', background: 'white', color: NAVY }} />
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => setShowTemplateModal(false)} style={{ flex: 1, padding: 10, borderRadius: 8, fontSize: 12, fontWeight: 700, background: '#F1F5F9', color: SLATE, border: 'none', cursor: 'pointer' }}>Cancel</button>
              <button onClick={confirmSaveTemplate} style={{ flex: 2, padding: 10, borderRadius: 8, fontSize: 12, fontWeight: 700, background: AMBER, color: NAVY, border: 'none', cursor: 'pointer' }}>Save Template</button>
            </div>
          </div>
        </div>
      )}



      {/* SENDER ACCOUNTS MANAGER MODAL */}
      {showAccountManager && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000, padding: 16 }}>
          <div style={{ background: 'white', borderRadius: 20, padding: 24, width: '100%', maxWidth: 440, maxHeight: '90vh', overflowY: 'auto' }}>
            <h3 style={{ marginTop: 0, fontSize: 18, fontWeight: 700, color: NAVY, marginBottom: 6 }}>Connected Gmail Accounts</h3>
            <p style={{ fontSize: 12, color: SLATE, marginBottom: 16 }}>Manage secondary custom email accounts connected for campaign outbound.</p>
            {connectedAccounts.length === 0 ? (
              <div style={{ padding: '20px 10px', textAlign: 'center', color: SLATE, fontSize: 12, background: '#F8FAFC', borderRadius: 12, marginBottom: 16 }}>
                No additional accounts connected. Campaign will send from your primary Google account.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
                {connectedAccounts.map(acc => (
                  <div key={acc.email} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', background: '#F8FAFC', borderRadius: 10, border: `1px solid ${NAVY_BORDER}` }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: NAVY }}>{acc.email}</span>
                    <button onClick={() => {
                      setConfirmDialog({
                        isOpen: true,
                        title: '🗑️ Remove Gmail Account',
                        message: `Are you sure you want to remove ${acc.email} from the sender list?`,
                        onConfirm: async () => {
                          await fetch('/api/accounts/remove', { method: 'POST', headers: getAuthHeaders(), body: JSON.stringify({ accountId: acc.email }) });
                          fetchAccounts();
                          toast.success('Account removed');
                        }
                      });
                    }} style={{ padding: '5px 10px', fontSize: 11, fontWeight: 700, background: RED_LIGHT, color: RED, border: 'none', borderRadius: 6, cursor: 'pointer' }}>Remove</button>
                  </div>
                ))}
              </div>
            )}
            <button onClick={() => setShowAccountManager(false)} style={{ width: '100%', padding: '10px 12px', background: '#F1F5F9', color: SLATE, border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>Close</button>
          </div>
        </div>
      )}

      {showCreateCampaignModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000, padding: 16 }}>
          <div style={{ background: 'white', borderRadius: 20, padding: 24, width: '100%', maxWidth: 500, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 10px 25px rgba(0,0,0,0.1)' }}>
            <div style={{ fontSize: 18, fontWeight: 900, color: NAVY, marginBottom: 6 }}>🆕 Create New Campaign</div>
            <p style={{ fontSize: 12, color: SLATE, margin: '0 0 16px 0', lineHeight: 1.4 }}>Set up an isolated pipeline for a new audience. Leads, progress and custom status will be saved separately.</p>
            
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 11, fontWeight: 800, color: SLATE, display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Campaign Name *</label>
              <input 
                type="text" 
                value={newCampaignName || ''} 
                onChange={e => setNewCampaignName(e.target.value)} 
                placeholder="e.g., UK SaaS Outreach, Winter Leads" 
                autoFocus 
                style={{ width: '100%', padding: '10px 14px', borderRadius: 8, border: `1px solid ${NAVY_BORDER}`, fontSize: 13, boxSizing: 'border-box', background: 'white', color: NAVY }} 
              />
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 11, fontWeight: 800, color: SLATE, display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Sender Gmail Account *
              </label>
              <select
                value={newCampaignSenderAccountId || ''}
                onChange={e => setNewCampaignSenderAccountId(e.target.value)}
                style={{ width: '100%', padding: '10px 14px', borderRadius: 8, border: `1px solid ${NAVY_BORDER}`, fontSize: 13, boxSizing: 'border-box', background: 'white', color: NAVY }}
              >
                <option value="">-- Select an account (required) --</option>
                {connectedAccounts.map(acc => (
                  <option key={acc.email} value={acc.email}>{acc.email}</option>
                ))}
              </select>
              {connectedAccounts.length === 0 && (
                <div style={{ fontSize: 11, color: RED, marginTop: 4 }}>
                  No Gmail accounts connected yet. Connect one from the Schedule tab first.
                </div>
              )}
              <div style={{ fontSize: 10, color: SLATE, marginTop: 4 }}>
                This account sends the initial email and every follow-up for this campaign. It can't be changed once sending starts.
              </div>
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 11, fontWeight: 800, color: SLATE, display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Target Country *</label>
              <select 
                value={isOtherCountrySelected ? 'Other' : (newCampaignCountry || '')} 
                onChange={e => {
                  const val = e.target.value;
                  if (val === 'Other') {
                    setIsOtherCountrySelected(true);
                    setNewCampaignCountry('');
                  } else {
                    setIsOtherCountrySelected(false);
                    setNewCampaignCountry(val);
                  }
                }} 
                style={{ width: '100%', padding: '10px 14px', borderRadius: 8, border: `1px solid ${NAVY_BORDER}`, fontSize: 13, boxSizing: 'border-box', background: 'white', color: NAVY }}
              >
                <option value="United Kingdom">United Kingdom 🇬🇧</option>
                <option value="United States">United States 🇺🇸</option>
                <option value="Canada">Canada 🇨🇦</option>
                <option value="Australia">Australia 🇦🇺</option>
                <option value="Germany">Germany 🇩🇪</option>
                <option value="France">France 🇫🇷</option>
                <option value="Other">Other / Global 🌐</option>
              </select>
              {isOtherCountrySelected && (
                <input 
                  type="text" 
                  value={newCampaignCountry || ''}
                  placeholder="Enter custom country name..." 
                  onChange={e => {
                    setNewCampaignCountry(e.target.value);
                  }} 
                  style={{ width: '100%', padding: '10px 14px', borderRadius: 8, border: `1px solid ${NAVY_BORDER}`, fontSize: 13, marginTop: 8, boxSizing: 'border-box', background: 'white', color: NAVY }} 
                />
              )}
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 11, fontWeight: 800, color: SLATE, display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Target Industry / ICP Template</label>
              <select 
                value={newCampaignIndustry || ''} 
                onChange={e => {
                  const val = e.target.value;
                  setNewCampaignIndustry(val);
                  const template = ICP_TEMPLATES[val];
                  if (template) {
                    setNewCampaignDecisionMaker(template.decisionMaker);
                    setNewCampaignIcpContext(template.icpContext);
                    setNewCampaignFollowUp1Days(template.followUp1Days);
                    setNewCampaignFollowUp2Days(template.followUp2Days);
                    setNewCampaignFollowUp3Days(template.followUp3Days);
                  }
                }} 
                style={{ width: '100%', padding: '10px 14px', borderRadius: 8, border: `1px solid ${NAVY_BORDER}`, fontSize: 13, boxSizing: 'border-box', background: 'white', color: NAVY }}
              >
                <option value="">-- Select Industry ICP Template (Optional) --</option>
                {Object.keys(ICP_TEMPLATES).map(key => (
                  <option key={key} value={key}>{key}</option>
                ))}
                <option value="Custom">Custom Industry</option>
              </select>
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 11, fontWeight: 800, color: SLATE, display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Target Decision Maker Title</label>
              <input 
                type="text" 
                value={newCampaignDecisionMaker || ''} 
                onChange={e => setNewCampaignDecisionMaker(e.target.value)} 
                placeholder="e.g., Founding Partner, Managing Director" 
                style={{ width: '100%', padding: '10px 14px', borderRadius: 8, border: `1px solid ${NAVY_BORDER}`, fontSize: 13, boxSizing: 'border-box', background: 'white', color: NAVY }} 
              />
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 11, fontWeight: 800, color: SLATE, display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>ICP Calibration Context</label>
              <textarea 
                value={newCampaignIcpContext || ''} 
                onChange={e => setNewCampaignIcpContext(e.target.value)} 
                placeholder="Briefly describe what this industry responds/dismisses immediately..." 
                rows={3}
                style={{ width: '100%', padding: '10px 14px', borderRadius: 8, border: `1px solid ${NAVY_BORDER}`, fontSize: 13, boxSizing: 'border-box', background: 'white', color: NAVY, resize: 'vertical', fontFamily: 'inherit' }} 
              />
            </div>

            <div style={{ marginBottom: 20 }}>
              <label style={{ fontSize: 11, fontWeight: 800, color: SLATE, display: 'block', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Follow-up Sequences offset (Days)</label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
                <div>
                  <span style={{ fontSize: 10, color: SLATE, display: 'block', marginBottom: 2 }}>Follow-up 1</span>
                  <input 
                    type="number" 
                    value={newCampaignFollowUp1Days !== undefined && newCampaignFollowUp1Days !== null && !isNaN(newCampaignFollowUp1Days) ? newCampaignFollowUp1Days : ''} 
                    onChange={e => setNewCampaignFollowUp1Days(Number(e.target.value))} 
                    style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: `1px solid ${NAVY_BORDER}`, fontSize: 13, boxSizing: 'border-box', background: 'white', color: NAVY }} 
                  />
                </div>
                <div>
                  <span style={{ fontSize: 10, color: SLATE, display: 'block', marginBottom: 2 }}>Follow-up 2</span>
                  <input 
                    type="number" 
                    value={newCampaignFollowUp2Days !== undefined && newCampaignFollowUp2Days !== null && !isNaN(newCampaignFollowUp2Days) ? newCampaignFollowUp2Days : ''} 
                    onChange={e => setNewCampaignFollowUp2Days(Number(e.target.value))} 
                    style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: `1px solid ${NAVY_BORDER}`, fontSize: 13, boxSizing: 'border-box', background: 'white', color: NAVY }} 
                  />
                </div>
                <div>
                  <span style={{ fontSize: 10, color: SLATE, display: 'block', marginBottom: 2 }}>Follow-up 3</span>
                  <input 
                    type="number" 
                    value={newCampaignFollowUp3Days !== undefined && newCampaignFollowUp3Days !== null && !isNaN(newCampaignFollowUp3Days) ? newCampaignFollowUp3Days : ''} 
                    onChange={e => setNewCampaignFollowUp3Days(Number(e.target.value))} 
                    style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: `1px solid ${NAVY_BORDER}`, fontSize: 13, boxSizing: 'border-box', background: 'white', color: NAVY }} 
                  />
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <button 
                onClick={() => setShowCreateCampaignModal(false)} 
                style={{ flex: 1, padding: '11px 16px', borderRadius: 8, fontSize: 13, fontWeight: 700, background: '#F1F5F9', color: SLATE, border: 'none', cursor: 'pointer' }}
              >
                Cancel
              </button>
              <button 
                onClick={() => {
                  if (!newCampaignName.trim()) {
                    toast.error('Campaign name is required');
                    return;
                  }
                  if (!newCampaignCountry.trim()) {
                    toast.error('Country is required');
                    return;
                  }
                  if (!newCampaignSenderAccountId) {
                    toast.error('Please select which Gmail account this campaign will send from');
                    return;
                  }
                  createCampaign(newCampaignName.trim(), newCampaignCountry.trim());
                  setShowCreateCampaignModal(false);
                }} 
                style={{ flex: 1.5, padding: '11px 16px', borderRadius: 8, fontSize: 13, fontWeight: 800, background: AMBER, color: NAVY, border: 'none', cursor: 'pointer' }}
              >
                Create Campaign
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDialog.isOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10000, padding: 16 }}>
          <div style={{ background: 'white', borderRadius: 20, padding: 24, width: '100%', maxWidth: 400, boxShadow: '0 10px 25px rgba(0,0,0,0.15)', transform: 'scale(1)', transition: 'all 0.2s' }}>
            <div style={{ fontSize: 18, fontWeight: 900, color: NAVY, marginBottom: 12 }}>{confirmDialog.title}</div>
            <p style={{ fontSize: 13, color: SLATE, margin: '0 0 24px 0', lineHeight: 1.5 }}>{confirmDialog.message}</p>
            <div style={{ display: 'flex', gap: 10 }}>
              <button 
                onClick={() => setConfirmDialog(prev => ({ ...prev, isOpen: false }))} 
                style={{ flex: 1, padding: '11px 16px', borderRadius: 8, fontSize: 13, fontWeight: 700, background: '#F1F5F9', color: SLATE, border: 'none', cursor: 'pointer' }}
              >
                Cancel
              </button>
              <button 
                onClick={async () => {
                  try {
                    await confirmDialog.onConfirm();
                  } catch (e) {
                    console.error('Confirmation action failed:', e);
                  } finally {
                    setConfirmDialog(prev => ({ ...prev, isOpen: false }));
                  }
                }} 
                style={{ flex: 1.5, padding: '11px 16px', borderRadius: 8, fontSize: 13, fontWeight: 800, background: '#EF4444', color: 'white', border: 'none', cursor: 'pointer' }}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
      <EmailPreviewModal
        isOpen={previewModal.isOpen}
        onClose={() => setPreviewModal(prev => ({ ...prev, isOpen: false }))}
        subject={previewModal.subject}
        body={previewModal.body}
        recipientName={previewModal.recipientName}
        leadCompany={previewModal.leadCompany}
      />
    </div>
  );
}
