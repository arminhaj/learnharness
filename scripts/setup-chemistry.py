"""Install the optional local 3D runtime without changing the system Python."""
from pathlib import Path
import shutil
import subprocess
import sys

root = Path(__file__).resolve().parent.parent
venv = root / ".venv-chemistry"
python = venv / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
uv = shutil.which("uv")
if uv:
    if not python.exists():
        subprocess.run([uv, "venv", "--python", "3.12", str(venv)], check=True)
    subprocess.run([uv, "pip", "install", "--python", str(python), "rdkit==2026.9.1"], check=True)
else:
    if not python.exists():
        subprocess.run([sys.executable, "-m", "venv", str(venv)], check=True)
    subprocess.run([str(python), "-m", "pip", "install", "rdkit==2026.9.1"], check=True)
print("3D chemistry ready:", python)
