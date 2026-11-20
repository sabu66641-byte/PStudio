import subprocess
import sys
import unittest

import app


class BoundedProcessRegressionTests(unittest.TestCase):
    def test_captures_normal_stdout_and_stderr(self):
        result = app.run_process_bounded(
            [
                sys.executable,
                "-c",
                "import sys; print('ready'); print('note', file=sys.stderr)",
            ],
            timeout=5,
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout.strip(), "ready")
        self.assertEqual(result.stderr.strip(), "note")

    def test_passes_standard_input_without_unbounded_communicate_capture(self):
        result = app.run_process_bounded(
            [
                sys.executable,
                "-c",
                "import sys; print(sys.stdin.read().upper())",
            ],
            input_text="pstudio",
            timeout=5,
        )
        self.assertEqual(result.stdout.strip(), "PSTUDIO")

    def test_kills_process_when_stdout_exceeds_limit(self):
        with self.assertRaises(app.ProcessOutputLimitExceeded):
            app.run_process_bounded(
                [
                    sys.executable,
                    "-c",
                    "import sys; sys.stdout.write('x' * 1000000); sys.stdout.flush()",
                ],
                stdout_limit=1024,
                timeout=5,
            )

    def test_kills_process_when_stderr_exceeds_limit(self):
        with self.assertRaises(app.ProcessOutputLimitExceeded):
            app.run_process_bounded(
                [
                    sys.executable,
                    "-c",
                    "import sys; sys.stderr.write('x' * 1000000); sys.stderr.flush()",
                ],
                stderr_limit=1024,
                timeout=5,
            )

    def test_preserves_timeout_behavior(self):
        with self.assertRaises(subprocess.TimeoutExpired):
            app.run_process_bounded(
                [sys.executable, "-c", "import time; time.sleep(2)"],
                timeout=0.05,
            )


if __name__ == "__main__":
    unittest.main()
