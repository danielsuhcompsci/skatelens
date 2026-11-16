# SkateLens model card

## Model

SkateLens uses `MCG-NJU/videomae-base` at revision `dc740ceda42fce44faed2ea03c6d447db72f6af9` as a frozen feature encoder. Mean pooling over its final hidden-state tokens produces a 768-dimensional vector. A saved StandardScaler and logistic regression probe produce the two class scores.

The probe was trained on 222 training clips with balanced class weights and `C=1`. Class 0 is **kickflip**; class 1 is **ollie**. The classifier artifact comes from `dsuhcs/skateboardml-img3115-inference` on Kaggle. Setup verifies its SHA-256 before loading it and exports numeric parameters to JSON; runtime inference does not load pickle files.

## Input recipe

1. Decode the selected video window in memory.
2. Select 16 uniformly spaced frames, including the first and last, using NumPy’s ties-to-even rounding.
3. Convert to RGB, resize the shortest side to 224 pixels using bilinear interpolation, and center-crop to 224 × 224.
4. Scale pixel values by 1/255 and normalize with mean `[0.485, 0.456, 0.406]` and standard deviation `[0.229, 0.224, 0.225]`.
5. Encode, pool, standardize, and apply the fixed linear classifier.

Replay uses OpenCV-decoded frames. The live camera uses 16 samples from an in-memory two-second browser frame buffer. These capture paths can produce different pixels and scores. The pinned processor configuration is in `model-config.json`; downloaded artifact hashes are in `config/artifacts.json`.

## Acceptance rules

Manual detections must pass the score gate, which defaults to 85%. Manual camera analysis also requires full-body visibility. Manual replay analysis does not require the pose or motion filters.

Automatic analysis requires visible shoulders, hips, knees, and ankles, sufficient movement, and two distinct agreeing windows above the score gate. A cooldown and duplicate suppression keep repeated windows out of the session reel. Only one model request runs at a time.

The model has no trained idle, other-trick, event-boundary, or landing-success class. Its scores are uncalibrated binary preferences. Pose and movement checks are heuristics, not additional trick classifiers.

## Runtime and storage

The verified environment uses Transformers 4.57.1, PyTorch 2.11.0, scikit-learn 1.6.1 for setup, and MediaPipe Tasks Vision 0.10.32. The browser pose model is Pose Landmarker Lite. The app uses Apple MPS when available and supports CPU fallback.

Model inference is local. Media is held in memory, while `.runtime/metrics.json` stores only scores, timings, and model metadata. The repository excludes model weights, browser runtime binaries, local credentials, and training videos.

## Sources

- [VideoMAE encoder](https://huggingface.co/MCG-NJU/videomae-base/tree/dc740ceda42fce44faed2ea03c6d447db72f6af9)
- [Training-source clips](https://github.com/LightningDrop/SkateboardML/tree/2413e9a6ba7bf09cd08bf5c8d90f61737ebe3ea5)
- [MediaPipe Pose Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker)
- [Component attribution](../web/design-resources/ATTRIBUTION.md)
