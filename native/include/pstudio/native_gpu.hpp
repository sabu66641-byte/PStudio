#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

#include "pstudio/graphics.hpp"

namespace pstudio::graphics {

/**
 * Native window-system handles are borrowed from the host application. PStudio
 * never creates or destroys the HWND/X11/Wayland/CAMetalLayer passed here.
 * Headless surfaces are valid for off-screen GPU work and CI smoke tests.
 */
enum class NativeSurfacePlatform { Headless, Win32, Xlib, Xcb, Wayland, MetalLayer };

struct NativeSurfaceDescriptor {
    NativeSurfacePlatform platform{NativeSurfacePlatform::Headless};
    void* display{nullptr}; // HINSTANCE, Display*, xcb_connection_t*, wl_display*
    void* window{nullptr};  // HWND encoded as void*, Window, xcb_window_t, wl_surface*
    void* layer{nullptr};   // CAMetalLayer* on Apple platforms when supplied by a host integration
    void* hostWindow{nullptr}; // borrowed SDL_Window*; SDL owns OS Surface/Swapchain integration
    std::uint32_t width{1};
    std::uint32_t height{1};
    std::uint32_t framesInFlight{2};
    bool verticalSync{true};
    bool allowTearing{false};

    bool valid(std::string* error = nullptr) const noexcept {
        if (width == 0 || height == 0) return fail(error, "Native surface dimensions must be positive");
        if (framesInFlight == 0 || framesInFlight > 4) return fail(error, "framesInFlight must be between 1 and 4");
        switch (platform) {
            case NativeSurfacePlatform::Headless: return true;
            case NativeSurfacePlatform::Win32:
            case NativeSurfacePlatform::Xlib:
            case NativeSurfacePlatform::Xcb:
            case NativeSurfacePlatform::Wayland:
                return hostWindow || (display && window) ? true : fail(error, "The selected window-system surface requires an SDL_Window* or native display/window handles");
            case NativeSurfacePlatform::MetalLayer:
                return hostWindow || layer ? true : fail(error, "Metal surface requires an SDL_Window* or CAMetalLayer handle");
        }
        return fail(error, "Unknown native surface platform");
    }

private:
    static bool fail(std::string* output, const char* message) noexcept {
        if (output) *output = message;
        return false;
    }
};

enum class GpuShaderStage { Vertex, Fragment, Compute };
enum class GpuShaderFormat { SpirV, Dxil, Msl };
enum class GpuPixelFormat { Bgra8Unorm, Rgba8Unorm, Rgba16Float, Depth32Float };
enum class GpuPresentMode { Fifo, Mailbox, Immediate };
enum class GpuWaitResult { Complete, Timeout, DeviceLost, Failed };

struct GpuShaderDescriptor {
    std::string id;
    GpuShaderStage stage{GpuShaderStage::Vertex};
    GpuShaderFormat format{GpuShaderFormat::SpirV};
    std::string entryPoint{"main"};
    std::vector<std::uint8_t> bytecode;
};

struct GpuTextureDescriptor {
    std::string id;
    std::uint32_t width{1};
    std::uint32_t height{1};
    GpuPixelFormat format{GpuPixelFormat::Rgba8Unorm};
    bool sampled{true};
    bool colorTarget{false};
    bool depthStencilTarget{false};
    std::uint32_t mipLevels{1};
};

struct GpuVertexAttribute {
    std::uint32_t location{0};
    std::uint32_t offset{0};
    std::uint32_t components{3}; // 1–4 float32 components
};

struct GpuPipelineDescriptor {
    std::string id;
    ResourceHandle vertexShader{};
    ResourceHandle fragmentShader{};
    std::uint32_t vertexStride{0};
    std::vector<GpuVertexAttribute> attributes;
    GpuPixelFormat colorFormat{GpuPixelFormat::Bgra8Unorm};
    GpuPixelFormat depthFormat{GpuPixelFormat::Depth32Float};
    bool depthTest{true};
    bool depthWrite{true};
    bool blend{false};
};

struct GpuDrawCall {
    ResourceHandle pipeline{};
    ResourceHandle vertexBuffer{};
    std::uint32_t vertexCount{0};
    std::uint32_t firstVertex{0};
    std::uint32_t instanceCount{1};
};

struct GpuFramePacket {
    std::uint64_t frameId{0};
    std::uint32_t width{0};
    std::uint32_t height{0};
    std::array<float, 4> clearColor{0.025f, 0.035f, 0.05f, 1.0f};
    bool clear{true};
    bool present{true};
    std::vector<GpuDrawCall> draws;
};

struct NativeGpuCapabilities {
    std::string deviceName;
    std::string driverName;
    std::string apiVersion;
    std::uint32_t maxFramesInFlight{1};
    std::uint64_t dedicatedVideoMemoryBytes{0};
    bool presentation{false};
    bool timelineSynchronization{false};
    bool computeShaders{false};
    bool storageBuffers{false};
};

struct NativeSwapchainInfo {
    std::uint32_t width{0};
    std::uint32_t height{0};
    std::uint32_t imageCount{0};
    GpuPixelFormat format{GpuPixelFormat::Bgra8Unorm};
    GpuPresentMode presentMode{GpuPresentMode::Fifo};
    std::uint64_t generation{0};
};

/**
 * Extended native GPU SPI. Implementations own API objects (device, queues,
 * swapchain, memory, shader modules, pipelines and synchronization primitives).
 * Handles are opaque and are only meaningful to the creating backend instance.
 */
class NativeGpuBackend : public Backend {
public:
    virtual bool configureSurface(const NativeSurfaceDescriptor& surface, std::string& error) = 0;
    virtual NativeGpuCapabilities capabilities() const = 0;
    virtual NativeSwapchainInfo swapchainInfo() const = 0;

