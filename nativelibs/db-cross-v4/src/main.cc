#include <napi.h>
#include <openssl/evp.h>
#include <openssl/aes.h>
#include <lzma.h>
#include <fstream>
#include <vector>
#include <string>
#include <filesystem>
#include <iostream>
#include <algorithm>
#include <cctype>
#include <array>
#include <unordered_map>

namespace fs = std::filesystem;

struct FileEntry { std::string name; uint32_t size; };

static uint32_t read_u32_be(const uint8_t* p) {
    return (p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3];
}

static std::vector<uint8_t> read_file(const std::string& path) {
    std::ifstream f(path, std::ios::binary | std::ios::ate);
    if (!f) throw std::runtime_error("Cannot open input: " + path);
    size_t size = f.tellg();
    f.seekg(0, std::ios::beg);
    std::vector<uint8_t> buf(size);
    if (f.read((char*)buf.data(), size)) return buf;
    throw std::runtime_error("Failed to read: " + path);
}

static bool looks_like_hex_key(const std::string& s) {
    if (s.size() != 64) return false;
    for (char c : s) {
        if (!std::isxdigit((unsigned char)c)) return false;
    }
    return true;
}

static uint8_t hex_nibble(char c) {
    if (c >= '0' && c <= '9') return (uint8_t)(c - '0');
    if (c >= 'a' && c <= 'f') return (uint8_t)(10 + (c - 'a'));
    if (c >= 'A' && c <= 'F') return (uint8_t)(10 + (c - 'A'));
    return 0;
}

static std::vector<uint8_t> derive_aes256_key_zalo_v2(const std::string& private_key_str) {
    // Confirmed from macOS addon + brute-force:
    // - JS passes `privateKey.toUpperCase()`
    // - Native code uses the FIRST 32 ASCII chars directly as AES-256 key bytes (NO hex decode)
    std::vector<uint8_t> k(32, 0);
    for (size_t i = 0; i < 32 && i < private_key_str.size(); i++) {
        unsigned char c = (unsigned char)private_key_str[i];
        if (c >= 'a' && c <= 'z') c = (unsigned char)(c - 'a' + 'A');
        k[i] = c;
    }
    return k;
}

static bool has_zdb4_magic_at0(const std::vector<uint8_t>& pt) {
    return pt.size() >= 6 && memcmp(pt.data(), "ZDB4.0", 6) == 0;
}

static bool aes256cbc_decrypt_nopad(const std::vector<uint8_t>& ct, const std::vector<uint8_t>& key32, const uint8_t iv[16], std::vector<uint8_t>& pt_out) {
    EVP_CIPHER_CTX* ctx = EVP_CIPHER_CTX_new();
    if (!ctx) return false;
    if (1 != EVP_DecryptInit_ex(ctx, EVP_aes_256_cbc(), nullptr, key32.data(), iv)) {
        EVP_CIPHER_CTX_free(ctx);
        return false;
    }
    EVP_CIPHER_CTX_set_padding(ctx, 0);

    std::vector<uint8_t> pt(ct.size() + AES_BLOCK_SIZE);
    int len1 = 0, len2 = 0;
    if (1 != EVP_DecryptUpdate(ctx, pt.data(), &len1, ct.data(), (int)ct.size())) {
        EVP_CIPHER_CTX_free(ctx);
        return false;
    }
    if (1 != EVP_DecryptFinal_ex(ctx, pt.data() + len1, &len2)) {
        // still return output so caller can check magic; but treat as failure
        EVP_CIPHER_CTX_free(ctx);
        return false;
    }
    EVP_CIPHER_CTX_free(ctx);
    pt.resize((size_t)len1 + (size_t)len2);
    pt_out = std::move(pt);
    return true;
}

static bool aes256cbc_decrypt_nopad_chunked_reset_iv(
    const std::vector<uint8_t>& ct,
    const std::vector<uint8_t>& key32,
    std::vector<uint8_t>& pt_out) {
    // Match observed macOS behavior: decrypt in fixed-size chunks and re-init IV to zeros per chunk.
    const size_t chunk = 0x10000; // 65536
    if ((ct.size() % 16) != 0) return false;
    pt_out.clear();
    pt_out.reserve(ct.size());
    uint8_t iv0[16] = {0};
    for (size_t off = 0; off < ct.size(); off += chunk) {
        size_t len = std::min(chunk, ct.size() - off);
        // len is still 16-byte aligned because ct.size() is aligned and chunk is aligned.
        std::vector<uint8_t> part_ct(ct.begin() + (ptrdiff_t)off, ct.begin() + (ptrdiff_t)(off + len));
        std::vector<uint8_t> part_pt;
        if (!aes256cbc_decrypt_nopad(part_ct, key32, iv0, part_pt)) return false;
        pt_out.insert(pt_out.end(), part_pt.begin(), part_pt.end());
    }
    return true;
}

static bool is_sqlite_db_file(const fs::path& p) {
    std::ifstream f(p, std::ios::binary);
    if (!f) return false;
    char hdr[16] = {0};
    f.read(hdr, 16);
    // SQLite header: "SQLite format 3\0"
    const char expected[16] = {
        'S','Q','L','i','t','e',' ','f','o','r','m','a','t',' ','3','\0'
    };
    return std::equal(hdr, hdr + 16, expected);
}

