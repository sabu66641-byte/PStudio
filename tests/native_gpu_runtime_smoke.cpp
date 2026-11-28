#include <cassert>
#include <cstdint>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include "pstudio/native_gpu_runtime.hpp"

using namespace pstudio::graphics;

class MockNativeGpuBackend final : public NativeGpuBackend {
public:
    explicit MockNativeGpuBackend(BackendKind kind = BackendKind::Vulkan, bool failPipeline = false)
        : kind_(kind), failPipeline_(failPipeline) {}
    BackendKind kind() const noexcept override { return kind_; }
    bool initialize(std::string& error) override {
        if (disposed_) { error = "disposed"; return false; }
        initialized_ = true; return true;
    }
    ResourceHandle createResource(const ResourceDescriptor& d, std::string&) override {
        return add(Kind::Buffer, d.id);
    }
    ResourceHandle createTexture(const GpuTextureDescriptor& d, std::string&) override {
        return add(Kind::Texture, d.id);
    }
    bool uploadTexture(ResourceHandle h, const void* data, std::size_t size, std::string&) override {
        return !disposed_ && data && size > 0 && valid(h, Kind::Texture);
    }
    bool uploadBuffer(ResourceHandle h, const void* data, std::size_t size, std::size_t offset, std::string&) override {
        return !disposed_ && data && size > 0 && offset == 0 && valid(h, Kind::Buffer);
    }
    ResourceHandle createShader(const GpuShaderDescriptor& d, std::string& error) override {
        if (!validateGpuShaderDescriptor(d, error)) return {};
        return add(Kind::Shader, d.id);
    }
    ResourceHandle createGraphicsPipeline(const GpuPipelineDescriptor& d, std::string& error) override {
        if (failPipeline_) { error = "mock pipeline failure"; return {}; }
        if (!valid(d.vertexShader, Kind::Shader) || !valid(d.fragmentShader, Kind::Shader)) {
            error = "unknown mock shader"; return {};
        }
        return add(Kind::Pipeline, d.id);
    }
    bool submitGpuFrame(const GpuFramePacket& frame, std::string& error) override {
        if (disposed_ || !initialized_ || deviceLost_) { error = "mock device unavailable"; return false; }
        for (const auto& draw : frame.draws) {
            if (!valid(draw.pipeline, Kind::Pipeline) || !valid(draw.vertexBuffer, Kind::Buffer)) {
                error = "mock draw handle invalid"; return false;
            }
        }
        ++submittedFrames_;
        ++lastFence_;
        return true;
    }
    bool configureSurface(const NativeSurfaceDescriptor& surface, std::string& error) override {
        if (!surface.valid(&error)) return false;
        surface_ = surface;
        configured_ = true;
        return initialized_ && !disposed_;
    }
    NativeGpuCapabilities capabilities() const override {
        NativeGpuCapabilities result;
        result.deviceName = "Mock GPU";
        result.driverName = "mock";
        result.presentation = surface_.platform != NativeSurfacePlatform::Headless;
        return result;
    }
    NativeSwapchainInfo swapchainInfo() const override {
        NativeSwapchainInfo result;
        result.width = surface_.width;
        result.height = surface_.height;
        result.generation = configured_ ? 1 : 0;
        return result;
    }
    GpuWaitResult waitForFence(std::uint64_t fence, std::uint64_t) override {
        return deviceLost_ ? GpuWaitResult::DeviceLost : (fence <= lastFence_ ? GpuWaitResult::Complete : GpuWaitResult::Failed);
    }
    std::uint64_t lastSubmittedFence() const noexcept override { return lastFence_; }
    bool resizeSurface(std::uint32_t w, std::uint32_t h, std::string& error) override {
        if (!w || !h) { error = "bad size"; return false; }
        surface_.width = w; surface_.height = h; return true;
    }
    bool isDeviceLost() const noexcept override { return deviceLost_; }
    bool waitIdle() override { return initialized_ && !disposed_ && !deviceLost_; }
    bool destroyResource(ResourceHandle h) noexcept override { return resources_.erase(h.value) == 1; }
    void dispose() noexcept override { resources_.clear(); disposed_ = true; initialized_ = false; }
    void lose() noexcept { deviceLost_ = true; }
    bool disposed() const noexcept { return disposed_; }
    std::uint64_t submittedFrames() const noexcept { return submittedFrames_; }
    std::size_t resourceCount() const noexcept { return resources_.size(); }

private:
    enum class Kind { Buffer, Texture, Shader, Pipeline };
    ResourceHandle add(Kind kind, const std::string&) {
        const ResourceHandle handle{next_++};
        resources_[handle.value] = kind;
        return handle;
    }
    bool valid(ResourceHandle handle, Kind kind) const {
        const auto found = resources_.find(handle.value);
        return handle && found != resources_.end() && found->second == kind;
    }
    BackendKind kind_;
    bool failPipeline_{false};
    bool initialized_{false};
    bool disposed_{false};
    bool deviceLost_{false};
    bool configured_{false};
    NativeSurfaceDescriptor surface_{};
    std::uint64_t next_{1}, lastFence_{0}, submittedFrames_{0};
    std::unordered_map<std::uint64_t, Kind> resources_;
};

