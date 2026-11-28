#pragma once

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <memory>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include "pstudio/native_gpu.hpp"

namespace pstudio::graphics {

enum class NativeGpuRuntimeState { Idle, Ready, Lost, Failed, Disposed };

/**
 * Recovery-aware native GPU owner.
 *
 * Public ResourceHandles are logical PStudio handles. API handles remain private
 * to the selected backend and may change during recovery. CPU upload shadows and
 * creation recipes are retained so buffers, textures, shaders and pipelines can
 * be reconstructed transactionally on a replacement device.
 */
class NativeGpuRuntime final {
public:
    explicit NativeGpuRuntime(std::shared_ptr<NativeGpuBackend> backend,
                              NativeSurfaceDescriptor surface = {})
        : backend_(std::move(backend)), surface_(surface) {
        if (!backend_) throw std::invalid_argument("NativeGpuRuntime requires a backend");
    }
    NativeGpuRuntime(const NativeGpuRuntime&) = delete;
    NativeGpuRuntime& operator=(const NativeGpuRuntime&) = delete;
    ~NativeGpuRuntime() { dispose(); }

    bool initialize(std::string* errorOut = nullptr) {
        if (state_ == NativeGpuRuntimeState::Disposed) return fail(errorOut, "Native GPU runtime is disposed");
        if (state_ == NativeGpuRuntimeState::Ready) return true;
        std::string error;
        if (!surface_.valid(&error)) { state_ = NativeGpuRuntimeState::Failed; return fail(errorOut, error); }
        if (!backend_->initialize(error) || !backend_->configureSurface(surface_, error)) {
            backend_->dispose();
            state_ = NativeGpuRuntimeState::Failed;
            return fail(errorOut, error.empty() ? "Native GPU backend initialization failed" : error);
        }
        state_ = NativeGpuRuntimeState::Ready;
        return true;
    }

    ResourceHandle createBuffer(const ResourceDescriptor& descriptor, std::string* errorOut = nullptr) {
        if (!ready(errorOut)) return {};
        if (!uniqueId(descriptor.id, errorOut)) return {};
        if (descriptor.type.empty() || descriptor.sizeBytes == 0) { fail(errorOut, "Native GPU buffer descriptor is invalid"); return {}; }
        std::string error;
        const auto actual = backend_->createResource(descriptor, error);
        if (!actual) { updateLostState(); fail(errorOut, error.empty() ? "Native GPU buffer creation failed" : error); return {}; }
        Entry entry; entry.kind = EntryKind::Buffer; entry.id = descriptor.id; entry.buffer = descriptor; entry.actual = actual;
        return insert(std::move(entry));
    }

    ResourceHandle createTexture(const GpuTextureDescriptor& descriptor, std::string* errorOut = nullptr) {
        if (!ready(errorOut)) return {};
        if (!uniqueId(descriptor.id, errorOut)) return {};
        std::string error;
        if (!validateGpuTextureDescriptor(descriptor, error)) { fail(errorOut, error); return {}; }
        const auto actual = backend_->createTexture(descriptor, error);
        if (!actual) { updateLostState(); fail(errorOut, error.empty() ? "Native GPU texture creation failed" : error); return {}; }
        Entry entry; entry.kind = EntryKind::Texture; entry.id = descriptor.id; entry.texture = descriptor; entry.actual = actual;
        return insert(std::move(entry));
    }

    ResourceHandle createShader(const GpuShaderDescriptor& descriptor, std::string* errorOut = nullptr) {
        if (!ready(errorOut)) return {};
        if (!uniqueId(descriptor.id, errorOut)) return {};
        std::string error;
        if (!validateGpuShaderDescriptor(descriptor, error)) { fail(errorOut, error); return {}; }
        const auto actual = backend_->createShader(descriptor, error);
        if (!actual) { updateLostState(); fail(errorOut, error.empty() ? "Native GPU shader creation failed" : error); return {}; }
        Entry entry; entry.kind = EntryKind::Shader; entry.id = descriptor.id; entry.shader = descriptor; entry.actual = actual;
        return insert(std::move(entry));
    }