static bool ensure_parent_dir(const fs::path& file_path, std::string& err) {
    try {
        fs::path parent = file_path.parent_path();
        if (!parent.empty()) fs::create_directories(parent);
        return true;
    } catch (const std::exception& e) {
        err = e.what();
        return false;
    }
}

struct DecryptResult { int code; std::string err; };

// ===== Minimal TLV + BinNet parsing (media critical) =====
// The macOS addon uses a TLV container ("tlv::TlvBox") for BinNet and for attachment blobs.
// We implement a compatible-enough reader so backup media has structured metadata (thumb/src/href/size...)
// rather than opaque binary stuffed into TEXT columns.

static uint32_t read_u32_le(const uint8_t* p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

struct TlvBoxLite {
    std::unordered_map<uint32_t, std::vector<std::vector<uint8_t>>> values;
    bool little_endian_used = true;

    bool ParseCore(const uint8_t* buf, size_t n, bool little_endian, std::string& err) {
        values.clear();
        if (!buf || n == 0) { err = "Empty buffer"; return false; }
        size_t off = 0;
        while (off + 8 <= n) {
            uint32_t key = little_endian ? read_u32_le(buf + off) : read_u32_be(buf + off);
            uint32_t len = little_endian ? read_u32_le(buf + off + 4) : read_u32_be(buf + off + 4);
            off += 8;
            if (len > (n - off)) { err = "TLV length out of bounds"; return false; }
            std::vector<uint8_t> v(buf + off, buf + off + len);
            off += len;
            values[key].push_back(std::move(v));
        }
        // Some writers may pad trailing bytes; allow small tail but reject huge garbage.
        if (off != n && (n - off) > 8) { err = "Trailing bytes"; return false; }
        return true;
    }

    int ScoreForBinNetShape() const {
        // Known keys from macOS parse paths are in low range.
        int score = 0;
        static const uint32_t expected_top[] = {0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b};
        static const uint32_t expected_attach[] = {
            0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d, 0x2e, 0x2f,
            0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37,
            0x40, 0x41, 0x42, 0x43, 0x44
        };
        for (auto k : expected_top) if (values.find(k) != values.end()) score += 6;
        for (auto k : expected_attach) if (values.find(k) != values.end()) score += 4;
        for (const auto& kv : values) {
            if (kv.first <= 0x80) score += 1;
            if (kv.first > 0x10000) score -= 3;
        }
        return score;
    }

    bool Parse(const uint8_t* buf, size_t n, std::string& err) {
        // Try LE first (current Linux assumption), then BE fallback.
        TlvBoxLite le_try;
        std::string le_err;
        bool le_ok = le_try.ParseCore(buf, n, true, le_err);
        int le_score = le_ok ? le_try.ScoreForBinNetShape() : -1000000;

        TlvBoxLite be_try;
        std::string be_err;
        bool be_ok = be_try.ParseCore(buf, n, false, be_err);
        int be_score = be_ok ? be_try.ScoreForBinNetShape() : -1000000;

        if (!le_ok && !be_ok) {
            err = !le_err.empty() ? le_err : be_err;
            return false;
        }

        if (be_score > le_score) values = std::move(be_try.values);
        else values = std::move(le_try.values);
        little_endian_used = !(be_score > le_score);
        return true;
    }

    std::vector<uint32_t> GetAllKeys() const {
        std::vector<uint32_t> ks;
        ks.reserve(values.size());
        for (const auto& it : values) ks.push_back(it.first);
        std::sort(ks.begin(), ks.end());
        return ks;
    }

    bool GetIntValue(uint32_t key, int& out) const {
        auto it = values.find(key);
        if (it == values.end() || it->second.empty()) return false;
        const auto& v = it->second[0];
        if (v.size() < 4) return false;
        out = (int)(little_endian_used ? read_u32_le(v.data()) : read_u32_be(v.data()));
        return true;
    }

    bool GetInt64Value(uint32_t key, int64_t& out) const {
        auto it = values.find(key);
        if (it == values.end() || it->second.empty()) return false;
        const auto& v = it->second[0];
        if (v.size() >= 8) {
            if (little_endian_used) {
                out = (int64_t)(
                    ((uint64_t)v[0]) |
                    ((uint64_t)v[1] << 8) |
                    ((uint64_t)v[2] << 16) |
                    ((uint64_t)v[3] << 24) |
                    ((uint64_t)v[4] << 32) |
                    ((uint64_t)v[5] << 40) |
                    ((uint64_t)v[6] << 48) |
                    ((uint64_t)v[7] << 56)
                );
            } else {
                out = (int64_t)(
                    ((uint64_t)v[7]) |
                    ((uint64_t)v[6] << 8) |
                    ((uint64_t)v[5] << 16) |
                    ((uint64_t)v[4] << 24) |
                    ((uint64_t)v[3] << 32) |
                    ((uint64_t)v[2] << 40) |
                    ((uint64_t)v[1] << 48) |
                    ((uint64_t)v[0] << 56)
                );
            }
            return true;
        }
        if (v.size() >= 4) {
            out = (int64_t)(little_endian_used ? read_u32_le(v.data()) : read_u32_be(v.data()));
            return true;
        }
        return false;
    }

    bool GetBytesValue(uint32_t key, std::vector<uint8_t>& out) const {
        auto it = values.find(key);
        if (it == values.end() || it->second.empty()) return false;
        out = it->second[0];
        return true;
    }
};

static bool IsLikelyUtf8Printable(const std::vector<uint8_t>& v) {
    if (v.empty()) return true;
    // Reject embedded NUL and most control bytes early. (This was the main source of "\u0019..." JSON garbage.)
    size_t good = 0;
    size_t bad = 0;
    for (size_t i = 0; i < v.size(); ) {
        uint8_t b = v[i];
        if (b == 0) return false;
        if (b == 9 || b == 10 || b == 13) { good++; i++; continue; } // whitespace OK
        if (b < 0x20) { bad++; i++; continue; }                      // other controls not OK
        if (b <= 0x7E) { good++; i++; continue; }                    // ASCII printable

        // Minimal UTF-8 validation for 2-4 byte sequences.
        auto need = [&](int n) -> bool { return i + (size_t)n <= v.size(); };
        if (b >= 0xC2 && b <= 0xDF) { // 2 bytes
            if (!need(2)) return false;
            uint8_t b1 = v[i+1];
            if ((b1 & 0xC0) != 0x80) { bad++; i++; continue; }
            good += 2; i += 2; continue;
        }
        if (b >= 0xE0 && b <= 0xEF) { // 3 bytes
            if (!need(3)) return false;
            uint8_t b1 = v[i+1], b2 = v[i+2];
            if ((b1 & 0xC0) != 0x80 || (b2 & 0xC0) != 0x80) { bad++; i++; continue; }
            good += 3; i += 3; continue;
        }
        if (b >= 0xF0 && b <= 0xF4) { // 4 bytes
            if (!need(4)) return false;
            uint8_t b1 = v[i+1], b2 = v[i+2], b3 = v[i+3];
            if ((b1 & 0xC0) != 0x80 || (b2 & 0xC0) != 0x80 || (b3 & 0xC0) != 0x80) { bad++; i++; continue; }
            good += 4; i += 4; continue;
        }
        // Invalid leading byte.
        bad++; i++;
    }
    // Require very high ratio of "good" bytes; otherwise treat as binary TLV.
    return bad == 0 && good * 20 >= v.size() * 19; // >= 95% good and no control garbage
}

static std::string BytesToPrintable(const std::vector<uint8_t>& v) {
    return std::string((const char*)v.data(), v.size());
}

static bool TryDecodeUtf16LePrintable(const std::vector<uint8_t>& v, std::string& out) {
    out.clear();
    if (v.size() < 4 || (v.size() % 2) != 0) return false;
    // Common pattern in these blobs: ASCII-like chars in UTF-16LE, i.e. non-zero low byte + zero high byte.
    size_t zero_hi = 0;
    size_t units = v.size() / 2;
    out.reserve(units);
    for (size_t i = 0; i + 1 < v.size(); i += 2) {
        uint8_t lo = v[i];
        uint8_t hi = v[i + 1];
        if (hi == 0) zero_hi++;
        if (hi == 0 && lo >= 0x20 && lo <= 0x7e) {
            out.push_back((char)lo);
        } else if (hi == 0 && (lo == 9 || lo == 10 || lo == 13)) {
            out.push_back((char)lo);
        } else {
            // Keep parser conservative; unsupported code points are ignored.
        }
    }
    if (out.empty()) return false;
    // Require strong UTF-16LE signature to avoid mis-decoding random binary.
    return zero_hi * 100 >= units * 60;
}

static bool TryDecodeTextSmart(const std::vector<uint8_t>& v, std::string& out) {
    if (IsLikelyUtf8Printable(v)) {
        out.assign((const char*)v.data(), v.size());
        return true;
    }
    return TryDecodeUtf16LePrintable(v, out);
}

static void ExtractPrintableRunsFromBytes(const uint8_t* buf, size_t n, std::vector<std::string>& out) {
    if (!buf || n == 0) return;
    auto push_unique = [&](const std::string& s) {
        if (s.size() < 4 || s.size() > 512) return;
        for (const auto& e : out) {
            if (e == s) return;
        }
        out.push_back(s);
    };

    // ASCII/UTF-8-safe runs (without requiring whole-buffer UTF-8 validity).
    {
        std::string run;
        run.reserve(128);
        for (size_t i = 0; i < n; i++) {
            unsigned char b = buf[i];
            bool ok = (b >= 0x20 && b <= 0x7e);
            if (ok) {
                run.push_back((char)b);
            } else {
                if (run.size() >= 4) push_unique(run);
                run.clear();
            }
        }
        if (run.size() >= 4) push_unique(run);
    }

    // UTF-16LE ASCII-like runs embedded in binary.
    {
        std::string run16;
        run16.reserve(128);
        for (size_t i = 0; i + 1 < n; i += 2) {
            unsigned char lo = buf[i];
            unsigned char hi = buf[i + 1];
            bool ok = (hi == 0 && lo >= 0x20 && lo <= 0x7e);
            if (ok) {
                run16.push_back((char)lo);
            } else {
                if (run16.size() >= 4) push_unique(run16);
                run16.clear();
            }
        }
        if (run16.size() >= 4) push_unique(run16);
    }
}

static void HeuristicScanAttachTags(const uint8_t* buf, size_t n, Napi::Env env, Napi::Object& out, std::vector<std::string>& texts) {
    if (!buf || n < 4) return;

    auto map_tag_name = [](uint8_t k) -> const char* {
        switch (k) {
            case 0x28: return "type";
            case 0x2a: return "id";
            case 0x2f: return "title";
            case 0x30: return "href";
            case 0x31: return "thumb";
            case 0x33: return "size";
            case 0x34: return "ext";
            default: return nullptr;
        }
    };

    auto push_text_unique = [&](const std::string& s) {
        if (s.empty()) return;
        for (const auto& e : texts) if (e == s) return;
        texts.push_back(s);
    };

    for (size_t i = 0; i + 3 < n; i++) {
        const uint8_t k = buf[i];
        const char* field = map_tag_name(k);
        if (!field) continue;

        struct Cand { size_t off; size_t len; };
        std::vector<Cand> cands;

        // 1-byte length
        {
            size_t off = i + 2;
            size_t len = buf[i + 1];
            if (len >= 2 && len <= 1024 && off + len <= n) cands.push_back({off, len});
        }
        // 2-byte length (BE/LE)
        if (i + 3 < n) {
            uint16_t lbe = (uint16_t)((buf[i + 1] << 8) | buf[i + 2]);
            uint16_t lle = (uint16_t)((buf[i + 2] << 8) | buf[i + 1]);
            size_t off = i + 3;
            if (lbe >= 2 && lbe <= 4096 && off + lbe <= n) cands.push_back({off, (size_t)lbe});
            if (lle >= 2 && lle <= 4096 && off + lle <= n) cands.push_back({off, (size_t)lle});
        }
        // 4-byte length (BE/LE)
        if (i + 5 < n) {
            uint32_t lbe = read_u32_be(buf + i + 1);
            uint32_t lle = read_u32_le(buf + i + 1);
            size_t off = i + 5;
            if (lbe >= 2 && lbe <= 8192 && off + lbe <= n) cands.push_back({off, (size_t)lbe});
            if (lle >= 2 && lle <= 8192 && off + lle <= n) cands.push_back({off, (size_t)lle});
        }

        for (const auto& c : cands) {
            std::vector<uint8_t> v(buf + c.off, buf + c.off + c.len);
            std::string sv;
            if (!TryDecodeTextSmart(v, sv)) continue;
            if (sv.size() < 2 || sv.size() > 2048) continue;
            push_text_unique(sv);
            if (!out.Has(field)) out.Set(field, Napi::String::New(env, sv));
            break;
        }
    }
}

static bool IsDigitsOnly(const std::string& s) {
    if (s.empty()) return false;
    for (char c : s) {
        if (c < '0' || c > '9') return false;
    }
    return true;
}

static bool LooksLikeUrl(const std::string& s) {
    return s.rfind("http://", 0) == 0 || s.rfind("https://", 0) == 0;
}

static bool LooksLikeExt(const std::string& s) {
    if (s.size() < 2 || s.size() > 10) return false;
    size_t start = (s[0] == '.') ? 1 : 0;
    if (start >= s.size()) return false;
    for (size_t i = start; i < s.size(); i++) {
        unsigned char c = (unsigned char)s[i];
        if (!(std::isalnum(c) || c == '_')) return false;
    }
    return true;
}

static bool LooksLikeIdToken(const std::string& s) {
    if (s.size() < 6 || s.size() > 128) return false;
    bool has_alnum = false;
    for (char c : s) {
        unsigned char u = (unsigned char)c;
        if (std::isspace(u)) return false;
        if (!(std::isalnum(u) || c == '_' || c == '-' || c == '.' || c == ':')) return false;
        if (std::isalnum(u)) has_alnum = true;
    }
    return has_alnum;
}

static bool LooksLikeMediaType(const std::string& s) {
    if (s.empty() || s.size() > 64) return false;
    std::string t;
    t.reserve(s.size());
    for (char c : s) t.push_back((char)std::tolower((unsigned char)c));
    if (t == "image" || t == "photo" || t == "video" || t == "file" || t == "audio" || t == "sticker" || t == "gif") return true;
    if (t.find("image/") == 0 || t.find("video/") == 0 || t.find("audio/") == 0 || t.find("application/") == 0) return true;
    return false;
}

struct Tlv8EntryLite {
    uint8_t key = 0;
    std::vector<uint8_t> value;
};

static bool ParseTlv8Lite(const uint8_t* buf, size_t n, std::vector<Tlv8EntryLite>& out) {
    out.clear();
    if (!buf || n < 2) return false;
    size_t off = 0;
    while (off + 2 <= n) {
        uint8_t key = buf[off];
        uint8_t len = buf[off + 1];
        off += 2;
        if (off + len > n) return false;
        Tlv8EntryLite e;
        e.key = key;
        e.value.assign(buf + off, buf + off + len);
        out.push_back(std::move(e));
        off += len;
    }
    return off == n;
}

static bool ReadIntFromBytes(const std::vector<uint8_t>& v, int& out) {
    if (v.empty()) return false;
    if (v.size() == 1) { out = (int)v[0]; return true; }
    if (v.size() >= 4) {
        // Prefer BE for compact TLV8 payloads observed in restore data.
        out = (int)read_u32_be(v.data() + (v.size() - 4));
        return true;
    }
    // 2-3 byte compact integer (big-endian)
    int x = 0;
    for (size_t i = 0; i < v.size(); i++) x = (x << 8) | (int)v[i];
    out = x;
    return true;
}

static void ParseAttachChatMsgLite(const uint8_t* buf, size_t n, Napi::Env env, Napi::Object& out) {
    std::string err;
    TlvBoxLite tlv;
    if (!tlv.Parse(buf, n, err)) return;

    // Key mapping aligned to macOS ParseAttachChatMsg disassembly.
    // Tags are numeric TLV keys found in the attachment object.
    for (uint32_t k : tlv.GetAllKeys()) {
        std::vector<uint8_t> v;
        if (!tlv.GetBytesValue(k, v)) continue;

        auto setStr = [&](const char* name) {
            std::string sv;
            if (TryDecodeTextSmart(v, sv)) out.Set(name, Napi::String::New(env, sv));
        };
        auto setInt = [&](const char* name) {
            int iv = 0;
            if (tlv.GetIntValue(k, iv)) out.Set(name, Napi::Number::New(env, iv));
        };

        switch (k) {
            case 0x28: setStr("type"); break;
            case 0x29: setInt("catId"); break;
            case 0x2a: setInt("id"); break;
            case 0x2b: setStr("extInfo"); break;
            case 0x2c: setInt("childNumber"); break;
            case 0x2d: setStr("action"); break;
            case 0x2e: setStr("params"); break;
            case 0x2f: setStr("title"); break;
            case 0x30: setStr("href"); break;
            case 0x31: setStr("thumb"); break;
            case 0x32: setStr("description"); break;
            case 0x33: setStr("size"); break;
            case 0x34: setStr("ext"); break;
            case 0x35: setStr("subType"); break;
            case 0x36: setStr("color"); break;
            case 0x37: setStr("property"); break;
            case 0x40: setStr("dataSource"); break;
            case 0x41: setStr("data"); break;
            case 0x42: setStr("remains"); break;
            case 0x43: setStr("zinstantData"); break;
            case 0x44: setStr("zinstantMsg"); break;
            default:
                // ignore
                break;
        }
    }
}

static void ParseReferenceOrQuoteLite(const uint8_t* buf, size_t n, Napi::Env env, Napi::Object& out) {
    std::string err;
    TlvBoxLite tlv;
    if (!tlv.Parse(buf, n, err)) return;

    int64_t i64 = 0;
    int i32 = 0;
    if (tlv.GetIntValue(0x50, i32)) out.Set("ownerId", Napi::Number::New(env, i32));
    if (tlv.GetInt64Value(0x51, i64)) out.Set("cliMsgId", Napi::Number::New(env, (double)i64));
    if (tlv.GetInt64Value(0x52, i64)) out.Set("globalMsgId", Napi::Number::New(env, (double)i64));
    if (tlv.GetIntValue(0x53, i32)) out.Set("cliMsgType", Napi::Number::New(env, i32));
    if (tlv.GetInt64Value(0x54, i64)) out.Set("ts", Napi::Number::New(env, (double)i64));
    if (tlv.GetInt64Value(0x55, i64)) out.Set("ttl", Napi::Number::New(env, (double)i64));

    std::vector<uint8_t> v;
    std::string sv;
    if (tlv.GetBytesValue(0x56, v) && TryDecodeTextSmart(v, sv)) out.Set("msg", Napi::String::New(env, sv));
    if (tlv.GetBytesValue(0x57, v) && TryDecodeTextSmart(v, sv)) out.Set("attach", Napi::String::New(env, sv));
    if (tlv.GetBytesValue(0x58, v) && TryDecodeTextSmart(v, sv)) out.Set("quoteStatus", Napi::String::New(env, sv));
    if (tlv.GetBytesValue(0x5a, v) && TryDecodeTextSmart(v, sv)) out.Set("fromD", Napi::String::New(env, sv));
}

static void ParseMentionLite(const uint8_t* buf, size_t n, Napi::Env env, Napi::Object& out) {
    std::string err;
    TlvBoxLite tlv;
    if (!tlv.Parse(buf, n, err)) return;
    int i = 0;
    if (tlv.GetIntValue(0x65, i)) out.Set("uid", Napi::Number::New(env, i));
    if (tlv.GetIntValue(0x66, i)) out.Set("pos", Napi::Number::New(env, i));
    if (tlv.GetIntValue(0x67, i)) out.Set("len", Napi::Number::New(env, i));
    if (tlv.GetIntValue(0x68, i)) out.Set("type", Napi::Number::New(env, i));
}

static DecryptResult process_zdb4_v2(
    const std::string& input_path,
    const std::string& output_path,
    const std::string& private_key_str,
    std::function<void()> progress_cb) {

    try {
        auto ct_full = read_file(input_path);
        const size_t ct_size_full = ct_full.size();
        if (ct_size_full < 16) return {-1, "Input too small"};

        // Observed layouts:
        // - Layout A: ciphertext starts at 0 and is 16-byte aligned
        // - Layout B: ciphertext starts at 4 (4-byte prefix), and (size-4) is 16-byte aligned
        // - Layout C: ciphertext starts at 0, but there are 4 trailing bytes (checksum/marker), so (size-4) is aligned
        struct CtSpan { size_t off; size_t len; };
        std::vector<CtSpan> spans;
        if ((ct_size_full % 16) == 0) spans.push_back({0, ct_size_full});
        if (ct_size_full > 4 && ((ct_size_full - 4) % 16) == 0) {
            spans.push_back({4, ct_size_full - 4}); // prefix
            spans.push_back({0, ct_size_full - 4}); // suffix
        }
        if (spans.empty()) return {-1, "Ciphertext length not AES block aligned"};

        const std::vector<uint8_t> aes_key = derive_aes256_key_zalo_v2(private_key_str);
        uint8_t iv[16] = {0}; // NULL IV (confirmed)

        std::vector<uint8_t> pt;
        bool ok_magic = false;
        for (const auto& sp : spans) {
            std::vector<uint8_t> ct(ct_full.begin() + (ptrdiff_t)sp.off, ct_full.begin() + (ptrdiff_t)(sp.off + sp.len));
            std::vector<uint8_t> tmp;
            if (!aes256cbc_decrypt_nopad_chunked_reset_iv(ct, aes_key, tmp)) {
                // fallback: standard CBC chaining (older variant)
                aes256cbc_decrypt_nopad(ct, aes_key, iv, tmp);
            }
            if (has_zdb4_magic_at0(tmp)) {
                pt = std::move(tmp);
                ok_magic = true;
                break;
            }
        }
        if (!ok_magic) return {-1, "Invalid ZDB4.0 Magic Header"};

        // NOTE: container layout is inferred; keep existing offsets but validate bounds thoroughly.
        size_t off = 14;
        uint32_t file_count = read_u32_be(pt.data() + off); off += 4;

        std::vector<FileEntry> files;
        for(uint32_t i = 0; i < file_count; i++) {
            if (off + 4 > pt.size()) return {-2, "Truncated file table"};
            uint32_t nlen = read_u32_be(pt.data() + off); off += 4;

            if (off + nlen + 4 > pt.size()) return {-2, "Truncated file table names"};
            std::string name((char*)pt.data() + off, nlen); off += nlen;

            uint32_t size = read_u32_be(pt.data() + off); off += 4;
            files.push_back({name, size});
        }

        // Payload after the file table is an XZ stream (LZMA2).
        // Use non-concatenated mode: some blobs appear to have trailing bytes after the XZ stream.
        lzma_stream strm = LZMA_STREAM_INIT;
        lzma_ret ret = lzma_stream_decoder(&strm, UINT64_MAX, 0);
        if (ret != LZMA_OK) return {-3, "Failed to init liblzma decoder"};

        strm.next_in = pt.data() + off;
        strm.avail_in = pt.size() - off;

        fs::create_directories(output_path);

        std::vector<uint8_t> out_buf(65536);
        size_t file_idx = 0;
        size_t bytes_written_for_current_file = 0;
        std::ofstream current_out;

        if (!files.empty()) {
            fs::path out_path = fs::path(output_path) / fs::path(files[file_idx].name);
            std::string err;
            if (!ensure_parent_dir(out_path, err)) return {-10, "Failed to create output directories: " + err};
            current_out.open(out_path, std::ios::binary);
            if (!current_out.is_open()) return {-11, "Failed to open output file: " + out_path.string()};
        }

        do {
            strm.next_out = out_buf.data();
            strm.avail_out = out_buf.size();

            lzma_action action = (strm.avail_in == 0) ? LZMA_FINISH : LZMA_RUN;
            ret = lzma_code(&strm, action);

            size_t decompressed_bytes = out_buf.size() - strm.avail_out;
            size_t buf_off = 0;

            while (buf_off < decompressed_bytes && file_idx < files.size()) {
                size_t needed = files[file_idx].size - bytes_written_for_current_file;
                size_t available = decompressed_bytes - buf_off;
                size_t to_write = std::min(needed, available);

                if (current_out.is_open()) {
                    current_out.write((char*)out_buf.data() + buf_off, to_write);
                }

                bytes_written_for_current_file += to_write;
                buf_off += to_write;

                if (bytes_written_for_current_file == files[file_idx].size) {
                    if (current_out.is_open()) current_out.close();

                    // CRITICAL FIX: Tell Zalo JS that EXACTLY 1 file has finished
                    if (progress_cb) progress_cb();

                    file_idx++;
                    bytes_written_for_current_file = 0;

                    if (file_idx < files.size()) {
                        fs::path out_path = fs::path(output_path) / fs::path(files[file_idx].name);
                        std::string err;
                        if (!ensure_parent_dir(out_path, err)) return {-10, "Failed to create output directories: " + err};
                        current_out.open(out_path, std::ios::binary);
                        if (!current_out.is_open()) return {-11, "Failed to open output file: " + out_path.string()};
                    }
                }
            }
        } while (ret == LZMA_OK);

        lzma_end(&strm);
        if (current_out.is_open()) current_out.close();

        if (ret != LZMA_STREAM_END) {
            return {-12, "LZMA decode did not finish cleanly"};
        }
        if (file_idx != files.size()) {
            return {-13, "Not all files were extracted"};
        }

        // Validate: at least one extracted *.db must be a real SQLite database.
        bool any_db = false;
        bool any_valid_sqlite = false;
        for (const auto& fe : files) {
            if (fe.name.size() >= 3 && fe.name.rfind(".db") == fe.name.size() - 3) {
                any_db = true;
                fs::path p = fs::path(output_path) / fs::path(fe.name);
                if (fs::exists(p) && is_sqlite_db_file(p)) {
                    any_valid_sqlite = true;
                    break;
                }
            }
        }
        if (any_db && !any_valid_sqlite) {
            return {-14, "Extracted .db files are not valid SQLite databases"};
        }
        if (!any_db) {
            return {-15, "No .db files were extracted"};
        }

        return {0, ""};
    } catch (const std::exception& e) {
        return {-99, e.what()};
    }
}

Napi::Value DecompressAndDecryptDb_V2(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    auto ret = Napi::Object::New(env);

    if (info.Length() < 3 || !info[0].IsString() || !info[1].IsString() || !info[2].IsString()) {
        ret.Set("result", -1);
        ret.Set("inner_error", Napi::String::New(env, "Invalid args"));
        ret.Set("error_message", Napi::String::New(env, "Invalid args"));
        return ret;
    }

    Napi::FunctionReference* cb_ref = nullptr;
    if (info.Length() >= 4 && info[3].IsFunction()) {
        cb_ref = new Napi::FunctionReference();
        *cb_ref = Napi::Persistent(info[3].As<Napi::Function>());
    }

    // CRITICAL FIX: No arguments. Just call it.
    auto progress_cb = [&]() {
        if (cb_ref && !cb_ref->IsEmpty()) cb_ref->Call({});
    };

    auto r = process_zdb4_v2(
        info[0].As<Napi::String>().Utf8Value(),
        info[1].As<Napi::String>().Utf8Value(),
        info[2].As<Napi::String>().Utf8Value(),
        progress_cb
    );

    if (cb_ref) delete cb_ref;

    ret.Set("result", Napi::Number::New(env, r.code));
    ret.Set("inner_error", Napi::String::New(env, r.err));
    ret.Set("error_message", Napi::String::New(env, r.err));
    return ret;
}

Napi::Value DecompressAndDecryptDb(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    auto ret = Napi::Object::New(env);
    ret.Set("result", -1);
    ret.Set("err_message", Napi::String::New(env, "V1 format not fully implemented in this build"));
    return ret;
}

Napi::Value ParseBinNet(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    auto ret = Napi::Object::New(env);
    ret.Set("result", Napi::Number::New(env, 0));
    ret.Set("error_message", Napi::String::New(env, ""));
    ret.Set("inner_error", Napi::String::New(env, ""));

    if (info.Length() < 1) {
        ret.Set("result", Napi::Number::New(env, 1));
        ret.Set("error_message", Napi::String::New(env, "Wrong arguments"));
        ret.Set("data", Napi::Object::New(env));
        return ret;
    }

    const uint8_t* p = nullptr;
    size_t n = 0;
    Napi::Value arg0 = info[0];
    Napi::ArrayBuffer abHold; // keep alive for duration of parse
    if (arg0.IsBuffer()) {
        auto buf = arg0.As<Napi::Buffer<uint8_t>>();
        p = buf.Data();
        n = buf.Length();
    } else if (arg0.IsTypedArray()) {
        // SharedWorker realm may not have Node's Buffer global; sqlite bindings often yield Uint8Array.
        // Accept Uint8Array (and other typed-array views) directly.
        auto ta = arg0.As<Napi::TypedArray>();
        abHold = ta.ArrayBuffer();
        p = (const uint8_t*)abHold.Data() + ta.ByteOffset();
        n = ta.ByteLength();
    } else if (arg0.IsArrayBuffer()) {
        abHold = arg0.As<Napi::ArrayBuffer>();
        p = (const uint8_t*)abHold.Data();
        n = abHold.ByteLength();
    } else {
        ret.Set("result", Napi::Number::New(env, 1));
        ret.Set("error_message", Napi::String::New(env, "Wrong arguments"));
        ret.Set("data", Napi::Object::New(env));
        return ret;
    }
    if (!p || n == 0) {
        ret.Set("result", Napi::Number::New(env, 2));
        ret.Set("error_message", Napi::String::New(env, "Something went wrong while parsing"));
        ret.Set("inner_error", Napi::String::New(env, "Empty BinNet"));
        ret.Set("data", Napi::Object::New(env));
        return ret;
    }

    std::string err;
    TlvBoxLite tlv;
    if (!tlv.Parse(p, n, err)) {
        ret.Set("result", Napi::Number::New(env, 2));
        ret.Set("error_message", Napi::String::New(env, "Something went wrong while parsing"));
        ret.Set("inner_error", Napi::String::New(env, err));
        ret.Set("data", Napi::Object::New(env));
        return ret;
    }

    auto debug = Napi::Object::New(env);
    debug.Set("inputLen", Napi::Number::New(env, (double)n));
    debug.Set("tlvEndian", Napi::String::New(env, tlv.little_endian_used ? "le" : "be"));
    Napi::Array topKeys = Napi::Array::New(env);
    auto allKeys = tlv.GetAllKeys();
    for (uint32_t i = 0; i < allKeys.size(); i++) {
        topKeys.Set(i, Napi::Number::New(env, allKeys[i]));
    }
    debug.Set("topKeys", topKeys);
    debug.Set("topKeyCount", Napi::Number::New(env, (double)allKeys.size()));
    Napi::Array attachCandidates = Napi::Array::New(env);
    uint32_t attachCandidateIdx = 0;

    auto data = Napi::Object::New(env);

    // Mirror macOS shape from ParseBinNet disassembly.
    Napi::Array attachs = Napi::Array::New(env);
    uint32_t attachIdx = 0;
    Napi::Array mentions = Napi::Array::New(env);
    uint32_t mentionIdx = 0;

    auto parse_attach_values = [&](const std::vector<std::vector<uint8_t>>& vals) {
        for (const auto& v : vals) {
            if (v.size() < 8) continue;
            Napi::Object att = Napi::Object::New(env);
            ParseAttachChatMsgLite(v.data(), v.size(), env, att);
            bool accepted = !att.IsEmpty();
            if (attachCandidateIdx < 32) {
                Napi::Object cand = Napi::Object::New(env);
                cand.Set("source", Napi::String::New(env, "key_0x06"));
                cand.Set("len", Napi::Number::New(env, (double)v.size()));
                cand.Set("accepted", Napi::Boolean::New(env, accepted));
                cand.Set("keys", Napi::Array::New(env));
                auto keys = att.GetPropertyNames();
                Napi::Array keyArr = Napi::Array::New(env);
                for (uint32_t i = 0; i < keys.Length() && i < 16; i++) keyArr.Set(i, keys.Get(i));
                cand.Set("keys", keyArr);
                attachCandidates.Set(attachCandidateIdx++, cand);
            }
            if (accepted) {
                attachs.Set(attachIdx++, att);
            }
        }
    };

    for (uint32_t k : tlv.GetAllKeys()) {
        auto it = tlv.values.find(k);
        if (it == tlv.values.end() || it->second.empty()) continue;

        switch (k) {
            case 0x05: { // property
                const auto& v = it->second[0];
                std::string perr;
                TlvBoxLite ptlv;
                if (ptlv.Parse(v.data(), v.size(), perr)) {
                    Napi::Object prop = Napi::Object::New(env);
                    int iv = 0;
                    std::vector<uint8_t> pv;
                    if (ptlv.GetIntValue(0x1e, iv)) prop.Set("size", Napi::Number::New(env, iv));
                    if (ptlv.GetIntValue(0x22, iv)) prop.Set("color", Napi::Number::New(env, iv));
                    if (ptlv.GetIntValue(0x20, iv)) prop.Set("type", Napi::Number::New(env, iv));
                    if (ptlv.GetIntValue(0x1f, iv)) prop.Set("subType", Napi::Number::New(env, iv));
                    if (ptlv.GetBytesValue(0x21, pv)) {
                        std::string sv;
                        if (TryDecodeTextSmart(pv, sv)) prop.Set("ext", Napi::String::New(env, sv));
                    }
                    if (!prop.IsEmpty()) data.Set("property", prop);
                }
                break;
            }
            case 0x06: { // attachs[]
                parse_attach_values(it->second);
                break;
            }
            case 0x07: { // quote
                const auto& v = it->second[0];
                Napi::Object q = Napi::Object::New(env);
                ParseReferenceOrQuoteLite(v.data(), v.size(), env, q);
                if (!q.IsEmpty()) data.Set("quote", q);
                break;
            }
            case 0x08: { // mentions[]
                for (const auto& v : it->second) {
                    Napi::Object m = Napi::Object::New(env);
                    ParseMentionLite(v.data(), v.size(), env, m);
                    if (!m.IsEmpty()) mentions.Set(mentionIdx++, m);
                }
                break;
            }
            case 0x09: { // quoteStatus
                int qst = 0;
                if (tlv.GetIntValue(0x09, qst)) data.Set("quoteStatus", Napi::Number::New(env, qst));
                break;
            }
            case 0x0a: { // dataSource
                const auto& v = it->second[0];
                if (IsLikelyUtf8Printable(v)) data.Set("dataSource", Napi::String::New(env, BytesToPrintable(v)));
                break;
            }
            case 0x0b: { // data
                const auto& v = it->second[0];
                if (IsLikelyUtf8Printable(v)) data.Set("data", Napi::String::New(env, BytesToPrintable(v)));
                break;
            }
            default: break;
        }
    }

    if (attachIdx > 0) data.Set("attachs", attachs);
    if (mentionIdx > 0) data.Set("mentions", mentions);

    ret.Set("data", data);
    debug.Set("attachCandidates", attachCandidates);
    debug.Set("attachCandidateCount", Napi::Number::New(env, (double)attachCandidateIdx));
    debug.Set("attachCount", Napi::Number::New(env, (double)attachIdx));
    ret.Set("debug", debug);
    return ret;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("decompressAndDecryptDb", Napi::Function::New(env, DecompressAndDecryptDb));
    exports.Set("decompressAndDecryptDb_V2", Napi::Function::New(env, DecompressAndDecryptDb_V2));
    exports.Set("parseBinNet", Napi::Function::New(env, ParseBinNet));
    return exports;
}

NODE_API_MODULE(db_cross_v4_native, Init)
