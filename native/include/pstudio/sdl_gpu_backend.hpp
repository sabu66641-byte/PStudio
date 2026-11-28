#pragma once

#include <memory>
#include <string>

#include "pstudio/backend_registry.hpp"
#include "pstudio/native_gpu.hpp"

namespace pstudio::graphics {

struct SdlGpuBackendOptions {
    bool debug{false};
    std::string applicationName{"PStudio"};
};

/**
 * Real native GPU backend powered by SDL3's GPU API.
 *
 * SDL selects and owns the requested Vulkan, Direct3D 12 or Metal driver.
 * PStudio verifies the selected driver name and does not silently accept a
 * different API. The host owns SDL_Window and passes it as a borrowed handle.
 */
class SdlGpuBackend final : public NativeGpuBackend {
public:
    SdlGpuBackend(BackendKind kind, SdlGpuBackendOptions options = {});
    ~SdlGpuBackend() override;

    SdlGpuBackend(const SdlGpuBackend&) = delete;
    SdlGpuBackend& operator=(const SdlGpuBackend&) = delete;

    BackendKind kind() const noexcept override;
    bool initialize(std::string& error) override;
    ResourceHandle createResource(const ResourceDescriptor& descriptor, std::string& error) override;
    bool destroyResource(ResourceHandle handle) noexcept override;
    bool submit(const FramePacket& frame, std::string& error) override;
    bool waitIdle() override;
    void dispose() noexcept override;

    bool configureSurface(const NativeSurfaceDescriptor& surface, std::string& error) override;
    NativeGpuCapabilities capabilities() const override;
    NativeSwapchainInfo swapchainInfo() const override;
    ResourceHandle createShader(const GpuShaderDescriptor& descriptor, std::string& error) override;
    ResourceHandle createTexture(const GpuTextureDescriptor& descriptor, std::string& error) override;
    bool uploadBuffer(ResourceHandle buffer, const void* data, std::size_t size, std::size_t offset, std::string& error) override;
    ResourceHandle createGraphicsPipeline(const GpuPipelineDescriptor& descriptor, std::string& error) override;
    bool submitGpuFrame(const GpuFramePacket& frame, std::string& error) override;
    GpuWaitResult waitForFence(std::uint64_t fenceValue, std::uint64_t timeoutNs) override;
    std::uint64_t lastSubmittedFence() const noexcept override;
    bool resizeSurface(std::uint32_t width, std::uint32_t height, std::string& error) override;
    bool isDeviceLost() const noexcept override;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

/** Registers the three real SDL3 GPU driver choices. Registration does not create a device. */
bool registerSdlGpuBackends(
    NativeBackendRegistry& registry,
    const SdlGpuBackendOptions& options = {},
    std::string* error = nullptr
);

} // namespace pstudio::graphics
