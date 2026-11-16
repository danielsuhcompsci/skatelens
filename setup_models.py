"""Reproduce the approved local-weight setup. Never downloads project videos."""
import base64
import hashlib
import io
import json
import shutil
import tarfile
import urllib.request
from pathlib import Path

from huggingface_hub import snapshot_download

ROOT = Path(__file__).resolve().parent
EXPECTED_PROBE = 'e1cd03ee8a78d59c28c3d2ee66d81327a271844affa968a275a0b16d0f605d42'


def main():
    models = ROOT/'models'; models.mkdir(exist_ok=True)
    hashes = json.loads((ROOT/'config/artifacts.json').read_text())
    encoder = models/'encoder'
    if not (encoder/'model.safetensors').exists():
        snapshot_download('MCG-NJU/videomae-base', revision='dc740ceda42fce44faed2ea03c6d447db72f6af9',
                          allow_patterns=['config.json','preprocessor_config.json','model.safetensors'], local_dir=encoder)
    probe_path = models/'probe-all-training-clips.joblib'
    if not probe_path.exists():
        from kaggle.api.kaggle_api_extended import KaggleApi
        api=KaggleApi(); api.authenticate()
        api.kernels_output('dsuhcs/skateboardml-img3115-inference',str(models),
                           file_pattern=r'(^|/)probe-all-training-clips\.joblib$')
    assert hashlib.sha256(probe_path.read_bytes()).hexdigest() == EXPECTED_PROBE, 'Kaggle probe changed; refusing to load it'
    if not (models/'probe.json').exists():
        import joblib
        pipeline=joblib.load(probe_path)
        scaler=pipeline.named_steps['standardscaler']; classifier=pipeline.named_steps['logisticregression']
        config={'class_order':['kickflip','ollie'],'classes':classifier.classes_.tolist(),
                'mean':scaler.mean_.tolist(),'scale':scaler.scale_.tolist(),
                'coef':classifier.coef_.tolist(),'intercept':classifier.intercept_.tolist(),
                'source_sha256':EXPECTED_PROBE,
                'source':'dsuhcs/skateboardml-img3115-inference; probe-all-training-clips.joblib'}
        (models/'probe.json').write_text(json.dumps(config))
    pose = models/'pose_landmarker_lite.task'
    if not pose.exists():
        with urllib.request.urlopen('https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task') as response:
            pose.write_bytes(response.read())
    vendor=ROOT/'web/vendor/mediapipe'
    if not (vendor/'vision_bundle.js').exists():
        package=json.loads((ROOT/'config/mediapipe-package.json').read_text())
        with urllib.request.urlopen(package['dist']['tarball']) as response: data=response.read()
        digest=base64.b64encode(hashlib.sha512(data).digest()).decode()
        assert 'sha512-'+digest==package['dist']['integrity']
        vendor.mkdir(parents=True,exist_ok=True)
        with tarfile.open(fileobj=io.BytesIO(data),mode='r:gz') as archive:
            for member in archive.getmembers():
                if not member.isfile(): continue
                relative=Path(member.name).relative_to('package')
                assert '..' not in relative.parts
                dest=vendor/relative; dest.parent.mkdir(parents=True,exist_ok=True)
                dest.write_bytes(archive.extractfile(member).read())
        shutil.copyfile(vendor/'vision_bundle.cjs',vendor/'vision_bundle.js')
    for name,expected in hashes.items():
        actual=hashlib.sha256((ROOT/name).read_bytes()).hexdigest()
        assert actual==expected['sha256'], f'Artifact mismatch: {name}'
    print('Pinned model, classifier, pose weights, and browser runtime are ready.')


if __name__=='__main__': main()
