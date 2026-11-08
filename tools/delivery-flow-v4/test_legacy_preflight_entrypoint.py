"""Check the preserved installed R3 entrypoint against its real fixed release."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

LEGACY_ENTRYPOINT = Path('E:/codex/yunticket/.test-tmp/jot-permissive-20261021/integration/tools/delivery-flow-v1/tool_entrypoint.py')


class LegacyPreflightEntrypointTests(unittest.TestCase):
    def test_original_r3_release_non_help_reaches_packet_validation(self):
        parent = Path(__file__).resolve().parents[2] / '.test-tmp/legacy-preflight-entrypoint'
        parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=parent) as directory:
            missing = Path(directory) / 'missing-packet.json'
            result = subprocess.run(['python', '-B', str(LEGACY_ENTRYPOINT), 'preflight', str(missing),
                                     '--root', directory], capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 1, result.stderr)
            response = json.loads(result.stdout)
            self.assertFalse(response['ok'])
            self.assertIn('missing-packet.json', response['error'])
            self.assertNotIn('ModuleNotFoundError', result.stdout + result.stderr)
            self.assertFalse(missing.exists())


if __name__ == '__main__':
    unittest.main()
