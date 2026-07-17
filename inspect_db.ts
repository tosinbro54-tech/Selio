import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_ANON_KEY || '';

if (!supabaseUrl || !supabaseKey) {
  console.error('SUPABASE_URL or SUPABASE_ANON_KEY is not set');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function inspect() {
  console.log('Fetching campaigns...');
  const { data: campaigns } = await supabase.from('campaigns').select('*');
  console.log('Campaigns:', campaigns?.map(c => ({ id: c.id, name: c.name })));

  for (const c of (campaigns || [])) {
    console.log(`\n--- Campaign: ${c.name} (${c.id}) ---`);
    const { data: leads } = await supabase.from('leads').select('*').eq('campaign_id', c.id);
    console.log(`Total Leads: ${leads?.length}`);
    for (const l of (leads || [])) {
      console.log(`  Lead: ${l.company} (${l.id}) - rowIndex: ${l.row_index} - email: ${l.email}`);
    }

    const { data: analysis } = await supabase.from('lead_analysis').select('*').eq('campaign_id', c.id);
    console.log(`Total Analysis rows: ${analysis?.length}`);
    for (const a of (analysis || [])) {
      console.log(`  Analysis: id: ${a.id}, lead_id: ${a.lead_id}, sent_status: ${a.sent_status}, batch_status: ${a.batch_status}`);
    }
  }
}

inspect();
