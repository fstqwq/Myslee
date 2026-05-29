from __future__ import annotations

import json
import os
import sqlite3
import urllib.error
import urllib.request
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from flask import Flask, current_app, jsonify, request, send_from_directory
from flask_cors import CORS


BASE_DIR = Path(__file__).resolve().parent
DEFAULT_PROBLEMS_PATH = BASE_DIR / "problems" / "hrt_interview_problems.jsonl"
LEGACY_PROBLEMS_PATH = BASE_DIR.parent / "hrt_interview_problems.jsonl"
DEFAULT_DB_PATH = BASE_DIR / "data" / "progress.sqlite3"
DEFAULT_WEB_DIST_DIR = BASE_DIR / "apps" / "web" / "dist"
DEFAULT_CONFIG_PATH = BASE_DIR / "config.json"


class LLMParseError(RuntimeError):
    def __init__(self, message: str, raw: str):
        super().__init__(message)
        self.raw = raw


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def problem_id_for_index(index: int) -> str:
    return f"myslee-{index:03d}"


def default_problems_path() -> Path:
    if DEFAULT_PROBLEMS_PATH.is_file():
        return DEFAULT_PROBLEMS_PATH
    return LEGACY_PROBLEMS_PATH


def load_config() -> dict[str, Any]:
    raw_path = os.environ.get("MYSLEE_CONFIG_PATH")
    path = Path(raw_path).expanduser() if raw_path else DEFAULT_CONFIG_PATH
    path = path.resolve()
    if not path.is_file():
        return {}
    with path.open("r", encoding="utf-8-sig") as handle:
        payload = json.load(handle)
    if not isinstance(payload, dict):
        raise ValueError("Config file must contain a JSON object.")
    return payload


def config_string(
    config: dict[str, Any],
    *,
    env_name: str,
    section: str,
    keys: tuple[str, ...],
    default: str = "",
) -> str:
    env_value = os.environ.get(env_name)
    if env_value is not None and env_value.strip():
        return env_value.strip()

    section_payload = config.get(section, {})
    if not isinstance(section_payload, dict):
        return default
    for key in keys:
        value = section_payload.get(key)
        if value is not None and str(value).strip():
            return str(value).strip()
    return default


def load_llm_config() -> dict[str, Any]:
    config = load_config()
    timeout_raw = config_string(
        config,
        env_name="MYSLEE_LLM_TIMEOUT",
        section="llm",
        keys=("timeout",),
        default="45",
    )
    try:
        timeout = float(timeout_raw)
    except ValueError:
        timeout = 45.0
    max_tokens_raw = config_string(
        config,
        env_name="MYSLEE_LLM_MAX_TOKENS",
        section="llm",
        keys=("maxTokens", "max_tokens"),
        default="1024",
    )
    try:
        max_tokens = int(max_tokens_raw)
    except ValueError:
        max_tokens = 1024
    max_tokens = max(128, max_tokens)

    return {
        "apiKey": config_string(
            config,
            env_name="MYSLEE_LLM_API_KEY",
            section="llm",
            keys=("apiKey", "api_key"),
        ),
        "model": config_string(
            config,
            env_name="MYSLEE_LLM_MODEL",
            section="llm",
            keys=("model",),
        ),
        "baseUrl": config_string(
            config,
            env_name="MYSLEE_LLM_BASE_URL",
            section="llm",
            keys=("baseUrl", "base_url", "baseURL"),
            default="https://api.openai.com/v1",
        ).rstrip("/"),
        "timeout": timeout,
        "maxTokens": max_tokens,
    }


def load_problems(path: Path) -> list[dict[str, Any]]:
    problems: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, raw_line in enumerate(handle, start=1):
            line = raw_line.strip()
            if not line:
                continue
            payload = json.loads(line)
            tags_raw = payload.get("tag", [])
            if isinstance(tags_raw, str):
                tags = [tags_raw]
            elif isinstance(tags_raw, list):
                tags = [str(tag) for tag in tags_raw if str(tag).strip()]
            else:
                tags = []
            index = len(problems) + 1
            problems.append(
                {
                    "id": problem_id_for_index(index),
                    "index": index,
                    "name": str(payload.get("name") or f"Problem {index}"),
                    "tags": tags,
                    "statement": str(payload.get("statements", "")),
                    "hint": str(payload.get("hint", "")),
                    "solution": str(payload.get("solution", "")),
                }
            )
            if not problems[-1]["statement"]:
                raise ValueError(f"Problem on line {line_number} is missing statements.")
    return problems


