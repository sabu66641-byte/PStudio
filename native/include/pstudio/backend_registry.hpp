#pragma once

#include <algorithm>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

#include "pstudio/graphics.hpp"

namespace pstudio::graphics {

struct NativeBackendDescriptor {
    BackendKind kind{BackendKind::Null};
    std::string id;
    int priority{0};
    std::vector<std::string> features;
    bool presentation{false};
};

struct NativeBackendSelection {
    std::shared_ptr<Backend> backend;
    NativeBackendDescriptor descriptor;
    bool fallback{false};
};

class NativeBackendRegistry final {
public:
    using Factory = std::function<std::shared_ptr<Backend>()>;

    bool registerBackend(NativeBackendDescriptor descriptor, Factory factory, std::string* errorOut = nullptr) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (descriptor.id.empty() || !factory) return fail(errorOut, "Backend id and factory are required");
        const auto found = std::find_if(entries_.begin(), entries_.end(), [&](const Entry& entry) { return entry.descriptor.id == descriptor.id; });
        if (found != entries_.end()) return fail(errorOut, "Duplicate native backend id: " + descriptor.id);
        std::sort(descriptor.features.begin(), descriptor.features.end());
        descriptor.features.erase(std::unique(descriptor.features.begin(), descriptor.features.end()), descriptor.features.end());
        entries_.push_back(Entry{std::move(descriptor), std::move(factory)});
        return true;
    }

    bool unregisterBackend(const std::string& id) {
        std::lock_guard<std::mutex> lock(mutex_);
        const auto found = std::find_if(entries_.begin(), entries_.end(), [&](const Entry& entry) { return entry.descriptor.id == id; });
        if (found == entries_.end()) return false;
        entries_.erase(found);
        return true;
    }

    std::vector<NativeBackendDescriptor> list() const {
        std::lock_guard<std::mutex> lock(mutex_);
        std::vector<NativeBackendDescriptor> result;
        result.reserve(entries_.size());
        for (const auto& entry : entries_) result.push_back(entry.descriptor);
        return result;
    }

    NativeBackendSelection select(
        const std::vector<BackendKind>& preference,
        const std::vector<std::string>& requiredFeatures,
        bool allowFallback,
        std::string* errorOut = nullptr
    ) const {
        std::vector<Entry> candidates;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            candidates = entries_;
        }
        auto rank = [&](BackendKind kind) {
            const auto found = std::find(preference.begin(), preference.end(), kind);
            return found == preference.end() ? static_cast<int>(preference.size()) + 1 : static_cast<int>(std::distance(preference.begin(), found));
        };
        candidates.erase(std::remove_if(candidates.begin(), candidates.end(), [&](const Entry& entry) {
            return !std::all_of(requiredFeatures.begin(), requiredFeatures.end(), [&](const std::string& feature) {
                return std::find(entry.descriptor.features.begin(), entry.descriptor.features.end(), feature) != entry.descriptor.features.end();
            });
        }), candidates.end());
        std::stable_sort(candidates.begin(), candidates.end(), [&](const Entry& a, const Entry& b) {
            const int ar = rank(a.descriptor.kind), br = rank(b.descriptor.kind);
            return ar == br ? a.descriptor.priority > b.descriptor.priority : ar < br;
        });
        if (!allowFallback && !preference.empty()) {
            candidates.erase(std::remove_if(candidates.begin(), candidates.end(), [&](const Entry& entry) {
                return entry.descriptor.kind != preference.front();
            }), candidates.end());
        }
        std::string lastError = "No native backend satisfies the requested features";
        for (const auto& candidate : candidates) {
            std::shared_ptr<Backend> backend;
            try { backend = candidate.factory(); }
            catch (const std::exception& error) { lastError = error.what(); continue; }
            if (!backend || backend->kind() != candidate.descriptor.kind) {
                if (backend) backend->dispose();
                lastError = "Native backend factory returned an implementation with a mismatched BackendKind";
                continue;
            }
            std::string initializeError;
            if (!backend->initialize(initializeError)) {
                backend->dispose();
                lastError = initializeError.empty() ? "Native backend initialization failed" : initializeError;
                continue;
            }
            const bool isFallback = !preference.empty() && candidate.descriptor.kind != preference.front();
            return NativeBackendSelection{std::move(backend), candidate.descriptor, isFallback};
        }
        fail(errorOut, lastError);
        return {};
    }

private:
    struct Entry { NativeBackendDescriptor descriptor; Factory factory; };
    static bool fail(std::string* output, const std::string& message) {
        if (output) *output = message;
        return false;
    }
    mutable std::mutex mutex_;
    std::vector<Entry> entries_;
};

} // namespace pstudio::graphics
