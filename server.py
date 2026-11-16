"""Loopback-only UI + bounded, memory-only clip inference. Run with ./run.sh."""
import asyncio
import base64
import io
import hashlib
import json
import logging
import secrets
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlparse

import numpy as np
import requests
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image, UnidentifiedImageError
from starlette.middleware.trustedhost import TrustedHostMiddleware

from inference import Predictor, sample_indices

ROOT = Path(__file__).resolve().parent
MAX_BODY = 96 * 1024 * 1024
Image.MAX_IMAGE_PIXELS = 1920 * 1080
state = {'status': 'loading', 'error': None}
predictor = None
busy = asyncio.Lock()
replay_bytes = {}
metrics = []


def record_metric(result, mode):
    entry = {**result, 'mode': mode, 'recorded_at': time.time()}
    metrics.append(entry)
    del metrics[:-100]
    # Scores/timings only: no images, videos, embeddings, or user filenames.
    runtime = ROOT / '.runtime'
    runtime.mkdir(exist_ok=True)
    (runtime / 'metrics.json').write_text(json.dumps(metrics, indent=2))


def load_model():
    global predictor
    try:
        predictor = Predictor()
        state.update(status='ready', device=predictor.device, error=None)
    except Exception as error:
        logging.exception('Model loading failed')
        state.update(status='unavailable', error=str(error))


@asynccontextmanager
async def lifespan(app):
    threading.Thread(target=load_model, daemon=True).start()
    yield


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=['127.0.0.1', 'localhost', '[::1]', 'testserver'])


@app.middleware('http')
async def local_only(request, call_next):
    origin = request.headers.get('origin')
    if origin and origin != f'{request.url.scheme}://{request.headers.get("host")}':
        from fastapi.responses import JSONResponse
        return JSONResponse({'detail': 'Same-origin requests only'}, status_code=403)
    response = await call_next(request)
    response.headers['Cache-Control'] = 'no-store'
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['Referrer-Policy'] = 'no-referrer'
    response.headers['Permissions-Policy'] = 'camera=(self), microphone=()'
    response.headers['Content-Security-Policy'] = (
        "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; "
        "style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; "
        "connect-src 'self'; worker-src 'self'; object-src 'none'; frame-ancestors 'none'"
    )
    return response


@app.get('/api/status')
def status():
    return {**state, 'model': 'M1 frozen VideoMAE + linear probe',
            'classes': ['kickflip', 'ollie'], 'frames': 16, 'storage': 'memory only',
            'calibrated': False, 'busy': busy.locked()}


@app.post('/api/analyze')
async def analyze(request: Request):
    if not predictor or state['status'] != 'ready':
        raise HTTPException(503, 'Model unavailable; playback and pose remain available')
    if busy.locked():
        raise HTTPException(429, 'One clip at a time; no inference queue')
    async with busy:
        begin = time.perf_counter()
        body = bytearray()
        async for part in request.stream():
            body.extend(part)
            if len(body) > MAX_BODY:
                raise HTTPException(413, 'Clip frame payload exceeds 96 MB')
        try:
            data = json.loads(body)
            del body
            encoded = data['frames']
            if len(encoded) != 16:
                raise ValueError('Exactly 16 frames required')
            frames = []
            for frame in encoded:
                raw = base64.b64decode(frame, validate=True)
                with Image.open(io.BytesIO(raw)) as image:
                    if image.format != 'PNG' or image.width * image.height > 1920 * 1080:
                        raise ValueError('Lossless PNG frames up to 1920 × 1080 required')
                    frames.append(np.array(image.convert('RGB')))
            if len({f.shape for f in frames}) != 1:
                raise ValueError('All frames must have the same dimensions')
            del data, encoded
        except (ValueError, KeyError, TypeError, UnidentifiedImageError) as error:
            raise HTTPException(422, str(error)) from error
        decoded = time.perf_counter()
        result = await asyncio.to_thread(predictor.predict, frames)
        result.update(decode_ms=(decoded - begin) * 1000,
                      server_ms=(time.perf_counter() - begin) * 1000)
        record_metric(result, 'live-frames')
        return result