    ResourceHandle createGraphicsPipeline(const GpuPipelineDescriptor& descriptor, std::string* errorOut = nullptr) {
        if (!ready(errorOut)) return {};
        if (!uniqueId(descriptor.id, errorOut)) return {};
        std::string error;
        if (!validateGpuPipelineDescriptor(descriptor, error)) { fail(errorOut, error); return {}; }
        const Entry* vertex = find(descriptor.vertexShader);
        const Entry* fragment = find(descriptor.fragmentShader);
        if (!vertex || !fragment || vertex->kind != EntryKind::Shader || fragment->kind != EntryKind::Shader) {
            fail(errorOut, "Graphics pipeline shader handles are not owned by this runtime");
            return {};
        }
        GpuPipelineDescriptor actualDescriptor = descriptor;
        actualDescriptor.vertexShader = vertex->actual;
        actualDescriptor.fragmentShader = fragment->actual;
        const auto actual = backend_->createGraphicsPipeline(actualDescriptor, error);
        if (!actual) { updateLostState(); fail(errorOut, error.empty() ? "Native GPU pipeline creation failed" : error); return {}; }
        Entry entry; entry.kind = EntryKind::Pipeline; entry.id = descriptor.id; entry.pipeline = descriptor; entry.actual = actual;
        return insert(std::move(entry));
    }

    bool uploadBuffer(ResourceHandle handle, const void* data, std::size_t size,
                      std::size_t offset = 0, std::string* errorOut = nullptr) {
        if (!ready(errorOut)) return false;
        Entry* entry = find(handle);
        if (!entry || entry->kind != EntryKind::Buffer || !data ||
            offset > entry->buffer.sizeBytes || size > entry->buffer.sizeBytes - offset) {
            return fail(errorOut, "Native GPU buffer handle or upload range is invalid");
        }
        if (entry->shadow.size() != entry->buffer.sizeBytes) entry->shadow.resize(static_cast<std::size_t>(entry->buffer.sizeBytes), 0);
        if (size) std::memcpy(entry->shadow.data() + offset, data, size);
        std::string error;
        if (!backend_->uploadBuffer(entry->actual, data, size, offset, error)) {
            updateLostState();
            return fail(errorOut, error.empty() ? "Native GPU buffer upload failed" : error);
        }
        return true;
    }

    bool uploadTexture(ResourceHandle handle, const void* data, std::size_t size,
                       std::string* errorOut = nullptr) {
        if (!ready(errorOut)) return false;
        Entry* entry = find(handle);
        if (!entry || entry->kind != EntryKind::Texture || !data) return fail(errorOut, "Native GPU texture handle or upload data is invalid");
        const std::size_t bytesPerPixel = entry->texture.format == GpuPixelFormat::Rgba16Float ? 8u : 4u;
        if (entry->texture.format == GpuPixelFormat::Depth32Float ||
            size != static_cast<std::size_t>(entry->texture.width) * entry->texture.height * bytesPerPixel) {
            return fail(errorOut, "Native GPU texture upload size or format is invalid");
        }
        entry->shadow.resize(size);
        if (size) std::memcpy(entry->shadow.data(), data, size);
        std::string error;
        if (!backend_->uploadTexture(entry->actual, data, size, error)) {
            updateLostState();
            return fail(errorOut, error.empty() ? "Native GPU texture upload failed" : error);
        }
        return true;
    }

    bool submitGpuFrame(const GpuFramePacket& frame, std::string* errorOut = nullptr) {
        if (!ready(errorOut)) return false;
        GpuFramePacket translated = frame;
        for (auto& draw : translated.draws) {
            const Entry* pipeline = find(draw.pipeline);
            const Entry* buffer = find(draw.vertexBuffer);
            if (!pipeline || !buffer || pipeline->kind != EntryKind::Pipeline || buffer->kind != EntryKind::Buffer) {
                return fail(errorOut, "GPU frame references a resource not owned by this runtime");
            }
            draw.pipeline = pipeline->actual;
            draw.vertexBuffer = buffer->actual;
        }
        std::string error;
        if (!backend_->submitGpuFrame(translated, error)) {
            updateLostState();
            return fail(errorOut, error.empty() ? "Native GPU frame submission failed" : error);
        }
        return true;
    }

