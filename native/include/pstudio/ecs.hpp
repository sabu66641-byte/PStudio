#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <functional>
#include <limits>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <typeindex>
#include <type_traits>
#include <unordered_map>
#include <utility>
#include <vector>

namespace pstudio::ecs {

using Entity = std::uint32_t;

struct Transform {
    double x{0.0}, y{0.0}, z{0.0};
    double rotationX{0.0}, rotationY{0.0}, rotationZ{0.0};
    double scaleX{1.0}, scaleY{1.0}, scaleZ{1.0};
};

struct SceneObjectRef {
    std::string sceneObjectId;
};

template <class T>
T& get(std::optional<T>& value, const char* name) {
    if (!value.has_value()) {
        throw std::runtime_error(std::string("Uninitialized ps local: ") + name);
    }
    return *value;
}

template <class T, class U>
void set(std::optional<T>& target, U&& value, const char* name) {
    (void)name;
    target = std::forward<U>(value);
}

inline std::vector<std::int64_t> range(std::int64_t start, std::int64_t stop, std::int64_t step);

inline std::vector<std::int64_t> range(std::int64_t stop) {
    std::vector<std::int64_t> result;
    if (stop <= 0) return result;
    result.reserve(static_cast<std::size_t>(std::min<std::int64_t>(stop, 1000000)));
    for (std::int64_t value = 0; value < stop; ++value) result.push_back(value);
    return result;
}

inline std::vector<std::int64_t> range(std::int64_t start, std::int64_t stop) {
    return range(start, stop, 1);
}

inline std::vector<std::int64_t> range(std::int64_t start, std::int64_t stop, std::int64_t step) {
    std::vector<std::int64_t> result;
    if (step == 0) throw std::invalid_argument("range() step cannot be zero");
    for (std::int64_t value = start;
         step > 0 ? value < stop : value > stop;
         value += step) {
        result.push_back(value);
        if (result.size() >= 1000000) throw std::length_error("range() element limit exceeded");
        if ((step > 0 && value > std::numeric_limits<std::int64_t>::max() - step) ||
            (step < 0 && value < std::numeric_limits<std::int64_t>::min() - step)) break;
    }
    return result;
}

template <class T>
auto len(const T& value) -> decltype(value.size()) {
    return value.size();
}

template <class A, class B>
double ps_div(A left, B right) {
    if (right == 0) throw std::runtime_error("division by zero");
    return static_cast<double>(left) / static_cast<double>(right);
}

template <class A, class B>
auto ps_mod(A left, B right) {
    if (right == 0) throw std::runtime_error("modulo by zero");
    if constexpr (std::is_floating_point_v<A> || std::is_floating_point_v<B>) {
        return std::fmod(static_cast<double>(left), static_cast<double>(right));
    } else {
        return left % right;
    }
}

class World {
    struct IStorage {
        virtual ~IStorage() = default;
        virtual bool contains(Entity entity) const = 0;
        virtual bool erase(Entity entity) = 0;
        virtual std::size_t size() const = 0;
        virtual const std::vector<Entity>& ids() const = 0;
    };

    template <class T>
    struct Storage final : IStorage {
        std::vector<Entity> entities;
        std::unordered_map<Entity, T> values;
        std::unordered_map<Entity, std::size_t> indices;

        bool contains(Entity entity) const override {
            return indices.find(entity) != indices.end();
        }

        bool erase(Entity entity) override {
            const auto found = indices.find(entity);
            if (found == indices.end()) return false;
            const std::size_t index = found->second;
            const std::size_t last = entities.size() - 1;
            if (index != last) {
                const Entity moved = entities[last];
                entities[index] = moved;
                indices[moved] = index;
            }
            entities.pop_back();
            indices.erase(found);
            values.erase(entity);
            return true;
        }

        std::size_t size() const override { return entities.size(); }
        const std::vector<Entity>& ids() const override { return entities; }

        T& insert(Entity entity, const T& value) {
            if (contains(entity)) throw std::logic_error("Entity already has this component");
            indices.emplace(entity, entities.size());
            entities.push_back(entity);
            return values.emplace(entity, value).first->second;
        }

        T& insert(Entity entity, T&& value) {
            if (contains(entity)) throw std::logic_error("Entity already has this component");
            indices.emplace(entity, entities.size());
            entities.push_back(entity);
            return values.emplace(entity, std::move(value)).first->second;
        }
    };

    std::unordered_map<std::type_index, std::unique_ptr<IStorage>> stores_;
    std::vector<Entity> entities_;
    std::vector<std::function<void(World&)>> deferred_;
    Entity nextEntity_{1};
    std::size_t iterationDepth_{0};
    bool flushing_{false};

    void assert_structure_mutable() const {
        if (iterationDepth_ != 0) {
            throw std::logic_error("ECS structure cannot change during each(); use defer()");
        }
    }

    template <class T>
    Storage<T>& storage() {
        const std::type_index key(typeid(T));
        auto found = stores_.find(key);
        if (found == stores_.end()) {
            auto created = std::make_unique<Storage<T>>();
            auto* raw = created.get();
            stores_.emplace(key, std::move(created));
            return *raw;
        }
        return *static_cast<Storage<T>*>(found->second.get());
    }

    template <class T>
    const Storage<T>* find_storage() const {
        const auto found = stores_.find(std::type_index(typeid(T)));
        return found == stores_.end() ? nullptr : static_cast<const Storage<T>*>(found->second.get());
    }

    template <class First, class... Rest>
    IStorage& smallest_storage() {
        IStorage* smallest = &storage<First>();
        ((smallest = storage<Rest>().size() < smallest->size()
            ? static_cast<IStorage*>(&storage<Rest>()) : smallest), ...);
        return *smallest;
    }