    virtual ResourceHandle createShader(const GpuShaderDescriptor& descriptor, std::string& error) = 0;
    virtual ResourceHandle createTexture(const GpuTextureDescriptor& descriptor, std::string& error) = 0;
    virtual bool uploadBuffer(ResourceHandle buffer, const void* data, std::size_t size, std::size_t offset, std::string& error) = 0;
    virtual ResourceHandle createGraphicsPipeline(const GpuPipelineDescriptor& descriptor, std::string& error) = 0;
    virtual bool submitGpuFrame(const GpuFramePacket& frame, std::string& error) = 0;

    /** Waits for a backend fence value; timeoutNs == UINT64_MAX means infinite. */
    virtual GpuWaitResult waitForFence(std::uint64_t fenceValue, std::uint64_t timeoutNs) = 0;
    virtual std::uint64_t lastSubmittedFence() const noexcept = 0;
    virtual bool resizeSurface(std::uint32_t width, std::uint32_t height, std::string& error) = 0;
    virtual bool isDeviceLost() const noexcept = 0;
};

/** Validates shader format/bytecode before handing data to a concrete API. */
inline bool validateGpuShaderDescriptor(const GpuShaderDescriptor& shader, std::string& error) {
    if (shader.id.empty()) { error = "Shader id is required"; return false; }
    if (shader.entryPoint.empty()) { error = "Shader entry point is required"; return false; }
    if (shader.bytecode.empty()) { error = "Shader bytecode is empty"; return false; }
    if (shader.format == GpuShaderFormat::SpirV) {
        if (shader.bytecode.size() < 20 || shader.bytecode.size() % 4 != 0) {
            error = "SPIR-V bytecode must contain a valid 32-bit word stream";
            return false;
        }
        const std::uint32_t magic =
            static_cast<std::uint32_t>(shader.bytecode[0]) |
            (static_cast<std::uint32_t>(shader.bytecode[1]) << 8) |
            (static_cast<std::uint32_t>(shader.bytecode[2]) << 16) |
            (static_cast<std::uint32_t>(shader.bytecode[3]) << 24);
        if (magic != 0x07230203u) { error = "SPIR-V magic number is invalid"; return false; }
    }
    return true;
}

inline bool validateGpuTextureDescriptor(const GpuTextureDescriptor& texture, std::string& error) {
    if (texture.id.empty()) { error = "Texture id is required"; return false; }
    if (texture.width == 0 || texture.height == 0 || texture.mipLevels == 0) {
        error = "Texture dimensions and mip levels must be positive"; return false;
    }
    if (texture.colorTarget && texture.depthStencilTarget) {
        error = "Texture cannot be both a color target and depth-stencil target"; return false;
    }
    return true;
}

inline bool validateGpuPipelineDescriptor(const GpuPipelineDescriptor& pipeline, std::string& error) {
    if (pipeline.id.empty()) { error = "Pipeline id is required"; return false; }
    if (!pipeline.vertexShader || !pipeline.fragmentShader) {
        error = "Graphics pipeline requires vertex and fragment shader handles";
        return false;
    }
    if (pipeline.vertexStride == 0 || pipeline.attributes.empty()) {
        error = "Graphics pipeline requires a vertex stride and attributes";
        return false;
    }
    for (const auto& attribute : pipeline.attributes) {
        if (attribute.components == 0 || attribute.components > 4 ||
            attribute.offset + attribute.components * sizeof(float) > pipeline.vertexStride) {
            error = "Vertex attribute is outside the declared vertex stride";
            return false;
        }
    }
    return true;
}

} // namespace pstudio::graphics