@app.api_route('/_clip/{token}', methods=['GET', 'HEAD'])
def memory_clip(token: str, request: Request):
    data = replay_bytes.get(token)
    if data is None:
        raise HTTPException(404)
    start, end = 0, len(data) - 1
    status = 200
    if request.headers.get('range'):
        import re
        match = re.fullmatch(r'bytes=(\d+)-(\d*)', request.headers['range'])
        if not match:
            raise HTTPException(416)
        start = int(match[1]); end = min(end, int(match[2])) if match[2] else end
        if start > end:
            raise HTTPException(416)
        status = 206
    headers = {'Accept-Ranges': 'bytes', 'Content-Length': str(end - start + 1)}
    if status == 206:
        headers['Content-Range'] = f'bytes {start}-{end}/{len(data)}'
    return Response(b'' if request.method == 'HEAD' else data[start:end + 1],
                    status_code=status, headers=headers, media_type='video/mp4')


def decode_replay(url, start, end):
    import cv2
    backend_names = []
    # Two bounded passes count actual decoded frames, then select the same
    # np.rint(linspace) indices as M1. No guessed FPS-based frame stride.
    def iterator():
        cap = cv2.VideoCapture(url)
        try:
            if not cap.isOpened():
                raise ValueError('Video codec could not be decoded')
            backend_names.append(cap.getBackendName())
            fps = cap.get(cv2.CAP_PROP_FPS)
            index = 0
            while True:
                ok, frame = cap.read()
                if not ok: break
                timestamp = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000
                if not np.isfinite(timestamp):
                    raise ValueError('Video timestamps are unavailable')
                if timestamp >= end: break
                if index > 36000: raise ValueError('Video exceeds frame bound')
                if timestamp >= start:
                    yield timestamp, frame
                index += 1
        finally:
            cap.release()
    count = sum(1 for _ in iterator())
    indices = sample_indices(count)
    selected, times = {}, {}
    wanted = set(indices)
    for i, (stamp, frame) in enumerate(iterator()):
        if i in wanted:
            if frame.shape[0] * frame.shape[1] > 3840 * 2160:
                raise ValueError('Replay resolution exceeds 4K')
            selected[i] = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            times[i] = stamp
    return [selected[i] for i in indices], {
        'decoded_frames': count, 'sampled_indices': indices.tolist(),
        'sampled_timestamps': [times[i] for i in indices], 'decoder': f'OpenCV {cv2.__version__}',
        'decoder_backend': backend_names[0],
        'sampling': 'uniform inclusive first-last; ties-to-even rounding',
    }


@app.post('/api/replay')
async def replay(request: Request, start: float = 0, end: float = 2, audit: bool = False):
    if not predictor or state['status'] != 'ready':
        raise HTTPException(503, 'Local model unavailable')
    if busy.locked(): raise HTTPException(429, 'One clip at a time; no inference queue')
    if not (0 <= start < end <= 60 and end - start <= 6):
        raise HTTPException(422, 'Select a window up to 6 seconds within the first minute')
    async with busy:
        begin = time.perf_counter()
        body = bytearray()
        async for part in request.stream():
            body.extend(part)
            if len(body) > 64 * 1024 * 1024:
                raise HTTPException(413, 'Replay file exceeds 64 MB')
        token = secrets.token_hex(24)
        clip_sha = hashlib.sha256(body).hexdigest()
        replay_bytes[token] = bytes(body)
        del body
        try:
            url = f'http://127.0.0.1:8765/_clip/{token}'
            frames, metadata = await asyncio.to_thread(decode_replay, url, start, end)
            decoded = time.perf_counter()
            result = await asyncio.to_thread(predictor.predict, frames, audit)
            result.update(metadata, decode_ms=(decoded-begin)*1000,
                          server_ms=(time.perf_counter()-begin)*1000)
            if audit: result['audit']['clip_sha256'] = clip_sha
            record_metric(result, 'replay')
            return result
        except (ValueError, KeyError) as error:
            raise HTTPException(422, str(error)) from error
        finally:
            replay_bytes.pop(token, None)


# Only these existing public source clips can be streamed. No arbitrary URLs.
# Requests stream directly into browser playback; the server never saves media.
SAMPLES = {
    'kickflip-0': ('Kickflip 0', 'Kickflip/Kickflip0.mov'),
    'kickflip-10': ('Kickflip 10', 'Kickflip/Kickflip10.mov'),
    'ollie-0': ('Ollie 0', 'Ollie/Ollie0.mov'),
    'ollie-10': ('Ollie 10', 'Ollie/Ollie10.mov'),
    'personal': ('Personal session · IMG_3115', None),
    'personal-trim': ('Kaggle reference · 4–6 s', None),
}
SOURCE_REV = '2413e9a6ba7bf09cd08bf5c8d90f61737ebe3ea5'


