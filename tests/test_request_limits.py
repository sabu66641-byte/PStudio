import unittest

import app as pstudio_app


class RequestLimitRegressionTests(unittest.TestCase):
    def setUp(self):
        pstudio_app.app.config.update(TESTING=True)
        self.client = pstudio_app.app.test_client()

    def test_compile_rejects_source_above_512_kib(self):
        source = ("ps 1" + chr(10)) * (pstudio_app.MAX_PS_SOURCE_BYTES // 4 + 1)
        response = self.client.post("/compile", json={"code": source})
        self.assertEqual(response.status_code, 413)
        self.assertIn("512KB", response.get_json()["error"])

    def test_run_rejects_source_above_512_kib(self):
        source = ("ps 1" + chr(10)) * (pstudio_app.MAX_PS_SOURCE_BYTES // 4 + 1)
        response = self.client.post("/run", json={"code": source})
        self.assertEqual(response.status_code, 413)
        self.assertIn("512KB", response.get_json()["error"])

    def test_run_rejects_stdin_above_128_kib(self):
        response = self.client.post(
            "/run",
            json={
                "code": 'ps "ok"',
                "stdin": "x" * (pstudio_app.MAX_PS_STDIN_BYTES + 1),
            },
        )
        self.assertEqual(response.status_code, 413)
        self.assertIn("128KB", response.get_json()["error"])

    def test_request_body_above_two_mib_returns_json_413(self):
        response = self.client.post(
            "/compile",
            data=b'{"code":"' + (b"x" * (2 * 1024 * 1024)) + b'"}',
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 413)
        self.assertEqual(response.get_json()["success"], False)

    def test_run_returns_503_when_all_execution_slots_are_busy(self):
        acquired = 0
        try:
            for _ in range(pstudio_app.MAX_CONCURRENT_PS_RUNS):
                self.assertTrue(pstudio_app.ps_run_semaphore.acquire(blocking=False))
                acquired += 1
            response = self.client.post("/run", json={"code": 'ps "ok"'})
            self.assertEqual(response.status_code, 503)
            self.assertIn("実行枠", response.get_json()["error"])
        finally:
            for _ in range(acquired):
                pstudio_app.ps_run_semaphore.release()


if __name__ == "__main__":
    unittest.main()
