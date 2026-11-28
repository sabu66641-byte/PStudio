#include <cassert>
#include <memory>
#include <string>
#include "pstudio/graphics.hpp"

int main() {
    using namespace pstudio::graphics;
    auto first = std::make_shared<NullBackend>();
    Runtime runtime(first);
    std::string error;
    assert(runtime.initialize(&error));
    const auto buffer = runtime.createResource(ResourceDescriptor{"scene.vertices", "buffer", 256, 3, false}, &error);
    assert(buffer);
    assert(runtime.resourceCount() == 1);
    FramePacket frame{1, 640, 480, {Command{CommandKind::BeginPass, {}, 0, 0, 0}, Command{CommandKind::Draw, buffer, 3, 1, 0}}};
    FramePacket invalidFrame{1, 640, 480, {Command{CommandKind::Draw, ResourceHandle{999999}, 3, 1, 0}}};
    assert(!runtime.submit(invalidFrame, &error));
    assert(runtime.submit(frame, &error));
    assert(!runtime.submit(frame, &error));
    assert(runtime.waitIdle());
    assert(runtime.markDeviceLost());
    auto second = std::make_shared<NullBackend>();
    assert(runtime.recover(second, &error));
    assert(runtime.state() == RuntimeState::Ready);
    assert(runtime.resourceCount() == 1);
    frame.frameId = 2;
    assert(runtime.submit(frame, &error));
    assert(runtime.destroyResource("scene.vertices"));
    assert(runtime.resourceCount() == 0);
    runtime.dispose();
    assert(runtime.state() == RuntimeState::Disposed);
    return 0;
}
