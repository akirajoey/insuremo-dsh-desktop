cmake_minimum_required(VERSION 3.20)
project(insuremo-runtime-supervisor LANGUAGES CXX)

add_executable(runtime-supervisor runtime-supervisor.cpp)
target_compile_features(runtime-supervisor PRIVATE cxx_std_17)
target_compile_definitions(runtime-supervisor PRIVATE UNICODE _UNICODE)
target_link_libraries(runtime-supervisor PRIVATE Advapi32)
set_target_properties(runtime-supervisor PROPERTIES OUTPUT_NAME "runtime-supervisor")
