# Run StudyAI's AI on Google Gemini (free tier)

These two functions replace the OpenAI versions and run chat + embeddings on
Gemini, so you can build and test for $0. Only the functions change — your web
app and database schema stay the same.

## 1. Get a free Gemini API key
Go to **aistudio.google.com** → **Get API key** → create a key.
No billing needed for the free tier (it has generous rate limits; check the
current limits on the AI Studio pricing page).

## 2. Set it as a Supabase secret
```bash
supabase secrets set GEMINI_API_KEY=your-gemini-key
```
(You no longer need OPENAI_API_KEY unless another function uses it.)

## 3. Replace the two function files
Drop these over the ones in your project:
```
supabase/functions/ai-chat/index.ts
supabase/functions/ingest-document/index.ts
```

## 4. Deploy
```bash
supabase functions deploy ai-chat
supabase functions deploy ingest-document
```

## 5. Test
Same as before — ask the tutor a question, then upload a PDF/.txt and ask about it.

---

## IMPORTANT: embedding dimensions
Your `doc_chunks` table is `vector(1536)`. These functions ask Gemini for
**1536-dim** embeddings (`outputDimensionality: 1536`) so they drop straight in —
**no schema change needed.**

- If you had **already ingested documents with OpenAI**, delete those old chunks
  and re-upload. Embeddings from different providers live in different vector
  spaces and can't be compared:
  ```sql
  delete from doc_chunks;               -- then re-upload your documents
  ```
- If you'd rather use Gemini's full-quality **3072-dim** embeddings, change the
  table to `vector(3072)` — but note pgvector's HNSW index caps the `vector`
  type at 2000 dims, so you'd switch the column to `halfvec(3072)` and index with
  `halfvec_cosine_ops`. Sticking with 1536 avoids all that.

## Models used
```ts
CHAT_MODEL  = 'gemini-3.7-flash';    // cheap, free-tier friendly
EMBED_MODEL = 'gemini-embedding-001'; // 1536 dims (set explicitly)
```
Both are placeholders you can bump to whatever's current.

## Moving to DeepSeek later (chat only)
When free-tier limits get tight, point **chat** at DeepSeek and keep **embeddings**
on Gemini:
- In `ai-chat`, change the chat `fetch` to `https://api.deepseek.com/v1/chat/completions`,
  model `deepseek-chat`, `Authorization: Bearer <DEEPSEEK_KEY>`.
- Leave the `embed()` function (Gemini) untouched, and keep GEMINI_API_KEY set.
- Add the new secret: `supabase secrets set DEEPSEEK_API_KEY=...`
DeepSeek is OpenAI-compatible, so the request body stays the same.
