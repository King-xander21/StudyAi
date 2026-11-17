// supabase/functions/ai-chat/index.ts  — GEMINI (robust)
// AI Tutor: embeds the question, retrieves the most relevant chunks of the
// student's documents, and answers grounded in them.
//  - knows which document the student is reading (so it never falsely says
//    "you haven't uploaded anything")
//  - if a document-scoped search is empty, falls back to searching all docs
//  - retries the embedding call once (guards against a flaky/cold request)
//
// Deploy:  supabase functions deploy ai-chat
// Secret:  supabase secrets set GEMINI_API_KEY=...

import { createClient } from 'jsr:@supabase/supabase-js@2';

const GEMINI_KEY  = Deno.env.get('GEMINI_API_KEY')!;
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const CHAT_MODEL  = 'gemini-3.6-flash';
const EMBED_MODEL = 'gemini-embedding-001';
const EMBED_DIMS  = 1536;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

// Gemini native embedding, fixed to EMBED_DIMS, with one retry
async function embed(text: string): Promise<number[]> {
  let lastErr = '';
  for (let i = 0; i < 2; i++) {
    const r = await fetch(`${GEMINI_BASE}/models/${EMBED_MODEL}:embedContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': GEMINI_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { parts: [{ text }] }, outputDimensionality: EMBED_DIMS }),
    });
    if (r.ok) return (await r.json()).embedding.values;
    lastErr = await r.text();
  }
  throw new Error('Embedding failed: ' + lastErr);
}

// ---- plan limits (per day) ----
const LIMITS: Record<string, Record<string, number>> = {
  free:    { chat: 15,   generate: 5,   ingest: 3 },
  pro:     { chat: 300,  generate: 100, ingest: 50 },
  premium: { chat: 5000, generate: 2000, ingest: 500 },
};
// ---- per-plan model + document size ----
const PLAN_TIER: Record<string, { model: string; maxChunks: number }> = {
  free:    { model: 'gemini-3.6-flash', maxChunks: 40 },
  pro:     { model: 'gemini-3.6-flash', maxChunks: 120 },
  premium: { model: 'gemini-3.7-flash', maxChunks: 400 },   // smarter model + bigger docs
};
async function enforceLimit(admin: any, userId: string, kind: string) {
  const { data: prof } = await admin.from('profiles').select('plan').eq('id', userId).single();
  const plan = prof?.plan || 'free';
  const limit = (LIMITS[plan] || LIMITS.free)[kind] ?? 999999;
  const { data, error } = await admin.rpc('bump_usage', { p_user: userId, p_kind: kind, p_limit: limit });
  if (error) return { ok: true, plan, limit };   // fail-open if usage infra not set up
  return { ok: data === true, plan, limit };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
// Friendly, user-facing names for the raw model ids
const MODEL_LABELS: Record<string, string> = {
  'gemini-3.6-flash': 'Gemini 3.6 Flash',
  'gemini-3.7-flash': 'Gemini 3.7 Flash',
};
const labelFor = (m: string) => MODEL_LABELS[m] || m;
// Try each model in order; retry once on 503/429, then fall back to the next model.
// Returns both the text AND the model that actually produced it (so the UI can
// reflect a fallback truthfully, e.g. premium 3.7 → 3.6 when 3.7 is overloaded).
async function chatComplete(models: string[], body: Record<string, unknown>): Promise<{ text: string; model: string }> {
  let last = '';
  for (const m of models) {
    for (let a = 0; a < 2; a++) {
      const r = await fetch(`${GEMINI_BASE}/openai/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${GEMINI_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, model: m }),
      });
      if (r.ok) return { text: (await r.json()).choices[0].message.content, model: m };
      last = await r.text();
      if ((r.status === 503 || r.status === 429) && a < 1) { await sleep(1500); continue; }
      break; // persistent error → try the next model
    }
  }
  throw new Error('Chat failed: ' + last);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const { question, documentId } = await req.json();
    if (!question) return json({ error: 'Missing question' }, 400);

    const authed = createClient(
      Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } },
    );
    const { data: { user } } = await authed.auth.getUser();
    if (!user) return json({ error: 'Unauthorized' }, 401);

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // Enforce the daily message limit for this user's plan
    const gate = await enforceLimit(admin, user.id, 'chat');
    if (!gate.ok) {
      return json({ answer: `You've reached the ${gate.plan} plan's limit of ${gate.limit} tutor messages for today. Your quota resets tomorrow — upgrade to Pro for much higher limits.`, sources: [], limitReached: true, plan: gate.plan });
    }

    // Which document is the student reading? (also: do they have ANY docs?)
    let docTitle: string | null = null;
    if (documentId) {
      const { data: doc } = await admin.from('documents').select('title').eq('id', documentId).single();
      docTitle = doc?.title ?? null;
    }
    const { count: docCount } = await admin.from('documents')
      .select('id', { count: 'exact', head: true }).eq('user_id', user.id);

    // Recent conversation on this thread, for continuity ("remember previous chats").
    // Scoped to the document being read (or the "all materials" thread when none is open).
    let history: { role: string; content: string }[] = [];
    {
      let hq = admin.from('chat_messages')
        .select('role,content,created_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(10);
      hq = documentId ? hq.eq('document_id', documentId) : hq.is('document_id', null);
      const { data: hist } = await hq;
      history = (hist || []).reverse().map((m: any) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: String(m.content || '').slice(0, 2000),
      }));
    }

    // 1) embed the question
    const queryEmbedding = await embed(question);

    // 2) retrieve — scoped to the open document first, then fall back to all docs
    async function match(docFilter: string | null) {
      const { data } = await admin.rpc('match_chunks', {
        query_embedding: queryEmbedding, match_user: user.id,
        match_document: docFilter, match_count: 6,
      });
      return data || [];
    }
    // Strict scoping: when a document is open, search ONLY that document —
    // never borrow content from a different document.
    const chunks = await match(documentId ?? null);
    const hasContext = chunks.length > 0;

    // 3) build the prompt
    const context = chunks.map((c: any, i: number) => `[Source ${i + 1} · p.${c.page ?? '?'}]\n${c.content}`).join('\n\n');
    const reading = docTitle ? ` The student is currently reading the document "${docTitle}".` : '';
    let system;
    if (hasContext) {
      system = `You are StudyAI, a patient, encouraging tutor.${reading} Answer using ONLY the sources below. If the answer isn't fully in them, say what's missing and clearly label any general-knowledge part. Never invent facts, and never claim the student hasn't uploaded anything — their materials are the sources below.\n\nSOURCES:\n${context}`;
    } else if (documentId) {
      // A specific document is open but has no searchable text — do NOT answer from other documents.
      system = `You are StudyAI, a patient, encouraging tutor. The student is reading the document "${docTitle ?? 'this document'}", but it has no searchable text yet — it may still be processing, or text could not be extracted from it. Tell them this document isn't ready to answer from yet and to try again in a moment or pick another document. Do NOT use or mention any other document. You may briefly offer general-knowledge help if they ask, clearly labeled as general knowledge.`;
    } else if (docCount && docCount > 0) {
      system = `You are StudyAI, a patient, encouraging tutor. No passage of their materials closely matched this question, but they DO have documents uploaded — do NOT say they haven't uploaded anything. Answer helpfully from general knowledge (label it as such) and invite them to open a specific document.`;
    } else {
      system = `You are StudyAI, a patient, encouraging tutor. The student has not uploaded any materials yet, so answer from general knowledge and say so. Encourage them to upload notes for grounded answers.`;
    }

    // 4) ask the model (premium tries the smarter model, then falls back if it's unavailable)
    const model = (PLAN_TIER[gate.plan] || PLAN_TIER.free).model;
    const models = model === 'gemini-3.6-flash' ? [model] : [model, 'gemini-3.6-flash'];
    let answer: string;
    let usedModel: string;
    try {
      const result = await chatComplete(models, {
        reasoning_effort: 'low',
        max_tokens: 1200,
        messages: [
          { role: 'system', content: system },
          ...history,                                  // prior turns → the model remembers the conversation
          { role: 'user', content: question },
        ],
      });
      answer = result.text;
      usedModel = result.model;
    } catch (e) {
      return json({ error: String((e as Error).message || e) }, 502);
    }

    await admin.from('chat_messages').insert([
      { user_id: user.id, document_id: documentId ?? null, role: 'user', content: question },
      { user_id: user.id, document_id: documentId ?? null, role: 'assistant', content: answer, sources: chunks },
    ]);

    return json({
      answer,
      sources: hasContext ? chunks : [],
      plan: gate.plan,
      model: usedModel,                 // raw id of the model that actually answered
      modelLabel: labelFor(usedModel),  // friendly name for the UI
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
