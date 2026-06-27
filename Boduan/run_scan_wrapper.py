"""Simple wrapper to run daily_scan.py and capture all output to a file."""
import sys
import os

# Ensure stdout/stderr can handle Unicode on Windows
if sys.platform == "win32":
    sys.stdout = open(sys.stdout.fileno(), mode="w", encoding="utf-8", errors="replace", buffering=1)
    sys.stderr = open(sys.stderr.fileno(), mode="w", encoding="utf-8", errors="replace", buffering=1)

os.environ["TQDM_DISABLE"] = "1"

log_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs", "scan_final_run.log")
os.makedirs(os.path.dirname(log_path), exist_ok=True)

# Tee: write to both console and file
class Tee:
    def __init__(self, *files):
        self.files = files
    def write(self, data):
        for f in self.files:
            f.write(data)
            f.flush()
    def flush(self):
        for f in self.files:
            f.flush()

log_f = open(log_path, "w", encoding="utf-8", errors="replace")
sys.stdout = Tee(sys.__stdout__, log_f)
sys.stderr = Tee(sys.__stderr__, log_f)

print(f"=== Daily Scan started at {__import__('datetime').datetime.now()} ===")
sys.stdout.flush()

# Import and run
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from daily_scan import main
main()

print(f"=== Daily Scan completed at {__import__('datetime').datetime.now()} ===")
log_f.close()
