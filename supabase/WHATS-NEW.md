# "What's new" summaries: one-time setup

After an update, the app shows only what is new **for that device**. When
someone skipped several versions, it shows one short summary instead of every
line. An AI writes that summary on our Supabase project, the first time
anyone makes that jump on that device; it is saved and reused for everyone
after. Until this is set up, or if no AI answers, the app simply lists the
lines (without version numbers), so nothing breaks.

## 1. Create the table

Supabase dashboard -> **SQL Editor -> New query**, paste all of
[`whats-new.sql`](whats-new.sql), **Run**.

## 2. Deploy the function

From the repository folder, on your Mac:

    npx supabase login
    npx supabase functions deploy whats-new --project-ref ybjyzvtilicsncuiujks --no-verify-jwt

Check it is up: this should answer with some lines (a jump with nothing to
summarise needs no AI):

    curl -s -X POST https://ybjyzvtilicsncuiujks.supabase.co/functions/v1/whats-new -d '{"from":"1.14.0","to":"1.15.0","device":"mac"}'

## 3. Add AI keys (any of them, any time)

Supabase dashboard -> **Edge Functions -> Secrets**. Each AI is used only when
its secrets are there; they are tried in this order, the next one taking over
when one is busy, down or slow:

| AI | Secrets |
|---|---|
| Anthropic (Claude) | `ANTHROPIC_API_KEY` (model: `claude-opus-5-5`, or set `ANTHROPIC_MODEL`) |
| OpenAI (ChatGPT) | `OPENAI_API_KEY` and `OPENAI_MODEL` |
| Google (Gemini) | `GEMINI_API_KEY` and `GEMINI_MODEL` |
| xAI (Grok) | `XAI_API_KEY` and `XAI_MODEL` |

To change the order, add `WHATS_NEW_PROVIDERS`, e.g. `gemini,anthropic`.
Keys stay on Supabase; they are never in the app.

## How to see it working

- Supabase -> Edge Functions -> whats-new -> **Logs**: each request, and
  "no summary for ..." when every AI failed.
- SQL: `select key, source, lines from whats_new_summaries order by created_at desc;`
  shows every summary written, and which AI wrote it. Delete a row to have it
  written again.

## Costs

One short request per new jump and device, the first time anyone makes it;
everyone after gets the saved one. A handful of requests per release.
