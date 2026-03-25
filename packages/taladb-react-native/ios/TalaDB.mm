/**
 * TalaDB React Native — iOS TurboModule + JSI HostObject installer.
 *
 * Build setup (Xcode / CocoaPods)
 * --------------------------------
 *  1. Run `cargo build --target aarch64-apple-ios --release` (device) and
 *     `cargo build --target x86_64-apple-ios --release` (simulator), then
 *     `lipo` them into a universal `libtaladb_ffi.a`.
 *  2. The podspec links the fat archive and adds `cpp/` to the header search
 *     paths — both are handled automatically when using the podspec.
 *
 * Runtime flow
 * ------------
 *  AppDelegate calls `[TalaDB installInRuntime:rt dbPath:path]` once the
 *  React bridge is ready.  This opens the Rust database and installs
 *  `global.__TalaDB__` as a JSI HostObject.
 *
 *  NativeTalaDB.ts routes all synchronous CRUD calls directly through
 *  `global.__TalaDB__` — the TurboModule stubs below satisfy Codegen but
 *  are never invoked at runtime.
 */

#import <React/RCTBridgeModule.h>
#import <ReactCommon/RCTTurboModule.h>
#import <ReactCommon/CallInvoker.h>
#import <jsi/jsi.h>
#import <React/RCTBridge+Private.h>

#include "../cpp/TalaDBHostObject.h"
#include "../cpp/taladb.h"

#import <Foundation/Foundation.h>

using namespace facebook::jsi;

// ---------------------------------------------------------------------------
// Global handle — one database per process
// ---------------------------------------------------------------------------

static TalaDbHandle *gHandle = nullptr;

// ---------------------------------------------------------------------------
// TalaDB — Obj-C TurboModule
// ---------------------------------------------------------------------------

@interface TalaDB : NSObject <RCTBridgeModule, RCTTurboModule>
@end

@implementation TalaDB

RCT_EXPORT_MODULE(TalaDB)

// ---- Class method: open DB and install the JSI HostObject ----------------

+ (void)installInRuntime:(facebook::jsi::Runtime &)rt
                  dbPath:(NSString *)path {
    if (gHandle) {
        taladb_close(gHandle);
        gHandle = nullptr;
    }

    gHandle = taladb_open(path.UTF8String);
    if (!gHandle) {
        NSLog(@"[TalaDB] Failed to open database at %@", path);
        return;
    }

    taladb::TalaDBHostObject::install(rt, gHandle);
    NSLog(@"[TalaDB] Installed JSI HostObject — db: %@", path);
}

// ---- initialize(dbName) → Promise<void>  ---------------------------------

RCT_EXPORT_METHOD(initialize:(NSString *)dbName
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
    @try {
        NSString *docs = [NSSearchPathForDirectoriesInDomains(
            NSDocumentDirectory, NSUserDomainMask, YES) firstObject];
        NSString *dbPath = [docs stringByAppendingPathComponent:dbName];

        RCTCxxBridge *bridge = (RCTCxxBridge *)[RCTBridge currentBridge];
        if (!bridge || !bridge.runtime) {
            reject(@"TALADB_NO_BRIDGE", @"JSI bridge not available", nil);
            return;
        }

        // Install the HostObject on the JS thread
        bridge.jsCallInvoker->invokeAsync([bridge, dbPath]() {
            auto &rt = *(Runtime *)bridge.runtime;
            [TalaDB installInRuntime:rt dbPath:dbPath];
        });

        resolve(nil);
    } @catch (NSException *ex) {
        reject(@"TALADB_INIT_ERROR", ex.reason, nil);
    }
}

// ---- close() → Promise<void>  --------------------------------------------

RCT_EXPORT_METHOD(close:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject) {
    if (gHandle) {
        taladb_close(gHandle);
        gHandle = nullptr;
    }
    resolve(nil);
}

// ---- Synchronous stubs — all real work goes through the JSI HostObject ---
// These exist only to satisfy the TurboModule Codegen spec (NativeTalaDB.ts).

RCT_EXPORT_SYNCHRONOUS_TYPED_METHOD(NSString *, insert:(NSString *)collection doc:(NSDictionary *)doc) {
    return nil;
}
RCT_EXPORT_SYNCHRONOUS_TYPED_METHOD(NSArray *, insertMany:(NSString *)collection docs:(NSArray *)docs) {
    return nil;
}
RCT_EXPORT_SYNCHRONOUS_TYPED_METHOD(NSArray *, find:(NSString *)collection filter:(NSDictionary *)filter) {
    return nil;
}
RCT_EXPORT_SYNCHRONOUS_TYPED_METHOD(NSDictionary *, findOne:(NSString *)collection filter:(NSDictionary *)filter) {
    return nil;
}
RCT_EXPORT_SYNCHRONOUS_TYPED_METHOD(BOOL, updateOne:(NSString *)collection filter:(NSDictionary *)filter update:(NSDictionary *)update) {
    return NO;
}
RCT_EXPORT_SYNCHRONOUS_TYPED_METHOD(double, updateMany:(NSString *)collection filter:(NSDictionary *)filter update:(NSDictionary *)update) {
    return 0;
}
RCT_EXPORT_SYNCHRONOUS_TYPED_METHOD(BOOL, deleteOne:(NSString *)collection filter:(NSDictionary *)filter) {
    return NO;
}
RCT_EXPORT_SYNCHRONOUS_TYPED_METHOD(double, deleteMany:(NSString *)collection filter:(NSDictionary *)filter) {
    return 0;
}
RCT_EXPORT_SYNCHRONOUS_TYPED_METHOD(double, count:(NSString *)collection filter:(NSDictionary *)filter) {
    return 0;
}
RCT_EXPORT_SYNCHRONOUS_TYPED_METHOD(void, createIndex:(NSString *)collection field:(NSString *)field) {}
RCT_EXPORT_SYNCHRONOUS_TYPED_METHOD(void, dropIndex:(NSString *)collection field:(NSString *)field) {}
RCT_EXPORT_SYNCHRONOUS_TYPED_METHOD(void, createFtsIndex:(NSString *)collection field:(NSString *)field) {}
RCT_EXPORT_SYNCHRONOUS_TYPED_METHOD(void, dropFtsIndex:(NSString *)collection field:(NSString *)field) {}

@end
