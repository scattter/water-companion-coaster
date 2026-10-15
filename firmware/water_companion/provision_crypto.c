#include "provision_protocol.h"
#include <string.h>
#include <stdio.h>
#include "mbedtls/md.h"
#include "mbedtls/ecp.h"
#include "mbedtls/ecdsa.h"
#include "mbedtls/sha256.h"
#include "mbedtls/platform_util.h"

static bool load_key(mbedtls_ecp_group *group, mbedtls_ecp_point *point, const char *text)
{
    uint8_t bytes[65];
    return provision_hex(text, 65, bytes) && bytes[0] == 4
        && mbedtls_ecp_group_load(group, MBEDTLS_ECP_DP_SECP256R1) == 0
        && mbedtls_ecp_point_read_binary(group, point, bytes, sizeof(bytes)) == 0
        && mbedtls_ecp_check_pubkey(group, point) == 0;
}

bool provision_fingerprint(const char *text, char output[65])
{
    uint8_t digest[32];
    if (!text || mbedtls_sha256((const unsigned char *)text, strlen(text), digest, 0) != 0) return false;
    static const char hex[] = "0123456789abcdef";
    for (unsigned i = 0; i < sizeof(digest); ++i) {
        output[i * 2] = hex[digest[i] >> 4];
        output[i * 2 + 1] = hex[digest[i] & 15];
    }
    output[64] = 0;
    mbedtls_platform_zeroize(digest, sizeof(digest));
    return true;
}

bool provision_identity_proof(const char *token, const char *operation, const char *hardware, const char *ticket, char output[65])
{
    uint8_t key[32], digest[32];
    char message[128];
    if (!token || !provision_uuid(operation) || !provision_hex(hardware, 6, NULL) || !provision_hex(ticket, 32, NULL)) return false;
    int length = snprintf(message, sizeof(message), "%s\n%s\n%s", operation, hardware, ticket);
    const mbedtls_md_info_t *md = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
    bool ok = md && length > 0 && (size_t)length < sizeof(message)
        && mbedtls_sha256((const unsigned char *)token, strlen(token), key, 0) == 0
        && mbedtls_md_hmac(md, key, sizeof(key), (const unsigned char *)message, (size_t)length, digest) == 0;
    if (ok) {
        for (unsigned i = 0; i < sizeof(digest); ++i) snprintf(output + i * 2, 3, "%02x", digest[i]);
    }
    mbedtls_platform_zeroize(key, sizeof(key));
    mbedtls_platform_zeroize(digest, sizeof(digest));
    mbedtls_platform_zeroize(message, sizeof(message));
    return ok;
}

bool provision_public_key(const char *text)
{
    mbedtls_ecp_group group;
    mbedtls_ecp_point point;
    mbedtls_ecp_group_init(&group);
    mbedtls_ecp_point_init(&point);
    bool ok = load_key(&group, &point, text);
    mbedtls_ecp_point_free(&point);
    mbedtls_ecp_group_free(&group);
    return ok;
}

bool provision_verify_signature(const char *payload, const char *signature, const char *public_key)
{
    uint8_t bytes[64], digest[32];
    if (!payload || !provision_hex(signature, 64, bytes)) return false;
    mbedtls_ecp_group group;
    mbedtls_ecp_point point;
    mbedtls_mpi r, s;
    mbedtls_ecp_group_init(&group);
    mbedtls_ecp_point_init(&point);
    mbedtls_mpi_init(&r);
    mbedtls_mpi_init(&s);
    bool ok = load_key(&group, &point, public_key)
        && mbedtls_sha256((const unsigned char *)payload, strlen(payload), digest, 0) == 0
        && mbedtls_mpi_read_binary(&r, bytes, 32) == 0
        && mbedtls_mpi_read_binary(&s, bytes + 32, 32) == 0
        && mbedtls_ecdsa_verify(&group, digest, sizeof(digest), &point, &r, &s) == 0;
    mbedtls_mpi_free(&s);
    mbedtls_mpi_free(&r);
    mbedtls_ecp_point_free(&point);
    mbedtls_ecp_group_free(&group);
    mbedtls_platform_zeroize(digest, sizeof(digest));
    return ok;
}
