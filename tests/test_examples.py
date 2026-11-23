import pathlib
import unittest

import app


ROOT = pathlib.Path(__file__).resolve().parents[1]


class ExampleProjectRegressionTests(unittest.TestCase):
    def setUp(self):
        app.app.config.update(TESTING=True)
        self.client = app.app.test_client()

    def load_sources(self, paths):
        return {
            path.name: path.read_text(encoding="utf-8")
            for path in paths
        }

    def validate_game_scripts(self, scripts):
        response = self.client.post("/game/prepare", json={"scripts": scripts})
        self.assertEqual(
            response.status_code,
            200,
            msg=f"/game/prepare rejected example scripts: {response.get_json()}",
        )
        payload = response.get_json()
        self.assertTrue(payload["success"])
        self.assertEqual(set(payload["scripts"]), set(scripts))
        return payload["scripts"]

    def test_root_player_and_enemy_examples_validate_together(self):
        paths = [
            ROOT / "examples" / "player.ps",
            ROOT / "examples" / "enemy.ps",
        ]
        parsed = self.validate_game_scripts(self.load_sources(paths))
        self.assertEqual(
            {name: len(tree["body"]) for name, tree in parsed.items()},
            {"player.ps": 3, "enemy.ps": 3},
        )

    def test_3d_rpg_starter_scripts_validate_together(self):
        paths = [
            ROOT / "examples" / "3d_rpg" / "player_controller.ps",
            ROOT / "examples" / "3d_rpg" / "world.ps",
        ]
        parsed = self.validate_game_scripts(self.load_sources(paths))
        self.assertIn("player_controller.ps", parsed)
        self.assertIn("world.ps", parsed)

    def test_atmosphere_api_is_available_only_to_browser_game_scripts(self):
        self.assertEqual(app.GAME_FUNCTIONS.get("set_atmosphere"), 4)
        script = {
            "atmosphere.ps": (
                "func start()\n"
                "    set_atmosphere(45, 135, 2.4, 0.35)\n"
            )
        }
        parsed = self.validate_game_scripts(script)
        self.assertIn("atmosphere.ps", parsed)
        self.assertEqual(parsed["atmosphere.ps"]["body"][0]["name"], "start")

    def test_atmosphere_api_rejects_wrong_argument_count(self):
        response = self.client.post(
            "/game/prepare",
            json={"scripts": {"bad_atmosphere.ps": "func start()\n    set_atmosphere(45, 135, 2.4)\n"}},
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("set_atmosphere", response.get_json()["error"])

    def test_god_rays_api_accepts_legacy_and_decay_arguments(self):
        legacy = self.validate_game_scripts({
            "legacy_god_rays.ps": "func start()\n    set_god_rays(true, 0.7)\n"
        })
        modern = self.validate_game_scripts({
            "modern_god_rays.ps": "func start()\n    set_god_rays(true, 0.7, 0.97)\n"
        })
        self.assertIn("legacy_god_rays.ps", legacy)
        self.assertIn("modern_god_rays.ps", modern)

    def test_god_rays_api_rejects_invalid_argument_counts(self):
        for source in [
            "func start()\n    set_god_rays(true)\n",
            "func start()\n    set_god_rays(true, 0.7, 0.97, 1)\n",
        ]:
            response = self.client.post(
                "/game/prepare",
                json={"scripts": {"bad_god_rays.ps": source}},
            )
            self.assertEqual(response.status_code, 400)
            self.assertIn("set_god_rays", response.get_json()["error"])


    def test_camera_lens_api_is_available_to_browser_game_scripts(self):
        self.assertEqual(app.GAME_FUNCTIONS.get("set_camera_lens"), 4)
        parsed = self.validate_game_scripts({
            "camera_lens.ps": (
                "func start()\\n"
                "    set_camera_lens(true, 18, 2.8, 0.08)\\n"
            )
        })
        self.assertIn("camera_lens.ps", parsed)
        self.assertEqual(parsed["camera_lens.ps"]["body"][0]["name"], "start")

    def test_camera_lens_api_rejects_wrong_argument_counts(self):
        for source in [
            "func start()\\n    set_camera_lens(true, 18, 2.8)\\n",
            "func start()\\n    set_camera_lens(true, 18, 2.8, 0.08, 1)\\n",
        ]:
            response = self.client.post(
                "/game/prepare",
                json={"scripts": {"bad_camera_lens.ps": source}},
            )
            self.assertEqual(response.status_code, 400)
            self.assertIn("set_camera_lens", response.get_json()["error"])

    def test_game_prepare_rejects_oversized_combined_script_payload(self):
        response = self.client.post(
            "/game/prepare",
            json={"scripts": {"large.ps": "x" * (512 * 1024 + 1)}},
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("512KB", response.get_json()["error"])


if __name__ == "__main__":
    unittest.main()
