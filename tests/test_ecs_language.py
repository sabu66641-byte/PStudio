import unittest

import app


class PsEcsLanguageTests(unittest.TestCase):
    def setUp(self):
        app.app.config.update(TESTING=True)
        self.client = app.app.test_client()

    def test_parser_builds_component_and_system_ast_with_member_assignment(self):
        source = (
            "component EnemyAI\n"
            "    speed = 3.0\n"
            "    health = 100\n"
            "\n"
            "system MoveEnemy(Transform, EnemyAI)\n"
            "    transform.x += enemy_ai.speed * dt\n"
        )
        tree = app.parse(app.tokenize(source))
        self.assertEqual(
            [node["type"] for node in tree["body"]],
            ["ComponentDef", "SystemDef"],
        )
        self.assertEqual(tree["body"][0]["name"], "EnemyAI")
        self.assertEqual(tree["body"][0]["body"][0]["variable"], "speed")
        system = tree["body"][1]
        self.assertEqual(system["components"], ["Transform", "EnemyAI"])
        statement = system["body"][0]
        self.assertEqual(statement["type"], "MemberCompoundAssignment")
        self.assertEqual(statement["target"]["type"], "MemberExpr")
        self.assertEqual(statement["target"]["property"], "x")

    def test_game_prepare_accepts_ecs_declarations_and_member_fields(self):
        source = (
            "component EnemyAI\n"
            "    speed = 3.0\n"
            "    health = 100\n"
            "\n"
            "system MoveEnemy(Transform, EnemyAI)\n"
            "    transform.x += enemy_ai.speed * dt\n"
            "    enemy_ai.health -= 1\n"
        )
        response = self.client.post(
            "/game/prepare",
            json={"scripts": {"ecs.ps": source}},
        )
        self.assertEqual(response.status_code, 200, msg=response.get_json())
        result = response.get_json()["scripts"]["ecs.ps"]
        self.assertEqual(result["body"][0]["type"], "ComponentDef")
        self.assertEqual(result["body"][1]["type"], "SystemDef")

    def test_system_can_reference_component_defined_in_another_script(self):
        scripts = {
            "components.ps": "component EnemyAI\n    speed = 2.5\n",
            "systems.ps": (
                "system MoveEnemy(Transform, EnemyAI)\n"
                "    transform.x += enemy_ai.speed * dt\n"
            ),
        }
        response = self.client.post("/game/prepare", json={"scripts": scripts})
        self.assertEqual(response.status_code, 200, msg=response.get_json())

    def test_game_prepare_rejects_unknown_component_and_unknown_field(self):
        unknown_component = self.client.post(
            "/game/prepare",
            json={"scripts": {"bad.ps": "system Move(Transform, Ghost)\n    transform.x += dt\n"}},
        )
        self.assertEqual(unknown_component.status_code, 400)
        self.assertIn("未定義Component", unknown_component.get_json()["error"])

        unknown_field = self.client.post(
            "/game/prepare",
            json={"scripts": {
                "bad.ps": (
                    "component EnemyAI\n    speed = 2\n"
                    "system Move(Transform, EnemyAI)\n"
                    "    enemy_ai.velocity += dt\n"
                )
            }},
        )
        self.assertEqual(unknown_field.status_code, 400)
        self.assertIn("Field 'velocity'", unknown_field.get_json()["error"])

    def test_ecs_declarations_are_not_accepted_by_normal_cpp_compile_path(self):
        response = self.client.post(
            "/compile",
            json={"code": "component EnemyAI\n    speed = 1\n"},
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("ブラウザゲームスクリプト", response.get_json()["error"])

    def test_component_and_system_remain_valid_variable_names(self):
        source = "component = 2\nsystem = 3\nps component + system\n"
        tree = app.parse(app.tokenize(source))
        app.validate_ast(tree)
        self.assertEqual(tree["body"][0]["type"], "AssignmentExpression")
        self.assertEqual(tree["body"][1]["type"], "AssignmentExpression")

    def test_component_defaults_must_be_static_literal_values(self):
        response = self.client.post(
            "/game/prepare",
            json={"scripts": {"bad.ps": "component EnemyAI\n    speed = range(3)\n"}},
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("リテラル", response.get_json()["error"])

    def test_ecs_declarations_cannot_be_nested_inside_functions(self):
        response = self.client.post(
            "/game/prepare",
            json={"scripts": {"bad.ps": "func start()\n    component EnemyAI\n        speed = 1\n"}},
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("トップレベル", response.get_json()["error"])


if __name__ == "__main__":
    unittest.main()
