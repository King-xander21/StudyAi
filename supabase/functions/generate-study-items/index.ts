// supabase/functions/generate-study-items/index.ts  — GEMINI
// Generates flashcards OR quiz questions from a document's text and saves them.
//   kind: 'flashcards' -> inserts into `flashcards`, returns { flashcards:[...] }
//   kind: 'quiz'       -> inserts a `quizzes` row, returns { quizId, questions:[...] }
//
// Deploy:  supabase functions deploy generate-study-items
// (uses the same GEMINI_API_KEY secret)

import { createClient } from 'jsr:@supabase/supabase-js@2';

const GEMINI_KEY  = Deno.env.get('GEMINI_API_KEY')!;
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const CHAT_MODEL  = 'gemini-3.6-flash';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

// Pull the first {...} JSON object out of a model reply, tolerant of code fences
function parseJson(text: string): any {
  let t = (text || '').trim().replace(/^```(json)?/i, '').replace(/```$/,'').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a !== -1 && b !== -1) t = t.slice(a, b + 1);
  return JSON.parse(t);
}

const LIMITS: Record<string, Record<string, number>> = {
  free:    { chat: 15,   generate: 5,   ingest: 3 },
  pro:     { chat: 300,  generate: 100, ingest: 50 },
  premium: { chat: 5000, generate: 2000, ingest: 500 },
};
const PLAN_TIER: Record<string, { model: string }> = {
  free:    { model: 'gemini-3.6-flash' },
  pro:     { model: 'gemini-3.6-flash' },
  premium: { model: 'gemini-3.7-flash' },
};
async function enforceLimit(admin: any, userId: string, kind: string) {
  const { data: prof } = await admin.from('profiles').select('plan').eq('id', userId).single();
  const plan = prof?.plan || 'free';
  const limit = (LIMITS[plan] || LIMITS.free)[kind] ?? 999999;
  const { data, error } = await admin.rpc('bump_usage', { p_user: userId, p_kind: kind, p_limit: limit });
  if (error) return { ok: true, plan, limit };
  return { ok: data === true, plan, limit };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const { documentId, kind = 'flashcards', count = 10, difficulty = 'Medium' } = await req.json();
    if (!documentId) return json({ error: 'Missing documentId' }, 400);

    // who is calling
    const authed = createClient(
      Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } },
    );
    const { data: { user } } = await authed.auth.getUser();
    if (!user) return json({ error: 'Unauthorized' }, 401);

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const gate = await enforceLimit(admin, user.id, 'generate');
    if (!gate.ok) return json({ error: `Daily generation limit reached (${gate.limit}/day on the ${gate.plan} plan). Upgrade for more, or try again tomorrow.`, limitReached: true }, 200);

    // gather the document's text
    const { data: doc } = await admin.from('documents').select('title').eq('id', documentId).single();
    const { data: chunks } = await admin.from('doc_chunks')
      .select('content').eq('document_id', documentId).eq('user_id', user.id).limit(20);
    const context = (chunks || []).map((c: any) => c.content).join('\n\n').slice(0, 12000);
    if (!context) return json({ error: 'No content found for this document. Make sure it finished processing.' }, 422);

    // prompt
    const schema = kind === 'quiz'
      ? `{ "quiz": [ { "q": "question text", "options": ["A","B","C","D"], "correct": 0, "explanation": "why" } ] }`
      : `{ "flashcards": [ { "front": "question/term", "back": "answer/definition", "difficulty": "easy|medium|hard" } ] }`;
    const instruction = kind === 'quiz'
      ? `Create ${count} ${difficulty} multiple-choice questions (exactly 4 options each; "correct" is the 0-based index).`
      : `Create ${count} flashcards.`;

    const wanted = (PLAN_TIER[gate.plan] || PLAN_TIER.free).model;
    const models = wanted === 'gemini-3.6-flash' ? [wanted] : [wanted, 'gemini-3.6-flash'];
    const body = {
      reasoning_effort: 'low',
      messages: [
        { role: 'system', content: `You are StudyAI. Base everything strictly on the SOURCES. Respond with ONLY valid JSON in exactly this shape: ${schema}\n\nSOURCES:\n${context}` },
        { role: 'user', content: instruction },
      ],
    };
    let raw = '';
    let lastErr = '';
    for (const m of models) {
      let done = false;
      for (let a = 0; a < 2; a++) {
        const r = await fetch(`${GEMINI_BASE}/openai/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${GEMINI_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...body, model: m }),
        });
        if (r.ok) { raw = (await r.json()).choices[0].message.content; done = true; break; }
        lastErr = await r.text();
        if ((r.status === 503 || r.status === 429) && a < 1) { await new Promise(res => setTimeout(res, 1500)); continue; }
        break;
      }
      if (done) break;
    }
    if (!raw) return json({ error: 'Generation failed: ' + lastErr }, 502);

    let parsed: any;
    try { parsed = parseJson(raw); } catch { return json({ error: 'Model returned invalid JSON' }, 502); }

    if (kind === 'quiz') {
      const questions = (parsed.quiz || []).filter((q: any) => q.q && Array.isArray(q.options));
      if (!questions.length) return json({ error: 'No questions generated' }, 502);
      const { data: quiz, error } = await admin.from('quizzes')
        .insert({ user_id: user.id, document_id: documentId, title: `Quiz · ${doc?.title ?? 'Document'}`, questions })
        .select().single();
      if (error) throw error;
      return json({ quizId: quiz.id, questions });
    } else {
      const cards = (parsed.flashcards || []).filter((c: any) => c.front && c.back)
        .map((c: any) => ({ user_id: user.id, document_id: documentId, front: c.front, back: c.back, difficulty: (c.difficulty || 'medium').toLowerCase() }));
      if (!cards.length) return json({ error: 'No flashcards generated' }, 502);
      const { data: inserted, error } = await admin.from('flashcards').insert(cards).select();
      if (error) throw error;
      return json({ flashcards: inserted });
    }
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
