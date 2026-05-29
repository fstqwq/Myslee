# Myslee

Personal progress tracker for the local JSONL problem set.

The default problem file is `problems/hrt_interview_problems.jsonl`. Set
`MYSLEE_PROBLEMS_PATH` to use a different JSONL file.

## Development

```bash
pip install -r requirements.txt
python app.py
npm --prefix apps/web install
npm run dev:web
```

The Vite dev server proxies `/api` to Flask on `http://127.0.0.1:5001`.

## Simple Production

```bash
npm --prefix apps/web install
npm --prefix apps/web run build
pip install -r requirements.txt
python app.py
```

Flask serves both `/api/*` and the built React app from `apps/web/dist`.
Progress is stored in `data/progress.sqlite3`.

## LLM Judging

Answer submission works without LLM configuration and records the attempt as unknown. To enable automatic judging, create `config.json`:

```json
{
  "llm": {
    "baseUrl": "https://api.deepseek.com",
    "model": "deepseek-v4-flash",
    "apiKey": "sk-...",
    "timeout": 45,
    "maxTokens": 4096
  }
}
```

`config.json` is ignored by git. Environment variables can override the file:

```bash
MYSLEE_LLM_API_KEY=...
MYSLEE_LLM_MODEL=...
MYSLEE_LLM_BASE_URL=https://api.openai.com/v1
MYSLEE_LLM_TIMEOUT=45
MYSLEE_LLM_MAX_TOKENS=4096
```

`MYSLEE_LLM_BASE_URL` can point to any OpenAI-compatible chat completions API.
