import unittest

import app


class DiscordInterpreterBudgetTests(unittest.TestCase):
    def parse_interpreter(self, source):
        return app.PsDiscordInterpreter(app.parse(app.tokenize(source)))

    def test_infinite_while_loop_stops_at_instruction_budget(self):
        interpreter = self.parse_interpreter(
            "counter = 0\n"
            "while true\n"
            "    counter += 1\n"
        )
        interpreter.max_steps = 20
        with self.assertRaisesRegex(Exception, "命令上限"):
            interpreter.run()

    def test_nested_function_shares_the_current_execution_budget(self):
        interpreter = self.parse_interpreter(
            "func spin()\n"
            "    while true\n"
            "        counter += 1\n"
            "counter = 0\n"
            "spin()\n"
        )
        interpreter.max_steps = 24
        with self.assertRaisesRegex(Exception, "命令上限"):
            interpreter.run()

    def test_discord_interpreter_bounds_accumulated_output(self):
        interpreter = self.parse_interpreter(
            'ps "abc"\n'
            'ps "def"\n'
        )
        interpreter.max_output_bytes = 6
        with self.assertRaisesRegex(Exception, "出力が上限"):
            interpreter.run()
        self.assertLessEqual(interpreter.output_bytes, 6)

    def test_integer_division_matches_normal_ps_float_division(self):
        interpreter = self.parse_interpreter(
            "ps 3 / 2\n"
        )
        self.assertEqual(interpreter.run(), "1.5")

    def test_prefix_increment_updates_the_target(self):
        interpreter = self.parse_interpreter(
            "counter = 4\n"
            "result = ++counter\n"
            "ps counter\n"
            "ps result\n"
        )
        self.assertEqual(interpreter.run(), "5\n5")

    def test_prefix_decrement_updates_array_item(self):
        interpreter = self.parse_interpreter(
            "values = [4]\n"
            "result = --values[0]\n"
            "ps values[0]\n"
            "ps result\n"
        )
        self.assertEqual(interpreter.run(), "3\n3")

    def test_compound_integer_division_matches_float_semantics(self):
        interpreter = self.parse_interpreter(
            "value = 3\n"
            "value /= 2\n"
            "ps value\n"
        )
        self.assertEqual(interpreter.run(), "1.5")


if __name__ == "__main__":
    unittest.main()
