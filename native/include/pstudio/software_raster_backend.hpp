#pragma once
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <string>
#include <unordered_map>
#include <vector>
#include "pstudio/graphics.hpp"

namespace pstudio::graphics {

/** Bounded CPU reference renderer. This is not a GPU or platform API backend. */
class SoftwareRasterBackend final : public Backend {
public:
    BackendKind kind() const noexcept override { return BackendKind::Software; }
    bool initialize(std::string& error) override {
        if (disposed_) { error = "SoftwareRasterBackend is disposed"; return false; }
        ready_ = true; return true;
    }
    ResourceHandle createResource(const ResourceDescriptor& d, std::string& error) override {
        if (!ready_ || disposed_) { error = "SoftwareRasterBackend is not ready"; return {}; }
        if (d.id.empty() || d.sizeBytes == 0 || (d.type != "buffer" && d.type != "vertex-buffer")) {
            error = "Software rasterizer requires a non-empty buffer resource";
            return {};
        }
        ResourceHandle h{next_++};
        Entry entry; entry.descriptor = d; entry.bytes.resize(static_cast<std::size_t>(d.sizeBytes), 0);
        resources_.emplace(h.value, std::move(entry));
        return h;
    }
    bool writeResource(ResourceHandle h, const void* data, std::size_t size, std::size_t offset = 0) {
        auto it = resources_.find(h.value);
        if (!ready_ || !h || !data || it == resources_.end()) return false;
        auto& bytes = it->second.bytes;
        if (offset > bytes.size() || size > bytes.size() - offset) return false;
        std::memcpy(bytes.data() + offset, data, size);
        return true;
    }
    bool destroyResource(ResourceHandle h) noexcept override { return h && resources_.erase(h.value) == 1; }
    bool submit(const FramePacket& frame, std::string& error) override {
        if (!ready_ || disposed_) { error = "SoftwareRasterBackend is not ready"; return false; }
        if (!frame.width || !frame.height || frame.width > 4096 || frame.height > 4096) {
            error = "Invalid or oversized software raster target";
            return false;
        }
        const std::uint64_t count = static_cast<std::uint64_t>(frame.width) * frame.height;
        if (count > 16ull * 1024ull * 1024ull) { error = "Software raster pixel budget exceeded"; return false; }
        width_ = frame.width; height_ = frame.height;
        pixels_.assign(static_cast<std::size_t>(count), 0xff101820u);
        for (const auto& command : frame.commands) {
            if (command.kind == CommandKind::Draw && !draw(command, error)) return false;
            if (command.kind == CommandKind::DrawIndexed || command.kind == CommandKind::Dispatch || command.kind == CommandKind::Copy) {
                error = "SoftwareRasterBackend supports non-indexed triangle draws only";
                return false;
            }
        }
        ++frames_;
        return true;
    }
    bool waitIdle() override { return ready_ && !disposed_; }
    void dispose() noexcept override {
        resources_.clear(); pixels_.clear(); width_ = height_ = 0; ready_ = false; disposed_ = true;
    }
    const std::vector<std::uint32_t>& pixels() const noexcept { return pixels_; }
    std::uint32_t width() const noexcept { return width_; }
    std::uint32_t height() const noexcept { return height_; }
    std::uint64_t submittedFrames() const noexcept { return frames_; }
    std::size_t resourceCount() const noexcept { return resources_.size(); }

private:
    struct Entry { ResourceDescriptor descriptor; std::vector<std::uint8_t> bytes; };
    static float edge(float ax, float ay, float bx, float by, float px, float py) noexcept {
        return (px - ax) * (by - ay) - (py - ay) * (bx - ax);
    }
    bool draw(const Command& c, std::string& error) {
        const auto found = resources_.find(c.resource.value);
        if (!c.resource || found == resources_.end()) { error = "Draw references an unknown vertex buffer"; return false; }
        const auto& bytes = found->second.bytes;
        const std::uint32_t count = c.x, instances = std::max<std::uint32_t>(1, c.y), first = c.z;
        if (count < 3 || count % 3) { error = "Triangle-list count must be a positive multiple of three"; return false; }
        const std::uint64_t end = static_cast<std::uint64_t>(first) + static_cast<std::uint64_t>(count) * instances;
        if (end * 2u * sizeof(float) > bytes.size()) { error = "Vertex range exceeds the supplied position buffer"; return false; }
        for (std::uint32_t instance = 0; instance < instances; ++instance) {
            const auto base = first + instance * count;
            for (std::uint32_t v = 0; v < count; v += 3) {
                float p[6]{};
                for (std::uint32_t k = 0; k < 3; ++k) {
                    const auto offset = static_cast<std::size_t>(base + v + k) * 2u * sizeof(float);
                    std::memcpy(&p[k * 2], bytes.data() + offset, 2u * sizeof(float));
                }
                if (!raster(p, error)) return false;
            }
        }
        return true;
    }
    bool raster(const float p[6], std::string& error) {
        for (int i = 0; i < 6; ++i) if (!std::isfinite(p[i])) { error = "Non-finite vertex position"; return false; }
        float x[3], y[3];
        for (int i = 0; i < 3; ++i) {
            x[i] = (p[i * 2] * 0.5f + 0.5f) * static_cast<float>(width_ - 1);
            y[i] = (1.0f - (p[i * 2 + 1] * 0.5f + 0.5f)) * static_cast<float>(height_ - 1);
        }
        const float area = edge(x[0], y[0], x[1], y[1], x[2], y[2]);
        if (std::abs(area) < 1e-6f) return true;
        const int minX = std::max(0, static_cast<int>(std::floor(std::min({x[0], x[1], x[2]}))));
        const int maxX = std::min(static_cast<int>(width_) - 1, static_cast<int>(std::ceil(std::max({x[0], x[1], x[2]}))));
        const int minY = std::max(0, static_cast<int>(std::floor(std::min({y[0], y[1], y[2]}))));
        const int maxY = std::min(static_cast<int>(height_) - 1, static_cast<int>(std::ceil(std::max({y[0], y[1], y[2]}))));
        for (int py = minY; py <= maxY; ++py) for (int px = minX; px <= maxX; ++px) {
            const float fx = static_cast<float>(px) + 0.5f, fy = static_cast<float>(py) + 0.5f;
            const float a = edge(x[1], y[1], x[2], y[2], fx, fy);
            const float b = edge(x[2], y[2], x[0], y[0], fx, fy);
            const float c = edge(x[0], y[0], x[1], y[1], fx, fy);
            const bool inside = area > 0 ? (a >= 0 && b >= 0 && c >= 0) : (a <= 0 && b <= 0 && c <= 0);
            if (inside) pixels_[static_cast<std::size_t>(py) * width_ + static_cast<std::size_t>(px)] = 0xffffffffu;
        }
        return true;
    }

    std::unordered_map<std::uint64_t, Entry> resources_;
    std::vector<std::uint32_t> pixels_;
    std::uint64_t next_{1}, frames_{0};
    std::uint32_t width_{0}, height_{0};
    bool ready_{false}, disposed_{false};
};

} // namespace pstudio::graphics
