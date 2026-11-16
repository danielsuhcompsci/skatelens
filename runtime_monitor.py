"""Read-only macOS GPU counters. No elevated permissions or media access."""
import platform
import re
import subprocess
import threading
import time


def parse_gpu(text):
    model = re.search(r'"model"\s*=\s*"([^"\n]+)"', text)
    usage = re.search(r'"Device Utilization %"\s*=\s*(\d+)', text)
    return {
        'name': model.group(1) if model else None,
        'utilization_percent': min(100, int(usage.group(1))) if usage else None,
        'scope': 'whole Mac, all applications',
        'source': 'macOS IOAccelerator / Device Utilization %',
    }


class MacGpuMonitor:
    def __init__(self):
        self._lock = threading.Lock()
        self._sample = None
        self._sampled_at = 0

    def read(self):
        if platform.system() != 'Darwin':
            return None
        with self._lock:
            now = time.monotonic()
            if now - self._sampled_at < .4:
                return self._sample
            try:
                result = subprocess.run(
                    ['/usr/sbin/ioreg', '-r', '-c', 'IOAccelerator', '-d', '1', '-l'],
                    capture_output=True, text=True, timeout=.75, check=True,
                )
                self._sample = {**parse_gpu(result.stdout), 'sampled_at': time.time()}
            except (OSError, subprocess.SubprocessError):
                self._sample = None
            self._sampled_at = time.monotonic()
            return self._sample
