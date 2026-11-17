// supabase/functions/ingest-document/index.ts  — GEMINI + VISION OCR
// download -> extract text (fast parser, else Gemini vision OCR) -> chunk -> embed -> store.
// Handles normal PDFs, equation-heavy / scanned PDFs, and photos of handwritten notes.
//
// Deploy:  supabase functions deploy ingest-document
// (uses the same GEMINI_API_KEY secret)

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { extractText, getDocumentProxy } from 'https://esm.sh/unpdf@0.12.1';

const GEMINI_KEY  = Deno.env.get('GEMINI_API_KEY')!;
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const OCR_MODEL   = 'gemini-3.6-flash';        // vision-capable
const EMBED_MODEL = 'gemini-embedding-001';
const EMBED_DIMS  = 1536;
const BATCH = 50;              // embeddings per request (free-tier friendly)
const MAX_CHUNKS = 40;         // cap per document so large PDFs don't blow the quota
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

function chunkText(text: string, size = 1500, overlap = 200) {
  const clean = text.replace(/\s+/g, ' ').trim();
  const chunks: { text: string; page: number }[] = [];
  for (let i = 0; i < clean.length; i += size - overlap) {
    chunks.push({ text: clean.slice(i, i + size), page: Math.floor(i / 2500) + 1 });
  }
  return chunks.filter(c => c.text.trim().length > 20);
}

// bytes -> base64 (chunked, avoids call-stack limits)
function toBase64(bytes: Uint8Array): string {
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + step)) as any);
  }
  return btoa(bin);
}

// Read a document with Gemini vision (works for scanned/equation PDFs & images)
async function visionExtract(bytes: Uint8Array, mime: string): Promise<string> {
  const r = await fetch(`${GEMINI_BASE}/models/${OCR_MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': GEMINI_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [
        { inline_data: { mime_type: mime, data: toBase64(bytes) } },
        { text: 'Extract ALL text from this document as plain text. Preserve reading order, headings, lists, and write any math/formulas in readable text (LaTeX-like is fine). Output ONLY the extracted text, no commentary.' },
      ] }],
      generationConfig: { temperature: 0 },
    }),
  });
  if (!r.ok) throw new Error('OCR failed: ' + await r.text());
  const data = await r.json();
  return (data.candidates?.[0]?.content?.parts || []).map((p: any) => p.text || '').join('\n').trim();
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const slice = texts.slice(i, i + BATCH);
    let attempt = 0;
    while (true) {
      const r = await fetch(`${GEMINI_BASE}/models/${EMBED_MODEL}:batchEmbedContents`, {
        method: 'POST',
        headers: { 'x-goog-api-key': GEMINI_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests: slice.map(t => ({
          model: `models/${EMBED_MODEL}`, content: { parts: [{ text: t }] }, outputDimensionality: EMBED_DIMS,
        })) }),
      });
      if (r.ok) { out.push(...(await r.json()).embeddings.map((e: any) => e.values)); break; }
      const errTxt = await r.text();
      if (r.status === 429 && attempt < 3) { attempt++; await sleep(2500 * attempt); continue; } // back off on rate limit
      throw new Error('Embedding failed: ' + errTxt);
    }
    if (i + BATCH < texts.length) await sleep(1500);   // throttle between batches
  }
  return out;
}

const LIMITS: Record<string, Record<string, number>> = {
  free:    { chat: 15,   generate: 5,   ingest: 3 },
  pro:     { chat: 300,  generate: 100, ingest: 50 },
  premium: { chat: 5000, generate: 2000, ingest: 500 },
};
// per-plan document size cap (how many chunks/pages get indexed)
const PLAN_MAX_CHUNKS: Record<string, number> = { free: 40, pro: 120, premium: 400 };
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
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  let documentId: string | undefined;
  try {
    ({ documentId } = await req.json());
    if (!documentId) return json({ error: 'Missing documentId' }, 400);

    const { data: doc, error: docErr } = await admin.from('documents').select('*').eq('id', documentId).single();
    if (docErr || !doc) return json({ error: 'Document not found' }, 404);

    // Enforce the daily upload/ingest limit for this user's plan
    const gate = await enforceLimit(admin, doc.user_id, 'ingest');
    if (!gate.ok) {
      await admin.from('documents').update({ status: 'failed' }).eq('id', documentId);
      return json({ error: `Daily upload limit reached (${gate.limit}/day on the ${gate.plan} plan).`, limitReached: true }, 200);
    }

    const { data: file, error: dlErr } = await admin.storage.from('documents').download(doc.storage_path);
    if (dlErr || !file) throw new Error('Could not download file');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const type = (doc.file_type || '').toLowerCase();
    const path = doc.storage_path.toLowerCase();

    let text = '';
    if (type.includes('pdf') || path.endsWith('.pdf')) {
      // 1) fast text extraction; 2) fall back to Gemini vision OCR if empty or it crashes
      try {
        const pdf = await getDocumentProxy(bytes);
        text = (await extractText(pdf, { mergePages: true })).text || '';
      } catch (_) { text = ''; }
      if (text.trim().length < 40) text = await visionExtract(bytes, 'application/pdf');
    } else if (type.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/.test(path)) {
      text = await visionExtract(bytes, type.startsWith('image/') ? type : 'image/png');
    } else if (type.includes('text') || path.endsWith('.txt') || path.endsWith('.md')) {
      text = await file.text();
    } else {
      await admin.from('documents').update({ status: 'failed' }).eq('id', documentId);
      return json({ error: `Unsupported file type: ${type}` }, 415);
    }

    if (!text || text.trim().length < 20) {
      await admin.from('documents').update({ status: 'failed' }).eq('id', documentId);
      return json({ error: 'No readable text could be extracted from this file' }, 422);
    }

    const cap = PLAN_MAX_CHUNKS[gate.plan] ?? MAX_CHUNKS;   // premium indexes far more of a document
    const chunks = chunkText(text).slice(0, cap);
    const embeddings = await embedBatch(chunks.map(c => c.text));
    const { error: insErr } = await admin.from('doc_chunks').insert(
      chunks.map((c, i) => ({ document_id: documentId, user_id: doc.user_id, content: c.text, page: c.page, embedding: embeddings[i] })),
    );
    if (insErr) throw insErr;

    await admin.from('documents').update({ status: 'ready', page_count: chunks[chunks.length - 1]?.page ?? null }).eq('id', documentId);
    return json({ ok: true, chunks: chunks.length });
  } catch (e) {
    if (documentId) await admin.from('documents').update({ status: 'failed' }).eq('id', documentId);
    return json({ error: String(e) }, 500);
  }
});