    bool waitIdle() {
        if (state_ != NativeGpuRuntimeState::Ready) return false;
        const bool result = backend_->waitIdle();
        updateLostState();
        return result;
    }

    GpuWaitResult waitForFence(std::uint64_t fence, std::uint64_t timeoutNs) {
        if (state_ != NativeGpuRuntimeState::Ready) return GpuWaitResult::DeviceLost;
        const auto result = backend_->waitForFence(fence, timeoutNs);
        if (result == GpuWaitResult::DeviceLost) state_ = NativeGpuRuntimeState::Lost;
        updateLostState();
        return result;
    }

    bool resizeSurface(std::uint32_t width, std::uint32_t height, std::string* errorOut = nullptr) {
        if (!ready(errorOut)) return false;
        std::string error;
        if (!backend_->resizeSurface(width, height, error)) {
            updateLostState();
            return fail(errorOut, error.empty() ? "Native GPU surface resize failed" : error);
        }
        surface_.width = width;
        surface_.height = height;
        return true;
    }

    bool markDeviceLost() noexcept {
        if (state_ != NativeGpuRuntimeState::Ready) return false;
        state_ = NativeGpuRuntimeState::Lost;
        return true;
    }

    /** Builds a replacement completely before committing it; old resources survive any failed attempt. */
    bool recover(std::shared_ptr<NativeGpuBackend> replacement, std::string* errorOut = nullptr) {
        if (state_ != NativeGpuRuntimeState::Lost) return fail(errorOut, "Native GPU runtime must be Lost before recovery");
        if (!replacement || replacement == backend_) return fail(errorOut, "Recovery requires a different backend instance");
        std::string error;
        if (!surface_.valid(&error) || !replacement->initialize(error) || !replacement->configureSurface(surface_, error)) {
            replacement->dispose();
            return fail(errorOut, error.empty() ? "Replacement native GPU backend initialization failed" : error);
        }

        std::unordered_map<std::uint64_t, ResourceHandle> restored;
        auto rollback = [&]() {
            replacement->dispose();
            return false;
        };
        for (auto& pair : entries_) {
            Entry& entry = pair.second;
            if (entry.kind != EntryKind::Buffer) continue;
            const auto handle = replacement->createResource(entry.buffer, error);
            if (!handle) { rollback(); return fail(errorOut, error.empty() ? "Buffer recreation failed" : error); }
            restored.emplace(pair.first, handle);
            if (!entry.shadow.empty() && !replacement->uploadBuffer(handle, entry.shadow.data(), entry.shadow.size(), 0, error)) {
                rollback(); return fail(errorOut, error.empty() ? "Buffer upload restoration failed" : error);
            }
        }
        for (auto& pair : entries_) {
            Entry& entry = pair.second;
            if (entry.kind != EntryKind::Texture) continue;
            const auto handle = replacement->createTexture(entry.texture, error);
            if (!handle) { rollback(); return fail(errorOut, error.empty() ? "Texture recreation failed" : error); }
            restored.emplace(pair.first, handle);
            if (!entry.shadow.empty() && !replacement->uploadTexture(handle, entry.shadow.data(), entry.shadow.size(), error)) {
                rollback(); return fail(errorOut, error.empty() ? "Texture upload restoration failed" : error);
            }
        }
        for (auto& pair : entries_) {
            Entry& entry = pair.second;
            if (entry.kind != EntryKind::Shader) continue;
            const auto handle = replacement->createShader(entry.shader, error);
            if (!handle) { rollback(); return fail(errorOut, error.empty() ? "Shader recreation failed" : error); }
            restored.emplace(pair.first, handle);
        }
        for (auto& pair : entries_) {
            Entry& entry = pair.second;
            if (entry.kind != EntryKind::Pipeline) continue;
            GpuPipelineDescriptor descriptor = entry.pipeline;
            const auto vertex = restored.find(descriptor.vertexShader.value);
            const auto fragment = restored.find(descriptor.fragmentShader.value);
            if (vertex == restored.end() || fragment == restored.end()) {
                rollback(); return fail(errorOut, "Pipeline recovery could not resolve its shader recipes");
            }
            descriptor.vertexShader = vertex->second;
            descriptor.fragmentShader = fragment->second;
            const auto handle = replacement->createGraphicsPipeline(descriptor, error);
            if (!handle) { rollback(); return fail(errorOut, error.empty() ? "Graphics pipeline recreation failed" : error); }
            restored.emplace(pair.first, handle);
        }

        backend_->dispose();
        backend_ = std::move(replacement);
        for (auto& pair : entries_) pair.second.actual = restored.at(pair.first);
        state_ = NativeGpuRuntimeState::Ready;
        ++recoveryGeneration_;
        return true;
    }