@app.get('/api/samples')
def samples():
    return [{'id': key, 'name': value[0], 'url': f'/media/{key}', 'split': 'training source'}
            for key, value in SAMPLES.items()]


@app.get('/media/{sample}')
def sample_stream(sample: str, request: Request):
    if sample not in SAMPLES:
        raise HTTPException(404)
    if sample == 'personal-trim':
        from kaggle.api.kaggle_api_extended import KaggleApi, ApiListKernelSessionOutputRequest
        try:
            api = KaggleApi(); api.authenticate()
            with api.build_kaggle_client() as client:
                query = ApiListKernelSessionOutputRequest()
                query.user_name = 'dsuhcs'; query.kernel_slug = 'skateboardml-img3115-inference'
                query.page_size = 100
                listing = client.kernels.kernels_api_client.list_kernel_session_output(query)
            url = next(f.url for f in listing.files if f.file_name == 'IMG_3115_4s-6s.mp4')
            upstream = requests.get(url, stream=True, timeout=(10, 40))
            upstream.raise_for_status()
        except Exception as error:
            raise HTTPException(502, 'Kaggle reference clip unavailable') from error
        def reference_chunks():
            try: yield from upstream.iter_content(256 * 1024)
            finally: upstream.close()
        return StreamingResponse(reference_chunks(), media_type='video/mp4',
                                 headers={'Content-Length': upstream.headers.get('Content-Length', '')})
    if sample == 'personal':
        # The authenticated Kaggle response is streamed for browser playback.
        # No token/signed URL is sent to the browser or written to disk.
        from kaggle.api.kaggle_api_extended import KaggleApi, ApiDownloadDatasetRequest
        try:
            api = KaggleApi(); api.authenticate()
            with api.build_kaggle_client() as client:
                query = ApiDownloadDatasetRequest()
                query.owner_slug = 'dsuhcs'
                query.dataset_slug = 'skateboardml-personal-img3115'
                query.dataset_version_number = 1
                query.file_name = 'IMG_3115.MOV'
                upstream = client.datasets.dataset_api_client.download_dataset(query)
                upstream.raise_for_status()
                # Kaggle may wrap a file in ZIP. Unwrap in memory for playback.
                content = upstream.content
            if len(content) > 64 * 1024 * 1024:
                raise ValueError('Personal source exceeds stream bound')
            if content[:2] == b'PK':
                import zipfile
                with zipfile.ZipFile(io.BytesIO(content)) as archive:
                    info = archive.getinfo('IMG_3115.MOV')
                    if info.file_size > 64 * 1024 * 1024: raise ValueError('Source too large')
                    content = archive.read(info)
            return Response(content, media_type='video/mp4')
        except Exception as error:
            raise HTTPException(502, 'Personal Kaggle replay unavailable') from error
    url = f'https://raw.githubusercontent.com/LightningDrop/SkateboardML/{SOURCE_REV}/Tricks/{SAMPLES[sample][1]}'
    headers = {}
    if 'range' in request.headers:
        headers['Range'] = request.headers['range']
    try:
        upstream = requests.get(url, stream=True, headers=headers, timeout=(10, 40))
        upstream.raise_for_status()
    except requests.RequestException as error:
        raise HTTPException(502, 'Example unavailable; choose a local video') from error
    forwarded = {key: upstream.headers[key] for key in ['Content-Length', 'Content-Range', 'Accept-Ranges'] if key in upstream.headers}

    def chunks():
        try:
            yield from upstream.iter_content(256 * 1024)
        finally:
            upstream.close()
    return StreamingResponse(chunks(), status_code=upstream.status_code,
                             media_type='video/mp4', headers=forwarded)


@app.get('/models/pose.task')
def pose_model():
    return FileResponse(ROOT / 'models/pose_landmarker_lite.task', media_type='application/octet-stream')


app.mount('/', StaticFiles(directory=ROOT / 'web', html=True), name='web')
