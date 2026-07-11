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

// ============================================================
// CAMPAIGNS
// ============================================================

export const getCampaigns = async (userId: string) => {
  const { data, error } = await supabase
    .from('campaigns')
    .select('*')
    .eq('user_id', userId)
    .order('last_opened', { ascending: false });
  if (error) { console.error('[DB] getCampaigns error:', error); return []; }
  return data || [];
};

export const saveCampaign = async (campaign: any, userId: string) => {
  const { data, error } = await supabase
    .from('campaigns')
    .upsert({
      id: campaign.id,
      user_id: userId,
      name: campaign.name,
      country: campaign.country,
      industry: campaign.industry,
      decision_maker_title: campaign.decisionMakerTitle,
      icp_context: campaign.icpContext,
      sender_account_id: campaign.senderAccountId,
      follow_up_start_time: campaign.followUpStartTime,
      follow_up_end_time: campaign.followUpEndTime,
      follow_up1_days: campaign.followUp1Days || 3,
      follow_up2_days: campaign.followUp2Days || 10,
      follow_up3_days: campaign.followUp3Days || 17,
      schedule_start_time: campaign.scheduleStartTime || '09:00',
      schedule_end_time: campaign.scheduleEndTime || '11:00',
      daily_limit: campaign.dailyLimit || 50,
      lead_count: campaign.leadCount || 0,
      analyzed_count: campaign.analyzedCount || 0,
      sent_count: campaign.sentCount || 0,
      reply_count: campaign.replyCount || 0,
      last_opened: new Date().toISOString(),
    }, { onConflict: 'id' });
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
  if (!leads.length) {
    const { error } = await supabase.from('leads').delete().eq('campaign_id', campaignId);
    if (error) console.error('[DB] saveLeads delete all error:', error);
    return [];
  }

  // Fetch existing lead IDs from DB to remove any database records that were deleted from the UI list
  const { data: dbLeads, error: fetchError } = await supabase
    .from('leads')
    .select('id')
    .eq('campaign_id', campaignId);

  if (!fetchError && dbLeads) {
    const currentDbIds = dbLeads.map(l => l.id);
    const incomingIds = new Set(leads.map(l => l._supabaseId).filter(Boolean));
    const idsToDelete = currentDbIds.filter(id => !incomingIds.has(id));
    if (idsToDelete.length > 0) {
      await supabase.from('leads').delete().in('id', idsToDelete);
    }
  }

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
    console.error('[DB] getAnalysis (fetching leads) error:', leadsError);
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

  if (error) { console.error('[DB] getAnalysis error:', error); return {}; }

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
      initialEmail: row.initial_email,
      followUp1: row.follow_up1,
      followUp2: row.follow_up2,
      followUp3: row.follow_up3,
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

    if (dbLead) {
      finalLeadId = dbLead.id;
    }
  }

  if (!finalLeadId) {
    console.warn('[DB] saveAnalysis warning: Could not resolve lead_id for rowIndex', rowIndex);
    return;
  }

  // Fetch any existing lead_analysis row to get its ID for primary key upsert
  const { data: existing } = await supabase
    .from('lead_analysis')
    .select('id')
    .eq('lead_id', finalLeadId)
    .maybeSingle();

  const existingId = existing?.id;

  const { error } = await supabase
    .from('lead_analysis')
    .upsert({
      id: existingId || generateUUID(),
      lead_id: finalLeadId,
      campaign_id: campaignId,
      user_id: userId,
      viable: analysis.viable,
      crawl_layer_label: analysis.crawlLayerLabel || analysis.seoData?.crawlLayerLabel,
      has_https: analysis.hasHttps !== undefined ? analysis.hasHttps : analysis.seoData?.hasHttps,
      has_blog: analysis.hasBlog !== undefined ? analysis.hasBlog : analysis.seoData?.hasBlog,
      blog_abandoned: analysis.blogAbandoned !== undefined ? analysis.blogAbandoned : analysis.seoData?.blogAbandoned,
      last_post_date: analysis.lastPostDate || analysis.seoData?.lastPostDate,
      word_count_estimate: analysis.wordCountEstimate !== undefined ? analysis.wordCountEstimate : analysis.seoData?.wordCountEstimate,
      has_open_graph: analysis.hasOpenGraph !== undefined ? analysis.hasOpenGraph : analysis.seoData?.hasOpenGraph,
      has_schema: analysis.hasSchema !== undefined ? analysis.hasSchema : analysis.seoData?.hasSchema,
      has_search_console: analysis.hasSearchConsole !== undefined ? analysis.hasSearchConsole : analysis.seoData?.hasSearchConsole,
      h1_count: analysis.h1Count !== undefined ? analysis.h1Count : analysis.seoData?.h1Count,
      h1_text: analysis.h1Text || analysis.seoData?.h1Text,
      h2_count: analysis.h2Count !== undefined ? analysis.h2Count : analysis.seoData?.h2Count,
      images_missing_alt: analysis.imagesMissingAlt !== undefined ? analysis.imagesMissingAlt : analysis.seoData?.imagesMissingAlt,
      total_images: analysis.totalImages !== undefined ? analysis.totalImages : analysis.seoData?.totalImages,
      has_canonical: analysis.hasCanonical !== undefined ? analysis.hasCanonical : analysis.seoData?.hasCanonical,
      description: analysis.description || analysis.seoData?.description,
      description_length: analysis.descriptionLength !== undefined ? analysis.descriptionLength : analysis.seoData?.descriptionLength,
      title: analysis.title || analysis.seoData?.title,
      title_length: analysis.titleLength !== undefined ? analysis.titleLength : analysis.seoData?.titleLength,
      internal_links: analysis.internalLinks || analysis.seoData?.internalLinks,
      psi_scores: analysis.psiScores || analysis.seoData?.psiScores,
      ranked_problems: analysis.rankedProblems || analysis.seoData?.rankedProblems,
      opportunity_score: analysis.score !== undefined ? analysis.score : (analysis.opportunityScore !== undefined ? analysis.opportunityScore : (analysis.details?.opportunityScore || 0)),
      total_score: analysis.totalScore !== undefined ? analysis.totalScore : (analysis.score || 0),
      classification: analysis.classification,
      status: analysis.status,
      viable_status: analysis.viableStatus,
      disqualify_reason: analysis.disqualifyReason,
      ai_analysis: analysis.aiAnalysis,
      initial_email: analysis.initialEmail,
      follow_up1: analysis.followUp1,
      follow_up2: analysis.followUp2,
      follow_up3: analysis.followUp3,
      subject_lines: analysis.subjectLines,
      insights: analysis.insights,
      primary_problem: analysis.primaryProblem,
      outreach_angle: analysis.outreachAngle,
      sent_status: analysis.sentStatus || 'not-sent',
      sent_at: analysis.sentAt,
      sent_to: analysis.sentTo,
      last_email_sent_at: analysis.lastEmailSentAt,
      follow_up1_sent: analysis.followUp1Sent || false,
      follow_up1_sent_at: analysis.followUp1SentAt,
      follow_up2_sent: analysis.followUp2Sent || false,
      follow_up2_sent_at: analysis.followUp2SentAt,
      follow_up3_sent: analysis.followUp3Sent || false,
      follow_up3_sent_at: analysis.followUp3SentAt,
      batch_status: analysis.batchStatus || 'queued',
      error_reason: analysis.errorReason,
      spam_reported: analysis.spamReported || false,
      unsubscribed_at: analysis.unsubscribedAt,
      bounced_at: analysis.bouncedAt,
      initial_message_id: analysis.initialMessageId,
      initial_thread_id: analysis.initialThreadId,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' });
  if (error) console.error('[DB] saveAnalysis error:', JSON.stringify(error, null, 2) || error);
};

export const saveBulkAnalysis = async (
  campaignId: string,
  userId: string,
  analyzedLeads: Record<number, any>,
  leads: any[]
) => {
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

  const rows = Object.entries(analyzedLeads).map(([rowIndexKey, analysis]) => {
    const rxInt = parseInt(rowIndexKey);
    const leadId = dbLeadsMap.get(rxInt);

    if (!leadId) {
      console.warn(`[DB] saveBulkAnalysis: No lead found with campaign_id ${campaignId} and rowIndex ${rxInt}`);
    }

    const existingId = leadId ? existingAnalysisMap.get(leadId) : undefined;

    return {
      id: existingId || generateUUID(),
      lead_id: leadId,
      campaign_id: campaignId,
      user_id: userId,
      viable: analysis.viable,
      crawl_layer_label: analysis.crawlLayerLabel || analysis.seoData?.crawlLayerLabel,
      has_https: analysis.hasHttps !== undefined ? analysis.hasHttps : analysis.seoData?.hasHttps,
      has_blog: analysis.hasBlog !== undefined ? analysis.hasBlog : analysis.seoData?.hasBlog,
      blog_abandoned: analysis.blogAbandoned !== undefined ? analysis.blogAbandoned : analysis.seoData?.blogAbandoned,
      last_post_date: analysis.lastPostDate || analysis.seoData?.lastPostDate,
      word_count_estimate: analysis.wordCountEstimate !== undefined ? analysis.wordCountEstimate : analysis.seoData?.wordCountEstimate,
      has_open_graph: analysis.hasOpenGraph !== undefined ? analysis.hasOpenGraph : analysis.seoData?.hasOpenGraph,
      has_schema: analysis.hasSchema !== undefined ? analysis.hasSchema : analysis.seoData?.hasSchema,
      has_search_console: analysis.hasSearchConsole !== undefined ? analysis.hasSearchConsole : analysis.seoData?.hasSearchConsole,
      h1_count: analysis.h1Count !== undefined ? analysis.h1Count : analysis.seoData?.h1Count,
      h1_text: analysis.h1Text || analysis.seoData?.h1Text,
      h2_count: analysis.h2Count !== undefined ? analysis.h2Count : analysis.seoData?.h2Count,
      images_missing_alt: analysis.imagesMissingAlt !== undefined ? analysis.imagesMissingAlt : analysis.seoData?.imagesMissingAlt,
      total_images: analysis.totalImages !== undefined ? analysis.totalImages : analysis.seoData?.totalImages,
      has_canonical: analysis.hasCanonical !== undefined ? analysis.hasCanonical : analysis.seoData?.hasCanonical,
      description: analysis.description || analysis.seoData?.description,
      description_length: analysis.descriptionLength !== undefined ? analysis.descriptionLength : analysis.seoData?.descriptionLength,
      title: analysis.title || analysis.seoData?.title,
      title_length: analysis.titleLength !== undefined ? analysis.titleLength : analysis.seoData?.titleLength,
      internal_links: analysis.internalLinks || analysis.seoData?.internalLinks,
      psi_scores: analysis.psiScores || analysis.seoData?.psiScores,
      ranked_problems: analysis.rankedProblems || analysis.seoData?.rankedProblems,
      opportunity_score: analysis.score !== undefined ? analysis.score : (analysis.opportunityScore !== undefined ? analysis.opportunityScore : (analysis.details?.opportunityScore || 0)),
      total_score: analysis.totalScore !== undefined ? analysis.totalScore : (analysis.score || 0),
      classification: analysis.classification,
      status: analysis.status,
      viable_status: analysis.viableStatus,
      disqualify_reason: analysis.disqualifyReason,
      ai_analysis: analysis.aiAnalysis,
      initial_email: analysis.initialEmail,
      follow_up1: analysis.followUp1,
      follow_up2: analysis.followUp2,
      follow_up3: analysis.followUp3,
      subject_lines: analysis.subjectLines,
      insights: analysis.insights,
      primary_problem: analysis.primaryProblem,
      outreach_angle: analysis.outreachAngle,
      sent_status: analysis.sentStatus || 'not-sent',
      sent_at: analysis.sentAt,
      sent_to: analysis.sentTo,
      last_email_sent_at: analysis.lastEmailSentAt,
      follow_up1_sent: analysis.followUp1Sent || false,
      follow_up1_sent_at: analysis.followUp1SentAt,
      follow_up2_sent: analysis.followUp2Sent || false,
      follow_up2_sent_at: analysis.followUp2SentAt,
      follow_up3_sent: analysis.followUp3Sent || false,
      follow_up3_sent_at: analysis.followUp3SentAt,
      batch_status: analysis.batchStatus || 'queued',
      error_reason: analysis.errorReason,
      spam_reported: analysis.spamReported || false,
      unsubscribed_at: analysis.unsubscribedAt,
      bounced_at: analysis.bouncedAt,
      initial_message_id: analysis.initialMessageId,
      initial_thread_id: analysis.initialThreadId,
      updated_at: new Date().toISOString(),
    };
  }).filter(row => row.lead_id);

  console.log('[DB] saving', rows.length, 'rows to lead_analysis table in Supabase');

  if (!rows.length) {
    console.warn('[DB] No valid rows to save (all missing lead_id!). dbLeads count:', dbLeads?.length);
    return;
  }
  const { error } = await supabase
    .from('lead_analysis')
    .upsert(rows, { onConflict: 'id' });
  if (error) console.error('[DB] saveBulkAnalysis error:', JSON.stringify(error, null, 2) || error);
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
  // Fetch any existing reply_status row to get its ID for primary key upsert
  const { data: existing } = await supabase
    .from('reply_status')
    .select('id')
    .eq('lead_id', leadSupabaseId)
    .maybeSingle();

  const existingId = existing?.id;

  const { error } = await supabase
    .from('reply_status')
    .upsert({
      id: existingId || generateUUID(),
      lead_id: leadSupabaseId,
      campaign_id: campaignId,
      user_id: userId,
      has_replied: status.hasReplied || false,
      is_unsubscribed: status.isUnsubscribed || false,
      is_negative: status.isNegative || false,
      is_bounced: status.isBounced || false,
      reply_count: status.replyCount || 0,
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
  if (typeof window !== 'undefined') {
    const cached = localStorage.getItem(`batch_schedule_${campaignId}`);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch (e) {}
    }
  }

  const { data, error } = await supabase
    .from('campaigns')
    .select('batch_schedule')
    .eq('id', campaignId)
    .single();
  if (error) return null;
  return data?.batch_schedule || null;
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
