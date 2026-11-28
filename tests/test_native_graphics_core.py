import pathlib
import shutil
import subprocess
import tempfile
import unittest


class NativeGraphicsCoreTests(unittest.TestCase):
    def test_native_graphics_runtime_compiles_and_runs_as_cpp17(self):
        compiler = shutil.which('g++') or shutil.which('clang++')
        if not compiler:
            self.skipTest('A C++17 compiler is not installed.')
        root = pathlib.Path(__file__).resolve().parents[1]
        source = root / 'tests' / 'native_graphics_core_smoke.cpp'
        with tempfile.TemporaryDirectory(prefix='pstudio_native_graphics_') as temp:
            binary = pathlib.Path(temp) / 'native_graphics_smoke'
            compiled = subprocess.run(
                [compiler, '-std=c++17', '-O2', '-Wall', '-Wextra', '-pedantic', '-I', str(root / 'native' / 'include'), str(source), '-o', str(binary)],
                capture_output=True, text=True, timeout=30, check=False,
            )
            self.assertEqual(compiled.returncode, 0, msg='Native graphics runtime did not compile:\n' + compiled.stderr)
            executed = subprocess.run([str(binary)], capture_output=True, text=True, timeout=5, check=False)
            self.assertEqual(executed.returncode, 0, msg=executed.stderr)


if __name__ == '__main__':
    unittest.main()
