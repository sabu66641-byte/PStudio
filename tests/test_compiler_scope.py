import pathlib
import shutil
import subprocess
import tempfile
import unittest

import app


ROOT = pathlib.Path(__file__).resolve().parents[1]


class CompilerScopeRegressionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.compiler = shutil.which("g++")

    def compile_and_run(self, source):
        if not self.compiler:
            self.skipTest("g++ is not installed; C++ compilation regression test skipped.")

        tree = app.parse(app.tokenize(source))
        app.validate_ast(tree)
        cpp = app.generate_cpp(tree)

        with tempfile.TemporaryDirectory(prefix="pstudio_scope_test_") as workdir:
            source_path = pathlib.Path(workdir) / "main.cpp"
            executable_path = pathlib.Path(workdir) / "main"
            source_path.write_text(cpp, encoding="utf-8")
            compiled = subprocess.run(
                [self.compiler, "-std=c++17", str(source_path), "-o", str(executable_path)],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=20,
                check=False,
            )
            self.assertEqual(
                compiled.returncode,
                0,
                msg="Generated C++ failed to compile:\n" + compiled.stderr + "\n--- C++ ---\n" + cpp,
            )
            executed = subprocess.run(
                [str(executable_path)],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=5,
                check=False,
            )
            self.assertEqual(executed.returncode, 0, msg=executed.stderr)
            return executed.stdout.strip().splitlines()

    def test_if_else_variables_are_visible_after_the_branch(self):
        output = self.compile_and_run(
            'if true\n'
            '    score = 12\n'
            'else\n'
            '    score = 30\n'
            'ps score\n'
        )
        self.assertEqual(output, ["12"])

    def test_while_body_variables_are_visible_after_the_loop(self):
        output = self.compile_and_run(
            'counter = 0\n'
            'while counter < 3\n'
            '    if counter == 1\n'
            '        branch_value = 5\n'
            '    else\n'
            '        branch_value = 7\n'
            '    counter += 1\n'
            'ps branch_value\n'
        )
        self.assertEqual(output, ["7"])

    def test_for_loop_variable_and_body_variables_remain_in_scope(self):
        output = self.compile_and_run(
            'total = 0\n'
            'for item in range(4)\n'
            '    total += item\n'
            'ps total\n'
            'ps item\n'
        )
        self.assertEqual(output, ["6", "3"])

    def test_function_branch_variables_are_visible_to_return(self):
        output = self.compile_and_run(
            'func calculate()\n'
            '    if true\n'
            '        result = 40\n'
            '    return result + 2\n'
            'ps calculate()\n'
        )
        self.assertEqual(output, ["42"])

    def test_integer_division_matches_ps_numeric_semantics(self):
        output = self.compile_and_run(
            'ps 3 / 2\n'
        )
        self.assertEqual(output, ["1.5"])

    def test_floating_point_modulo_compiles_and_runs(self):
        output = self.compile_and_run(
            'value = 5.5 % 2.0\n'
            'ps value\n'
        )
        self.assertEqual(output, ["1.5"])

    def test_boolean_array_loop_variable_uses_value_type_after_loop(self):
        output = self.compile_and_run(
            'for flag in [true, false]\n'
            '    last = flag\n'
            'if last\n'
            '    ps "true"\n'
            'else\n'
            '    ps "false"\n'
        )
        self.assertEqual(output, ["false"])

    def test_cpp_reserved_identifier_is_rejected_as_ps_semantic_error(self):
        tree = app.parse(app.tokenize("class = 1\n"))
        with self.assertRaisesRegex(Exception, r"C\+\+予約語"):
            app.validate_ast(tree)

    def test_boolean_literal_cannot_be_assigned_as_identifier(self):
        tree = app.parse(app.tokenize("true = 1\n"))
        with self.assertRaisesRegex(Exception, "論理値"):
            app.validate_ast(tree)

    def test_reserved_cpp_function_name_is_rejected(self):
        tree = app.parse(app.tokenize("func namespace()\n    return 1\n"))
        with self.assertRaisesRegex(Exception, r"C\+\+予約語"):
            app.validate_ast(tree)


if __name__ == "__main__":
    unittest.main()
