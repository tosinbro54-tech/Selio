import { supabase } from './supabase';

const generateUUID = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
};

// The inverse of CLIENT_OWNED_ANALYSIS_FIELDS — these are the columns only
// server-side sends/cron ever write. Safe to merge into local state at any
// time since the client never owns them; no risk of clobbering user edits.
export const SERVER_OWNED_DB_TO_CLIENT_FIELD: Record<string, string> = {
  sent_status: 'sentStatus',
  sent_at: 'sentAt',
  sent_to: 'sentTo',
  last_email_sent_at: 'lastEmailSentAt',
  follow_up1_sent: 'followUp1Sent',
  follow_up1_sent_at: 'followUp1SentAt',
  follow_up2_sent: 'followUp2Sent',
  follow_up2_sent_at: 'followUp2SentAt',
  follow_up3_sent: 'followUp3Sent',
  follow_up3_sent_at: 'followUp3SentAt',
  batch_status: 'batchStatus',
  error_reason: 'errorReason',
  initial_message_id: 'initialMessageId',
  initial_thread_id: 'initialThreadId',
  status: 'status',
};

// ============================================================
// CAMPAIGNS
// ============================================================

export const mapCampaignFromDb = (row: any) => {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    country: row.country,
    timezone: row.timezone,
    industry: row.industry,
    decisionMakerTitle: row.decision_maker_title,
    icpContext: row.icp_context,
    senderAccountId: row.sender_account_id,
    followUpStartTime: row.follow_up_start_time,
    followUpEndTime: row.follow_up_end_time,
    followUp1Days: row.follow_up1_days,
    followUp2Days: row.follow_up2_days,
    followUp3Days: row.follow_up3_days,
    scheduleStartTime: row.schedule_start_time,
    scheduleEndTime: row.schedule_end_time,
    dailyLimit: row.daily_limit,
    leadCount: row.lead_count,
    analyzedCount: row.analyzed_count,
    sentCount: row.sent_count,
    replyCount: row.reply_count,
    createdAt: row.created_at,
    lastOpened: row.last_opened,
  };
};

export const getCampaigns = async (userId: string) => {
  const { data, error } = await supabase
    .from('campaigns')
    .select('*')
    .eq('user_id', userId)
    .order('last_opened', { ascending: false });
  if (error) { console.error('[DB] getCampaigns error:', error); return []; }
  return (data || []).map(mapCampaignFromDb);
};

export const saveCampaign = async (campaign: any, userId: string, touchLastOpened = false) => {
  const payload: any = {
    id: campaign.id,
    user_id: userId,
    name: campaign.name,
    country: campaign.country,
    timezone: campaign.timezone || null,
    industry: campaign.industry,
    decision_maker_title: campaign.decisionMakerTitle !== undefined ? campaign.decisionMakerTitle : campaign.decision_maker_title,
    icp_context: campaign.icpContext !== undefined ? campaign.icpContext : campaign.icp_context,
    sender_account_id: campaign.senderAccountId !== undefined ? campaign.senderAccountId : campaign.sender_account_id,
    follow_up_start_time: campaign.followUpStartTime !== undefined ? campaign.followUpStartTime : campaign.follow_up_start_time,
    follow_up_end_time: campaign.followUpEndTime !== undefined ? campaign.followUpEndTime : campaign.follow_up_end_time,
    follow_up1_days: campaign.followUp1Days !== undefined ? campaign.followUp1Days : (campaign.follow_up1_days || 3),
    follow_up2_days: campaign.followUp2Days !== undefined ? campaign.followUp2Days : (campaign.follow_up2_days || 10),
    follow_up3_days: campaign.followUp3Days !== undefined ? campaign.followUp3Days : (campaign.follow_up3_days || 17),
    schedule_start_time: campaign.scheduleStartTime !== undefined ? campaign.scheduleStartTime : (campaign.schedule_start_time || '09:00'),
    schedule_end_time: campaign.scheduleEndTime !== undefined ? campaign.scheduleEndTime : (campaign.schedule_end_time || '11:00'),
    daily_limit: campaign.dailyLimit !== undefined ? campaign.dailyLimit : (campaign.daily_limit || 50),
    lead_count: campaign.leadCount !== undefined ? campaign.leadCount : (campaign.lead_count || 0),
    analyzed_count: campaign.analyzedCount !== undefined ? campaign.analyzedCount : (campaign.analyzed_count || 0),
    sent_count: campaign.sentCount !== undefined ? campaign.sentCount : (campaign.sent_count || 0),
    reply_count: campaign.replyCount !== undefined ? campaign.replyCount : (campaign.reply_count || 0),
  };
  if (touchLastOpened) payload.last_opened = new Date().toISOString();

  const { data, error } = await supabase
    .from('campaigns')
    .upsert(payload, { onConflict: 'id' });
  if (error) console.error('[DB] saveCampaign error:', error);
  return data;
};

