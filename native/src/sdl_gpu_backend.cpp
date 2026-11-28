#include "pstudio/sdl_gpu_backend.hpp"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstring>
#include <limits>
#include <map>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

#include <SDL3/SDL.h>
#include <SDL3/SDL_gpu.h>

namespace pstudio::graphics {
namespace {

const char* requestedDriver(BackendKind kind) noexcept {
    switch (kind) {
        case BackendKind::Vulkan: return "vulkan";
        case BackendKind::Direct3D12: return "direct3d12";
        case BackendKind::Metal: return "metal";
        default: return nullptr;
    }
}

SDL_GPUShaderFormat shaderFlag(BackendKind kind) noexcept {
    switch (kind) {
        case BackendKind::Vulkan: return SDL_GPU_SHADERFORMAT_SPIRV;
        case BackendKind::Direct3D12: return SDL_GPU_SHADERFORMAT_DXIL;
        case BackendKind::Metal: return SDL_GPU_SHADERFORMAT_MSL;
        default: return SDL_GPU_SHADERFORMAT_INVALID;
    }
}

SDL_GPUTextureFormat textureFormat(GpuPixelFormat format) noexcept {
    switch (format) {
        case GpuPixelFormat::Bgra8Unorm: return SDL_GPU_TEXTUREFORMAT_B8G8R8A8_UNORM;
        case GpuPixelFormat::Rgba8Unorm: return SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM;
        case GpuPixelFormat::Rgba16Float: return SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT;
        case GpuPixelFormat::Depth32Float: return SDL_GPU_TEXTUREFORMAT_D32_FLOAT;
    }
    return SDL_GPU_TEXTUREFORMAT_INVALID;
}

GpuPixelFormat pixelFormat(SDL_GPUTextureFormat format) noexcept {
    switch (format) {
        case SDL_GPU_TEXTUREFORMAT_B8G8R8A8_UNORM: return GpuPixelFormat::Bgra8Unorm;
        case SDL_GPU_TEXTUREFORMAT_R8G8B8A8_UNORM: return GpuPixelFormat::Rgba8Unorm;
        case SDL_GPU_TEXTUREFORMAT_R16G16B16A16_FLOAT: return GpuPixelFormat::Rgba16Float;
        case SDL_GPU_TEXTUREFORMAT_D32_FLOAT: return GpuPixelFormat::Depth32Float;
        default: return GpuPixelFormat::Bgra8Unorm;
    }
}

SDL_GPUVertexElementFormat vertexFormat(std::uint32_t components) noexcept {
    switch (components) {
        case 1: return SDL_GPU_VERTEXELEMENTFORMAT_FLOAT;
        case 2: return SDL_GPU_VERTEXELEMENTFORMAT_FLOAT2;
        case 3: return SDL_GPU_VERTEXELEMENTFORMAT_FLOAT3;
        case 4: return SDL_GPU_VERTEXELEMENTFORMAT_FLOAT4;
        default: return SDL_GPU_VERTEXELEMENTFORMAT_INVALID;
    }
}

std::string sdlError(const char* fallback) {
    const char* value = SDL_GetError();
    return value && *value ? std::string(value) : std::string(fallback);
}

bool looksLikeDeviceLoss(const std::string& message) {
    std::string lower(message);
    std::transform(lower.begin(), lower.end(), lower.begin(),
        [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return lower.find("device lost") != std::string::npos ||
           lower.find("device removed") != std::string::npos ||
           lower.find("removed device") != std::string::npos ||
           lower.find("gpu reset") != std::string::npos ||
           lower.find("dxgi_error_device") != std::string::npos;
}

} // namespace

struct SdlGpuBackend::Impl {
    enum class ObjectType { Buffer, Texture, Shader, Pipeline };
    struct Object {
        ObjectType type{ObjectType::Buffer};
        SDL_GPUBuffer* buffer{nullptr};
        SDL_GPUTexture* texture{nullptr};
        SDL_GPUShader* shader{nullptr};
        SDL_GPUGraphicsPipeline* pipeline{nullptr};
        std::uint64_t sizeBytes{0};
        std::uint32_t width{0};
        std::uint32_t height{0};
        GpuPixelFormat pixelFormat{GpuPixelFormat::Rgba8Unorm};
        std::string id;
    };

    BackendKind kind{BackendKind::Null};
    SdlGpuBackendOptions options;
    SDL_GPUDevice* device{nullptr};
    SDL_Window* window{nullptr}; // borrowed from host; never destroyed by PStudio
    bool ownsVideoSubsystem{false};
    bool ready{false};
    bool disposed{false};
    bool deviceLost{false};
    bool surfaceConfigured{false};
    bool present{false};
    std::uint32_t width{1};
    std::uint32_t height{1};
    std::uint32_t framesInFlight{2};
    bool verticalSync{true};
    bool allowTearing{false};
    SDL_GPUPresentMode presentMode{SDL_GPU_PRESENTMODE_VSYNC};
    SDL_GPUTexture* offscreenColor{nullptr};
    SDL_GPUTexture* depthTexture{nullptr};
    std::uint32_t targetWidth{0};
    std::uint32_t targetHeight{0};
    SDL_GPUTextureFormat targetFormat{SDL_GPU_TEXTUREFORMAT_B8G8R8A8_UNORM};
    std::uint64_t nextHandle{1};
    std::uint64_t nextFence{1};
    std::uint64_t completedFence{0};
    std::uint64_t lastFrameId{0};
    std::uint64_t swapchainGeneration{0};
    std::unordered_map<std::uint64_t, Object> objects;
    std::map<std::uint64_t, SDL_GPUFence*> fences;

    explicit Impl(BackendKind requested, SdlGpuBackendOptions config)
        : kind(requested), options(std::move(config)) {}

    void markDeviceLost(const std::string& reason) noexcept {
        if (deviceLost) return;
        deviceLost = true;
        try {
            if (options.onDeviceLost) options.onDeviceLost(reason);
        } catch (...) {
            // Device-loss observers must never escape into the GPU backend.
        }
    }

    void setError(std::string& error, const char* fallback) {
        error = sdlError(fallback);
        if (looksLikeDeviceLoss(error)) markDeviceLost(error);
    }

    void releaseObject(Object& object) noexcept {
        if (!device) return;
        switch (object.type) {
            case ObjectType::Buffer:
                if (object.buffer) SDL_ReleaseGPUBuffer(device, object.buffer);
                break;
            case ObjectType::Texture:
                if (object.texture) SDL_ReleaseGPUTexture(device, object.texture);
                break;
            case ObjectType::Shader:
                if (object.shader) SDL_ReleaseGPUShader(device, object.shader);
                break;
            case ObjectType::Pipeline:
                if (object.pipeline) SDL_ReleaseGPUGraphicsPipeline(device, object.pipeline);
                break;
        }
        object = {};
    }

    void releaseTargetTextures() noexcept {
        if (device && offscreenColor) SDL_ReleaseGPUTexture(device, offscreenColor);
        if (device && depthTexture) SDL_ReleaseGPUTexture(device, depthTexture);
        offscreenColor = nullptr;
        depthTexture = nullptr;
        targetWidth = targetHeight = 0;
    }

    bool ensureTargets(std::uint32_t requestedWidth, std::uint32_t requestedHeight, std::string& error) {
        if (!requestedWidth || !requestedHeight) {
            error = "GPU render target dimensions must be positive";
            return false;
        }
        if (targetWidth == requestedWidth && targetHeight == requestedHeight &&
            (present || (offscreenColor && depthTexture))) return true;

        releaseTargetTextures();
        SDL_GPUTextureCreateInfo colorInfo{};
        colorInfo.type = SDL_GPU_TEXTURETYPE_2D;
        colorInfo.format = present ? SDL_GetGPUSwapchainTextureFormat(device, window) : SDL_GPU_TEXTUREFORMAT_B8G8R8A8_UNORM;
        colorInfo.usage = SDL_GPU_TEXTUREUSAGE_COLOR_TARGET;
        colorInfo.width = requestedWidth;
        colorInfo.height = requestedHeight;
        colorInfo.layer_count_or_depth = 1;
        colorInfo.num_levels = 1;
        colorInfo.sample_count = SDL_GPU_SAMPLECOUNT_1;
        if (!present) {
            offscreenColor = SDL_CreateGPUTexture(device, &colorInfo);
            if (!offscreenColor) { setError(error, "Unable to create offscreen color target"); return false; }
        }

        SDL_GPUTextureCreateInfo depthInfo{};
        depthInfo.type = SDL_GPU_TEXTURETYPE_2D;
        depthInfo.format = SDL_GPU_TEXTUREFORMAT_D32_FLOAT;
        depthInfo.usage = SDL_GPU_TEXTUREUSAGE_DEPTH_STENCIL_TARGET;
        depthInfo.width = requestedWidth;
        depthInfo.height = requestedHeight;
        depthInfo.layer_count_or_depth = 1;
        depthInfo.num_levels = 1;
        depthInfo.sample_count = SDL_GPU_SAMPLECOUNT_1;
        depthTexture = SDL_CreateGPUTexture(device, &depthInfo);
        if (!depthTexture) {
            if (offscreenColor) SDL_ReleaseGPUTexture(device, offscreenColor);
            offscreenColor = nullptr;
            setError(error, "Unable to create depth target");
            return false;
        }
        targetWidth = requestedWidth;
        targetHeight = requestedHeight;
        if (present) targetFormat = SDL_GetGPUSwapchainTextureFormat(device, window);
        else targetFormat = SDL_GPU_TEXTUREFORMAT_B8G8R8A8_UNORM;
        return true;
    }

    void releaseCompletedFences() noexcept {
        if (!device) return;
        for (auto it = fences.begin(); it != fences.end();) {
            if (SDL_QueryGPUFence(device, it->second)) {
                completedFence = std::max(completedFence, it->first);
                SDL_ReleaseGPUFence(device, it->second);
                it = fences.erase(it);
            } else {
                ++it;
            }
        }
    }

    ResourceHandle insert(Object object) {
        const ResourceHandle handle{nextHandle++};
        objects.emplace(handle.value, std::move(object));
        return handle;
    }
};

SdlGpuBackend::SdlGpuBackend(BackendKind kind, SdlGpuBackendOptions options)
    : impl_(std::make_unique<Impl>(kind, std::move(options))) {}

SdlGpuBackend::~SdlGpuBackend() { dispose(); }

BackendKind SdlGpuBackend::kind() const noexcept { return impl_->kind; }

bool SdlGpuBackend::initialize(std::string& error) {
    auto& s = *impl_;
    if (s.disposed) { error = "SDL GPU backend has been disposed"; return false; }
    if (s.ready) return true;
    const char* driver = requestedDriver(s.kind);
    const SDL_GPUShaderFormat shaderFormats = shaderFlag(s.kind);
    if (!driver || shaderFormats == SDL_GPU_SHADERFORMAT_INVALID) {
        error = "SDL GPU backend requires Vulkan, Direct3D12 or Metal";
        return false;
    }

    if ((SDL_WasInit(SDL_INIT_VIDEO) & SDL_INIT_VIDEO) == 0) {
        if (!SDL_InitSubSystem(SDL_INIT_VIDEO)) {
            s.setError(error, "SDL video subsystem initialization failed");
            return false;
        }
        s.ownsVideoSubsystem = true;
    }

    s.device = SDL_CreateGPUDevice(shaderFormats, s.options.debug, driver);
    if (!s.device) {
        s.setError(error, "SDL could not create the requested GPU device");
        if (s.ownsVideoSubsystem) {
            SDL_QuitSubSystem(SDL_INIT_VIDEO);
            s.ownsVideoSubsystem = false;
        }
        return false;
    }

    const char* actualDriver = SDL_GetGPUDeviceDriver(s.device);
    if (!actualDriver || std::string(actualDriver) != driver) {
        error = std::string("Requested GPU driver '") + driver + "' but SDL selected '" +
            (actualDriver ? actualDriver : "unknown") + "'";
        SDL_DestroyGPUDevice(s.device);
        s.device = nullptr;
        if (s.ownsVideoSubsystem) {
            SDL_QuitSubSystem(SDL_INIT_VIDEO);
            s.ownsVideoSubsystem = false;
        }
        return false;
    }
    if (!SDL_SetGPUAllowedFramesInFlight(s.device, s.framesInFlight > 3 ? 3 : s.framesInFlight)) {
        s.setError(error, "Unable to configure frames in flight");
        SDL_DestroyGPUDevice(s.device);
        s.device = nullptr;
        return false;
    }
    s.ready = true;
    s.deviceLost = false;
    return true;
}

bool SdlGpuBackend::configureSurface(const NativeSurfaceDescriptor& surface, std::string& error) {
    auto& s = *impl_;
    if (!s.ready || s.deviceLost) { error = "GPU backend is not ready"; return false; }
    if (!surface.valid(&error)) return false;
    s.width = surface.width;
    s.height = surface.height;
    s.framesInFlight = std::min<std::uint32_t>(3, surface.framesInFlight);
    s.verticalSync = surface.verticalSync;
    s.allowTearing = surface.allowTearing;

    if (!surface.hostWindow) {
        if (surface.platform != NativeSurfacePlatform::Headless) {
            error = "SDL GPU presentation requires a borrowed SDL_Window* in hostWindow";
            return false;
        }
        if (s.window) SDL_ReleaseWindowFromGPUDevice(s.device, s.window);
        s.window = nullptr;
        s.present = false;
        s.surfaceConfigured = true;
        ++s.swapchainGeneration;
        s.releaseTargetTextures();
        return SDL_SetGPUAllowedFramesInFlight(s.device, s.framesInFlight);
    }

    auto* window = static_cast<SDL_Window*>(surface.hostWindow);
#if defined(_WIN32)
    if (surface.platform != NativeSurfacePlatform::Win32) { error = "Windows build requires a Win32 surface"; return false; }
#elif defined(__APPLE__)
    if (surface.platform != NativeSurfacePlatform::MetalLayer) { error = "Apple build requires a MetalLayer surface"; return false; }
#elif defined(__linux__)
    if (surface.platform != NativeSurfacePlatform::Xlib &&
        surface.platform != NativeSurfacePlatform::Xcb &&
        surface.platform != NativeSurfacePlatform::Wayland) {
        error = "Linux build requires an Xlib, Xcb or Wayland surface";
        return false;
    }
#endif
    if (s.window && s.window != window) SDL_ReleaseWindowFromGPUDevice(s.device, s.window);
    if (s.window != window && !SDL_ClaimWindowForGPUDevice(s.device, window)) {
        s.setError(error, "Unable to claim host window for GPU presentation");
        return false;
    }
    s.window = window;
    s.present = true;

    SDL_GPUPresentMode mode = SDL_GPU_PRESENTMODE_VSYNC;
    if (!surface.verticalSync && surface.allowTearing &&
        SDL_WindowSupportsGPUPresentMode(s.device, window, SDL_GPU_PRESENTMODE_IMMEDIATE)) {
        mode = SDL_GPU_PRESENTMODE_IMMEDIATE;
    } else if (surface.verticalSync &&
        SDL_WindowSupportsGPUPresentMode(s.device, window, SDL_GPU_PRESENTMODE_MAILBOX)) {
        mode = SDL_GPU_PRESENTMODE_MAILBOX;
    }
    if (!SDL_SetGPUSwapchainParameters(s.device, window, SDL_GPU_SWAPCHAINCOMPOSITION_SDR, mode)) {
        s.setError(error, "Unable to configure GPU swapchain");
        return false;
    }
    if (!SDL_SetGPUAllowedFramesInFlight(s.device, s.framesInFlight)) {
        s.setError(error, "Unable to configure swapchain frames in flight");
        return false;
    }
    s.presentMode = mode;
    s.targetFormat = SDL_GetGPUSwapchainTextureFormat(s.device, window);
    s.surfaceConfigured = true;
    ++s.swapchainGeneration;
    s.releaseTargetTextures();
    return true;
}

NativeGpuCapabilities SdlGpuBackend::capabilities() const {
    const auto& s = *impl_;
    NativeGpuCapabilities result;
    const char* driver = s.device ? SDL_GetGPUDeviceDriver(s.device) : nullptr;
    result.deviceName = s.device
        ? "SDL3 GPU device (device model not exposed by the pinned SDL3 GPU API)"
        : "uninitialized";
    result.driverName = driver && *driver ? driver : "uninitialized";
    result.apiVersion = "SDL3 GPU";
    result.maxFramesInFlight = 3;
    result.presentation = s.present;
    result.computeShaders = false; // SDL shader SPI currently exposes vertex/fragment stages in this adapter.
    result.storageBuffers = false;
    result.timelineSynchronization = false;
    return result;
}

NativeSwapchainInfo SdlGpuBackend::swapchainInfo() const {
    const auto& s = *impl_;
    NativeSwapchainInfo result;
    result.width = s.width;
    result.height = s.height;
    result.imageCount = 0; // SDL owns the swapchain image count and does not expose it.
    result.format = s.present && s.device && s.window
        ? pixelFormat(SDL_GetGPUSwapchainTextureFormat(s.device, s.window))
        : GpuPixelFormat::Rgba8Unorm;
    result.presentMode = s.presentMode == SDL_GPU_PRESENTMODE_IMMEDIATE ? GpuPresentMode::Immediate :
        (s.presentMode == SDL_GPU_PRESENTMODE_MAILBOX ? GpuPresentMode::Mailbox : GpuPresentMode::Fifo);
    result.generation = s.swapchainGeneration;
    return result;
}

ResourceHandle SdlGpuBackend::createResource(const ResourceDescriptor& descriptor, std::string& error) {
    auto& s = *impl_;
    if (!s.ready || s.deviceLost) { error = "GPU backend is not ready"; return {}; }
    if (descriptor.id.empty() || descriptor.sizeBytes == 0 ||
        descriptor.sizeBytes > std::numeric_limits<Uint32>::max()) {
        error = "GPU buffer requires an id and a size representable by SDL GPU";
        return {};
    }
    SDL_GPUBufferUsageFlags usage = SDL_GPU_BUFFERUSAGE_VERTEX;
    if (descriptor.type == "index-buffer") usage = SDL_GPU_BUFFERUSAGE_INDEX;
    else if (descriptor.type == "storage-buffer") {
        usage = SDL_GPU_BUFFERUSAGE_GRAPHICS_STORAGE_READ |
                SDL_GPU_BUFFERUSAGE_COMPUTE_STORAGE_READ |
                SDL_GPU_BUFFERUSAGE_COMPUTE_STORAGE_WRITE;
    } else if (descriptor.type != "buffer" && descriptor.type != "vertex-buffer") {
        error = "Unsupported SDL GPU resource type: " + descriptor.type;
        return {};
    }
    SDL_GPUBufferCreateInfo info{};
    info.usage = usage;
    info.size = static_cast<Uint32>(descriptor.sizeBytes);
    SDL_GPUBuffer* buffer = SDL_CreateGPUBuffer(s.device, &info);
    if (!buffer) { s.setError(error, "GPU buffer creation failed"); return {}; }
    Impl::Object object;
    object.type = Impl::ObjectType::Buffer;
    object.buffer = buffer;
    object.sizeBytes = descriptor.sizeBytes;
    object.id = descriptor.id;
    return s.insert(std::move(object));
}

ResourceHandle SdlGpuBackend::createTexture(const GpuTextureDescriptor& descriptor, std::string& error) {
    auto& s = *impl_;
    if (!s.ready || s.deviceLost) { error = "GPU backend is not ready"; return {}; }
    if (!validateGpuTextureDescriptor(descriptor, error)) return {};
    SDL_GPUTextureUsageFlags usage = 0;
    if (descriptor.sampled) usage |= SDL_GPU_TEXTUREUSAGE_SAMPLER;
    if (descriptor.colorTarget) usage |= SDL_GPU_TEXTUREUSAGE_COLOR_TARGET;
    if (descriptor.depthStencilTarget) usage |= SDL_GPU_TEXTUREUSAGE_DEPTH_STENCIL_TARGET;
    if (!usage) { error = "GPU texture must declare at least one usage"; return {}; }
    SDL_GPUTextureCreateInfo info{};
    info.type = SDL_GPU_TEXTURETYPE_2D;
    info.format = textureFormat(descriptor.format);
    info.usage = usage;
    info.width = descriptor.width;
    info.height = descriptor.height;
    info.layer_count_or_depth = 1;
    info.num_levels = descriptor.mipLevels;
    info.sample_count = SDL_GPU_SAMPLECOUNT_1;
    SDL_GPUTexture* texture = SDL_CreateGPUTexture(s.device, &info);
    if (!texture) { s.setError(error, "GPU texture creation failed"); return {}; }
    Impl::Object object;
    object.type = Impl::ObjectType::Texture;
    object.texture = texture;
    object.width = descriptor.width;
    object.height = descriptor.height;
    object.pixelFormat = descriptor.format;
    object.id = descriptor.id;
    return s.insert(std::move(object));
}

bool SdlGpuBackend::uploadTexture(ResourceHandle handle, const void* data, std::size_t size, std::string& error) {
    auto& s = *impl_;
    if (!s.ready || s.deviceLost || !handle || !data) {
        error = "Invalid GPU texture upload request";
        return false;
    }
    auto found = s.objects.find(handle.value);
    if (found == s.objects.end() || found->second.type != Impl::ObjectType::Texture) {
        error = "GPU texture handle is invalid";
        return false;
    }
    const auto& object = found->second;
    std::uint32_t bytesPerPixel = 4;
    if (object.pixelFormat == GpuPixelFormat::Rgba16Float) bytesPerPixel = 8;
    if (object.pixelFormat == GpuPixelFormat::Depth32Float) {
        error = "CPU uploads to depth-stencil textures are not supported by this adapter";
        return false;
    }
    const std::uint64_t tightRowBytes = static_cast<std::uint64_t>(object.width) * bytesPerPixel;
    const std::uint64_t tightSize = tightRowBytes * object.height;
    const std::uint64_t paddedRowBytes = ((tightRowBytes + 255u) / 256u) * 256u;
    const std::uint64_t paddedSize = paddedRowBytes * object.height;
    if (!object.width || !object.height || tightSize != size ||
        paddedRowBytes / bytesPerPixel > std::numeric_limits<Uint32>::max() ||
        paddedSize > std::numeric_limits<Uint32>::max()) {
        error = "GPU texture upload data size or row pitch is invalid";
        return false;
    }

    SDL_GPUTransferBufferCreateInfo transferInfo{};
    transferInfo.usage = SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD;
    transferInfo.size = static_cast<Uint32>(paddedSize);
    SDL_GPUTransferBuffer* transfer = SDL_CreateGPUTransferBuffer(s.device, &transferInfo);
    if (!transfer) { s.setError(error, "GPU texture transfer buffer creation failed"); return false; }
    void* mapped = SDL_MapGPUTransferBuffer(s.device, transfer, false);
    if (!mapped) {
        s.setError(error, "GPU texture transfer buffer mapping failed");
        SDL_ReleaseGPUTransferBuffer(s.device, transfer);
        return false;
    }
    auto* destinationBytes = static_cast<std::uint8_t*>(mapped);
    const auto* sourceBytes = static_cast<const std::uint8_t*>(data);
    for (std::uint32_t row = 0; row < object.height; ++row) {
        std::memcpy(destinationBytes + static_cast<std::size_t>(row * paddedRowBytes),
                    sourceBytes + static_cast<std::size_t>(row * tightRowBytes),
                    static_cast<std::size_t>(tightRowBytes));
    }
    SDL_UnmapGPUTransferBuffer(s.device, transfer);

    SDL_GPUCommandBuffer* command = SDL_AcquireGPUCommandBuffer(s.device);
    if (!command) {
        s.setError(error, "GPU texture upload command buffer acquisition failed");
        SDL_ReleaseGPUTransferBuffer(s.device, transfer);
        return false;
    }
    SDL_GPUCopyPass* copy = SDL_BeginGPUCopyPass(command);
    if (!copy) {
        s.setError(error, "GPU texture upload copy pass creation failed");
        SDL_CancelGPUCommandBuffer(command);
        SDL_ReleaseGPUTransferBuffer(s.device, transfer);
        return false;
    }
    SDL_GPUTextureTransferInfo source{transfer, 0, static_cast<Uint32>(paddedRowBytes / bytesPerPixel), object.height};
    SDL_GPUTextureRegion target{object.texture, 0, 0, 0, 0, 0, object.width, object.height, 1};
    SDL_UploadToGPUTexture(copy, &source, &target, true);
    SDL_EndGPUCopyPass(copy);
    SDL_GPUFence* fence = SDL_SubmitGPUCommandBufferAndAcquireFence(command);
    SDL_ReleaseGPUTransferBuffer(s.device, transfer);
    if (!fence) { s.setError(error, "GPU texture upload submission failed"); return false; }
    s.fences.emplace(s.nextFence++, fence);
    return true;
}

ResourceHandle SdlGpuBackend::createShader(const GpuShaderDescriptor& descriptor, std::string& error) {
    auto& s = *impl_;
    if (!s.ready || s.deviceLost) { error = "GPU backend is not ready"; return {}; }
    if (!validateGpuShaderDescriptor(descriptor, error)) return {};
    if (descriptor.stage == GpuShaderStage::Compute) {
        error = "This SDL3 GPU adapter currently supports graphics vertex/fragment shaders only";
        return {};
    }
    const GpuShaderFormat expected = s.kind == BackendKind::Vulkan ? GpuShaderFormat::SpirV :
        (s.kind == BackendKind::Direct3D12 ? GpuShaderFormat::Dxil : GpuShaderFormat::Msl);
    if (descriptor.format != expected) {
        error = "Shader bytecode format does not match the selected native GPU driver";
        return {};
    }
    SDL_GPUShaderCreateInfo info{};
    info.code_size = descriptor.bytecode.size();
    info.code = descriptor.bytecode.data();
    info.entrypoint = descriptor.entryPoint.c_str();
    info.format = shaderFlag(s.kind);
    info.stage = descriptor.stage == GpuShaderStage::Vertex
        ? SDL_GPU_SHADERSTAGE_VERTEX : SDL_GPU_SHADERSTAGE_FRAGMENT;
    SDL_GPUShader* shader = SDL_CreateGPUShader(s.device, &info);
    if (!shader) { s.setError(error, "GPU shader creation failed"); return {}; }
    Impl::Object object;
    object.type = Impl::ObjectType::Shader;
    object.shader = shader;
    object.id = descriptor.id;
    return s.insert(std::move(object));
}

bool SdlGpuBackend::uploadBuffer(ResourceHandle handle, const void* data, std::size_t size,
                                 std::size_t offset, std::string& error) {
    auto& s = *impl_;
    if (!s.ready || s.deviceLost || !handle || !data || size == 0 ||
        size > std::numeric_limits<Uint32>::max() || offset > std::numeric_limits<Uint32>::max()) {
        error = "Invalid GPU buffer upload request";
        return false;
    }
    auto found = s.objects.find(handle.value);
    if (found == s.objects.end() || found->second.type != Impl::ObjectType::Buffer ||
        offset > found->second.sizeBytes || size > found->second.sizeBytes - offset) {
        error = "GPU buffer handle or upload range is invalid";
        return false;
    }
    SDL_GPUTransferBufferCreateInfo transferInfo{};
    transferInfo.usage = SDL_GPU_TRANSFERBUFFERUSAGE_UPLOAD;
    transferInfo.size = static_cast<Uint32>(size);
    SDL_GPUTransferBuffer* transfer = SDL_CreateGPUTransferBuffer(s.device, &transferInfo);
    if (!transfer) { s.setError(error, "GPU upload transfer buffer creation failed"); return false; }
    void* mapped = SDL_MapGPUTransferBuffer(s.device, transfer, false);
    if (!mapped) {
        s.setError(error, "GPU upload transfer buffer mapping failed");
        SDL_ReleaseGPUTransferBuffer(s.device, transfer);
        return false;
    }
    std::memcpy(mapped, data, size);
    SDL_UnmapGPUTransferBuffer(s.device, transfer);

    SDL_GPUCommandBuffer* command = SDL_AcquireGPUCommandBuffer(s.device);
    if (!command) {
        s.setError(error, "GPU upload command buffer acquisition failed");
        SDL_ReleaseGPUTransferBuffer(s.device, transfer);
        return false;
    }
    SDL_GPUCopyPass* copy = SDL_BeginGPUCopyPass(command);
    if (!copy) {
        s.setError(error, "GPU copy pass creation failed");
        SDL_CancelGPUCommandBuffer(command);
        SDL_ReleaseGPUTransferBuffer(s.device, transfer);
        return false;
    }
    SDL_GPUTransferBufferLocation source{transfer, 0};
    SDL_GPUBufferRegion destination{found->second.buffer, static_cast<Uint32>(offset), static_cast<Uint32>(size)};
    SDL_UploadToGPUBuffer(copy, &source, &destination, true);
    SDL_EndGPUCopyPass(copy);
    SDL_GPUFence* fence = SDL_SubmitGPUCommandBufferAndAcquireFence(command);
    SDL_ReleaseGPUTransferBuffer(s.device, transfer);
    if (!fence) { s.setError(error, "GPU upload submission failed"); return false; }
    s.fences.emplace(s.nextFence++, fence);
    return true;
}

ResourceHandle SdlGpuBackend::createGraphicsPipeline(const GpuPipelineDescriptor& descriptor, std::string& error) {
    auto& s = *impl_;
    if (!s.ready || s.deviceLost) { error = "GPU backend is not ready"; return {}; }
    if (!validateGpuPipelineDescriptor(descriptor, error)) return {};
    const auto vertexIt = s.objects.find(descriptor.vertexShader.value);
    const auto fragmentIt = s.objects.find(descriptor.fragmentShader.value);
    if (vertexIt == s.objects.end() || fragmentIt == s.objects.end() ||
        vertexIt->second.type != Impl::ObjectType::Shader ||
        fragmentIt->second.type != Impl::ObjectType::Shader) {
        error = "Graphics pipeline references unknown shader handles";
        return {};
    }
    const SDL_GPUTextureFormat color = s.present && s.device && s.window
        ? SDL_GetGPUSwapchainTextureFormat(s.device, s.window) : textureFormat(descriptor.colorFormat);
    const SDL_GPUTextureFormat depth = textureFormat(descriptor.depthFormat);
    if (color == SDL_GPU_TEXTUREFORMAT_INVALID || depth != SDL_GPU_TEXTUREFORMAT_D32_FLOAT) {
        error = "Unsupported graphics pipeline target format";
        return {};
    }

    SDL_GPUVertexBufferDescription vertexBuffer{};
    vertexBuffer.slot = 0;
    vertexBuffer.pitch = descriptor.vertexStride;
    vertexBuffer.input_rate = SDL_GPU_VERTEXINPUTRATE_VERTEX;
    vertexBuffer.instance_step_rate = 0;
    std::vector<SDL_GPUVertexAttribute> attributes;
    attributes.reserve(descriptor.attributes.size());
    for (const auto& input : descriptor.attributes) {
        SDL_GPUVertexAttribute attribute{};
        attribute.location = input.location;
        attribute.buffer_slot = 0;
        attribute.format = vertexFormat(input.components);
        attribute.offset = input.offset;
        if (attribute.format == SDL_GPU_VERTEXELEMENTFORMAT_INVALID) {
            error = "Unsupported GPU vertex attribute format";
            return {};
        }
        attributes.push_back(attribute);
    }

    SDL_GPUColorTargetDescription colorTarget{};
    colorTarget.format = color;
    colorTarget.blend_state.src_color_blendfactor = descriptor.blend
        ? SDL_GPU_BLENDFACTOR_SRC_ALPHA : SDL_GPU_BLENDFACTOR_ONE;
    colorTarget.blend_state.dst_color_blendfactor = descriptor.blend
        ? SDL_GPU_BLENDFACTOR_ONE_MINUS_SRC_ALPHA : SDL_GPU_BLENDFACTOR_ZERO;
    colorTarget.blend_state.color_blend_op = SDL_GPU_BLENDOP_ADD;
    colorTarget.blend_state.src_alpha_blendfactor = SDL_GPU_BLENDFACTOR_ONE;
    colorTarget.blend_state.dst_alpha_blendfactor = descriptor.blend
        ? SDL_GPU_BLENDFACTOR_ONE_MINUS_SRC_ALPHA : SDL_GPU_BLENDFACTOR_ZERO;
    colorTarget.blend_state.alpha_blend_op = SDL_GPU_BLENDOP_ADD;
    colorTarget.blend_state.enable_blend = descriptor.blend;

    SDL_GPUGraphicsPipelineCreateInfo info{};
    info.vertex_shader = vertexIt->second.shader;
    info.fragment_shader = fragmentIt->second.shader;
    info.vertex_input_state.vertex_buffer_descriptions = &vertexBuffer;
    info.vertex_input_state.num_vertex_buffers = 1;
    info.vertex_input_state.vertex_attributes = attributes.data();
    info.vertex_input_state.num_vertex_attributes = static_cast<Uint32>(attributes.size());
    info.primitive_type = SDL_GPU_PRIMITIVETYPE_TRIANGLELIST;
    info.rasterizer_state.fill_mode = SDL_GPU_FILLMODE_FILL;
    info.rasterizer_state.cull_mode = SDL_GPU_CULLMODE_NONE;
    info.rasterizer_state.front_face = SDL_GPU_FRONTFACE_COUNTER_CLOCKWISE;
    info.rasterizer_state.enable_depth_clip = true;
    info.multisample_state.sample_count = SDL_GPU_SAMPLECOUNT_1;
    info.depth_stencil_state.compare_op = descriptor.depthTest
        ? SDL_GPU_COMPAREOP_LESS_OR_EQUAL : SDL_GPU_COMPAREOP_ALWAYS;
    info.depth_stencil_state.enable_depth_test = descriptor.depthTest;
    info.depth_stencil_state.enable_depth_write = descriptor.depthWrite;
    info.depth_stencil_state.enable_stencil_test = false;
    info.target_info.color_target_descriptions = &colorTarget;
    info.target_info.num_color_targets = 1;
    info.target_info.depth_stencil_format = depth;
    info.target_info.has_depth_stencil_target = descriptor.depthTest || descriptor.depthWrite;

    SDL_GPUGraphicsPipeline* pipeline = SDL_CreateGPUGraphicsPipeline(s.device, &info);
    if (!pipeline) { s.setError(error, "GPU graphics pipeline creation failed"); return {}; }
    Impl::Object object;
    object.type = Impl::ObjectType::Pipeline;
    object.pipeline = pipeline;
    object.id = descriptor.id;
    return s.insert(std::move(object));
}

bool SdlGpuBackend::submitGpuFrame(const GpuFramePacket& frame, std::string& error) {
    auto& s = *impl_;
    if (!s.ready || s.deviceLost) { error = "GPU backend is not ready"; return false; }
    if (!frame.frameId || frame.frameId <= s.lastFrameId || !frame.width || !frame.height) {
        error = "GPU frame ids must increase and dimensions must be positive";
        return false;
    }
    if (!s.surfaceConfigured) {
        error = "Configure a native surface or headless target before submitting GPU frames";
        return false;
    }

    // Validate every logical resource before acquiring a swapchain image. SDL
    // forbids cancelling a command buffer after a non-null swapchain texture
    // has been acquired, so no recoverable validation branch may occur later.
    for (const auto& draw : frame.draws) {
        const auto pipeline = s.objects.find(draw.pipeline.value);
        const auto vertex = s.objects.find(draw.vertexBuffer.value);
        if (pipeline == s.objects.end() || vertex == s.objects.end() ||
            pipeline->second.type != Impl::ObjectType::Pipeline ||
            vertex->second.type != Impl::ObjectType::Buffer ||
            !draw.vertexCount || !draw.instanceCount) {
            error = "GPU draw references invalid pipeline/buffer handles or zero draw counts";
            return false;
        }
    }

    // Prepare the depth target before touching the swapchain. This also means
    // a failed allocation never leaves an acquired presentation image pending.
    if (s.present) {
        int pixelWidth = 0, pixelHeight = 0;
        if (SDL_GetWindowSizeInPixels(s.window, &pixelWidth, &pixelHeight) && pixelWidth > 0 && pixelHeight > 0) {
            if (!s.ensureTargets(static_cast<Uint32>(pixelWidth), static_cast<Uint32>(pixelHeight), error)) return false;
        }
    } else if (!s.ensureTargets(frame.width, frame.height, error)) {
        return false;
    }

    SDL_GPUCommandBuffer* command = SDL_AcquireGPUCommandBuffer(s.device);
    if (!command) { s.setError(error, "GPU command buffer acquisition failed"); return false; }

    SDL_GPUTexture* colorTexture = nullptr;
    Uint32 targetWidth = frame.width, targetHeight = frame.height;
    bool swapchainTextureAcquired = false;
    if (s.present) {
        if (!SDL_WaitAndAcquireGPUSwapchainTexture(command, s.window, &colorTexture, &targetWidth, &targetHeight)) {
            s.setError(error, "Unable to acquire GPU swapchain texture");
            SDL_CancelGPUCommandBuffer(command);
            return false;
        }
        if (!colorTexture) {
            SDL_CancelGPUCommandBuffer(command); // minimized/zero-sized host window; no image was acquired
            return true;
        }
        swapchainTextureAcquired = true;
        if (targetWidth == 0 || targetHeight == 0) {
            SDL_SubmitGPUCommandBuffer(command);
            return true;
        }
        s.width = targetWidth;
        s.height = targetHeight;
    } else {
        colorTexture = s.offscreenColor;
    }

    if (!s.ensureTargets(targetWidth, targetHeight, error)) {
        if (swapchainTextureAcquired) SDL_SubmitGPUCommandBuffer(command);
        else SDL_CancelGPUCommandBuffer(command);
        return false;
    }

    SDL_GPUColorTargetInfo colorInfo{};
    colorInfo.texture = colorTexture;
    colorInfo.clear_color = SDL_FColor{frame.clearColor[0], frame.clearColor[1], frame.clearColor[2], frame.clearColor[3]};
    colorInfo.load_op = frame.clear ? SDL_GPU_LOADOP_CLEAR : SDL_GPU_LOADOP_LOAD;
    colorInfo.store_op = SDL_GPU_STOREOP_STORE;
    SDL_GPUDepthStencilTargetInfo depthInfo{};
    depthInfo.texture = s.depthTexture;
    depthInfo.clear_depth = 1.0f;
    depthInfo.load_op = SDL_GPU_LOADOP_CLEAR;
    depthInfo.store_op = SDL_GPU_STOREOP_DONT_CARE;
    depthInfo.stencil_load_op = SDL_GPU_LOADOP_DONT_CARE;
    depthInfo.stencil_store_op = SDL_GPU_STOREOP_DONT_CARE;

    SDL_GPURenderPass* pass = SDL_BeginGPURenderPass(command, &colorInfo, 1, &depthInfo);
    if (!pass) {
        s.setError(error, "GPU render pass creation failed");
        if (swapchainTextureAcquired) SDL_SubmitGPUCommandBuffer(command);
        else SDL_CancelGPUCommandBuffer(command);
        return false;
    }
    SDL_GPUViewport viewport{};
    viewport.x = 0.0f;
    viewport.y = 0.0f;
    viewport.w = static_cast<float>(targetWidth);
    viewport.h = static_cast<float>(targetHeight);
    viewport.min_depth = 0.0f;
    viewport.max_depth = 1.0f;
    SDL_SetGPUViewport(pass, &viewport);

    for (const auto& draw : frame.draws) {
        const auto& pipeline = s.objects.find(draw.pipeline.value)->second;
        const auto& vertex = s.objects.find(draw.vertexBuffer.value)->second;
        SDL_BindGPUGraphicsPipeline(pass, pipeline.pipeline);
        SDL_GPUBufferBinding binding{vertex.buffer, 0};
        SDL_BindGPUVertexBuffers(pass, 0, &binding, 1);
        SDL_DrawGPUPrimitives(pass, draw.vertexCount, draw.instanceCount, draw.firstVertex, 0);
    }
    SDL_EndGPURenderPass(pass);
    SDL_GPUFence* fence = SDL_SubmitGPUCommandBufferAndAcquireFence(command);
    if (!fence) { s.setError(error, "GPU frame submission failed"); return false; }
    s.fences.emplace(s.nextFence++, fence);
    s.lastFrameId = frame.frameId;
    s.releaseCompletedFences();
    return true;
}

bool SdlGpuBackend::submit(const FramePacket& frame, std::string& error) {
    for (const auto& command : frame.commands) {
        if (command.kind == CommandKind::Draw || command.kind == CommandKind::DrawIndexed ||
            command.kind == CommandKind::Dispatch || command.kind == CommandKind::Copy) {
            error = "Use submitGpuFrame with explicit graphics pipeline and vertex buffer bindings";
            return false;
        }
    }
    GpuFramePacket gpuFrame;
    gpuFrame.frameId = frame.frameId;
    gpuFrame.width = frame.width;
    gpuFrame.height = frame.height;
    gpuFrame.present = impl_->present;
    return submitGpuFrame(gpuFrame, error);
}

GpuWaitResult SdlGpuBackend::waitForFence(std::uint64_t fenceValue, std::uint64_t timeoutNs) {
    auto& s = *impl_;
    if (!s.device || s.deviceLost) return GpuWaitResult::DeviceLost;
    if (fenceValue <= s.completedFence) return GpuWaitResult::Complete;
    auto found = s.fences.find(fenceValue);
    if (found == s.fences.end()) return GpuWaitResult::Failed;
    if (timeoutNs == std::numeric_limits<std::uint64_t>::max()) {
        SDL_GPUFence* fence = found->second;
        if (!SDL_WaitForGPUFences(s.device, true, &fence, 1)) {
            const std::string message = sdlError("GPU fence wait failed");
            if (looksLikeDeviceLoss(message)) { s.markDeviceLost(message); return GpuWaitResult::DeviceLost; }
            return GpuWaitResult::Failed;
        }
        s.releaseCompletedFences();
        return GpuWaitResult::Complete;
    }
    const auto start = std::chrono::steady_clock::now();
    const auto timeout = std::chrono::nanoseconds(timeoutNs);
    while (std::chrono::steady_clock::now() - start < timeout) {
        if (SDL_QueryGPUFence(s.device, found->second)) {
            s.releaseCompletedFences();
            return GpuWaitResult::Complete;
        }
        SDL_Delay(1);
        if (s.deviceLost) return GpuWaitResult::DeviceLost;
    }
    return GpuWaitResult::Timeout;
}

std::uint64_t SdlGpuBackend::lastSubmittedFence() const noexcept {
    return impl_->nextFence - 1;
}

bool SdlGpuBackend::waitIdle() {
    auto& s = *impl_;
    if (!s.device || s.deviceLost) return false;
    if (!SDL_WaitForGPUIdle(s.device)) {
        const std::string message = sdlError("GPU idle wait failed");
        if (looksLikeDeviceLoss(message)) s.markDeviceLost(message);
        return false;
    }
    for (auto& entry : s.fences) {
        SDL_ReleaseGPUFence(s.device, entry.second);
        s.completedFence = std::max(s.completedFence, entry.first);
    }
    s.fences.clear();
    return true;
}

bool SdlGpuBackend::resizeSurface(std::uint32_t width, std::uint32_t height, std::string& error) {
    auto& s = *impl_;
    if (!s.ready || s.deviceLost) { error = "GPU backend is not ready"; return false; }
    if (!width || !height) { error = "Surface dimensions must be positive"; return false; }
    if (!waitIdle()) { error = sdlError("GPU must be idle before resizing resources"); return false; }
    s.width = width;
    s.height = height;
    ++s.swapchainGeneration;
    s.releaseTargetTextures(); // SDL recreates its OS swapchain as the host window changes size.
    return true;
}

bool SdlGpuBackend::isDeviceLost() const noexcept { return impl_->deviceLost; }

bool SdlGpuBackend::destroyResource(ResourceHandle handle) noexcept {
    auto& s = *impl_;
    if (!handle) return false;
    auto found = s.objects.find(handle.value);
    if (found == s.objects.end()) return false;
    if (!s.deviceLost) s.releaseObject(found->second);
    s.objects.erase(found);
    return true;
}

void SdlGpuBackend::dispose() noexcept {
    if (!impl_ || impl_->disposed) return;
    auto& s = *impl_;
    if (s.device) {
        if (!s.deviceLost) SDL_WaitForGPUIdle(s.device);
        for (auto& fence : s.fences) SDL_ReleaseGPUFence(s.device, fence.second);
        s.fences.clear();
        for (auto& object : s.objects) s.releaseObject(object.second);
        s.objects.clear();
        s.releaseTargetTextures();
        if (s.window) SDL_ReleaseWindowFromGPUDevice(s.device, s.window);
        s.window = nullptr;
        SDL_DestroyGPUDevice(s.device);
        s.device = nullptr;
    }
    if (s.ownsVideoSubsystem) {
        SDL_QuitSubSystem(SDL_INIT_VIDEO);
        s.ownsVideoSubsystem = false;
    }
    s.ready = false;
    s.disposed = true;
}

bool registerSdlGpuBackends(NativeBackendRegistry& registry, const SdlGpuBackendOptions& options,
                            std::string* error) {
    const struct Entry { BackendKind kind; const char* id; int priority; } entries[] = {
        {BackendKind::Vulkan, "pstudio.native.vulkan", 100},
        {BackendKind::Direct3D12, "pstudio.native.direct3d12", 100},
        {BackendKind::Metal, "pstudio.native.metal", 100}
    };
    for (const auto& entry : entries) {
        NativeBackendDescriptor descriptor;
        descriptor.kind = entry.kind;
        descriptor.id = entry.id;
        descriptor.priority = entry.priority;
        descriptor.features = {"graphics", "buffers", "textures", "shaders", "pipelines", "fences", "surface-present"};
        descriptor.presentation = true;
        if (!registry.registerBackend(std::move(descriptor), [kind = entry.kind, options] {
            return std::make_shared<SdlGpuBackend>(kind, options);
        }, error)) return false;
    }
    return true;
}

} // namespace pstudio::graphics
