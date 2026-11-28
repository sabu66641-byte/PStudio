function isByteArray(value) {
  return value && typeof value.length === 'number' && Number.isSafeInteger(value.length);
}

function validateFrame(frame) {
  if (!frame || typeof frame !== 'object') throw new TypeError('A frame with data, width and height is required.');
  const width = Math.floor(Number(frame.width));
  const height = Math.floor(Number(frame.height));
  const channels = Math.floor(Number(frame.channels) || 4);
  if (width < 1 || height < 1 || (channels !== 3 && channels !== 4)) throw new RangeError('Invalid frame dimensions or channel count.');
  if (!isByteArray(frame.data) || frame.data.length !== width * height * channels) {
    throw new RangeError('Frame data length does not match its dimensions.');
  }
  return { data: frame.data, width, height, channels };
}

export function compareRgbaFrames(reference, candidate, options = {}) {
  const a = validateFrame(reference);
  const b = validateFrame(candidate);
  if (a.width !== b.width || a.height !== b.height || a.channels !== b.channels) {
    throw new RangeError('Frames must have identical dimensions and channel counts.');
  }
  const pixelThreshold = Math.max(0, Math.min(255, Number(options.pixelThreshold) || 2));
  const compareAlpha = options.compareAlpha === true && a.channels === 4;
  const channelCount = compareAlpha ? a.channels : 3;
  const pixelCount = a.width * a.height;
  let absoluteSum = 0;
  let squaredSum = 0;
  let maximumDifference = 0;
  let changedPixels = 0;
  let lumaAbsoluteSum = 0;
  let alphaAbsoluteSum = 0;

  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const offset = pixel * a.channels;
    let pixelChanged = false;
    for (let channel = 0; channel < channelCount; channel += 1) {
      const delta = Math.abs(Number(a.data[offset + channel]) - Number(b.data[offset + channel]));
      absoluteSum += delta;
      squaredSum += delta * delta;
      if (delta > maximumDifference) maximumDifference = delta;
      if (delta > pixelThreshold) pixelChanged = true;
      if (channel === 0) lumaAbsoluteSum += delta * 0.2126;
      else if (channel === 1) lumaAbsoluteSum += delta * 0.7152;
      else if (channel === 2) lumaAbsoluteSum += delta * 0.0722;
    }
    if (a.channels === 4) alphaAbsoluteSum += Math.abs(Number(a.data[offset + 3]) - Number(b.data[offset + 3]));
    if (pixelChanged) changedPixels += 1;
  }

  const sampleCount = pixelCount * channelCount;
  return {
    metric: 'pstudio.rgba-basic.v1',
    width: a.width,
    height: a.height,
    comparedChannels: channelCount,
    meanAbsoluteError: absoluteSum / sampleCount / 255,
    rootMeanSquareError: Math.sqrt(squaredSum / sampleCount) / 255,
    meanAbsoluteLumaError: lumaAbsoluteSum / pixelCount / 255,
    meanAbsoluteAlphaError: a.channels === 4 ? alphaAbsoluteSum / pixelCount / 255 : null,
    changedPixelRatio: changedPixels / pixelCount,
    maximumChannelDifference: maximumDifference / 255,
    pixelThreshold: pixelThreshold / 255,
    sampleCount
  };
}

export function compareTemporalSequences(referenceFrames, candidateFrames, options = {}) {
  if (!Array.isArray(referenceFrames) || !Array.isArray(candidateFrames) ||
      referenceFrames.length < 2 || referenceFrames.length !== candidateFrames.length) {
    throw new RangeError('Temporal comparison requires equal sequences containing at least two frames.');
  }
  const references = referenceFrames.map(validateFrame);
  const candidates = candidateFrames.map(validateFrame);
  const first = references[0];
  for (let index = 0; index < references.length; index += 1) {
    const r = references[index];
    const c = candidates[index];
    if (r.width !== first.width || r.height !== first.height || r.channels !== first.channels ||
        c.width !== first.width || c.height !== first.height || c.channels !== first.channels) {
      throw new RangeError('All temporal frames must use the same dimensions and channel count.');
    }
  }
  const channels = options.compareAlpha === true && first.channels === 4 ? 4 : 3;
  let absoluteDeltaError = 0;
  let referenceMotion = 0;
  let candidateMotion = 0;
  let sampleCount = 0;
  for (let frameIndex = 1; frameIndex < references.length; frameIndex += 1) {
    const previousReference = references[frameIndex - 1].data;
    const currentReference = references[frameIndex].data;
    const previousCandidate = candidates[frameIndex - 1].data;
    const currentCandidate = candidates[frameIndex].data;
    for (let index = 0; index < first.width * first.height * first.channels; index += 1) {
      const channel = index % first.channels;
      if (channel >= channels) continue;
      const refDelta = Number(currentReference[index]) - Number(previousReference[index]);
      const candidateDelta = Number(currentCandidate[index]) - Number(previousCandidate[index]);
      absoluteDeltaError += Math.abs(refDelta - candidateDelta);
      referenceMotion += Math.abs(refDelta);
      candidateMotion += Math.abs(candidateDelta);
      sampleCount += 1;
    }
  }
  return {
    metric: 'pstudio.temporal-delta-basic.v1',
    frameCount: references.length,
    meanAbsoluteTemporalDeltaError: sampleCount ? absoluteDeltaError / sampleCount / 255 : 0,
    referenceMotionMagnitude: sampleCount ? referenceMotion / sampleCount / 255 : 0,
    candidateMotionMagnitude: sampleCount ? candidateMotion / sampleCount / 255 : 0,
    sampleCount,
    note: 'Basic aligned pixel-delta comparison; not optical flow or a validated perceptual flicker metric.'
  };
}