    void finish_iteration() {
        if (iterationDepth_ == 0 && !flushing_) flush_deferred();
    }

    void flush_deferred() {
        if (flushing_ || iterationDepth_ != 0) return;
        flushing_ = true;
        std::size_t processed = 0;
        try {
            while (!deferred_.empty()) {
                if (++processed > 100000) throw std::runtime_error("ECS deferred operation limit exceeded");
                auto action = std::move(deferred_.front());
                deferred_.erase(deferred_.begin());
                action(*this);
            }
        } catch (...) {
            flushing_ = false;
            throw;
        }
        flushing_ = false;
    }

public:
    Entity create_entity() {
        assert_structure_mutable();
        if (nextEntity_ == 0) throw std::overflow_error("ECS entity id space exhausted");
        const Entity entity = nextEntity_++;
        entities_.push_back(entity);
        return entity;
    }

    bool destroy_entity(Entity entity) {
        assert_structure_mutable();
        const auto found = std::find(entities_.begin(), entities_.end(), entity);
        if (found == entities_.end()) return false;
        entities_.erase(found);
        for (auto& entry : stores_) entry.second->erase(entity);
        return true;
    }

    template <class T>
    T& add(Entity entity, const T& value = T{}) {
        assert_structure_mutable();
        if (std::find(entities_.begin(), entities_.end(), entity) == entities_.end()) {
            throw std::out_of_range("ECS entity does not exist");
        }
        return storage<T>().insert(entity, value);
    }

    template <class T>
    T& add(Entity entity, T&& value) {
        assert_structure_mutable();
        if (std::find(entities_.begin(), entities_.end(), entity) == entities_.end()) {
            throw std::out_of_range("ECS entity does not exist");
        }
        return storage<T>().insert(entity, std::move(value));
    }

    template <class T>
    T& get(Entity entity) {
        auto& values = storage<T>().values;
        const auto found = values.find(entity);
        if (found == values.end()) throw std::out_of_range("ECS component not found on entity");
        return found->second;
    }

    template <class T>
    const T& get(Entity entity) const {
        const auto* values = find_storage<T>();
        if (!values) throw std::out_of_range("ECS component type is not registered");
        const auto found = values->values.find(entity);
        if (found == values->values.end()) throw std::out_of_range("ECS component not found on entity");
        return found->second;
    }

    template <class T>
    bool has(Entity entity) const {
        const auto* values = find_storage<T>();
        return values && values->contains(entity);
    }

    template <class T>
    bool remove(Entity entity) {
        assert_structure_mutable();
        const auto found = stores_.find(std::type_index(typeid(T)));
        if (found == stores_.end()) return false;
        return found->second->erase(entity);
    }

    template <class... Components, class Fn>
    void each(Fn&& callback) {
        static_assert(sizeof...(Components) > 0, "World::each requires at least one Component type");
        IStorage& base = smallest_storage<Components...>();
        ++iterationDepth_;
        try {
            const auto& ids = base.ids();
            for (std::size_t index = 0; index < ids.size(); ++index) {
                const Entity entity = ids[index];
                if ((has<Components>(entity) && ...)) {
                    callback(entity, get<Components>(entity)...);
                }
            }
        } catch (...) {
            --iterationDepth_;
            finish_iteration();
            throw;
        }
        --iterationDepth_;
        finish_iteration();
    }

    void defer(std::function<void(World&)> action) {
        if (!action) throw std::invalid_argument("ECS defer expects a callable");
        deferred_.push_back(std::move(action));
        finish_iteration();
    }

    std::size_t entity_count() const { return entities_.size(); }
};

class Scheduler {
public:
    using Update = std::function<void(World&, double)>;

private:
    struct Entry {
        std::string id;
        int priority{0};
        std::uint64_t sequence{0};
        bool enabled{true};
        Update update;
    };
    std::vector<Entry> systems_;
    std::uint64_t nextSequence_{0};

public:
    void add(std::string id, int priority, Update update) {
        if (id.empty()) throw std::invalid_argument("ECS System id cannot be empty");
        if (!update) throw std::invalid_argument("ECS System update must be callable");
        if (std::any_of(systems_.begin(), systems_.end(), [&](const Entry& entry) { return entry.id == id; })) {
            throw std::logic_error("ECS System is already registered: " + id);
        }
        systems_.push_back({std::move(id), priority, nextSequence_++, true, std::move(update)});
        std::stable_sort(systems_.begin(), systems_.end(), [](const Entry& a, const Entry& b) {
            return a.priority < b.priority || (a.priority == b.priority && a.sequence < b.sequence);
        });
    }

    bool remove(const std::string& id) {
        const auto found = std::find_if(systems_.begin(), systems_.end(), [&](const Entry& entry) { return entry.id == id; });
        if (found == systems_.end()) return false;
        systems_.erase(found);
        return true;
    }

    bool set_enabled(const std::string& id, bool enabled) {
        const auto found = std::find_if(systems_.begin(), systems_.end(), [&](const Entry& entry) { return entry.id == id; });
        if (found == systems_.end()) throw std::out_of_range("ECS System is not registered: " + id);
        found->enabled = enabled;
        return enabled;
    }

    void update(World& world, double dt) const {
        if (!std::isfinite(dt) || dt < 0.0) throw std::invalid_argument("ECS delta time must be finite and non-negative");
        const auto frameSystems = systems_;
        for (const auto& system : frameSystems) {
            if (system.enabled) system.update(world, dt);
        }
    }

    std::size_t size() const { return systems_.size(); }
};

} // namespace pstudio::ecs
