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


if __name__ == "__main__":
    unittest.main()
