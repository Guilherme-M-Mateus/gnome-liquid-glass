cmake_minimum_required(VERSION 3.20)
project(kwin-effect-liquidglass VERSION 1.0.0)

set(QT_MIN_VERSION "6.6.0")
set(KF_MIN_VERSION "6.0.0")

find_package(ECM ${KF_MIN_VERSION} REQUIRED NO_MODULE)
list(APPEND CMAKE_MODULE_PATH ${ECM_MODULE_PATH})

include(KDEInstallDirs)
include(KDECMakeSettings)
include(KDECompilerSettings NO_POLICY_SCOPE)

find_package(Qt6 ${QT_MIN_VERSION} REQUIRED COMPONENTS Core Gui Widgets Quick DBus)
find_package(KF6 ${KF_MIN_VERSION} REQUIRED COMPONENTS Config CoreAddons WindowSystem)
find_package(KDecoration3 REQUIRED)
find_package(KWin REQUIRED)
find_package(XCB REQUIRED COMPONENTS XCB)

kcoreaddons_add_plugin(liquidglass
    SOURCES src/main.cpp src/liquidglass.cpp src/liquidglass.qrc
    INSTALL_NAMESPACE "kwin/effects/plugins"
)
target_link_libraries(liquidglass PRIVATE
    KWin::kwin
    KF6::ConfigCore
    KDecoration3::KDecoration
    XCB::XCB
)