def ensure_db(db_path: Path) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(db_path)) as connection:
        columns = connection.execute("PRAGMA table_info(progress)").fetchall()
        if columns:
            column_names = {column[1] for column in columns}
            expected_columns = {"problem_id", "opened", "starred", "note", "updated_at"}
            if "opened" not in column_names or not column_names.issubset(expected_columns):
                connection.execute("DROP TABLE IF EXISTS progress_next")
                connection.execute(
                    """
                    CREATE TABLE progress_next (
                        problem_id TEXT PRIMARY KEY,
                        opened INTEGER NOT NULL DEFAULT 0,
                        starred INTEGER NOT NULL DEFAULT 0,
                        note TEXT NOT NULL DEFAULT '',
                        updated_at TEXT NOT NULL
                    )
                    """
                )
                if "opened" in column_names:
                    connection.execute(
                        """
                        INSERT OR REPLACE INTO progress_next (problem_id, opened, starred, note, updated_at)
                        SELECT problem_id, opened, starred, note, updated_at
                        FROM progress
                        """
                    )
                else:
                    connection.execute(
                        """
                        INSERT OR REPLACE INTO progress_next (problem_id, opened, starred, note, updated_at)
                        SELECT problem_id, 1, starred, note, updated_at
                        FROM progress
                        """
                    )
                connection.execute("DROP TABLE progress")
                connection.execute("ALTER TABLE progress_next RENAME TO progress")
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS progress (
                problem_id TEXT PRIMARY KEY,
                opened INTEGER NOT NULL DEFAULT 0,
                starred INTEGER NOT NULL DEFAULT 0,
                note TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS submissions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                problem_id TEXT NOT NULL,
                answer TEXT NOT NULL,
                elapsed_ms INTEGER NOT NULL DEFAULT 0,
                is_correct INTEGER,
                feedback TEXT NOT NULL DEFAULT '',
                llm_raw TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_submissions_problem_id ON submissions(problem_id, created_at)"
        )
        connection.commit()


