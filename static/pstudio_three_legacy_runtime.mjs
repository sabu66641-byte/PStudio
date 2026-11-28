export const PSTUDIO_LEGACY_THREE_REVISION = "187";
export const PSTUDIO_LEGACY_THREE_WEBGPU_SPECIFIER = "three/webgpu";

/**
 * The optional legacy Three.js WebGPU runtime is resolved only when a caller
 * explicitly initializes that adapter. PStudio Graphics Core must not import it.
 */
export async function loadPStudioLegacyThreeWebGPU(options = {}) {
  const runtime = options.threeRuntime || options.THREE || await import(PSTUDIO_LEGACY_THREE_WEBGPU_SPECIFIER);
  const revision = String(runtime?.REVISION || "");
  if (revision !== PSTUDIO_LEGACY_THREE_REVISION) {
    throw new Error("PStudio legacy Three.js adapter requires r" + PSTUDIO_LEGACY_THREE_REVISION + "; received r" + (revision || "unknown") + ".");
  }
  if (typeof runtime.WebGPURenderer !== "function") {
    throw new TypeError("The supplied Three.js runtime does not expose WebGPURenderer.");
  }
  return runtime;
}

export function isPStudioLegacyThreeWebGPURuntime(runtime) {
  return String(runtime?.REVISION || "") === PSTUDIO_LEGACY_THREE_REVISION
    && typeof runtime?.WebGPURenderer === "function";
}
