import subprocess, sys, os

def test_output():
    # Run count.py and capture output
    result = subprocess.run([sys.executable, 'count.py'], capture_output=True, text=True)
    assert result.returncode == 0
    # Expected output lines 1-5 each on its own line
    expected = "\n".join(str(i) for i in range(1, 6)) + "\n"
    assert result.stdout == expected
