import io
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

import discord_runtime


class FakeResponse:
    status = 200

    def __init__(self, body):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, size=-1):
        if size < 0:
            return self.body
        return self.body[:size]


class DiscordResponseLimitTests(unittest.TestCase):
    def setUp(self):
        self.client = discord_runtime.DiscordClient("test-token")

    def test_normal_json_response_is_preserved(self):
        body = b'{"id":"123","username":"pstudio"}'
        with patch("discord_runtime.urlopen", return_value=FakeResponse(body)):
            result = self.client.get("/users/@me")
        self.assertEqual(result, {"id": "123", "username": "pstudio"})

    def test_large_success_response_is_rejected_before_full_read(self):
        with patch(
            "discord_runtime.urlopen",
            return_value=FakeResponse(b"x" * 1000),
        ) as open_url:
            with self.assertRaisesRegex(
                discord_runtime.DiscordError,
                "response exceeded the configured limit",
            ):
                self.client.get("/users/@me", max_response_bytes=32)
        self.assertEqual(open_url.call_count, 1)

    def test_error_response_body_is_bounded(self):
        error = HTTPError(
            "https://discord.com/api/v10/test",
            500,
            "server error",
            {},
            io.BytesIO(b"x" * (discord_runtime.MAX_ERROR_RESPONSE_BYTES + 4096)),
        )
        with patch("discord_runtime.urlopen", side_effect=error):
            with self.assertRaises(discord_runtime.DiscordError) as captured:
                self.client.get("/test")
        self.assertEqual(captured.exception.status, 500)
        self.assertIn("exceeded", captured.exception.data["message"])

    def test_invalid_response_limit_is_rejected(self):
        for invalid in (0, -1, True, 1.5, "128"):
            with self.subTest(value=invalid):
                with self.assertRaises(discord_runtime.DiscordError):
                    self.client.get("/users/@me", max_response_bytes=invalid)


if __name__ == "__main__":
    unittest.main()
