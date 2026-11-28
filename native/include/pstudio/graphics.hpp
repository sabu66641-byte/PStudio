#pragma once

#include <cstdint>
#include <algorithm>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace pstudio::graphics {

enum class BackendKind { Null, Software, Vulkan, Direct3D12, Metal };
enum class RuntimeState { Idle, Ready, Lost, Failed, Disposed };
enum class CommandKind { BeginPass, EndPass, Draw, DrawIndexed, Dispatch, Copy, Present };

struct ResourceDescriptor {
    std::string id;
    std::string type;
    std::uint64_t sizeBytes{0};
    std::uint32_t usage{0};
    bool transient{false};
};

struct ResourceHandle {
    std::uint64_t value{0};
    explicit operator bool() const noexcept { return value != 0; }
};

struct Command {
    CommandKind kind{CommandKind::BeginPass};
    ResourceHandle resource{};
    std::uint32_t x{0};
    std::uint32_t y{0};
    std::uint32_t z{0};
};

struct FramePacket {
    std::uint64_t frameId{0};
    std::uint32_t width{0};
    std::uint32_t height{0};
    std::vector<Command> commands;
};

class Backend {
public:
    virtual ~Backend() = default;
    virtual BackendKind kind() const noexcept = 0;
    virtual bool initialize(std::string& error) = 0;
    virtual ResourceHandle createResource(const ResourceDescriptor& descriptor, std::string& error) = 0;
    virtual bool destroyResource(ResourceHandle handle) noexcept = 0;
    virtual bool submit(const FramePacket& frame, std::string& error) = 0;
    virtual bool waitIdle() = 0;
    virtual void dispose() noexcept = 0;
};

/** CPU-only validation backend. It is for contracts and tests, never a GPU renderer. */
class NullBackend final : public Backend {
public:
    BackendKind kind() const noexcept override { return BackendKind::Null; }
    bool initialize(std::string& error) override {
        if (disposed_) { error = "NullBackend is disposed"; return false; }
        ready_ = true; return true;
    }
    ResourceHandle createResource(const ResourceDescriptor& descriptor, std::string& error) override {
        if (!ready_ || disposed_) { error = "NullBackend is not ready"; return {}; }
        if (descriptor.id.empty() || descriptor.type.empty()) { error = "Resource id and type are required"; return {}; }
        const ResourceHandle handle{nextHandle_++};
        resources_.emplace(handle.value, descriptor);
        return handle;
    }
    bool destroyResource(ResourceHandle handle) noexcept override {
        return handle && resources_.erase(handle.value) == 1;
    }
    bool submit(const FramePacket& frame, std::string& error) override {
        if (!ready_ || disposed_) { error = "NullBackend is not ready"; return false; }
        if (frame.width == 0 || frame.height == 0) { error = "Frame dimensions must be positive"; return false; }
        ++submittedFrames_; return true;
    }
    bool waitIdle() override { return ready_ && !disposed_; }
    void dispose() noexcept override { resources_.clear(); ready_ = false; disposed_ = true; }
    std::size_t resourceCount() const noexcept { return resources_.size(); }
    std::uint64_t submittedFrames() const noexcept { return submittedFrames_; }
private:
    std::unordered_map<std::uint64_t, ResourceDescriptor> resources_;
    std::uint64_t nextHandle_{1};
    std::uint64_t submittedFrames_{0};
    bool ready_{false};
    bool disposed_{false};
};

/**
 * Backend-independent native runtime ownership layer. Concrete Vulkan/D3D12/Metal
 * adapters implement Backend and are intentionally separate native-platform work.
 */
class Runtime final {
public:
    explicit Runtime(std::shared_ptr<Backend> backend) : backend_(std::move(backend)) {
        if (!backend_) throw std::invalid_argument("PStudio native graphics Runtime requires a backend");
    }
    Runtime(const Runtime&) = delete;
    Runtime& operator=(const Runtime&) = delete;
    ~Runtime() { dispose(); }

