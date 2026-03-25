/**
 * TalaDB React Native — iOS JSI HostObject
 *
 * This file registers a C++ JSI HostObject (`TalaDBHostObject`) that bridges
 * the JavaScript TurboModule API to the Rust `taladb-core` static library.
 *
 * Build requirements:
 *   - Link `libtaladb_core.a` (built by `cargo build --target aarch64-apple-ios`)
 *   - Set Header Search Paths to include the generated C header from cbindgen
 *   - Enable New Architecture (TurboModules) in the Xcode project
 *
 * Implementation status:
 *   [x] Module registration
 *   [x] JSI HostObject skeleton
 *   [ ] Full C FFI implementation (requires cbindgen header generation)
 */

#import <React/RCTBridgeModule.h>
#import <ReactCommon/RCTTurboModule.h>
#import <jsi/jsi.h>

using namespace facebook::jsi;

// ---------------------------------------------------------------------------
// TalaDBHostObject — JSI HostObject wrapping taladb-core
// ---------------------------------------------------------------------------

class TalaDBHostObject : public HostObject {
public:
  TalaDBHostObject() {}
  ~TalaDBHostObject() override {}

  Value get(Runtime &rt, const PropNameID &name) override {
    auto methodName = name.utf8(rt);

    // initialize(dbName: string): Promise<void>
    if (methodName == "initialize") {
      return Function::createFromHostFunction(
        rt, PropNameID::forAscii(rt, "initialize"), 1,
        [this](Runtime &rt, const Value &, const Value *args, size_t count) -> Value {
          // TODO: Call taladb_open(dbName) from the Rust FFI
          // std::string dbName = args[0].getString(rt).utf8(rt);
          // taladb_open(dbName.c_str());
          return Value::undefined();
        });
    }

    // insert(collection, doc): string
    if (methodName == "insert") {
      return Function::createFromHostFunction(
        rt, PropNameID::forAscii(rt, "insert"), 2,
        [this](Runtime &rt, const Value &, const Value *args, size_t count) -> Value {
          // TODO: serialize args[1] (JS object) to JSON, call taladb_insert()
          return String::createFromAscii(rt, "placeholder-ulid");
        });
    }

    // find(collection, filter): Object[]
    if (methodName == "find") {
      return Function::createFromHostFunction(
        rt, PropNameID::forAscii(rt, "find"), 2,
        [this](Runtime &rt, const Value &, const Value *args, size_t count) -> Value {
          // TODO: call taladb_find(), deserialize JSON result to JS array
          return Array(rt, 0);
        });
    }

    // Stub all other methods
    return Function::createFromHostFunction(
      rt, name, 0,
      [](Runtime &rt, const Value &, const Value *, size_t) -> Value {
        return Value::undefined();
      });
  }

  void set(Runtime &rt, const PropNameID &name, const Value &value) override {}
  std::vector<PropNameID> getPropertyNames(Runtime &rt) override { return {}; }
};

// ---------------------------------------------------------------------------
// TalaDB — RCTTurboModule bridge
// ---------------------------------------------------------------------------

@interface TalaDB : NSObject <RCTBridgeModule, RCTTurboModule>
@end

@implementation TalaDB

RCT_EXPORT_MODULE(TalaDB)

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params {
  // Install the JSI HostObject at app startup
  auto &rt = *params.jsInvoker;
  // NOTE: actual installation requires calling
  //   rt.global().setProperty(rt, "__TalaDB__", Object::createFromHostObject(rt, hostObject));
  // from the AppDelegate after the bridge is ready.
  return nullptr;
}

@end
