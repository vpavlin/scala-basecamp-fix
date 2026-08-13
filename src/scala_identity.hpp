#pragma once
// Per-device signing identity + event authentication (secp256k1 / OpenSSL), ported
// from the proven qaku implementation. BYTE-PARITY with mobile/src/lib/identity.ts —
// a desktop-signed event verifies on the phone and vice-versa:
//   address(pub)     = "0x" + hex(sha256(pub_compressed_33B))[24:64]   (last 20 bytes)
//   canonicalMessage = "scala-sig-v1|"+type+"|"+wall+"|"+ctr+"|"+dev+"|"+id+"|"+cjson(payload)
//   cjson            = compact JSON, object keys sorted lexicographically, no spaces
//   digest           = sha256(utf8(canonicalMessage))
//   sig              = secp256k1 ECDSA over digest, compact r||s (64B) hex, LOW-S
// This is the AUTHENTICITY layer (who authored an event) — orthogonal to the AES-GCM
// calendar seal (confidentiality). It turns roles from attribution into enforcement:
// a forged author claim can't produce a valid signature, so the fold drops it.
#include <string>
#include <vector>
#include <algorithm>
#include <cstdio>
#include <cstdint>
#include <openssl/ec.h>
#include <openssl/ecdsa.h>
#include <openssl/obj_mac.h>
#include <openssl/bn.h>
#include <openssl/sha.h>
#include <openssl/rand.h>
#include "logos_sync/event.hpp"

