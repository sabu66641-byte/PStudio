#include <cassert>
#include <cstdint>
#include <string>
#include <vector>

#include "pstudio/native_gpu.hpp"

using namespace pstudio::graphics;

int main() {
    std::string error;

    NativeSurfaceDescriptor headless;
    assert(headless.valid(&error));
    headless.width = 0;
    assert(!headless.valid(&error));
    assert(!error.empty());

    NativeSurfaceDescriptor win32;
    win32.platform = NativeSurfacePlatform::Win32;
    win32.width = 1280;
    win32.height = 720;
    assert(!win32.valid(&error));
    win32.hostWindow = reinterpret_cast<void*>(static_cast<std::uintptr_t>(1));
    assert(win32.valid(&error));

    GpuShaderDescriptor shader;
    shader.id = "vertex";
    shader.stage = GpuShaderStage::Vertex;
    shader.format = GpuShaderFormat::SpirV;
    shader.bytecode = {
        0x03, 0x02, 0x23, 0x07, // SPIR-V magic, little endian
        0x00, 0x00, 0x01, 0x00, // version
        0x00, 0x00, 0x00, 0x00, // generator
        0x01, 0x00, 0x00, 0x00, // bound
        0x00, 0x00, 0x00, 0x00  // schema
    };
    assert(validateGpuShaderDescriptor(shader, error));
    shader.bytecode[0] = 0;
    assert(!validateGpuShaderDescriptor(shader, error));
    shader.bytecode[0] = 0x03;

    GpuTextureDescriptor texture;
    texture.id = "color";
    texture.width = 1024;
    texture.height = 1024;
    texture.sampled = true;
    texture.colorTarget = true;
    assert(validateGpuTextureDescriptor(texture, error));
    texture.depthStencilTarget = true;
    assert(!validateGpuTextureDescriptor(texture, error));

    GpuPipelineDescriptor pipeline;
    pipeline.id = "basic";
    pipeline.vertexShader = ResourceHandle{1};
    pipeline.fragmentShader = ResourceHandle{2};
    pipeline.vertexStride = sizeof(float) * 5;
    pipeline.attributes = {
        GpuVertexAttribute{0, 0, 3},
        GpuVertexAttribute{1, sizeof(float) * 3, 2}
    };
    assert(validateGpuPipelineDescriptor(pipeline, error));
    pipeline.attributes[1].offset = sizeof(float) * 4;
    assert(!validateGpuPipelineDescriptor(pipeline, error));

    NativeSwapchainInfo swapchain;
    assert(swapchain.width == 0);
    assert(swapchain.generation == 0);
    return 0;
}
