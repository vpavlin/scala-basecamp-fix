// Desktop-side of the interop roundtrip: reproduces calendar_sync.cpp open() +
// the double-base64-depth handleReceive fallback. Reads two lines on stdin:
//   line 1: encryptionKey (dashed 72-char string)
//   line 2: sealedOnceDecoded, base64 (what handleReceive receives = the transport
//           already peeled ONE layer; for a MOBILE message this is still b64(sealed))
// Prints the decrypted plaintext, or "OPEN-FAIL".
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <openssl/evp.h>

static int b64dec(const char *in, size_t inlen, unsigned char *out, int *outlen) {
    // OpenSSL base64 decode (no newlines).
    EVP_ENCODE_CTX *ctx = EVP_ENCODE_CTX_new();
    EVP_DecodeInit(ctx);
    int l1 = 0, l2 = 0;
    if (EVP_DecodeUpdate(ctx, out, &l1, (const unsigned char *)in, (int)inlen) < 0) { EVP_ENCODE_CTX_free(ctx); return 0; }
    EVP_DecodeFinal(ctx, out + l1, &l2);
    EVP_ENCODE_CTX_free(ctx);
    *outlen = l1 + l2;
    return 1;
}

// AES-256-GCM open of nonce(12)||tag(16)||ct, key from sscanf("%2hhx") over keyHex.
static int try_open(const char *keyHex, const unsigned char *sealed, int slen, unsigned char *pt, int *ptlen) {
    if (slen < 28) return 0;
    unsigned char key[32] = {0};
    for (size_t i = 0; i < 32 && i * 2 < strlen(keyHex); i++) sscanf(keyHex + i * 2, "%2hhx", &key[i]);
    const unsigned char *nonce = sealed;
    const unsigned char *tag = sealed + 12;
    const unsigned char *ct = sealed + 28;
    int ctlen = slen - 28;
    EVP_CIPHER_CTX *c = EVP_CIPHER_CTX_new();
    int ok = 0, outl = 0, finl = 0;
    EVP_DecryptInit_ex(c, EVP_aes_256_gcm(), NULL, key, nonce);
    EVP_DecryptUpdate(c, pt, &outl, ct, ctlen);
    EVP_CIPHER_CTX_ctrl(c, EVP_CTRL_GCM_SET_TAG, 16, (void *)tag);
    ok = EVP_DecryptFinal_ex(c, pt + outl, &finl) > 0;
    EVP_CIPHER_CTX_free(c);
    if (ok) { *ptlen = outl + finl; return 1; }
    return 0;
}

int main(void) {
    char keyHex[256], line2[8192];
    if (!fgets(keyHex, sizeof keyHex, stdin)) return 1;
    if (!fgets(line2, sizeof line2, stdin)) return 1;
    keyHex[strcspn(keyHex, "\r\n")] = 0;
    line2[strcspn(line2, "\r\n")] = 0;

    // sealedOnceDecoded (base64 text) -> bytes (peel #1 already done by transport;
    // this is the "single-depth" candidate).
    unsigned char single[8192]; int slen = 0;
    b64dec(line2, strlen(line2), single, &slen);

    unsigned char pt[8192]; int ptlen = 0;
    // Attempt 1 (desktop sender): open as-is.
    if (try_open(keyHex, single, slen, pt, &ptlen)) { fwrite(pt, 1, ptlen, stdout); printf("\n"); return 0; }
    // Attempt 2 (MOBILE sender, double-b64): peel one more base64 layer, then open.
    unsigned char dbl[8192]; int dlen = 0;
    if (b64dec((const char *)single, slen, dbl, &dlen) && try_open(keyHex, dbl, dlen, pt, &ptlen)) {
        fwrite(pt, 1, ptlen, stdout); printf("\n"); return 0;
    }
    printf("OPEN-FAIL\n");
    return 2;
}
