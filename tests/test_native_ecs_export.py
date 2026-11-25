import io
import pathlib
import shutil
import subprocess
import tempfile
import unittest
import zipfile

import app


class NativeEcsExportTests(unittest.TestCase):
    def setUp(self):
        app.app.config.update(TESTING=True)
        self.client = app.app.test_client()

    def sample_scripts(self):
        return {
            "components.ps": (
                "component EnemyAI\n"
                "    speed = 3.0\n"
                "    health = 100\n"
                "    label = \"Enemy\"\n"
            ),
            "systems.ps": (
                "system MoveEnemy(Transform, EnemyAI)\n"
                "    transform.x += enemy_ai.speed * dt\n"
                "    if enemy_ai.label\n"
                "        transform.z = 1\n"
                "    for step in range(2)\n"
                "        transform.y += enemy_ai.speed\n"
                "    if enemy_ai.health <= 0\n"
                "        transform.y = 0\n"
            ),
        }

    def export(self, scripts=None):
        return self.client.post(
            "/native/ecs/export",
            json={"scripts": scripts or self.sample_scripts()},
        )

    def test_export_returns_portable_cmake_project(self):
        response = self.export()
        self.assertEqual(response.status_code, 200, msg=response.get_json())
        self.assertIn("application/zip", response.content_type)
        with zipfile.ZipFile(io.BytesIO(response.data)) as archive:
            self.assertIsNone(archive.testzip())
            names = set(archive.namelist())
            self.assertTrue({
                "CMakeLists.txt",
                "README.md",
                "native/include/pstudio/ecs.hpp",
                "src/pstudio_generated.hpp",
                "src/pstudio_generated.cpp",
                "src/main.cpp",
            }.issubset(names))
            generated = archive.read("src/pstudio_generated.cpp").decode("utf-8")
            self.assertIn("world.each<Transform, EnemyAI>", generated)
            self.assertIn("transform.x += (enemy_ai.speed * dt);", generated)
            self.assertIn("scheduler.add", generated)
            readme = archive.read("README.md").decode("utf-8")
            self.assertIn("not yet a complete PStudio game port", readme)

    def test_exported_native_cpp17_project_compiles_and_runs(self):
        compiler = shutil.which("g++")
        if not compiler:
            self.skipTest("g++ is not installed.")
        response = self.export()
        self.assertEqual(response.status_code, 200, msg=response.get_json())
        with tempfile.TemporaryDirectory(prefix="pstudio_native_ecs_") as temp:
            root = pathlib.Path(temp)
            with zipfile.ZipFile(io.BytesIO(response.data)) as archive:
                archive.extractall(root)
            binary = root / "pstudio_native_sample"
            compiled = subprocess.run(
                [
                    compiler, "-std=c++17", "-O2",
                    "-I", str(root / "native" / "include"),
                    "-I", str(root / "src"),
                    str(root / "src" / "main.cpp"),
                    str(root / "src" / "pstudio_generated.cpp"),
                    "-o", str(binary),
                ],
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
            self.assertEqual(
                compiled.returncode, 0,
                msg="Native ECS C++17 source did not compile:\n" + compiled.stderr,
            )
            executed = subprocess.run(
                [str(binary)],
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
            self.assertEqual(executed.returncode, 0, msg=executed.stderr)
            self.assertIn("entities=1", executed.stdout)
            self.assertIn("x=0.05", executed.stdout)
            self.assertIn("y=6", executed.stdout)
            self.assertIn("z=1", executed.stdout)

    def test_export_rejects_non_native_functions_in_systems(self):
        scripts = {
            "main.ps": (
                "component EnemyAI\n"
                "    speed = 3.0\n"
                "system MoveEnemy(Transform, EnemyAI)\n"
                "    set_x(enemy_ai.speed)\n"
            )
        }
        response = self.export(scripts)
        self.assertEqual(response.status_code, 400)
        self.assertIn("not yet supported", response.get_json()["error"])

    def test_export_rejects_missing_component_references(self):
        scripts = {
            "main.ps": (
                "system MoveEnemy(Transform, Ghost)\n"
                "    transform.x += dt\n"
            )
        }
        response = self.export(scripts)
        self.assertEqual(response.status_code, 400)
        self.assertIn("未定義Component", response.get_json()["error"])


if __name__ == "__main__":
    unittest.main()
