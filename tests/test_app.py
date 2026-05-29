import json
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

import app as myslee_app  # noqa: E402


class MysleeApiTestCase(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.base_dir = Path(self.temp_dir.name)
        self.problems_path = self.base_dir / "problems.jsonl"
        self.db_path = self.base_dir / "progress.sqlite3"
        self.web_dist_dir = self.base_dir / "dist"
        self.problems_path.write_text(
            "\n".join(
                [
                    json.dumps(
                        {
                            "name": "One",
                            "tag": ["probability", "warmup"],
                            "statements": "Problem $1$",
                            "hint": "Hint 1",
                            "solution": "Solution 1",
                        }
                    ),
                    json.dumps(
                        {
                            "name": "Two",
                            "tag": "geometry",
                            "statements": "Problem $2$",
                            "hint": "Hint 2",
                            "solution": "Solution 2",
                        }
                    ),
                ]
            ),
            encoding="utf-8",
        )
        app = myslee_app.create_app(
            problems_path=self.problems_path,
            db_path=self.db_path,
            web_dist_dir=self.web_dist_dir,
        )
        app.config["TESTING"] = True
        self.client = app.test_client()

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_get_problems_returns_defaults(self):
        response = self.client.get("/api/problems")

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(len(payload["problems"]), 2)
        self.assertEqual(payload["problems"][0]["id"], "myslee-001")
        self.assertEqual(payload["problems"][0]["name"], "One")
        self.assertEqual(payload["problems"][0]["tags"], ["probability", "warmup"])
        self.assertEqual(payload["problems"][1]["tags"], ["geometry"])
        self.assertFalse(payload["problems"][0]["progress"]["opened"])
        self.assertFalse(payload["problems"][0]["progress"]["starred"])
        self.assertEqual(payload["problems"][0]["submissions"], [])
        self.assertNotIn("summary", payload)

    def test_patch_progress_persists(self):
        response = self.client.patch(
            "/api/progress/myslee-001",
            json={"opened": True, "starred": True, "note": "Recheck variance trick."},
        )

        self.assertEqual(response.status_code, 200)
        saved = response.get_json()["progress"]
        self.assertTrue(saved["opened"])
        self.assertTrue(saved["starred"])
        self.assertEqual(saved["note"], "Recheck variance trick.")
        self.assertIsNotNone(saved["updatedAt"])

        response = self.client.get("/api/problems")
        problem = response.get_json()["problems"][0]
        self.assertTrue(problem["progress"]["opened"])
        self.assertTrue(problem["progress"]["starred"])
        self.assertEqual(problem["progress"]["note"], "Recheck variance trick.")

    def test_patch_rejects_invalid_opened(self):
        response = self.client.patch("/api/progress/myslee-001", json={"opened": "yes"})

        self.assertEqual(response.status_code, 400)
        self.assertIn("opened must be", response.get_json()["error"])

    def test_patch_default_progress_removes_saved_row(self):
        self.client.patch("/api/progress/myslee-001", json={"opened": True})
        response = self.client.patch(
            "/api/progress/myslee-001",
            json={"opened": False, "starred": False, "note": ""},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.get_json()["progress"],
            {"opened": False, "starred": False, "note": "", "updatedAt": None},
        )

        response = self.client.get("/api/problems")
        self.assertIsNone(response.get_json()["problems"][0]["progress"]["updatedAt"])

    def test_patch_returns_404_for_unknown_problem(self):
        response = self.client.patch("/api/progress/myslee-999", json={"opened": True})

        self.assertEqual(response.status_code, 404)

    def test_judge_answer_sends_json_response_format_and_interview_prompt(self):
        config_path = self.base_dir / "config.json"
        config_path.write_text(
            json.dumps(
                {
                    "llm": {
                        "baseUrl": "https://llm.test",
                        "model": "judge-model",
                        "apiKey": "secret",
                        "timeout": 7,
                    }
                }
            ),
            encoding="utf-8",
        )
        captured = {}

        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                return False

            def read(self):
                return json.dumps(
                    {
                        "choices": [
                            {
                                "message": {
                                    "content": json.dumps(
                                        {"isCorrect": False, "feedback": "Try conditioning on the first event."}
                                    )
                                }
                            }
                        ]
                    }
                ).encode("utf-8")

        def fake_urlopen(request, timeout):
            captured["url"] = request.full_url
            captured["timeout"] = timeout
            captured["body"] = json.loads(request.data.decode("utf-8"))
            return FakeResponse()

        with patch.dict(os.environ, {"MYSLEE_CONFIG_PATH": str(config_path)}, clear=True):
            with patch.object(myslee_app.urllib.request, "urlopen", fake_urlopen):
                result = myslee_app.judge_answer(
                    {
                        "name": "One",
                        "statement": "Problem",
                        "solution": "Solution",
                    },
                    "spoken-ish answer",
                )

        self.assertEqual(result["feedback"], "Try conditioning on the first event.")
        self.assertEqual(captured["url"], "https://llm.test/chat/completions")
        self.assertEqual(captured["timeout"], 7.0)
        self.assertEqual(captured["body"]["response_format"], {"type": "json_object"})
        self.assertEqual(captured["body"]["max_tokens"], 1024)
        system_prompt = captured["body"]["messages"][0]["content"]
        self.assertIn("speech input", system_prompt)
        self.assertIn("interview-style hint", system_prompt)

    def test_load_llm_config_reads_json_file(self):
        config_path = self.base_dir / "config.json"
        config_path.write_text(
            json.dumps(
                {
                    "llm": {
                        "baseUrl": "https://example.test",
                        "model": "file-model",
                        "apiKey": "file-key",
                        "timeout": 12,
                        "maxTokens": 900,
                    }
                }
            ),
            encoding="utf-8",
        )

        with patch.dict(os.environ, {"MYSLEE_CONFIG_PATH": str(config_path)}, clear=True):
            config = myslee_app.load_llm_config()

        self.assertEqual(config["baseUrl"], "https://example.test")
        self.assertEqual(config["model"], "file-model")
        self.assertEqual(config["apiKey"], "file-key")
        self.assertEqual(config["timeout"], 12.0)
        self.assertEqual(config["maxTokens"], 900)

    def test_load_llm_config_prefers_environment(self):
        config_path = self.base_dir / "config.json"
        config_path.write_text(
            json.dumps(
                {
                    "llm": {
                        "baseUrl": "https://file.test",
                        "model": "file-model",
                        "apiKey": "file-key",
                    }
                }
            ),
            encoding="utf-8",
        )

        with patch.dict(
            os.environ,
            {
                "MYSLEE_CONFIG_PATH": str(config_path),
                "MYSLEE_LLM_BASE_URL": "https://env.test",
                "MYSLEE_LLM_MODEL": "env-model",
                "MYSLEE_LLM_API_KEY": "env-key",
                "MYSLEE_LLM_TIMEOUT": "34",
                "MYSLEE_LLM_MAX_TOKENS": "777",
            },
            clear=True,
        ):
            config = myslee_app.load_llm_config()

        self.assertEqual(config["baseUrl"], "https://env.test")
        self.assertEqual(config["model"], "env-model")
        self.assertEqual(config["apiKey"], "env-key")
        self.assertEqual(config["timeout"], 34.0)
        self.assertEqual(config["maxTokens"], 777)

    def test_post_submission_stores_raw_response_when_json_parse_fails(self):
        config_path = self.base_dir / "config.json"
        config_path.write_text(
            json.dumps(
                {
                    "llm": {
                        "baseUrl": "https://llm.test",
                        "model": "judge-model",
                        "apiKey": "secret",
                    }
                }
            ),
            encoding="utf-8",
        )

        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                return False

            def read(self):
                return json.dumps(
                    {
                        "choices": [
                            {
                                "message": {
                                    "content": "",
                                    "reasoning_content": "Reasoning used the whole output budget.",
                                },
                                "finish_reason": "length",
                            }
                        ]
                    }
                ).encode("utf-8")

        with patch.dict(os.environ, {"MYSLEE_CONFIG_PATH": str(config_path)}, clear=True):
            with patch.object(myslee_app.urllib.request, "urlopen", lambda request, timeout: FakeResponse()):
                response = self.client.post(
                    "/api/problems/myslee-001/submissions",
                    json={"answer": "Maybe.", "elapsedMs": 123},
                )

        self.assertEqual(response.status_code, 200)
        submission = response.get_json()["submission"]
        self.assertIsNone(submission["isCorrect"])
        self.assertEqual(submission["feedback"], "LLM response ran out of output tokens before producing JSON.")

        connection = sqlite3.connect(self.db_path)
        try:
            raw = connection.execute("SELECT llm_raw FROM submissions WHERE id = ?", (submission["id"],)).fetchone()[0]
        finally:
            connection.close()
        self.assertIn("Reasoning used the whole output budget.", raw)

    def test_post_submission_records_judgment_and_elapsed_time(self):
        with patch.object(
            myslee_app,
            "judge_answer",
            return_value={"isCorrect": True, "feedback": "Looks correct.", "raw": '{"isCorrect":true}'},
        ) as judge_mock:
            response = self.client.post(
                "/api/problems/myslee-001/submissions",
                json={"answer": "Use symmetry.", "elapsedMs": 12345},
            )

        self.assertEqual(response.status_code, 200)
        submission = response.get_json()["submission"]
        self.assertEqual(submission["problemId"], "myslee-001")
        self.assertEqual(submission["answer"], "Use symmetry.")
        self.assertEqual(submission["elapsedMs"], 12345)
        self.assertTrue(submission["isCorrect"])
        self.assertEqual(submission["feedback"], "Looks correct.")
        judge_mock.assert_called_once()

        response = self.client.get("/api/problems")
        submissions = response.get_json()["problems"][0]["submissions"]
        self.assertEqual(len(submissions), 1)
        self.assertEqual(submissions[0]["answer"], "Use symmetry.")

    def test_patch_submission_correctness(self):
        with patch.object(
            myslee_app,
            "judge_answer",
            return_value={"isCorrect": None, "feedback": "Unknown.", "raw": "{}"},
        ):
            response = self.client.post(
                "/api/problems/myslee-001/submissions",
                json={"answer": "Maybe.", "elapsedMs": 10},
            )
        submission_id = response.get_json()["submission"]["id"]

        response = self.client.patch(f"/api/submissions/{submission_id}", json={"isCorrect": False})

        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.get_json()["submission"]["isCorrect"])

        response = self.client.patch(f"/api/submissions/{submission_id}", json={"isCorrect": None})
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.get_json()["submission"]["isCorrect"])


if __name__ == "__main__":
    unittest.main()
