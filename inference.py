"""The accepted M1 feature/probe path; no network or media persistence."""
import hashlib
import json
import os
import time
from pathlib import Path

import numpy as np
import torch
from transformers import VideoMAEImageProcessor, VideoMAEModel

ROOT = Path(__file__).resolve().parent
REVISION = 'dc740ceda42fce44faed2ea03c6d447db72f6af9'


def sample_indices(count):
    if count < 1:
        raise ValueError('No decoded frames')
    return np.rint(np.linspace(0, count - 1, 16)).astype(int)


class Predictor:
    def __init__(self, device=None):
        self.device = device or os.environ.get('SKATELENS_DEVICE') or ('mps' if torch.backends.mps.is_available() else 'cpu')
        if self.device not in ('mps', 'cpu'): raise ValueError('Choose cpu or mps for local inference')
        config = json.loads((ROOT / 'model-config.json').read_text())
        assert config['revision'] == REVISION and config['transformers'] == '4.57.1'
        self.processor = VideoMAEImageProcessor.from_dict(config['processor'])
        self.model, self.loading = VideoMAEModel.from_pretrained(
            ROOT / 'models/encoder', local_files_only=True, output_loading_info=True,
            attn_implementation='sdpa',
        )
        assert not self.loading['missing_keys'], self.loading
        assert not self.loading.get('mismatched_keys'), self.loading
        assert not self.loading.get('error_msgs'), self.loading
        assert all(k.startswith(('decoder.', 'encoder_to_decoder.', 'mask_token'))
                   for k in self.loading['unexpected_keys']), self.loading
        self.model.eval().to(self.device)
        for parameter in self.model.parameters():
            parameter.requires_grad_(False)
        p = json.loads((ROOT / 'models/probe.json').read_text())
        assert p['class_order'] == ['kickflip', 'ollie'] and p['classes'] == [0, 1]
        self.mean, self.scale = np.array(p['mean']), np.array(p['scale'])
        self.coef, self.intercept = np.array(p['coef']), np.array(p['intercept'])
        assert self.coef.shape == (1, 768) and np.all(self.scale > 0)
        self.probe_sha = p['source_sha256']
        self.ready = True

    def synchronize(self):
        if self.device == 'mps':
            torch.mps.synchronize()

    def predict(self, frames, audit=False):
        if len(frames) != 16:
            raise ValueError('Exactly 16 decoded RGB frames required')
        start = time.perf_counter()
        inputs = self.processor(frames, return_tensors='pt')
        processed = time.perf_counter()
        with torch.inference_mode():
            x = inputs['pixel_values'].to(self.device)
            feature = self.model(pixel_values=x).last_hidden_state.mean(dim=1).cpu().numpy()
        self.synchronize()
        encoded = time.perf_counter()
        logit = ((feature - self.mean) / self.scale) @ self.coef.T + self.intercept
        ollie = float(1 / (1 + np.exp(-np.clip(logit[0, 0], -700, 700))))
        scores = {'kickflip': 1 - ollie, 'ollie': ollie}
        label = max(scores, key=scores.get)
        result = {
            'label': label, 'scores': scores, 'confidence': scores[label],
            'margin': abs(1 - 2 * ollie), 'device': self.device,
            'preprocess_ms': (processed - start) * 1000,
            'encoder_ms': (encoded - processed) * 1000,
            'inference_ms': (time.perf_counter() - start) * 1000,
            'model_revision': REVISION, 'probe_sha256': self.probe_sha,
            'frames': 16, 'calibrated': False,
        }
        if audit:
            result['audit'] = {'frame_shape': list(np.asarray(frames[0]).shape),
                               'frame_hashes': [hashlib.sha256(np.asarray(f).tobytes()).hexdigest() for f in frames],
                               'input_sha256': hashlib.sha256(inputs['pixel_values'].numpy().tobytes()).hexdigest(),
                               'attention': self.model.config._attn_implementation}
        return result
