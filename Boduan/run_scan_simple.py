"""Simplest possible scan runner - direct execution with file output."""
import sys
import os

os.environ["TQDM_DISABLE"] = "1"
os.environ["PYTHONUNBUFFERED"] = "1"
os.environ["PYTHONIOENCODING"] = "utf-8"

# Run the scan
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from daily_scan import main
main()