export const deleteCampaign = async (campaignId: string) => {
  const { error } = await supabase
    .from('campaigns')
    .delete()
    .eq('id', campaignId);
  if (error) console.error('[DB] deleteCampaign error:', error);
};

export const getLastOpenedCampaign = async (userId: string) => {
  const { data, error } = await supabase
    .from('campaigns')
    .select('id')
    .eq('user_id', userId)
    .order('last_opened', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return data?.id || null;
};

export const updateCampaignLastOpened = async (campaignId: string) => {
  const { error } = await supabase
    .from('campaigns')
    .update({ last_opened: new Date().toISOString() })
    .eq('id', campaignId);
  if (error) console.error('[DB] updateCampaignLastOpened error:', error);
};

// ============================================================
// LEADS
// ============================================================

export const getLeads = async (campaignId: string) => {
  const { data, error } = await supabase
    .from('leads')
    .select('*')
    .eq('campaign_id', campaignId)
    .order('row_index', { ascending: true });
  if (error) { console.error('[DB] getLeads error:', error); return []; }
  return (data || []).map((row: any) => ({
    rowIndex: row.row_index,
    company: row.company,
    website: row.website,
    email: row.email,
    recipient: row.recipient,
    phone: row.phone,
    customFields: row.custom_fields || {},
    _supabaseId: row.id,
  }));
};

export const saveLeads = async (campaignId: string, userId: string, leads: any[]) => {
  if (!leads.length) return [];

  const rows = leads.map(lead => ({
    campaign_id: campaignId,
    user_id: userId,
    row_index: lead.rowIndex,
    company: lead.company || '',
    website: lead.website || '',
    email: lead.email || '',
    recipient: lead.recipient || '',
    phone: lead.phone || '',
    custom_fields: lead.customFields || {},
    ...(lead._supabaseId ? { id: lead._supabaseId } : {}),
  }));

  // Upsert and return the inserted/updated rows with their IDs
  const { data, error } = await supabase
    .from('leads')
    .upsert(rows, { onConflict: 'id' })
    .select();  // IMPORTANT: returns the rows with generated IDs

  if (error) {
    console.error('[DB] saveLeads upsert error:', error);
    throw error;
  }

  // Transform back to frontend lead format with _supabaseId
  return (data || []).map(row => ({
    rowIndex: row.row_index,
    company: row.company,
    website: row.website,
    email: row.email,
    recipient: row.recipient,
    phone: row.phone,
    customFields: row.custom_fields || {},
    _supabaseId: row.id,
  }));
};

export const reconcileLeadDeletions = async (campaignId: string, authoritativeLeads: any[]) => {
  if (!authoritativeLeads.length) {
    // Explicit empty-list case (e.g. "clear all leads") — still gate this
    // behind an explicit caller, not a stray state update.
    const { error } = await supabase.from('leads').delete().eq('campaign_id', campaignId);
    if (error) console.error('[DB] reconcileLeadDeletions (clear all) error:', error);
    return;
  }

  const { data: dbLeads, error: fetchError } = await supabase
    .from('leads')
    .select('id')
    .eq('campaign_id', campaignId);

  if (fetchError || !dbLeads) {
    console.error('[DB] reconcileLeadDeletions: failed to fetch current leads:', fetchError);
    return;
  }

  const currentDbIds = dbLeads.map(l => l.id);
  const incomingIds = new Set(authoritativeLeads.map(l => l._supabaseId).filter(Boolean));
  const idsToDelete = currentDbIds.filter(id => !incomingIds.has(id));

  if (idsToDelete.length > 0) {
    console.log(`[DB] reconcileLeadDeletions: removing ${idsToDelete.length} leads no longer in the imported list`);
    const { error } = await supabase.from('leads').delete().in('id', idsToDelete);
    if (error) console.error('[DB] reconcileLeadDeletions delete error:', error);
  }
};

export const deleteCampaignLeads = async (campaignId: string) => {
  const { error } = await supabase
    .from('leads')
    .delete()
    .eq('campaign_id', campaignId);
  if (error) console.error('[DB] deleteCampaignLeads error:', error);
};

// ============================================================
// LEAD ANALYSIS
// ============================================================

function parseRowIndex(rowLeadsField: any): number | undefined {
  if (!rowLeadsField) return undefined;
  if (Array.isArray(rowLeadsField)) {
    if (rowLeadsField.length > 0) {
      const first = rowLeadsField[0];
      const val = first?.row_index;
      return typeof val === 'number' ? val : (val !== undefined && val !== null ? parseInt(val) : undefined);
    }
  } else {
    const val = rowLeadsField.row_index;
    return typeof val === 'number' ? val : (val !== undefined && val !== null ? parseInt(val) : undefined);
  }
  return undefined;
}

export const getAnalysis = async (campaignId: string) => {
  // 1. Fetch leads map first (id -> row_index)
  const { data: leadsData, error: leadsError } = await supabase
    .from('leads')
    .select('id, row_index')
    .eq('campaign_id', campaignId);

  if (leadsError) {
    console.error('[DB] getAnalysis (fetching leads) error:', {
      message: leadsError.message,
      code: leadsError.code,
      details: leadsError.details,
      hint: leadsError.hint
    });
    return {};
  }

  const leadIdToRowIndex = new Map<string, number>();
  for (const l of (leadsData || [])) {
    if (l.id && l.row_index !== undefined && l.row_index !== null) {
      leadIdToRowIndex.set(l.id, parseInt(l.row_index));
    }
  }

  // 2. Fetch lead_analysis data directly without complex join
  const { data, error } = await supabase
    .from('lead_analysis')
    .select('*')
    .eq('campaign_id', campaignId);

  if (error) {
    console.error('[DB] getAnalysis error:', {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint
    });
    return {};
  }

  const result: Record<number, any> = {};
  for (const row of (data || [])) {
    const rowIndex = row.lead_id ? leadIdToRowIndex.get(row.lead_id) : undefined;
    if (rowIndex === undefined) continue;

    // Build nested seoData to support the client UI directly (selectedAnalysis.seoData.*)
    const seoData = {
      viable: row.viable,
      crawlLayerLabel: row.crawl_layer_label,
      hasHttps: row.has_https,
      hasBlog: row.has_blog,
      blogAbandoned: row.blog_abandoned,
      lastPostDate: row.last_post_date,
      wordCountEstimate: row.word_count_estimate,
      hasOpenGraph: row.has_open_graph,
      hasSchema: row.has_schema,
      hasSearchConsole: row.has_search_console,
      h1Count: row.h1_count,
      h1Text: row.h1_text,
      h2Count: row.h2_count,
      imagesMissingAlt: row.images_missing_alt,
      totalImages: row.total_images,
      hasCanonical: row.has_canonical,
      description: row.description,
      descriptionLength: row.description_length,
      title: row.title,
      titleLength: row.title_length,
      internalLinks: row.internal_links,
      psiScores: row.psi_scores,
      rankedProblems: row.ranked_problems,
    };

    result[rowIndex] = {
      viable: row.viable,
      crawlLayerLabel: row.crawl_layer_label,
      hasHttps: row.has_https,
      hasBlog: row.has_blog,
      blogAbandoned: row.blog_abandoned,
      lastPostDate: row.last_post_date,
      wordCountEstimate: row.word_count_estimate,
      hasOpenGraph: row.has_open_graph,
      hasSchema: row.has_schema,
      hasSearchConsole: row.has_search_console,
      h1Count: row.h1_count,
      h1Text: row.h1_text,
      h2Count: row.h2_count,
      imagesMissingAlt: row.images_missing_alt,
      totalImages: row.total_images,
      hasCanonical: row.has_canonical,
      description: row.description,
      descriptionLength: row.description_length,
      title: row.title,
      titleLength: row.title_length,
      internalLinks: row.internal_links,
      psiScores: row.psi_scores,
      rankedProblems: row.ranked_problems,
      seoData: seoData,

      opportunityScore: row.opportunity_score,
      totalScore: row.total_score,
      score: row.opportunity_score !== null && row.opportunity_score !== undefined ? row.opportunity_score : (row.total_score !== null && row.total_score !== undefined ? row.total_score : 0),
      classification: row.classification,
      status: row.status,
      viableStatus: row.viable_status,
      disqualifyReason: row.disqualify_reason,
      aiAnalysis: row.ai_analysis,
      initialEmail: row.initial_email || row.ai_analysis?.initialEmail || null,
      followUp1: row.follow_up1 || row.ai_analysis?.followUp1 || null,
      followUp2: row.follow_up2 || row.ai_analysis?.followUp2 || null,
      followUp3: row.follow_up3 || row.ai_analysis?.followUp3 || null,
      subjectLines: row.subject_lines,
      insights: row.insights,
      primaryProblem: row.primary_problem,
      outreachAngle: row.outreach_angle,
      sentStatus: row.sent_status,
      sentAt: row.sent_at,
      sentTo: row.sent_to,
      lastEmailSentAt: row.last_email_sent_at,
      followUp1Sent: row.follow_up1_sent,
      followUp1SentAt: row.follow_up1_sent_at,
      followUp2Sent: row.follow_up2_sent,
      followUp2SentAt: row.follow_up2_sent_at,
      followUp3Sent: row.follow_up3_sent,
      followUp3SentAt: row.follow_up3_sent_at,
      batchStatus: row.batch_status,
      errorReason: row.error_reason,
      spamReported: row.spam_reported,
      unsubscribedAt: row.unsubscribed_at,
      bouncedAt: row.bounced_at,
      initialMessageId: row.initial_message_id,
      initialThreadId: row.initial_thread_id,
      _supabaseId: row.id,
      _leadSupabaseId: row.lead_id,
    };
  }
  return result;
};

export const saveAnalysis = async (
  campaignId: string,
  userId: string,
  leadSupabaseId: string,
  rowIndex: number,
  analysis: any
) => {
  let finalLeadId = leadSupabaseId;
  if (!finalLeadId) {
    const { data: dbLead } = await supabase
      .from('leads')
      .select('id')
      .eq('campaign_id', campaignId)
      .eq('row_index', rowIndex)
      .maybeSingle();
    if (dbLead) finalLeadId = dbLead.id;
  }

  if (!finalLeadId) {
    console.warn('[DB] saveAnalysis warning: Could not resolve lead_id for rowIndex', rowIndex);
    return;
  }

  const { data: existing } = await supabase
    .from('lead_analysis')
    .select('id')
    .eq('lead_id', finalLeadId)
    .maybeSingle();

  const existingId = existing?.id;
  const clientFields = buildClientOwnedRow(analysis); // reuse the allowlist helper added for saveBulkAnalysis

  const dbRow: any = {
    crawl_layer_label: clientFields.crawlLayerLabel,
    has_https: clientFields.hasHttps,
    has_blog: clientFields.hasBlog,
    blog_abandoned: clientFields.blogAbandoned,
    last_post_date: clientFields.lastPostDate,
    word_count_estimate: clientFields.wordCountEstimate,
    has_open_graph: clientFields.hasOpenGraph,
    has_schema: clientFields.hasSchema,
    has_search_console: clientFields.hasSearchConsole,
    h1_count: clientFields.h1Count,
    h1_text: clientFields.h1Text,
    h2_count: clientFields.h2Count,
    images_missing_alt: clientFields.imagesMissingAlt,
    total_images: clientFields.totalImages,
    has_canonical: clientFields.hasCanonical,
    description: clientFields.description,
    description_length: clientFields.descriptionLength,
    title: clientFields.title,
    title_length: clientFields.titleLength,
    internal_links: clientFields.internalLinks,
    psi_scores: clientFields.psiScores,
    ranked_problems: clientFields.rankedProblems,
    opportunity_score: clientFields.score !== undefined ? clientFields.score : clientFields.opportunityScore,
    total_score: clientFields.totalScore !== undefined ? clientFields.totalScore : clientFields.score,
    classification: clientFields.classification,
    viable: clientFields.viable,
    viable_status: clientFields.viableStatus,
    disqualify_reason: clientFields.disqualifyReason,
    ai_analysis: clientFields.aiAnalysis,
    initial_email: clientFields.initialEmail,
    follow_up1: clientFields.followUp1,
    follow_up2: clientFields.followUp2,
    follow_up3: clientFields.followUp3,
    subject_lines: clientFields.subjectLines,
    insights: clientFields.insights,
    primary_problem: clientFields.primaryProblem,
    outreach_angle: clientFields.outreachAngle,
    spam_reported: clientFields.spamReported,
    unsubscribed_at: clientFields.unsubscribedAt,
    bounced_at: clientFields.bouncedAt,
    updated_at: new Date().toISOString(),
  };
  Object.keys(dbRow).forEach(k => dbRow[k] === undefined && delete dbRow[k]);

  if (existingId) {
    const { error } = await supabase.from('lead_analysis').update(dbRow).eq('id', existingId);
    if (error) console.error('[DB] saveAnalysis error:', JSON.stringify(error, null, 2) || error);
  } else {
    const { error } = await supabase.from('lead_analysis').insert({
      id: generateUUID(),
      lead_id: finalLeadId,
      campaign_id: campaignId,
      user_id: userId,
      sent_status: 'not-sent',
      batch_status: null,
      ...dbRow,
    });
    if (error) console.error('[DB] saveAnalysis error:', JSON.stringify(error, null, 2) || error);
  }
};

// Fields the client is authoritative for — analysis results, edited copy, etc.
// Everything NOT in this list is owned by the server (cron/send routes) and
// must never be overwritten by a client-side bulk save, or an open tab with
// stale local state can silently undo a real send in progress.
const CLIENT_OWNED_ANALYSIS_FIELDS = new Set([
  'viable', 'crawlLayerLabel', 'hasHttps', 'hasBlog', 'blogAbandoned', 'lastPostDate',
  'wordCountEstimate', 'hasOpenGraph', 'hasSchema', 'hasSearchConsole', 'h1Count', 'h1Text',
  'h2Count', 'imagesMissingAlt', 'totalImages', 'hasCanonical', 'description', 'descriptionLength',
  'title', 'titleLength', 'internalLinks', 'psiScores', 'rankedProblems',
  'opportunityScore', 'totalScore', 'score', 'classification', 'viableStatus', 'disqualifyReason',
  'aiAnalysis', 'initialEmail', 'followUp1', 'followUp2', 'followUp3', 'subjectLines',
  'insights', 'primaryProblem', 'outreachAngle',
  // spam/bounce toggles are legitimately user-driven (manual flag buttons), keep client-owned
  'spamReported', 'unsubscribedAt', 'bouncedAt',
]);

// Server-owned: sent_status, sentAt, sentTo, lastEmailSentAt, followUp1/2/3Sent + SentAt,
// batchStatus, errorReason, initialMessageId, initialThreadId, status
// These are set only by /api/send-email, send-batch-now, and the cron functions.

function buildClientOwnedRow(analysis: any) {
  const row: any = {};
  for (const key of CLIENT_OWNED_ANALYSIS_FIELDS) {
    let val = analysis[key];
    if (val === undefined && analysis.seoData) {
      val = analysis.seoData[key];
    }
    row[key] = val;
  }
  // extra fallback for opportunity score
  if (row.opportunityScore === undefined && analysis.details?.opportunityScore !== undefined) {
    row.opportunityScore = analysis.details.opportunityScore;
  }
  // extra fallback for score
  if (row.score === undefined && analysis.score !== undefined) {
    row.score = analysis.score;
  }
  return row;
}

let saveBulkAnalysisPromise: Promise<any> = Promise.resolve();

export const saveBulkAnalysis = async (
  campaignId: string,
  userId: string,
  analyzedLeads: Record<number, any>,
  leads: any[]
) => {
  const currentPromise = saveBulkAnalysisPromise;
  
  let resolveLock: () => void;
  const newPromise = new Promise<void>(resolve => {
    resolveLock = resolve;
  });
  
  saveBulkAnalysisPromise = newPromise;
  
  try {
    await currentPromise;
  } catch (e) {
    // ignore previous execution errors
  }

  try {
    console.log('[DB] saveBulkAnalysis called with', Object.keys(analyzedLeads).length, 'analyzed leads,', leads.length, 'leads fallback');

    // Let's ALWAYS fetch all current leads for this campaign from Supabase to ensure we have the absolute latest IDs.
    const { data: dbLeads, error: dbLeadsError } = await supabase
      .from('leads')
      .select('id, row_index')
      .eq('campaign_id', campaignId);

    const dbLeadsMap = new Map<number, string>();
    if (!dbLeadsError && dbLeads) {
      for (const r of dbLeads) {
        if (r.row_index !== undefined && r.row_index !== null) {
          dbLeadsMap.set(parseInt(r.row_index), r.id);
        }
      }
    }

    // Also fallback to any in-memory leads if they contain _supabaseId and aren't in dbLeadsMap yet
    for (const l of (leads || [])) {
      if (l._supabaseId && l.rowIndex !== undefined && !dbLeadsMap.has(l.rowIndex)) {
        dbLeadsMap.set(l.rowIndex, l._supabaseId);
      }
    }

    // Check if any lead in our in-memory list is missing from the database map
    const missingAny = (leads || []).some(l => !dbLeadsMap.has(l.rowIndex));

    if (missingAny && leads && leads.length > 0) {
      console.log('[DB] saveBulkAnalysis: Some leads are missing from the database map. Auto-saving leads first to resolve IDs...');
      try {
        const savedLeads = await saveLeads(campaignId, userId, leads);
        // Re-populate the map with fresh saved leads
        dbLeadsMap.clear();
        for (const sl of savedLeads) {
          if (sl._supabaseId && sl.rowIndex !== undefined) {
            dbLeadsMap.set(sl.rowIndex, sl._supabaseId);
          }
        }
      } catch (err) {
        console.error('[DB] saveBulkAnalysis: failed to auto-save missing leads:', err);
      }
    }

    // To avoid ON CONFLICT 'lead_id' errors, fetch existing lead_analysis rows to obtain their ids
    const { data: existingAnalysisData, error: existingAnalysisError } = await supabase
      .from('lead_analysis')
      .select('id, lead_id')
      .eq('campaign_id', campaignId);

    const existingAnalysisMap = new Map<string, string>();
    if (!existingAnalysisError && existingAnalysisData) {
      for (const row of existingAnalysisData) {
        if (row.lead_id) {
          existingAnalysisMap.set(row.lead_id, row.id);
        }
      }
    }

    // Only rows that already exist get patched (client-owned fields only, via
    // per-row targeted update). New rows (no existing id) still get a full
    // insert since there's nothing server-owned to protect yet.
    const updates: Promise<any>[] = [];

    for (const [rowIndexKey, analysis] of Object.entries(analyzedLeads)) {
      const rxInt = parseInt(rowIndexKey);
      const leadId = dbLeadsMap.get(rxInt);
      if (!leadId) {
        console.warn(`[DB] saveBulkAnalysis: No lead found for rowIndex ${rxInt}`);
        continue;
      }

      const existingId = existingAnalysisMap.get(leadId);
      const clientFields = buildClientOwnedRow(analysis);

      const dbRow: any = {
        crawl_layer_label: clientFields.crawlLayerLabel,
        has_https: clientFields.hasHttps,
        has_blog: clientFields.hasBlog,
        blog_abandoned: clientFields.blogAbandoned,
        last_post_date: clientFields.lastPostDate,
        word_count_estimate: clientFields.wordCountEstimate,
        has_open_graph: clientFields.hasOpenGraph,
        has_schema: clientFields.hasSchema,
        has_search_console: clientFields.hasSearchConsole,
        h1_count: clientFields.h1Count,
        h1_text: clientFields.h1Text,
        h2_count: clientFields.h2Count,
        images_missing_alt: clientFields.imagesMissingAlt,
        total_images: clientFields.totalImages,
        has_canonical: clientFields.hasCanonical,
        description: clientFields.description,
        description_length: clientFields.descriptionLength,
        title: clientFields.title,
        title_length: clientFields.titleLength,
        internal_links: clientFields.internalLinks,
        psi_scores: clientFields.psiScores,
        ranked_problems: clientFields.rankedProblems,
        opportunity_score: clientFields.score !== undefined ? clientFields.score : clientFields.opportunityScore,
        total_score: clientFields.totalScore !== undefined ? clientFields.totalScore : clientFields.score,
        classification: clientFields.classification,
        viable: clientFields.viable,
        viable_status: clientFields.viableStatus,
        disqualify_reason: clientFields.disqualifyReason,
        ai_analysis: clientFields.aiAnalysis,
        initial_email: clientFields.initialEmail,
        follow_up1: clientFields.followUp1,
        follow_up2: clientFields.followUp2,
        follow_up3: clientFields.followUp3,
        subject_lines: clientFields.subjectLines,
        insights: clientFields.insights,
        primary_problem: clientFields.primaryProblem,
        outreach_angle: clientFields.outreachAngle,
        spam_reported: clientFields.spamReported,
        unsubscribed_at: clientFields.unsubscribedAt,
        bounced_at: clientFields.bouncedAt,
        updated_at: new Date().toISOString(),
      };
      // Strip undefined keys so Supabase doesn't null out columns we didn't touch
      Object.keys(dbRow).forEach(k => dbRow[k] === undefined && delete dbRow[k]);

      if (existingId) {
        updates.push(
          supabase.from('lead_analysis').update(dbRow).eq('id', existingId)
        );
      } else {
        updates.push(
          supabase.from('lead_analysis').insert({
            id: generateUUID(),
            lead_id: leadId,
            campaign_id: campaignId,
            user_id: userId,
            sent_status: 'not-sent',
            batch_status: null,
            ...dbRow,
          })
        );
      }
    }

    const results = await Promise.allSettled(updates);
    const failed = results.filter(r => r.status === 'rejected');
    if (failed.length > 0) {
      console.error('[DB] saveBulkAnalysis: some rows failed to save:', failed);
    }
  } finally {
    resolveLock!();
  }
};

export const deleteCampaignAnalysis = async (campaignId: string) => {
  const { error } = await supabase
    .from('lead_analysis')
    .delete()
    .eq('campaign_id', campaignId);
  if (error) console.error('[DB] deleteCampaignAnalysis error:', error);
};

// ============================================================
// REPLY STATUS
// ============================================================

export const getReplyStatus = async (campaignId: string) => {
  // 1. Fetch leads map first (id -> row_index)
  const { data: leadsData, error: leadsError } = await supabase
    .from('leads')
    .select('id, row_index')
    .eq('campaign_id', campaignId);

  if (leadsError) {
    console.error('[DB] getReplyStatus (fetching leads) error:', leadsError);
    return {};
  }

  const leadIdToRowIndex = new Map<string, number>();
  for (const l of (leadsData || [])) {
    if (l.id && l.row_index !== undefined && l.row_index !== null) {
      leadIdToRowIndex.set(l.id, parseInt(l.row_index));
    }
  }

  // 2. Fetch reply_status data directly
  const { data, error } = await supabase
    .from('reply_status')
    .select('*')
    .eq('campaign_id', campaignId);

  if (error) { console.error('[DB] getReplyStatus error:', error); return {}; }

  const result: Record<number, any> = {};
  for (const row of (data || [])) {
    const rowIndex = row.lead_id ? leadIdToRowIndex.get(row.lead_id) : undefined;
    if (rowIndex === undefined) continue;
    result[rowIndex] = {
      hasReplied: row.has_replied,
      isUnsubscribed: row.is_unsubscribed,
      isNegative: row.is_negative,
      isBounced: row.is_bounced,
      replyCount: row.reply_count,
      lastChecked: row.last_checked,
    };
  }
  return result;
};

export const saveReplyStatus = async (
  campaignId: string,
  userId: string,
  leadSupabaseId: string,
  status: any
) => {
  // Read-merge-write: both client and server independently detect replies by
  // polling Gmail, so either can have the more current answer. Never let a
  // stale client write regress a flag the server already flipped true.
  const { data: existing } = await supabase
    .from('reply_status')
    .select('id, has_replied, is_unsubscribed, is_negative, is_bounced, reply_count')
    .eq('lead_id', leadSupabaseId)
    .maybeSingle();

  const existingId = existing?.id;

  const merged = {
    has_replied: !!(existing?.has_replied || status.hasReplied),
    is_unsubscribed: !!(existing?.is_unsubscribed || status.isUnsubscribed),
    is_negative: !!(existing?.is_negative || status.isNegative),
    is_bounced: !!(existing?.is_bounced || status.isBounced),
    reply_count: Math.max(existing?.reply_count || 0, status.replyCount || 0),
  };

  const { error } = await supabase
    .from('reply_status')
    .upsert({
      id: existingId || generateUUID(),
      lead_id: leadSupabaseId,
      campaign_id: campaignId,
      user_id: userId,
      ...merged,
      last_checked: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' });
  if (error) console.error('[DB] saveReplyStatus error:', error);
};

export const deleteCampaignReplyStatus = async (campaignId: string) => {
  const { error } = await supabase
    .from('reply_status')
    .delete()
    .eq('campaign_id', campaignId);
  if (error) console.error('[DB] deleteCampaignReplyStatus error:', error);
};

// ============================================================
// REPUTATION
// ============================================================

export const getReputation = async (campaignId: string) => {
  const { data, error } = await supabase
    .from('reputation')
    .select('*')
    .eq('campaign_id', campaignId)
    .maybeSingle();
  if (error) return { bounces: 0, spamReports: 0, sentCount: 0 };
  if (!data) return { bounces: 0, spamReports: 0, sentCount: 0 };
  return {
    bounces: data.bounces || 0,
    spamReports: data.spam_reports || 0,
    sentCount: data.sent_count || 0,
    lastUpdated: data.last_updated,
  };
};

export const saveReputation = async (
  campaignId: string,
  userId: string,
  reputation: any
) => {
  const { data: existing } = await supabase
    .from('reputation')
    .select('id')
    .eq('campaign_id', campaignId)
    .maybeSingle();

  const existingId = existing?.id;

  const { error } = await supabase
    .from('reputation')
    .upsert({
      id: existingId || generateUUID(),
      campaign_id: campaignId,
      user_id: userId,
      bounces: reputation.bounces || 0,
      spam_reports: reputation.spamReports || 0,
      sent_count: reputation.sentCount || 0,
      last_updated: new Date().toISOString(),
    }, { onConflict: 'id' });
  if (error) console.error('[DB] saveReputation error:', error);
};

// ============================================================
// EMAIL TEMPLATES
// ============================================================

export const getEmailTemplates = async (userId: string) => {
  const { data, error } = await supabase
    .from('email_templates')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) { console.error('[DB] getEmailTemplates error:', error); return []; }
  return (data || []).map((row: any) => ({
    id: row.id,
    name: row.name,
    subject: row.subject,
    body: row.body,
  }));
};

export const saveEmailTemplate = async (userId: string, template: any) => {
  const { error } = await supabase
    .from('email_templates')
    .upsert({
      id: template.id,
      user_id: userId,
      name: template.name,
      subject: template.subject || '',
      body: template.body || '',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' });
  if (error) console.error('[DB] saveEmailTemplate error:', error);
};

export const deleteEmailTemplate = async (templateId: string) => {
  const { error } = await supabase
    .from('email_templates')
    .delete()
    .eq('id', templateId);
  if (error) console.error('[DB] deleteEmailTemplate error:', error);
};

// ============================================================
// BATCH SCHEDULE
// ============================================================

export const getBatchSchedule = async (campaignId: string) => {
  const { data, error } = await supabase
    .from('campaigns')
    .select('batch_schedule')
    .eq('id', campaignId)
    .single();

  if (!error) {
    const schedule = data?.batch_schedule || null;
    if (typeof window !== 'undefined' && schedule) {
      // keep the cache warm for offline/failure fallback only — never read from it first
      localStorage.setItem(`batch_schedule_${campaignId}`, JSON.stringify(schedule));
    }
    return schedule;
  }

  console.warn('[DB] getBatchSchedule: Supabase read failed, falling back to local cache:', error);
  if (typeof window !== 'undefined') {
    const cached = localStorage.getItem(`batch_schedule_${campaignId}`);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch (e) {}
    }
  }
  return null;
};

export const saveBatchSchedule = async (campaignId: string, schedule: any) => {
  if (typeof window !== 'undefined') {
    localStorage.setItem(`batch_schedule_${campaignId}`, JSON.stringify(schedule));
  }

  const { error } = await supabase
    .from('campaigns')
    .update({ batch_schedule: schedule })
    .eq('id', campaignId);
  if (error) console.error('[DB] saveBatchSchedule error:', error);
};

// ============================================================
// ADDITIONAL GMAIL ACCOUNTS (server side — for reference)
// ============================================================

export const getAdditionalAccounts = async (userId: string) => {
  const { data, error } = await supabase
    .from('gmail_accounts')
    .select('*')
    .eq('user_id', userId);
  if (error) { console.error('[DB] getAdditionalAccounts error:', error); return {}; }
  const result: Record<string, any> = {};
  for (const row of (data || [])) {
    result[row.email] = row.tokens;
  }
  return result;
};

export const saveAdditionalAccount = async (userId: string, email: string, tokens: any) => {
  const { error } = await supabase
    .from('gmail_accounts')
    .upsert({
      user_id: userId,
      email,
      tokens,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'email' });
  if (error) console.error('[DB] saveAdditionalAccount error:', error);
};

export const deleteAdditionalAccount = async (email: string) => {
  const { error } = await supabase
    .from('gmail_accounts')
    .delete()
    .eq('email', email);
  if (error) console.error('[DB] deleteAdditionalAccount error:', error);
};

// ============================================================
// QUOTA TRACKING (server side — for reference)
// ============================================================

export const getQuota = async (userId: string, accountEmail: string) => {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('quota')
    .select('count')
    .eq('user_id', userId)
    .eq('account_email', accountEmail)
    .eq('date', today)
    .single();
  if (error) return 0;
  return data?.count || 0;
};

export const incrementQuota = async (userId: string, accountEmail: string) => {
  const today = new Date().toISOString().slice(0, 10);
  const current = await getQuota(userId, accountEmail);
  const { error } = await supabase
    .from('quota')
    .upsert({
      user_id: userId,
      account_email: accountEmail,
      date: today,
      count: current + 1,
    }, { onConflict: 'account_email,date' });
  if (error) console.error('[DB] incrementQuota error:', error);
};

// ============================================================
// CROSS-CAMPAIGN DUPLICATE CHECK
// ============================================================
export const checkCrossCampaignDuplicates = async (
  userId: string,
  currentCampaignId: string,
  incomingLeads: { website?: string; email?: string }[]
) => {
  const websites = Array.from(new Set(incomingLeads.map(l => (l.website || '').trim().toLowerCase()).filter(Boolean)));
  const emails = Array.from(new Set(incomingLeads.map(l => (l.email || '').trim().toLowerCase()).filter(Boolean)));
  if (!websites.length && !emails.length) return { count: 0, matchKeys: [] as string[], campaignNames: [] as string[] };

  const orParts: string[] = [];
  if (websites.length) orParts.push(`website.in.(${websites.map(w => `"${w}"`).join(',')})`);
  if (emails.length) orParts.push(`email.in.(${emails.map(e => `"${e}"`).join(',')})`);

  const { data: matchedLeads, error } = await supabase
    .from('leads')
    .select('id, website, email, campaign_id')
    .eq('user_id', userId)
    .neq('campaign_id', currentCampaignId)
    .or(orParts.join(','));

  if (error || !matchedLeads?.length) {
    if (error) console.error('[DB] checkCrossCampaignDuplicates leads fetch error:', error);
    return { count: 0, matchKeys: [] as string[], campaignNames: [] as string[] };
  }

  const leadIds = matchedLeads.map((l: any) => l.id);
  const { data: sentRows, error: sentErr } = await supabase
    .from('lead_analysis')
    .select('lead_id, sent_status')
    .in('lead_id', leadIds)
    .eq('sent_status', 'sent');

  if (sentErr) console.error('[DB] checkCrossCampaignDuplicates lead_analysis fetch error:', sentErr);

  const sentLeadIds = new Set((sentRows || []).map((r: any) => r.lead_id));
  const alreadySent = matchedLeads.filter((l: any) => sentLeadIds.has(l.id));

  // Fetch campaign names explicitly to avoid foreign key dependency
  const uniqueCampaignIds = Array.from(new Set(alreadySent.map((l: any) => l.campaign_id).filter(Boolean)));
  const campaignNamesMap: Record<string, string> = {};
  if (uniqueCampaignIds.length > 0) {
    const { data: campaignsData, error: campaignsError } = await supabase
      .from('campaigns')
      .select('id, name')
      .in('id', uniqueCampaignIds);
    if (!campaignsError && campaignsData) {
      campaignsData.forEach((c: any) => {
        campaignNamesMap[c.id] = c.name;
      });
    }
  }

  const matchKeys = new Set<string>();
  alreadySent.forEach((l: any) => {
    if (l.website) matchKeys.add(String(l.website).trim().toLowerCase());
    if (l.email) matchKeys.add(String(l.email).trim().toLowerCase());
  });

  const campaignNames = Array.from(new Set(alreadySent.map((l: any) => campaignNamesMap[l.campaign_id]).filter(Boolean)));

  return { count: alreadySent.length, matchKeys: Array.from(matchKeys), campaignNames };
};

export const deleteLead = async (leadId: string) => {
  const { error: analysisErr } = await supabase.from('lead_analysis').delete().eq('lead_id', leadId);
  if (analysisErr) console.error('[DB] deleteLead (lead_analysis) error:', analysisErr);

  const { error: replyErr } = await supabase.from('reply_status').delete().eq('lead_id', leadId);
  if (replyErr) console.error('[DB] deleteLead (reply_status) error:', replyErr);

  const { error } = await supabase.from('leads').delete().eq('id', leadId);
  if (error) console.error('[DB] deleteLead error:', error);
};