    bool initialize(std::string* errorOut = nullptr) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (state_ == RuntimeState::Disposed) return fail(errorOut, "Runtime is disposed");
        if (state_ == RuntimeState::Ready) return true;
        std::string error;
        if (!backend_->initialize(error)) { state_ = RuntimeState::Failed; return fail(errorOut, error); }
        state_ = RuntimeState::Ready;
        return true;
    }

    ResourceHandle createResource(const ResourceDescriptor& descriptor, std::string* errorOut = nullptr) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (state_ != RuntimeState::Ready) { fail(errorOut, "Runtime is not ready"); return {}; }
        if (descriptor.id.empty() || descriptor.type.empty()) { fail(errorOut, "Resource id and type are required"); return {}; }
        if (resources_.find(descriptor.id) != resources_.end()) { fail(errorOut, "Duplicate resource id: " + descriptor.id); return {}; }
        std::string error;
        const auto handle = backend_->createResource(descriptor, error);
        if (!handle) { fail(errorOut, error.empty() ? "Backend returned an invalid resource handle" : error); return {}; }
        for (const auto& item : resources_) {
            if (item.second.handle.value == handle.value) {
                backend_->destroyResource(handle);
                fail(errorOut, "Backend returned a duplicate live resource handle");
                return {};
            }
        }
        resources_.emplace(descriptor.id, ResourceRecord{descriptor, handle});
        return handle;
    }

    bool destroyResource(const std::string& id) noexcept {
        std::lock_guard<std::mutex> lock(mutex_);
        const auto found = resources_.find(id);
        if (found == resources_.end()) return false;
        if (state_ == RuntimeState::Ready) backend_->destroyResource(found->second.handle);
        resources_.erase(found);
        return true;
    }

    bool submit(const FramePacket& frame, std::string* errorOut = nullptr) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (state_ != RuntimeState::Ready) return fail(errorOut, "Runtime is not ready");
        if (frame.frameId == 0 || frame.frameId <= lastFrameId_) return fail(errorOut, "Frame ids must increase monotonically");
        if (frame.width == 0 || frame.height == 0) return fail(errorOut, "Frame dimensions must be positive");
        for (const auto& command : frame.commands) {
            if (!command.resource) continue;
            const auto owned = std::find_if(resources_.begin(), resources_.end(), [&](const auto& item) { return item.second.handle.value == command.resource.value; });
            if (owned == resources_.end()) return fail(errorOut, "Frame references a resource not owned by this Runtime");
        }
        std::string error;
        if (!backend_->submit(frame, error)) return fail(errorOut, error.empty() ? "Backend frame submission failed" : error);
        lastFrameId_ = frame.frameId;
        return true;
    }

    bool waitIdle() {
        std::lock_guard<std::mutex> lock(mutex_);
        return state_ == RuntimeState::Ready && backend_->waitIdle();
    }

    bool markDeviceLost() noexcept {
        std::lock_guard<std::mutex> lock(mutex_);
        if (state_ != RuntimeState::Ready) return false;
        state_ = RuntimeState::Lost;
        return true;
    }

    /** Explicit backend replacement. Resource descriptors are recreated before commit. */
    bool recover(std::shared_ptr<Backend> replacement, std::string* errorOut = nullptr) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (state_ != RuntimeState::Lost) return fail(errorOut, "Runtime must be lost before recovery");
        if (!replacement || replacement == backend_) return fail(errorOut, "Recovery requires a different backend instance");
        std::string error;
        if (!replacement->initialize(error)) { replacement->dispose(); return fail(errorOut, error.empty() ? "Replacement backend initialization failed" : error); }
        std::unordered_map<std::string, ResourceRecord> restored;
        for (const auto& entry : resources_) {
            const auto handle = replacement->createResource(entry.second.descriptor, error);
            if (!handle) {
                for (const auto& item : restored) replacement->destroyResource(item.second.handle);
                replacement->dispose();
                return fail(errorOut, error.empty() ? "Resource recreation failed" : error);
            }
            restored.emplace(entry.first, ResourceRecord{entry.second.descriptor, handle});
        }
        backend_->dispose();
        backend_ = std::move(replacement);
        resources_ = std::move(restored);
        state_ = RuntimeState::Ready;
        return true;
    }

    void dispose() noexcept {
        std::lock_guard<std::mutex> lock(mutex_);
        if (state_ == RuntimeState::Disposed) return;
        if (state_ == RuntimeState::Ready) for (const auto& item : resources_) backend_->destroyResource(item.second.handle);
        resources_.clear();
        if (backend_) backend_->dispose();
        state_ = RuntimeState::Disposed;
    }

    RuntimeState state() const noexcept { std::lock_guard<std::mutex> lock(mutex_); return state_; }
    BackendKind backendKind() const noexcept { std::lock_guard<std::mutex> lock(mutex_); return backend_->kind(); }
    std::size_t resourceCount() const noexcept { std::lock_guard<std::mutex> lock(mutex_); return resources_.size(); }
    std::uint64_t lastFrameId() const noexcept { std::lock_guard<std::mutex> lock(mutex_); return lastFrameId_; }

private:
    struct ResourceRecord { ResourceDescriptor descriptor; ResourceHandle handle; };
    static bool fail(std::string* output, const std::string& message) {
        if (output) *output = message;
        return false;
    }
    mutable std::mutex mutex_;
    std::shared_ptr<Backend> backend_;
    std::unordered_map<std::string, ResourceRecord> resources_;
    RuntimeState state_{RuntimeState::Idle};
    std::uint64_t lastFrameId_{0};
};

} // namespace pstudio::graphics
