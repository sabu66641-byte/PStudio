#include <cassert>
#include <memory>
#include <string>
#include <vector>
#include "pstudio/backend_registry.hpp"
#include "pstudio/software_raster_backend.hpp"

using namespace pstudio::graphics;

class TestNativeBackend final : public Backend {
public:
    explicit TestNativeBackend(BackendKind kind) : kind_(kind) {}
    BackendKind kind() const noexcept override { return kind_; }
    bool initialize(std::string&) override { ready_ = true; return true; }
    ResourceHandle createResource(const ResourceDescriptor&, std::string&) override { return ResourceHandle{1}; }
    bool destroyResource(ResourceHandle) noexcept override { return true; }
    bool submit(const FramePacket&, std::string&) override { return ready_; }
    bool waitIdle() override { return ready_; }
    void dispose() noexcept override { ready_ = false; }
private:
    BackendKind kind_;
    bool ready_{false};
};

int main() {
    std::string error;
    NativeBackendRegistry registry;
    assert(registry.registerBackend({BackendKind::Vulkan, "vulkan.mock", 100, {"graphics"}, true},
        [] { return std::make_shared<TestNativeBackend>(BackendKind::Vulkan); }, &error));
    assert(registry.registerBackend({BackendKind::Direct3D12, "d3d12.mock", 50, {"graphics", "compute", "storage"}, true},
        [] { return std::make_shared<TestNativeBackend>(BackendKind::Direct3D12); }, &error));
    auto selected = registry.select({BackendKind::Vulkan, BackendKind::Direct3D12}, {"graphics", "compute"}, true, &error);
    assert(selected.backend);
    assert(selected.descriptor.kind == BackendKind::Direct3D12);
    assert(selected.fallback);
    selected.backend->dispose();
    auto strict = registry.select({BackendKind::Vulkan}, {"graphics", "compute"}, false, &error);
    assert(!strict.backend);
    assert(!error.empty());

    SoftwareRasterBackend software;
    assert(software.initialize(error));
    const ResourceDescriptor vertices{"triangle", "vertex-buffer", sizeof(float) * 6, 1, false};
    const auto handle = software.createResource(vertices, error);
    assert(handle);
    const float positions[] = {-0.8f, -0.8f, 0.8f, -0.8f, 0.0f, 0.8f};
    assert(software.writeResource(handle, positions, sizeof(positions)));
    FramePacket frame{1, 64, 64, {Command{CommandKind::Draw, handle, 3, 1, 0}}};
    assert(software.submit(frame, error));
    assert(software.submittedFrames() == 1);
    assert(software.width() == 64 && software.height() == 64);
    std::size_t painted = 0;
    for (const auto pixel : software.pixels()) if (pixel == 0xffffffffu) ++painted;
    assert(painted > 500);
    assert(software.waitIdle());
    assert(software.destroyResource(handle));
    software.dispose();
    assert(software.pixels().empty());
    return 0;
}
