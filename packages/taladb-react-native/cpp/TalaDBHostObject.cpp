#include "TalaDBHostObject.h"

#include <stdexcept>
#include <vector>

using namespace facebook::jsi;

namespace taladb {

// ---------------------------------------------------------------------------
// Constructor / Destructor
// ---------------------------------------------------------------------------

TalaDBHostObject::TalaDBHostObject(TalaDbHandle *db) : db_(db) {}

TalaDBHostObject::~TalaDBHostObject() {
    if (db_) {
        taladb_close(db_);
        db_ = nullptr;
    }
}

// ---------------------------------------------------------------------------
// Static installer
// ---------------------------------------------------------------------------

void TalaDBHostObject::install(Runtime &rt, TalaDbHandle *db) {
    auto hostObject = std::make_shared<TalaDBHostObject>(db);
    auto jsiObject  = Object::createFromHostObject(rt, hostObject);
    rt.global().setProperty(rt, "__TalaDB__", std::move(jsiObject));
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

std::string TalaDBHostObject::stringify(Runtime &rt, const Value &val) {
    auto json    = rt.global().getPropertyAsObject(rt, "JSON");
    auto strFn   = json.getPropertyAsFunction(rt, "stringify");
    auto result  = strFn.call(rt, val);
    if (result.isString()) {
        return result.getString(rt).utf8(rt);
    }
    return "null";
}

Value TalaDBHostObject::parse(Runtime &rt, const std::string &json) {
    auto jsonObj = rt.global().getPropertyAsObject(rt, "JSON");
    auto parseFn = jsonObj.getPropertyAsFunction(rt, "parse");
    return parseFn.call(rt, String::createFromUtf8(rt, json));
}

std::string TalaDBHostObject::valueToFilterJson(Runtime &rt, const Value &val) {
    if (val.isNull() || val.isUndefined()) {
        return "{}";
    }
    return stringify(rt, val);
}

// ---------------------------------------------------------------------------
// Property names advertised to JS
// ---------------------------------------------------------------------------

std::vector<PropNameID> TalaDBHostObject::getPropertyNames(Runtime &rt) {
    std::vector<std::string> names = {
        "insert", "insertMany",
        "find", "findOne",
        "updateOne", "updateMany",
        "deleteOne", "deleteMany",
        "count",
        "createIndex", "dropIndex",
        "createFtsIndex", "dropFtsIndex",
        "close",
    };
    std::vector<PropNameID> result;
    result.reserve(names.size());
    for (auto &n : names) {
        result.push_back(PropNameID::forUtf8(rt, n));
    }
    return result;
}

void TalaDBHostObject::set(Runtime &, const PropNameID &, const Value &) {}

// ---------------------------------------------------------------------------
// Property dispatch
// ---------------------------------------------------------------------------

Value TalaDBHostObject::get(Runtime &rt, const PropNameID &propName) {
    auto name = propName.utf8(rt);

    // ------------------------------------------------------------------
    // insert(collection: string, doc: object): string
    // ------------------------------------------------------------------
    if (name == "insert") {
        return Function::createFromHostFunction(
            rt, PropNameID::forAscii(rt, "insert"), 2,
            [this](Runtime &rt, const Value &, const Value *args, size_t count) -> Value {
                if (count < 2) throw JSError(rt, "insert requires 2 arguments");
                auto col     = args[0].getString(rt).utf8(rt);
                auto docJson = stringify(rt, args[1]);
                char *result = taladb_insert(db_, col.c_str(), docJson.c_str());
                if (!result) throw JSError(rt, "taladb_insert failed");
                std::string id(result);
                taladb_free_string(result);
                return String::createFromUtf8(rt, id);
            });
    }

    // ------------------------------------------------------------------
    // insertMany(collection: string, docs: object[]): string[]
    // ------------------------------------------------------------------
    if (name == "insertMany") {
        return Function::createFromHostFunction(
            rt, PropNameID::forAscii(rt, "insertMany"), 2,
            [this](Runtime &rt, const Value &, const Value *args, size_t count) -> Value {
                if (count < 2) throw JSError(rt, "insertMany requires 2 arguments");
                auto col      = args[0].getString(rt).utf8(rt);
                auto docsJson = stringify(rt, args[1]);
                char *result  = taladb_insert_many(db_, col.c_str(), docsJson.c_str());
                if (!result) throw JSError(rt, "taladb_insert_many failed");
                std::string json(result);
                taladb_free_string(result);
                return parse(rt, json);
            });
    }

    // ------------------------------------------------------------------
    // find(collection: string, filter: object | null): object[]
    // ------------------------------------------------------------------
    if (name == "find") {
        return Function::createFromHostFunction(
            rt, PropNameID::forAscii(rt, "find"), 2,
            [this](Runtime &rt, const Value &, const Value *args, size_t count) -> Value {
                if (count < 1) throw JSError(rt, "find requires at least 1 argument");
                auto col        = args[0].getString(rt).utf8(rt);
                auto filterJson = count > 1 ? valueToFilterJson(rt, args[1]) : "{}";
                char *result    = taladb_find(db_, col.c_str(), filterJson.c_str());
                if (!result) throw JSError(rt, "taladb_find failed");
                std::string json(result);
                taladb_free_string(result);
                return parse(rt, json);
            });
    }

    // ------------------------------------------------------------------
    // findOne(collection: string, filter: object | null): object | null
    // ------------------------------------------------------------------
    if (name == "findOne") {
        return Function::createFromHostFunction(
            rt, PropNameID::forAscii(rt, "findOne"), 2,
            [this](Runtime &rt, const Value &, const Value *args, size_t count) -> Value {
                if (count < 1) throw JSError(rt, "findOne requires at least 1 argument");
                auto col        = args[0].getString(rt).utf8(rt);
                auto filterJson = count > 1 ? valueToFilterJson(rt, args[1]) : "{}";
                char *result    = taladb_find_one(db_, col.c_str(), filterJson.c_str());
                if (!result) throw JSError(rt, "taladb_find_one failed");
                std::string json(result);
                taladb_free_string(result);
                return parse(rt, json);
            });
    }

    // ------------------------------------------------------------------
    // updateOne(collection, filter, update): boolean
    // ------------------------------------------------------------------
    if (name == "updateOne") {
        return Function::createFromHostFunction(
            rt, PropNameID::forAscii(rt, "updateOne"), 3,
            [this](Runtime &rt, const Value &, const Value *args, size_t count) -> Value {
                if (count < 3) throw JSError(rt, "updateOne requires 3 arguments");
                auto col        = args[0].getString(rt).utf8(rt);
                auto filterJson = stringify(rt, args[1]);
                auto updateJson = stringify(rt, args[2]);
                int32_t res = taladb_update_one(
                    db_, col.c_str(), filterJson.c_str(), updateJson.c_str());
                if (res < 0) throw JSError(rt, "taladb_update_one failed");
                return Value(res == 1);
            });
    }

    // ------------------------------------------------------------------
    // updateMany(collection, filter, update): number
    // ------------------------------------------------------------------
    if (name == "updateMany") {
        return Function::createFromHostFunction(
            rt, PropNameID::forAscii(rt, "updateMany"), 3,
            [this](Runtime &rt, const Value &, const Value *args, size_t count) -> Value {
                if (count < 3) throw JSError(rt, "updateMany requires 3 arguments");
                auto col        = args[0].getString(rt).utf8(rt);
                auto filterJson = stringify(rt, args[1]);
                auto updateJson = stringify(rt, args[2]);
                int32_t res = taladb_update_many(
                    db_, col.c_str(), filterJson.c_str(), updateJson.c_str());
                if (res < 0) throw JSError(rt, "taladb_update_many failed");
                return Value(static_cast<double>(res));
            });
    }

    // ------------------------------------------------------------------
    // deleteOne(collection, filter): boolean
    // ------------------------------------------------------------------
    if (name == "deleteOne") {
        return Function::createFromHostFunction(
            rt, PropNameID::forAscii(rt, "deleteOne"), 2,
            [this](Runtime &rt, const Value &, const Value *args, size_t count) -> Value {
                if (count < 2) throw JSError(rt, "deleteOne requires 2 arguments");
                auto col        = args[0].getString(rt).utf8(rt);
                auto filterJson = stringify(rt, args[1]);
                int32_t res = taladb_delete_one(db_, col.c_str(), filterJson.c_str());
                if (res < 0) throw JSError(rt, "taladb_delete_one failed");
                return Value(res == 1);
            });
    }

    // ------------------------------------------------------------------
    // deleteMany(collection, filter): number
    // ------------------------------------------------------------------
    if (name == "deleteMany") {
        return Function::createFromHostFunction(
            rt, PropNameID::forAscii(rt, "deleteMany"), 2,
            [this](Runtime &rt, const Value &, const Value *args, size_t count) -> Value {
                if (count < 2) throw JSError(rt, "deleteMany requires 2 arguments");
                auto col        = args[0].getString(rt).utf8(rt);
                auto filterJson = stringify(rt, args[1]);
                int32_t res = taladb_delete_many(db_, col.c_str(), filterJson.c_str());
                if (res < 0) throw JSError(rt, "taladb_delete_many failed");
                return Value(static_cast<double>(res));
            });
    }

    // ------------------------------------------------------------------
    // count(collection, filter): number
    // ------------------------------------------------------------------
    if (name == "count") {
        return Function::createFromHostFunction(
            rt, PropNameID::forAscii(rt, "count"), 2,
            [this](Runtime &rt, const Value &, const Value *args, size_t count) -> Value {
                if (count < 1) throw JSError(rt, "count requires at least 1 argument");
                auto col        = args[0].getString(rt).utf8(rt);
                auto filterJson = count > 1 ? valueToFilterJson(rt, args[1]) : "{}";
                int32_t res = taladb_count(db_, col.c_str(), filterJson.c_str());
                if (res < 0) throw JSError(rt, "taladb_count failed");
                return Value(static_cast<double>(res));
            });
    }

    // ------------------------------------------------------------------
    // createIndex / dropIndex / createFtsIndex / dropFtsIndex
    // ------------------------------------------------------------------
    if (name == "createIndex" || name == "dropIndex" ||
        name == "createFtsIndex" || name == "dropFtsIndex") {
        return Function::createFromHostFunction(
            rt, PropNameID::forUtf8(rt, name), 2,
            [this, name](Runtime &rt, const Value &, const Value *args, size_t count) -> Value {
                if (count < 2) throw JSError(rt, (name + " requires 2 arguments").c_str());
                auto col   = args[0].getString(rt).utf8(rt);
                auto field = args[1].getString(rt).utf8(rt);
                if      (name == "createIndex")    taladb_create_index    (db_, col.c_str(), field.c_str());
                else if (name == "dropIndex")      taladb_drop_index      (db_, col.c_str(), field.c_str());
                else if (name == "createFtsIndex") taladb_create_fts_index(db_, col.c_str(), field.c_str());
                else                               taladb_drop_fts_index  (db_, col.c_str(), field.c_str());
                return Value::undefined();
            });
    }

    // ------------------------------------------------------------------
    // close(): void  (synchronous — the destructor does the real work)
    // ------------------------------------------------------------------
    if (name == "close") {
        return Function::createFromHostFunction(
            rt, PropNameID::forAscii(rt, "close"), 0,
            [this](Runtime &rt, const Value &, const Value *, size_t) -> Value {
                if (db_) {
                    taladb_close(db_);
                    db_ = nullptr;
                }
                return Value::undefined();
            });
    }

    return Value::undefined();
}

} // namespace taladb