static GpuShaderDescriptor shader(const std::string& id, GpuShaderStage stage) {
    GpuShaderDescriptor d;
    d.id = id;
    d.stage = stage;
    d.format = GpuShaderFormat::SpirV;
    d.bytecode = {0x03, 0x02, 0x23, 0x07, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0};
    return d;
}

int main() {
    std::string error;
    auto first = std::make_shared<MockNativeGpuBackend>();
    NativeGpuRuntime runtime(first, NativeSurfaceDescriptor{});
    assert(runtime.initialize(&error));
    assert(runtime.state() == NativeGpuRuntimeState::Ready);

    ResourceDescriptor bufferDesc{"world.vertices", "vertex-buffer", 36, 1, false};
    const ResourceHandle vertexBuffer = runtime.createBuffer(bufferDesc, &error);
    assert(vertexBuffer);
    GpuTextureDescriptor textureDesc;
    textureDesc.id = "world.albedo";
    textureDesc.width = 2;
    textureDesc.height = 2;
    textureDesc.format = GpuPixelFormat::Rgba8Unorm;
    const ResourceHandle texture = runtime.createTexture(textureDesc, &error);
    assert(texture);
    const ResourceHandle vertexShader = runtime.createShader(shader("world.vs", GpuShaderStage::Vertex), &error);
    const ResourceHandle fragmentShader = runtime.createShader(shader("world.fs", GpuShaderStage::Fragment), &error);
    assert(vertexShader && fragmentShader);

    GpuPipelineDescriptor pipelineDesc;
    pipelineDesc.id = "world.pipeline";
    pipelineDesc.vertexShader = vertexShader;
    pipelineDesc.fragmentShader = fragmentShader;
    pipelineDesc.vertexStride = 12;
    pipelineDesc.attributes = {{0, 0, 3}};
    const ResourceHandle pipeline = runtime.createGraphicsPipeline(pipelineDesc, &error);
    assert(pipeline);

    const std::uint8_t vertices[36] = {};
    const std::uint8_t pixels[16] = {};
    assert(runtime.uploadBuffer(vertexBuffer, vertices, sizeof(vertices), 0, &error));
    assert(runtime.uploadTexture(texture, pixels, sizeof(pixels), &error));

    GpuFramePacket frame;
    frame.frameId = 1;
    frame.width = 640;
    frame.height = 480;
    frame.draws.push_back({pipeline, vertexBuffer, 3, 0, 1});
    assert(runtime.submitGpuFrame(frame, &error));
    assert(runtime.waitForFence(1, 0) == GpuWaitResult::Complete);
    assert(runtime.waitIdle());
    assert(first->submittedFrames() == 1);

    // A failed replacement is rolled back. The previous lost backend remains owned.
    assert(runtime.markDeviceLost());
    auto rejected = std::make_shared<MockNativeGpuBackend>(BackendKind::Vulkan, true);
    assert(!runtime.recover(rejected, &error));
    assert(runtime.state() == NativeGpuRuntimeState::Lost);
    assert(rejected->disposed());
    assert(!first->disposed());

    // Successful replacement rebuilds buffer + texture + shaders + pipeline.
    auto replacement = std::make_shared<MockNativeGpuBackend>();
    assert(runtime.recover(replacement, &error));
    assert(runtime.state() == NativeGpuRuntimeState::Ready);
    assert(runtime.recoveryGeneration() == 1);
    assert(runtime.resourceCount() == 5);
    assert(first->disposed());
    frame.frameId = 2;
    assert(runtime.submitGpuFrame(frame, &error)); // logical handles remain stable
    assert(replacement->submittedFrames() == 1);
    assert(runtime.resizeSurface(800, 600, &error));
    assert(runtime.swapchainInfo().width == 800);

    assert(runtime.destroy(pipeline));
    assert(runtime.destroy(vertexShader));
    assert(runtime.destroy(fragmentShader));
    assert(runtime.destroy(texture));
    assert(runtime.destroy(vertexBuffer));
    assert(runtime.resourceCount() == 0);
    runtime.dispose();
    assert(runtime.state() == NativeGpuRuntimeState::Disposed);
    return 0;
}
