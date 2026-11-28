#pragma once

#include <cstdint>
#include <map>
#include <mutex>
#include <string>
#include <utility>

namespace pstudio::graphics {

enum class NativeSurfaceKind { Headless, Win32, Xcb, Wayland, MetalLayer };

struct NativeSurfaceDescriptor {
    std::string id;
    NativeSurfaceKind kind{NativeSurfaceKind::Headless};
    std::uintptr_t nativeWindow{0};
    std::uintptr_t nativeDisplay{0};
    std::uint32_t width{0};
    std::uint32_t height{0};
    std::uint32_t imageCount{2};
    bool verticalSync{true};
};

struct PresentationImage {
    std::uint64_t token{0};
    std::uint64_t generation{0};
    std::uint32_t imageIndex{0};
    std::uint32_t width{0};
    std::uint32_t height{0};
    explicit operator bool() const noexcept { return token != 0; }
};

enum class PresentationState { Idle, Ready, Lost, Failed, Disposed };

/** Platform API implementations own the actual surface, swapchain and image objects. */
class PresentationBackend {
public:
    virtual ~PresentationBackend() = default;
    virtual bool configureSurface(const NativeSurfaceDescriptor&, std::string& error) = 0;
    virtual bool resizeSurface(std::uint32_t width, std::uint32_t height, std::string& error) = 0;
    virtual bool acquireNextImage(std::uint64_t generation, std::uint64_t timeoutNanoseconds,
                                  PresentationImage& output, std::string& error) = 0;
    virtual bool presentImage(const PresentationImage&, std::string& error) = 0;
    virtual void abandonImage(const PresentationImage&) noexcept = 0;
    virtual void releaseSurface() noexcept = 0;
};

/**
 * Backend-neutral acquire/present state machine. It rejects stale images,
 * duplicate presents, resize races and release while frames are still acquired.
 */
class PresentationRuntime final {
public:
    explicit PresentationRuntime(PresentationBackend& backend) : backend_(backend) {}
    PresentationRuntime(const PresentationRuntime&) = delete;
    PresentationRuntime& operator=(const PresentationRuntime&) = delete;
    ~PresentationRuntime() { dispose(); }

    bool configure(const NativeSurfaceDescriptor& descriptor, std::string* errorOut = nullptr) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (state_ == PresentationState::Disposed) return fail(errorOut, "PresentationRuntime is disposed");
        if (state_ != PresentationState::Idle) return fail(errorOut, "Surface can only be configured from Idle");
        if (descriptor.id.empty() || descriptor.width == 0 || descriptor.height == 0 ||
            descriptor.imageCount < 2 || descriptor.imageCount > 8) {
            return fail(errorOut, "Surface id, positive dimensions and 2-8 swapchain images are required");
        }
        std::string error;
        if (!backend_.configureSurface(descriptor, error)) {
            state_ = PresentationState::Failed;
            return fail(errorOut, error.empty() ? "Surface configuration failed" : error);
        }
        width_ = descriptor.width;
        height_ = descriptor.height;
        generation_ = 1;
        state_ = PresentationState::Ready;
        return true;
    }

    bool acquire(PresentationImage& output, std::uint64_t timeoutNanoseconds = 0, std::string* errorOut = nullptr) {
        std::lock_guard<std::mutex> lock(mutex_);
        output = {};
        if (state_ != PresentationState::Ready) return fail(errorOut, "PresentationRuntime is not ready");
        PresentationImage image{};
        std::string error;
        if (!backend_.acquireNextImage(generation_, timeoutNanoseconds, image, error)) {
            return fail(errorOut, error.empty() ? "No presentation image is available" : error);
        }
        if (!image || image.generation != generation_ || image.width != width_ || image.height != height_ ||
            acquired_.find(image.token) != acquired_.end()) {
            if (image) backend_.abandonImage(image);
            return fail(errorOut, "Backend returned a stale, duplicate or mismatched presentation image");
        }
        acquired_.emplace(image.token, image);
        output = image;
        return true;
    }

    bool present(const PresentationImage& image, std::string* errorOut = nullptr) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (state_ != PresentationState::Ready) return fail(errorOut, "PresentationRuntime is not ready");
        const auto found = acquired_.find(image.token);
        if (!image || found == acquired_.end() || !same(found->second, image) || image.generation != generation_) {
            return fail(errorOut, "Presentation image is not currently acquired by this runtime");
        }
        std::string error;
        if (!backend_.presentImage(image, error)) return fail(errorOut, error.empty() ? "Image presentation failed" : error);
        acquired_.erase(found);
        return true;
    }

    bool abandon(const PresentationImage& image) noexcept {
        std::lock_guard<std::mutex> lock(mutex_);
        const auto found = acquired_.find(image.token);
        if (found == acquired_.end() || !same(found->second, image)) return false;
        backend_.abandonImage(found->second);
        acquired_.erase(found);
        return true;
    }

    bool resize(std::uint32_t width, std::uint32_t height, std::string* errorOut = nullptr) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (state_ != PresentationState::Ready) return fail(errorOut, "PresentationRuntime is not ready");
        if (width == 0 || height == 0) return fail(errorOut, "Surface dimensions must be positive");
        if (!acquired_.empty()) return fail(errorOut, "All acquired images must be presented or abandoned before resize");
        std::string error;
        if (!backend_.resizeSurface(width, height, error)) return fail(errorOut, error.empty() ? "Surface resize failed" : error);
        width_ = width;
        height_ = height;
        ++generation_;
        if (generation_ == 0) ++generation_;
        return true;
    }

    bool markLost() noexcept {
        std::lock_guard<std::mutex> lock(mutex_);
        if (state_ != PresentationState::Ready) return false;
        for (const auto& item : acquired_) backend_.abandonImage(item.second);
        acquired_.clear();
        state_ = PresentationState::Lost;
        return true;
    }

    bool release(std::string* errorOut = nullptr) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (state_ == PresentationState::Idle) return true;
        if (state_ == PresentationState::Disposed) return fail(errorOut, "PresentationRuntime is disposed");
        for (const auto& item : acquired_) backend_.abandonImage(item.second);
        acquired_.clear();
        backend_.releaseSurface();
        width_ = height_ = 0;
        ++generation_;
        state_ = PresentationState::Idle;
        return true;
    }

    void dispose() noexcept {
        std::lock_guard<std::mutex> lock(mutex_);
        if (state_ == PresentationState::Disposed) return;
        for (const auto& item : acquired_) backend_.abandonImage(item.second);
        acquired_.clear();
        if (state_ != PresentationState::Idle) backend_.releaseSurface();
        width_ = height_ = 0;
        state_ = PresentationState::Disposed;
    }

    PresentationState state() const noexcept { std::lock_guard<std::mutex> lock(mutex_); return state_; }
    std::size_t acquiredCount() const noexcept { std::lock_guard<std::mutex> lock(mutex_); return acquired_.size(); }
    std::uint64_t generation() const noexcept { std::lock_guard<std::mutex> lock(mutex_); return generation_; }

private:
    static bool same(const PresentationImage& a, const PresentationImage& b) noexcept {
        return a.token == b.token && a.generation == b.generation && a.imageIndex == b.imageIndex &&
               a.width == b.width && a.height == b.height;
    }
    static bool fail(std::string* output, const std::string& message) {
        if (output) *output = message;
        return false;
    }
    mutable std::mutex mutex_;
    PresentationBackend& backend_;
    std::map<std::uint64_t, PresentationImage> acquired_;
    PresentationState state_{PresentationState::Idle};
    std::uint64_t generation_{0};
    std::uint32_t width_{0}, height_{0};
};

} // namespace pstudio::graphics
