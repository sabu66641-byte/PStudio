import unittest

import discord_runtime


class FakeThread:
    def __init__(self, alive=True):
        self.alive = alive

    def is_alive(self):
        return self.alive


class DiscordLifecycleRegressionTests(unittest.TestCase):
    def test_stop_request_is_visible_until_gateway_loop_finishes(self):
        client = discord_runtime.DiscordClient("test-token")
        client._started = True

        client.stop()

        self.assertTrue(client._started)
        self.assertFalse(client.is_running())
        self.assertFalse(client.status()["running"])

    def test_restart_during_stop_is_rejected_instead_of_silently_ignored(self):
        client = discord_runtime.DiscordClient("test-token")
        client._started = True
        client.stop()

        with self.assertRaisesRegex(discord_runtime.DiscordError, "停止処理中"):
            client.start()

    def test_start_is_rejected_while_previous_background_thread_is_alive(self):
        client = discord_runtime.DiscordClient("test-token")
        client._thread = FakeThread(alive=True)

        with self.assertRaisesRegex(discord_runtime.DiscordError, "終了していません"):
            client.start()

    def test_start_is_allowed_after_previous_thread_has_terminated(self):
        client = discord_runtime.DiscordClient("test-token")
        client._thread = FakeThread(alive=False)
        client._stop_event.set()

        async def connect_once():
            client._stop_event.set()

        client._connect_gateway = connect_once
        import asyncio
        asyncio.run(client.start_async())
        self.assertFalse(client._started)
        self.assertFalse(client.is_running())


if __name__ == "__main__":
    unittest.main()
