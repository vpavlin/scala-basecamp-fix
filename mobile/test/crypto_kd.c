// C ground truth for the AES key derivation — the EXACT code path the desktop
// core uses (src/calendar_sync.cpp): per byte i, sscanf(keyHex + i*2, "%2hhx").
// Reads one encryptionKey per line from stdin, prints its 32-byte key as hex.
#include <stdio.h>
#include <string.h>
int main(void) {
    char line[256];
    while (fgets(line, sizeof line, stdin)) {
        size_t n = strlen(line);
        while (n && (line[n-1] == '\n' || line[n-1] == '\r')) line[--n] = 0;
        if (!n) continue;
        unsigned char key[32] = {0};
        for (size_t i = 0; i < 32 && i * 2 < n; i++)
            sscanf(line + i * 2, "%2hhx", &key[i]);
        for (int i = 0; i < 32; i++) printf("%02x", key[i]);
        printf("\n");
    }
    return 0;
}