def connect_db(db_path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(db_path)
    connection.row_factory = sqlite3.Row
    return connection


def default_progress() -> dict[str, Any]:
    return {
        "opened": False,
        "starred": False,
        "note": "",
        "updatedAt": None,
    }


def serialize_progress(row: sqlite3.Row | None) -> dict[str, Any]:
    if row is None:
        return default_progress()
    return {
        "opened": bool(row["opened"]),
        "starred": bool(row["starred"]),
        "note": row["note"] or "",
        "updatedAt": row["updated_at"],
    }


def serialize_submission(row: sqlite3.Row) -> dict[str, Any]:
    raw_correct = row["is_correct"]
    if raw_correct is None:
        is_correct = None
    else:
        is_correct = bool(raw_correct)
    return {
        "id": row["id"],
        "problemId": row["problem_id"],
        "answer": row["answer"],
        "elapsedMs": row["elapsed_ms"],
        "isCorrect": is_correct,
        "feedback": row["feedback"] or "",
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def read_submissions_map(db_path: Path) -> dict[str, list[dict[str, Any]]]:
    ensure_db(db_path)
    with closing(connect_db(db_path)) as connection:
        rows = connection.execute(
            """
            SELECT id, problem_id, answer, elapsed_ms, is_correct, feedback, created_at, updated_at
            FROM submissions
            ORDER BY created_at DESC, id DESC
            """
        ).fetchall()

    submissions: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        submissions.setdefault(row["problem_id"], []).append(serialize_submission(row))
    return submissions


def create_submission(
    db_path: Path,
    problem_id: str,
    *,
    answer: str,
    elapsed_ms: int,
    is_correct: bool | None,
    feedback: str,
    llm_raw: str,
) -> dict[str, Any]:
    ensure_db(db_path)
    now = utc_now_iso()
    with closing(connect_db(db_path)) as connection:
        cursor = connection.execute(
            """
            INSERT INTO submissions (problem_id, answer, elapsed_ms, is_correct, feedback, llm_raw, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                problem_id,
                answer,
                elapsed_ms,
                None if is_correct is None else (1 if is_correct else 0),
                feedback,
                llm_raw,
                now,
                now,
            ),
        )
        connection.commit()
        row = connection.execute(
            """
            SELECT id, problem_id, answer, elapsed_ms, is_correct, feedback, created_at, updated_at
            FROM submissions
            WHERE id = ?
            """,
            (cursor.lastrowid,),
        ).fetchone()
    return serialize_submission(row)


def patch_submission_correctness(db_path: Path, submission_id: int, is_correct: bool | None) -> dict[str, Any] | None:
    ensure_db(db_path)
    now = utc_now_iso()
    with closing(connect_db(db_path)) as connection:
        cursor = connection.execute(
            """
            UPDATE submissions
            SET is_correct = ?, updated_at = ?
            WHERE id = ?
            """,
            (None if is_correct is None else (1 if is_correct else 0), now, submission_id),
        )
        connection.commit()
        if cursor.rowcount == 0:
            return None
        row = connection.execute(
            """
            SELECT id, problem_id, answer, elapsed_ms, is_correct, feedback, created_at, updated_at
            FROM submissions
            WHERE id = ?
            """,
            (submission_id,),
        ).fetchone()
    return serialize_submission(row)


def read_progress_map(db_path: Path) -> dict[str, dict[str, Any]]:
    ensure_db(db_path)
    with closing(connect_db(db_path)) as connection:
        rows = connection.execute(
            "SELECT problem_id, opened, starred, note, updated_at FROM progress"
        ).fetchall()
    return {row["problem_id"]: serialize_progress(row) for row in rows}


def read_progress(db_path: Path, problem_id: str) -> dict[str, Any]:
    ensure_db(db_path)
    with closing(connect_db(db_path)) as connection:
        row = connection.execute(
            """
            SELECT problem_id, opened, starred, note, updated_at
            FROM progress
            WHERE problem_id = ?
            """,
            (problem_id,),
        ).fetchone()
    return serialize_progress(row)


def write_progress(db_path: Path, problem_id: str, progress: dict[str, Any]) -> dict[str, Any]:
    ensure_db(db_path)
    if not progress["opened"] and not progress["starred"] and not progress["note"].strip():
        with closing(connect_db(db_path)) as connection:
            connection.execute("DELETE FROM progress WHERE problem_id = ?", (problem_id,))
            connection.commit()
        return default_progress()

    updated_at = utc_now_iso()
    with closing(connect_db(db_path)) as connection:
        connection.execute(
            """
            INSERT INTO progress (problem_id, opened, starred, note, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(problem_id) DO UPDATE SET
                opened = excluded.opened,
                starred = excluded.starred,
                note = excluded.note,
                updated_at = excluded.updated_at
            """,
            (
                problem_id,
                1 if progress["opened"] else 0,
                1 if progress["starred"] else 0,
                progress["note"],
                updated_at,
            ),
        )
        connection.commit()
    return {
        "opened": bool(progress["opened"]),
        "starred": bool(progress["starred"]),
        "note": progress["note"],
        "updatedAt": updated_at,
    }


def normalize_patch_payload(payload: object, current: dict[str, Any]) -> tuple[dict[str, Any] | None, str | None]:
    if not isinstance(payload, dict):
        return None, "Request body must be a JSON object."

    next_progress = dict(current)

    if "opened" in payload:
        opened = payload["opened"]
        if not isinstance(opened, bool):
            return None, "opened must be a boolean."
        next_progress["opened"] = opened

    if "starred" in payload:
        starred = payload["starred"]
        if not isinstance(starred, bool):
            return None, "starred must be a boolean."
        next_progress["starred"] = starred

    if "note" in payload:
        note = payload["note"]
        if not isinstance(note, str):
            return None, "note must be a string."
        next_progress["note"] = note

    return next_progress, None


def find_problem(problems: list[dict[str, Any]], problem_id: str) -> dict[str, Any] | None:
    return next((problem for problem in problems if problem["id"] == problem_id), None)


def normalize_submission_payload(payload: object) -> tuple[dict[str, Any] | None, str | None]:
    if not isinstance(payload, dict):
        return None, "Request body must be a JSON object."

    answer = payload.get("answer")
    if not isinstance(answer, str) or not answer.strip():
        return None, "answer must be a non-empty string."

    elapsed_ms = payload.get("elapsedMs", 0)
    if isinstance(elapsed_ms, bool) or not isinstance(elapsed_ms, int) or elapsed_ms < 0:
        return None, "elapsedMs must be a non-negative integer."

    return {"answer": answer.strip(), "elapsedMs": elapsed_ms}, None


def normalize_correctness_payload(payload: object) -> tuple[bool | None, str | None]:
    if not isinstance(payload, dict):
        return None, "Request body must be a JSON object."
    if "isCorrect" not in payload:
        return None, "isCorrect is required."
    is_correct = payload["isCorrect"]
    if is_correct is not None and not isinstance(is_correct, bool):
        return None, "isCorrect must be true, false, or null."
    return is_correct, None


def extract_json_object(text: str) -> dict[str, Any]:
    try:
        payload = json.loads(text)
        if isinstance(payload, dict):
            return payload
    except json.JSONDecodeError:
        pass

    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        try:
            payload = json.loads(text[start : end + 1])
            if isinstance(payload, dict):
                return payload
        except json.JSONDecodeError:
            pass
    raise ValueError("LLM response did not contain a JSON object.")


def judge_answer(problem: dict[str, Any], answer: str) -> dict[str, Any]:
    llm_config = load_llm_config()
    api_key = llm_config["apiKey"]
    model = llm_config["model"]
    if not api_key or not model:
        return {
            "isCorrect": None,
            "feedback": "LLM is not configured. Set config.json or MYSLEE_LLM_API_KEY and MYSLEE_LLM_MODEL to enable automatic judging.",
            "raw": "",
        }

    base_url = llm_config["baseUrl"]
    timeout = llm_config["timeout"]
    max_tokens = llm_config["maxTokens"]
    prompt = {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are a concise interview-style grader. "
                    "The user may be using speech input or another unreliable typing method, "
                    "so interpret their answer charitably and infer the likely intended content where reasonable. "
                    "Compare the user's answer against the official solution. "
                    "Return only JSON with keys isCorrect (boolean) and feedback (string). "
                    "If the answer is correct, confirm briefly. "
                    "If the answer is incorrect or unclear, do not reveal the solution or enumerate differences; "
                    "give one short interview-style hint about the next direction to try."
                ),
            },
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "name": problem["name"],
                        "statement": problem["statement"],
                        "officialSolution": problem["solution"],
                        "userAnswer": answer,
                    },
                    ensure_ascii=False,
                ),
            },
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0,
        "max_tokens": max_tokens,
    }
    request_body = json.dumps(prompt).encode("utf-8")
    request = urllib.request.Request(
        f"{base_url}/chat/completions",
        data=request_body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            response_payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        message = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"LLM request failed: {message or exc.reason}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"LLM request failed: {exc.reason}") from exc

    raw_response = json.dumps(response_payload, ensure_ascii=False)
    message = response_payload.get("choices", [{}])[0].get("message", {})
    content = message.get("content", "")
    content_text = content if isinstance(content, str) else ""
    try:
        parsed = extract_json_object(content_text)
    except ValueError as exc:
        finish_reason = response_payload.get("choices", [{}])[0].get("finish_reason")
        detail = "LLM response did not contain a JSON object."
        if not content_text.strip() and finish_reason == "length":
            detail = "LLM response ran out of output tokens before producing JSON."
        raise LLMParseError(detail, raw_response) from exc
    is_correct = parsed.get("isCorrect")
    if not isinstance(is_correct, bool):
        is_correct = None
    feedback = parsed.get("feedback")
    return {
        "isCorrect": is_correct,
        "feedback": feedback if isinstance(feedback, str) else "",
        "raw": content_text,
    }


def create_app(
    *,
    problems_path: Path | str | None = None,
    db_path: Path | str | None = None,
    web_dist_dir: Path | str | None = None,
) -> Flask:
    flask_app = Flask(__name__)
    CORS(flask_app)

    configured_problems_path = Path(
        problems_path
        or os.environ.get("MYSLEE_PROBLEMS_PATH")
        or default_problems_path()
    ).resolve()
    configured_db_path = Path(
        db_path
        or os.environ.get("MYSLEE_PROGRESS_DB")
        or DEFAULT_DB_PATH
    ).resolve()
    configured_web_dist_dir = Path(
        web_dist_dir
        or os.environ.get("MYSLEE_WEB_DIST_DIR")
        or DEFAULT_WEB_DIST_DIR
    ).resolve()

    flask_app.config["PROBLEMS_PATH"] = configured_problems_path
    flask_app.config["DB_PATH"] = configured_db_path
    flask_app.config["WEB_DIST_DIR"] = configured_web_dist_dir

    @flask_app.get("/api/health")
    def health():
        return jsonify({"ok": True})

    @flask_app.get("/api/problems")
    def get_problems():
        problems = load_problems(current_app.config["PROBLEMS_PATH"])
        progress_map = read_progress_map(current_app.config["DB_PATH"])
        submissions_map = read_submissions_map(current_app.config["DB_PATH"])
        for problem in problems:
            problem["progress"] = progress_map.get(problem["id"], default_progress())
            problem["submissions"] = submissions_map.get(problem["id"], [])
        return jsonify({"problems": problems})

    @flask_app.patch("/api/progress/<problem_id>")
    def patch_progress(problem_id: str):
        problems = load_problems(current_app.config["PROBLEMS_PATH"])
        if find_problem(problems, problem_id) is None:
            return jsonify({"error": f"Problem '{problem_id}' was not found."}), 404

        current = read_progress(current_app.config["DB_PATH"], problem_id)
        payload = request.get_json(silent=True)
        next_progress, error = normalize_patch_payload(payload, current)
        if error is not None:
            return jsonify({"error": error}), 400

        saved = write_progress(current_app.config["DB_PATH"], problem_id, next_progress)
        return jsonify({"problemId": problem_id, "progress": saved})

    @flask_app.post("/api/problems/<problem_id>/submissions")
    def post_submission(problem_id: str):
        problems = load_problems(current_app.config["PROBLEMS_PATH"])
        problem = find_problem(problems, problem_id)
        if problem is None:
            return jsonify({"error": f"Problem '{problem_id}' was not found."}), 404

        payload, error = normalize_submission_payload(request.get_json(silent=True))
        if error is not None:
            return jsonify({"error": error}), 400

        try:
            judgment = judge_answer(problem, payload["answer"])
        except LLMParseError as exc:
            judgment = {
                "isCorrect": None,
                "feedback": str(exc),
                "raw": exc.raw,
            }
        except Exception as exc:
            judgment = {
                "isCorrect": None,
                "feedback": str(exc),
                "raw": "",
            }

        submission = create_submission(
            current_app.config["DB_PATH"],
            problem_id,
            answer=payload["answer"],
            elapsed_ms=payload["elapsedMs"],
            is_correct=judgment["isCorrect"],
            feedback=judgment["feedback"],
            llm_raw=judgment["raw"],
        )
        return jsonify({"submission": submission})

    @flask_app.patch("/api/submissions/<int:submission_id>")
    def patch_submission(submission_id: int):
        is_correct, error = normalize_correctness_payload(request.get_json(silent=True))
        if error is not None:
            return jsonify({"error": error}), 400

        submission = patch_submission_correctness(current_app.config["DB_PATH"], submission_id, is_correct)
        if submission is None:
            return jsonify({"error": f"Submission '{submission_id}' was not found."}), 404
        return jsonify({"submission": submission})

    @flask_app.route("/", defaults={"path": ""})
    @flask_app.route("/<path:path>")
    def serve_frontend(path: str):
        if path.startswith("api/"):
            return jsonify({"error": "Not found."}), 404

        dist_dir: Path = current_app.config["WEB_DIST_DIR"]
        requested_path = dist_dir / path
        if path and requested_path.is_file():
            return send_from_directory(dist_dir, path)

        index_path = dist_dir / "index.html"
        if index_path.is_file():
            return send_from_directory(dist_dir, "index.html")

        return (
            jsonify(
                {
                    "error": "Frontend build not found.",
                    "hint": "Run npm --prefix apps/web run build from the project root.",
                }
            ),
            404,
        )

    return flask_app


app = create_app()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5001"))
    app.run(host="127.0.0.1", port=port, debug=False)
