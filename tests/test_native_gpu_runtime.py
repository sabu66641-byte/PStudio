import pathlib
import shutil
import subprocess
import tempfile
import unittest


class NativeGpuRuntimeTests(unittest.TestCase):
    def test_native_gpu_resource_recovery_compiles_and_runs_without_hardware(self):
        compiler = shutil.which("g++") or shutil.which("clang++")
        if not compiler:
            self.skipTest("A C++17 compiler is not installed.")
        root = pathlib.Path(__file__).resolve().parents[1]
        source = root / "tests" / "native_gpu_runtime_smoke.cpp"
        with tempfile.TemporaryDirectory(prefix="pstudio_native_gpu_runtime_") as temp:
            binary = pathlib.Path(temp) / "native_gpu_runtime_smoke"
            compiled = subprocess.run(
                [compiler, "-std=c++17", "-O2", "-Wall", "-Wextra", "-pedantic",
                 "-I", str(root / "native" / "include"), str(source), "-o", str(binary)],
                capture_output=True, text=True, timeout=30, check=False,
            )
            self.assertEqual(
                compiled.returncode, 0,
                msg="Native GPU runtime test did not compile:\n" + compiled.stderr,
            )
            executed = subprocess.run(
                [str(binary)], capture_output=True, text=True, timeout=5, check=False
            )
            self.assertEqual(executed.returncode, 0, msg=executed.stderr)


if __name__ == "__main__":
    unittest.main()
