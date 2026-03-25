require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name          = "taladb-react-native"
  s.version       = package["version"]
  s.summary       = package["description"]
  s.homepage      = "https://github.com/thinkgrid-labs/taladb"
  s.license       = package["license"]
  s.authors       = { "thinkgrid-labs" => "hello@thinkgrid.io" }

  s.platforms     = { :ios => "13.0" }
  s.source        = { :git => "https://github.com/thinkgrid-labs/taladb.git",
                      :tag => "v#{s.version}" }

  # TypeScript / JS sources (not compiled by Xcode, just bundled)
  s.source_files  = "ios/**/*.{h,m,mm}", "cpp/**/*.{h,cpp}"

  # ---------------------------------------------------------------------------
  # Pre-built Rust static library
  # ---------------------------------------------------------------------------
  # Build with:
  #   cargo build --target aarch64-apple-ios          --release   (device)
  #   cargo build --target x86_64-apple-ios           --release   (simulator Intel)
  #   cargo build --target aarch64-apple-ios-sim      --release   (simulator Apple Silicon)
  #   lipo device + sim → ios/libtaladb_ffi.a (fat / xcframework)
  #
  # The podspec expects the lipo'd archive at ios/libtaladb_ffi.a.
  s.vendored_libraries = "ios/libtaladb_ffi.a"

  # ---------------------------------------------------------------------------
  # Compiler settings
  # ---------------------------------------------------------------------------
  s.pod_target_xcconfig = {
    "CLANG_CXX_LANGUAGE_STANDARD"   => "c++17",
    "OTHER_CPLUSPLUSFLAGS"           => "-DFOLLY_NO_CONFIG -DFOLLY_MOBILE=1 -DFOLLY_USE_LIBCPP=1",
    "HEADER_SEARCH_PATHS"            => "$(PODS_ROOT)/Headers/Public/React-Core $(PODS_ROOT)/Headers/Public/React-RCTFabric",
    "LIBRARY_SEARCH_PATHS"           => "$(PODS_ROOT)/../ios",
    # Suppress linker warnings from the Rust archive
    "OTHER_LDFLAGS"                  => "-lc++ -lz",
  }

  # ---------------------------------------------------------------------------
  # React Native dependencies
  # ---------------------------------------------------------------------------
  s.dependency "React-Core"
  s.dependency "React-jsi"
  s.dependency "ReactCommon/turbomodule/core"
end
