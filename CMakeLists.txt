cmake_minimum_required(VERSION 3.24)
project(PStudioNativeGpuBackend LANGUAGES C CXX)

option(PSTUDIO_BUILD_NATIVE_GPU_BACKEND "Compile the optional SDL3 Vulkan/D3D12/Metal adapter" OFF)

if(PSTUDIO_BUILD_NATIVE_GPU_BACKEND)
    include(FetchContent)

    # SDL3 supplies the OS-native Vulkan, Direct3D 12 and Metal GPU driver
    # implementations behind its GPU API. This target compiles the adapter only;
    # no window, GPU device or physical hardware is initialized by the build.
    set(SDL_SHARED OFF CACHE BOOL "" FORCE)
    set(SDL_STATIC ON CACHE BOOL "" FORCE)
    set(SDL_TESTS OFF CACHE BOOL "" FORCE)
    set(SDL_EXAMPLES OFF CACHE BOOL "" FORCE)
    set(SDL_INSTALL OFF CACHE BOOL "" FORCE)
    set(SDL_TEST_LIBRARY OFF CACHE BOOL "" FORCE)

    FetchContent_Declare(
        SDL3
        GIT_REPOSITORY https://github.com/libsdl-org/SDL.git
        GIT_TAG release-3.2.10
        GIT_SHALLOW TRUE
    )
    FetchContent_MakeAvailable(SDL3)

    add_library(pstudio_native_gpu_backend OBJECT
        native/src/sdl_gpu_backend.cpp
    )
    target_include_directories(pstudio_native_gpu_backend
        PRIVATE \${CMAKE_CURRENT_SOURCE_DIR}/native/include
    )
    target_compile_features(pstudio_native_gpu_backend PRIVATE cxx_std_17)
    target_link_libraries(pstudio_native_gpu_backend PRIVATE SDL3::SDL3)
    if(MSVC)
        target_compile_options(pstudio_native_gpu_backend PRIVATE /W4)
    else()
        target_compile_options(pstudio_native_gpu_backend PRIVATE -Wall -Wextra -Wpedantic)
    endif()
endif()
