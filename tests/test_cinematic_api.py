import pathlib
import unittest

import app


ROOT = pathlib.Path(__file__).resolve().parents[1]


class CinematicGameApiTests(unittest.TestCase):
    def setUp(self):
        app.app.config.update(TESTING=True)
        self.client = app.app.test_client()

    def prepare(self, source):
        return self.client.post(
            "/game/prepare",
            json={"scripts": {"cinematic.ps": source}},
        )

    def test_all_cinematic_calls_are_accepted_in_game_ast(self):
        source = (
            "func start()\n"
            "    camera_shake(0.9, 0.24)\n"
            "    set_time_scale(0.2)\n"
            "    set_god_rays(true, 0.7)\n"
            "func update(dt)\n"
            "    draw_trail(\"weapon-id\", \"#8fe6ff\", 0.08, 0.3)\n"
        )
        response = self.prepare(source)
        self.assertEqual(response.status_code, 200, msg=response.get_json())
        tree = response.get_json()["scripts"]["cinematic.ps"]

        calls = {}

        def visit(value):
            if isinstance(value, dict):
                if value.get("type") == "CallExpr":
                    calls[value["name"]] = len(value.get("args", []))
                for child in value.values():
                    visit(child)
            elif isinstance(value, list):
                for child in value:
                    visit(child)

        visit(tree)
        self.assertEqual(
            calls,
            {
                "camera_shake": 2,
                "set_time_scale": 1,
                "set_god_rays": 2,
                "draw_trail": 4,
            },
        )

    def test_each_cinematic_api_rejects_wrong_arity(self):
        examples = {
            "camera_shake": "camera_shake(1)",
            "set_time_scale": "set_time_scale(1, 2)",
            "draw_trail": 'draw_trail("weapon", "#ffffff", 0.1)',
            "set_god_rays": "set_god_rays(true)",
        }
        for name, call in examples.items():
            with self.subTest(name=name):
                response = self.prepare("func start()\n    " + call + "\n")
                self.assertEqual(response.status_code, 400)
                self.assertIn(name, response.get_json()["error"])

    def test_cinematic_apis_remain_game_runtime_only(self):
        response = self.client.post(
            "/compile",
            json={"code": "camera_shake(1, 0.2)\n"},
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("未定義の関数", response.get_json()["error"])

    def test_cinematic_demo_example_passes_game_script_validation(self):
        example = ROOT / "examples" / "cinematic_demo.ps"
        response = self.prepare(example.read_text(encoding="utf-8"))
        self.assertEqual(response.status_code, 200, msg=response.get_json())


if __name__ == "__main__":
    unittest.main()
