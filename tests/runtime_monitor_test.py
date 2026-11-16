"""GPU telemetry must distinguish an idle device from missing telemetry."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from runtime_monitor import parse_gpu


class GpuCounterTests(unittest.TestCase):
    def test_reads_actual_counter_and_chip(self):
        result = parse_gpu('"model" = "Apple M3 Pro"\n"PerformanceStatistics" = {"Device Utilization %"=73}')
        self.assertEqual(result['name'], 'Apple M3 Pro')
        self.assertEqual(result['utilization_percent'], 73)
        self.assertEqual(result['scope'], 'whole Mac, all applications')

    def test_idle_is_zero_and_missing_is_unknown(self):
        self.assertEqual(parse_gpu('"Device Utilization %"=0')['utilization_percent'], 0)
        self.assertIsNone(parse_gpu('')['utilization_percent'])
        self.assertIsNone(parse_gpu('')['name'])


if __name__ == '__main__':
    unittest.main()
