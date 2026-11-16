// The pinned CommonJS bundle exposes exports; classic workers are required by
// this MediaPipe WASM loader's importScripts initialization.
self.exports = {};
importScripts('/vendor/mediapipe/vision_bundle.js');
const vision = self.exports;
let landmarker;
self.onmessage = async ({data}) => {
  if (data.type === 'init') {
    try {
      const files = await vision.FilesetResolver.forVisionTasks('/vendor/mediapipe/wasm');
      landmarker = await vision.PoseLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: '/models/pose.task', delegate: 'CPU' },
        runningMode: 'VIDEO', numPoses: 1,
        minPoseDetectionConfidence: .6, minPosePresenceConfidence: .6,
        minTrackingConfidence: .6, outputSegmentationMasks: false,
      });
      self.postMessage({type:'ready'});
    } catch (error) { self.postMessage({type:'error',message:error.message}); }
  }
  if (data.type === 'frame' && landmarker) {
    try {
      const start = performance.now();
      const result = landmarker.detectForVideo(data.bitmap, data.timestamp);
      self.postMessage({type:'pose', landmarks:result.landmarks[0] || [],
        inferenceMs:performance.now()-start, generation:data.generation});
    } catch (error) { self.postMessage({type:'error',message:error.message}); }
    finally { data.bitmap.close(); }
  }
};