    bool destroy(ResourceHandle handle) noexcept {
        if (!handle) return false;
        auto found = entries_.find(handle.value);
        if (found == entries_.end()) return false;
        if (state_ == NativeGpuRuntimeState::Ready) backend_->destroyResource(found->second.actual);
        ids_.erase(found->second.id);
        entries_.erase(found);
        return true;
    }

    void dispose() noexcept {
        if (state_ == NativeGpuRuntimeState::Disposed) return;
        if (backend_) backend_->dispose();
        entries_.clear();
        ids_.clear();
        state_ = NativeGpuRuntimeState::Disposed;
    }

    NativeGpuRuntimeState state() const noexcept { return state_; }
    BackendKind backendKind() const noexcept { return backend_->kind(); }
    std::uint64_t recoveryGeneration() const noexcept { return recoveryGeneration_; }
    std::size_t resourceCount() const noexcept { return entries_.size(); }
    NativeGpuCapabilities capabilities() const { return backend_->capabilities(); }
    NativeSwapchainInfo swapchainInfo() const { return backend_->swapchainInfo(); }

private:
    enum class EntryKind { Buffer, Texture, Shader, Pipeline };
    struct Entry {
        EntryKind kind{EntryKind::Buffer};
        std::string id;
        ResourceDescriptor buffer;
        GpuTextureDescriptor texture;
        GpuShaderDescriptor shader;
        GpuPipelineDescriptor pipeline;
        ResourceHandle actual{};
        std::vector<std::uint8_t> shadow;
    };

    static bool fail(std::string* output, const std::string& message) {
        if (output) *output = message;
        return false;
    }
    bool ready(std::string* output) {
        if (state_ == NativeGpuRuntimeState::Ready) return true;
        if (backend_ && backend_->isDeviceLost()) state_ = NativeGpuRuntimeState::Lost;
        return fail(output, state_ == NativeGpuRuntimeState::Lost ? "Native GPU device is lost; recover with a replacement backend" : "Native GPU runtime is not ready");
    }
    void updateLostState() noexcept {
        if (backend_ && backend_->isDeviceLost()) state_ = NativeGpuRuntimeState::Lost;
    }
    bool uniqueId(const std::string& id, std::string* output) const {
        if (id.empty()) return fail(output, "Native GPU resource id is required");
        if (ids_.find(id) != ids_.end()) return fail(output, "Duplicate native GPU resource id: " + id);
        return true;
    }
    ResourceHandle insert(Entry entry) {
        const ResourceHandle handle{nextLogicalHandle_++};
        ids_.insert(entry.id);
        entries_.emplace(handle.value, std::move(entry));
        return handle;
    }
    Entry* find(ResourceHandle handle) {
        const auto found = entries_.find(handle.value);
        return found == entries_.end() ? nullptr : &found->second;
    }
    const Entry* find(ResourceHandle handle) const {
        const auto found = entries_.find(handle.value);
        return found == entries_.end() ? nullptr : &found->second;
    }

    std::shared_ptr<NativeGpuBackend> backend_;
    NativeSurfaceDescriptor surface_;
    NativeGpuRuntimeState state_{NativeGpuRuntimeState::Idle};
    std::unordered_map<std::uint64_t, Entry> entries_;
    std::unordered_set<std::string> ids_;
    std::uint64_t nextLogicalHandle_{1};
    std::uint64_t recoveryGeneration_{0};
};

} // namespace pstudio::graphics
