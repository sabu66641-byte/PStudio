#include <cassert>
#include <memory>
#include <string>
#include "pstudio/presentation.hpp"

using namespace pstudio::graphics;

class FakePresentationBackend final : public PresentationBackend {
public:
    bool configureSurface(const NativeSurfaceDescriptor& d, std::string&) override {
        configured = true; width = d.width; height = d.height; return true;
    }
    bool resizeSurface(std::uint32_t w, std::uint32_t h, std::string&) override {
        if (!configured) return false;
        width = w; height = h; return true;
    }
    bool acquireNextImage(std::uint64_t generation, std::uint64_t, PresentationImage& out, std::string&) override {
        if (!configured) return false;
        out = PresentationImage{next++, generation, static_cast<std::uint32_t>((next - 2) % 3), width, height};
        return true;
    }
    bool presentImage(const PresentationImage& image, std::string&) override {
        if (!configured || image.width != width || image.height != height) return false;
        ++presented; return true;
    }
    void abandonImage(const PresentationImage&) noexcept override { ++abandoned; }
    void releaseSurface() noexcept override { configured = false; ++released; }
    bool configured{false};
    std::uint64_t next{1}, presented{0}, abandoned{0}, released{0};
    std::uint32_t width{0}, height{0};
};

int main() {
    FakePresentationBackend backend;
    PresentationRuntime runtime(backend);
    std::string error;
    assert(runtime.configure({"test", NativeSurfaceKind::Headless, 0, 0, 640, 480, 3, true}, &error));
    assert(runtime.state() == PresentationState::Ready);
    PresentationImage first{};
    assert(runtime.acquire(first, 0, &error));
    assert(runtime.acquiredCount() == 1);
    assert(!runtime.resize(800, 600, &error));
    assert(runtime.present(first, &error));
    assert(!runtime.present(first, &error));
    assert(runtime.acquiredCount() == 0);
    const auto oldGeneration = runtime.generation();
    assert(runtime.resize(800, 600, &error));
    assert(runtime.generation() == oldGeneration + 1);
    PresentationImage second{};
    assert(runtime.acquire(second, 0, &error));
    assert(second.width == 800 && second.height == 600);
    assert(runtime.abandon(second));
    assert(!runtime.abandon(second));
    assert(backend.abandoned == 1);
    PresentationImage third{};
    assert(runtime.acquire(third, 0, &error));
    assert(runtime.markLost());
    assert(runtime.state() == PresentationState::Lost);
    assert(backend.abandoned == 2);
    assert(runtime.release(&error));
    assert(runtime.state() == PresentationState::Idle);
    assert(backend.released == 1);
    runtime.dispose();
    assert(runtime.state() == PresentationState::Disposed);
    return 0;
}