namespace scala {
using json = nlohmann::json;
using Bytes = std::vector<unsigned char>;
// Adopt the shared envelope into scala:: (scala_engine.hpp does the same; a repeated
// using-declaration in the same namespace is allowed). This header may be included
// before scala_engine's own adoption, so it must not depend on it.
using logos_sync::Event;
using logos_sync::HLC;
using logos_sync::eventToJson;
using logos_sync::eventFromJson;

// ── small crypto helpers (self-contained) ───────────────────────────────────
inline Bytes sha256b(const Bytes& in) {
    Bytes out(32);
    SHA256(in.data(), in.size(), out.data());
    return out;
}
inline Bytes strBytes(const std::string& s) { return Bytes(s.begin(), s.end()); }
inline std::string toHexS(const unsigned char* b, size_t n) {
    static const char* H = "0123456789abcdef";
    std::string o; o.reserve(n * 2);
    for (size_t i = 0; i < n; i++) { o += H[b[i] >> 4]; o += H[b[i] & 0xf]; }
    return o;
}
inline Bytes fromHexB(const std::string& s) {
    Bytes out; out.reserve(s.size() / 2);
    auto nib = [](char c) -> int {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        return -1; };
    for (size_t i = 0; i + 1 < s.size(); i += 2) {
        int hi = nib(s[i]), lo = nib(s[i + 1]);
        if (hi < 0 || lo < 0) return {};
        out.push_back((uint8_t)((hi << 4) | lo));
    }
    return out;
}

struct SignId {
    Bytes priv;            // 32B scalar
    Bytes pub;             // 33B compressed point
    std::string address;   // "0x" + 40 lowercase hex
    std::string pubHex;    // 66 lowercase hex
    bool valid = false;
};

// JSON.stringify(string) — quote + escape, matching JS exactly (bytes >= 0x80 pass
// through as UTF-8).
inline std::string jsonString(const std::string& s) {
    std::string o = "\"";
    for (unsigned char c : s) {
        switch (c) {
            case '"':  o += "\\\""; break;
            case '\\': o += "\\\\"; break;
            case '\b': o += "\\b"; break;
            case '\f': o += "\\f"; break;
            case '\n': o += "\\n"; break;
            case '\r': o += "\\r"; break;
            case '\t': o += "\\t"; break;
            default:
                if (c < 0x20) { char buf[8]; std::snprintf(buf, sizeof buf, "\\u%04x", c); o += buf; }
                else o += (char)c;
        }
    }
    return o + "\"";
}

// Canonical JSON matching identity.ts cjson(): sorted object keys, compact, integer
// numbers as-is. Scala payloads are strings/ints/bools/arrays/objects — no floats.
inline std::string cjson(const json& v) {
    if (v.is_null()) return "null";
    if (v.is_boolean()) return v.get<bool>() ? "true" : "false";
    if (v.is_string()) return jsonString(v.get<std::string>());
    if (v.is_number_integer()) return std::to_string(v.get<long long>());
    if (v.is_number_unsigned()) return std::to_string(v.get<unsigned long long>());
    if (v.is_number_float()) return json(v).dump();
    if (v.is_array()) {
        std::string o = "[";
        for (size_t i = 0; i < v.size(); i++) { if (i) o += ","; o += cjson(v[i]); }
        return o + "]";
    }
    if (v.is_object()) {
        std::vector<std::string> keys;
        for (auto it = v.begin(); it != v.end(); ++it) keys.push_back(it.key());
        std::sort(keys.begin(), keys.end());
        std::string o = "{";
        for (size_t i = 0; i < keys.size(); i++) { if (i) o += ","; o += jsonString(keys[i]) + ":" + cjson(v.at(keys[i])); }
        return o + "}";
    }
    return "null";
}

inline std::string canonicalMessage(const Event& e) {
    const std::string& dev = !e.hlc.dev.empty() ? e.hlc.dev : e.dev;
    return "scala-sig-v1|" + e.type + "|" + std::to_string(e.hlc.wall) + "|"
         + std::to_string(e.hlc.ctr) + "|" + dev + "|" + e.id + "|" + cjson(e.payload);
}

inline SignId identityFromPriv(const Bytes& priv) {
    SignId id;
    if (priv.size() != 32) return id;
    EC_KEY* key = EC_KEY_new_by_curve_name(NID_secp256k1);
    BN_CTX* ctx = BN_CTX_new();
    BIGNUM* bn = BN_bin2bn(priv.data(), 32, nullptr);
    if (key && bn && EC_KEY_set_private_key(key, bn) == 1) {
        const EC_GROUP* grp = EC_KEY_get0_group(key);
        EC_POINT* pub = EC_POINT_new(grp);
        if (EC_POINT_mul(grp, pub, bn, nullptr, nullptr, ctx) == 1 && EC_KEY_set_public_key(key, pub) == 1) {
            Bytes pubc(33);
            size_t n = EC_POINT_point2oct(grp, pub, POINT_CONVERSION_COMPRESSED, pubc.data(), 33, ctx);
            if (n == 33) {
                id.priv = priv; id.pub = pubc; id.pubHex = toHexS(pubc.data(), 33);
                Bytes h = sha256b(pubc);
                id.address = "0x" + toHexS(h.data(), 32).substr(24, 40);
                id.valid = true;
            }
        }
        EC_POINT_free(pub);
    }
    BN_free(bn); BN_CTX_free(ctx); EC_KEY_free(key);
    return id;
}

inline SignId generateIdentity() {
    Bytes priv(32);
    for (int tries = 0; tries < 8; tries++) {
        RAND_bytes(priv.data(), 32);
        SignId id = identityFromPriv(priv);
        if (id.valid) return id;
    }
    return SignId{};
}

// ECDSA sign, low-S normalized, compact r||s (64B).
inline Bytes ecdsaSignLowS(const Bytes& priv, const Bytes& digest32) {
    Bytes out;
    EC_KEY* key = EC_KEY_new_by_curve_name(NID_secp256k1);
    BIGNUM* bn = BN_bin2bn(priv.data(), (int)priv.size(), nullptr);
    if (key && bn && EC_KEY_set_private_key(key, bn) == 1) {
        ECDSA_SIG* sig = ECDSA_do_sign(digest32.data(), (int)digest32.size(), key);
        if (sig) {
            const BIGNUM* r; const BIGNUM* s;
            ECDSA_SIG_get0(sig, &r, &s);
            const EC_GROUP* grp = EC_KEY_get0_group(key);
            BN_CTX* ctx = BN_CTX_new();
            BIGNUM* order = BN_new(); EC_GROUP_get_order(grp, order, ctx);
            BIGNUM* half = BN_new(); BN_rshift1(half, order);
            BIGNUM* sN = BN_dup(s);
            if (BN_cmp(sN, half) > 0) BN_sub(sN, order, sN);
            out.assign(64, 0);
            BN_bn2binpad(r, out.data(), 32);
            BN_bn2binpad(sN, out.data() + 32, 32);
            BN_free(sN); BN_free(half); BN_free(order); BN_CTX_free(ctx);
            ECDSA_SIG_free(sig);
        }
    }
    BN_free(bn); EC_KEY_free(key);
    return out;
}

inline bool ecdsaVerify(const Bytes& pub33, const Bytes& digest32, const Bytes& sig64) {
    if (pub33.size() != 33 || sig64.size() != 64) return false;
    bool ok = false;
    EC_KEY* key = EC_KEY_new_by_curve_name(NID_secp256k1);
    BN_CTX* ctx = BN_CTX_new();
    const EC_GROUP* grp = EC_KEY_get0_group(key);
    EC_POINT* pt = EC_POINT_new(grp);
    if (EC_POINT_oct2point(grp, pt, pub33.data(), 33, ctx) == 1 && EC_KEY_set_public_key(key, pt) == 1) {
        ECDSA_SIG* sig = ECDSA_SIG_new();
        BIGNUM* r = BN_bin2bn(sig64.data(), 32, nullptr);
        BIGNUM* s = BN_bin2bn(sig64.data() + 32, 32, nullptr);
        ECDSA_SIG_set0(sig, r, s);
        ok = ECDSA_do_verify(digest32.data(), (int)digest32.size(), sig, key) == 1;
        ECDSA_SIG_free(sig);
    }
    EC_POINT_free(pt); BN_CTX_free(ctx); EC_KEY_free(key);
    return ok;
}

// Stamp the event with our address as author (dev + hlc.dev) and sign. Mutates ev.
inline void signEvent(const SignId& id, Event& e) {
    e.dev = id.address;
    e.hlc.dev = id.address;
    Bytes digest = sha256b(strBytes(canonicalMessage(e)));
    Bytes sig = ecdsaSignLowS(id.priv, digest);
    e.pub = id.pubHex;
    e.sig = toHexS(sig.data(), (int)sig.size());
}

// True iff the event is well-signed by the key whose address it claims. Never throws.
inline bool verifyEvent(const Event& e) {
    if (e.pub.empty() || e.sig.empty() || e.type.empty() || e.id.empty()) return false;
    const std::string& dev = !e.hlc.dev.empty() ? e.hlc.dev : e.dev;
    if (dev.empty()) return false;
    Bytes pub = fromHexB(e.pub);
    if (pub.size() != 33) return false;
    Bytes h = sha256b(pub);
    if ("0x" + toHexS(h.data(), 32).substr(24, 40) != dev) return false;
    Bytes sig = fromHexB(e.sig);
    if (sig.size() != 64) return false;
    Bytes digest = sha256b(strBytes(canonicalMessage(e)));
    return ecdsaVerify(pub, digest, sig);
}

// An event is "legacy" (pre-signing) when it carries no signature — admitted for
// backward compat, but never treated as an authenticated author.
inline bool isSigned(const Event& e) { return !e.sig.empty(); }

} // namespace scala
