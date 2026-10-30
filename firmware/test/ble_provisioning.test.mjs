import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const firmware = fileURLToPath(new URL('../water_companion/', import.meta.url));
// Node crypto generated this P-256 fixture. Its private key was discarded.
const vector = {
  payload: ['coaster-provision-v1', '11111111-1111-4111-8111-111111111111', 'coaster-test', 'ab'.repeat(32),
    '22222222-2222-4222-8222-222222222222', 'https://coaster.example:8443', '7', '1800000300000', 'cd'.repeat(32)].join('\n'),
  publicKey: '04f3269fd9fa579a7e21029ee8454739712911f50d95f16f32b248964484e83e2ba664fe740e49e5de301958f39e02e833913ca22156413c7064afe37fcd6eee5a',
  signature: '1154a0bffdb9bb611a4e32d1c52f76225b14cea9fc12580b086dc2d96d2ec0bcceb6210c99910b280ace6656ac232eaeffdc9d155cc6690e61e9372ee12250c7',
};

function actual(source, signature) {
  const start = source.indexOf(`${signature}(`);
  assert.notEqual(start, -1, signature);
  const end = source.indexOf('\n}', start);
  assert.notEqual(end, -1, signature);
  return source.slice(start, end + 2);
}

function runC(program, files = [], headers = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'coaster-ble-'));
  try {
    for (const [name, content] of Object.entries(headers)) writeFileSync(join(dir, name), content);
    const source = join(dir, 'test.c'), executable = join(dir, 'test');
    writeFileSync(source, program);
    const compiled = spawnSync(process.env.CC || 'cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-Wno-unused-function',
      '-I', dir, '-I', firmware, source, ...files.map(f => join(firmware, f)), '-lm', '-o', executable], { encoding: 'utf8' });
    assert.equal(compiled.status, 0, compiled.error?.message || compiled.stderr);
    const result = spawnSync(executable, [], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.error?.message || result.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const basicHeaders = {
  'esp_err.h': '#pragma once\ntypedef int esp_err_t;\nenum { ESP_OK=0, ESP_ERR_NVS_NOT_FOUND=1, ESP_ERR_INVALID_ARG=2, ESP_ERR_INVALID_STATE=3, ESP_ERR_NO_MEM=4, ESP_ERR_INVALID_RESPONSE=5 };\n',
  'esp_wifi.h': '#pragma once\ntypedef struct { char ssid[33]; } wifi_ap_record_t;\n',
};
// Same small JSON object shim used by the existing USB C tests. Actual validation
// functions are compiled; only the parser/platform/network/flash boundaries are replaced.
const oldTest = readFileSync(new URL('./server_command.test.mjs', import.meta.url), 'utf8');
const jsonShim = oldTest.split("writeFileSync(join(directory, 'cJSON.h'), `")[1].split('`);')[0]
  + '\nstatic bool cJSON_IsObject(const cJSON *j) { return j && j->type == JSON_OBJECT; }\n'
  + 'static bool cJSON_IsNull(const cJSON *j) { return j && j->type == JSON_NULL; }\n';

const fixtures = `
static const char *payload = ${JSON.stringify(vector.payload)};
static const char *public_key = ${JSON.stringify(vector.publicKey)};
static const char *signature = ${JSON.stringify(vector.signature)};
static const char *deployment = "11111111-1111-4111-8111-111111111111";
static const char *operation = "22222222-2222-4222-8222-222222222222";
static const char *challenge = "${'ab'.repeat(32)}";
`;

test('fixed P-256/P1363 fixture verifies in Node; modified payload and signature fail', () => {
  const bytes = Buffer.from(vector.publicKey, 'hex');
  const key = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256',
    x: bytes.subarray(1, 33).toString('base64url'), y: bytes.subarray(33).toString('base64url') } });
  const signature = Buffer.from(vector.signature, 'hex');
  const options = { key, dsaEncoding: 'ieee-p1363' };
  assert(verify('sha256', Buffer.from(vector.payload), options, signature));
  assert(!verify('sha256', Buffer.from(vector.payload.replace('coaster-test', 'coaster-evil')), options, signature));
  signature[10] ^= 1;
  assert(!verify('sha256', Buffer.from(vector.payload), options, signature));
});

test('actual C framing and signed-payload parsing reject replay, limits and target substitution', () => {
  runC(`
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "provision_protocol.h"
${fixtures}
int main(void) {
    provision_trust_t trust = { .version = 1 };
    strcpy(trust.deployment_id, deployment); strcpy(trust.public_key, public_key);
    provision_candidate_t candidate = {0};
    assert(provision_payload(payload, &trust, "coaster-test", challenge, operation, 1800000000000LL, &candidate));
    assert(!strcmp(candidate.server_url, "https://coaster.example:8443") && candidate.config_version == 7);
    assert(provision_payload(payload, &trust, "coaster-test", challenge, operation, 0, &candidate));
    assert(!provision_payload(payload, &trust, "wrong-device", challenge, operation, 0, &candidate));
    assert(!provision_payload(payload, &trust, "coaster-test", "00", operation, 0, &candidate));
    assert(!provision_payload(payload, &trust, "coaster-test", challenge, deployment, 0, &candidate));
    assert(!provision_payload(payload, &trust, "coaster-test", challenge, operation, 1800000300000LL, &candidate));
    assert(!provision_payload(payload, &trust, "coaster-test", challenge, operation, 1799999999999LL, &candidate));
    char changed[800]; snprintf(changed, sizeof(changed), "%s\\n", payload);
    assert(!provision_payload(changed, &trust, "coaster-test", challenge, operation, 0, &candidate));
    strcpy(changed, payload); *strstr(changed, "\\n7\\n") = '\\r';
    assert(!provision_payload(changed, &trust, "coaster-test", challenge, operation, 0, &candidate));
    trust.deployment_id[0] = 'f';
    assert(!provision_payload(payload, &trust, "coaster-test", challenge, operation, 0, &candidate));
    assert(provision_hex(signature, 64, NULL) && provision_hex(public_key, 65, NULL));
    assert(!provision_hex(signature, 65, NULL) && !provision_hex("AB", 1, NULL));
    assert(provision_origin("https://coaster.example:8443"));
    assert(enrollment_origin("http://192.168.1.10:3001"));
    assert(enrollment_origin("http://10.0.0.2"));
    assert(enrollment_origin("http://172.16.1.2"));
    const char *bad_local[] = {"http://localhost:3001", "http://127.0.0.1", "http://8.8.8.8", "http://192.168.evil.com", "http://192.168.1.999", "http://172.32.1.2", "http://192.168.1.1/api", "http://192.168.01.1"};
    for (unsigned i=0; i<sizeof(bad_local)/sizeof(*bad_local); ++i) assert(!enrollment_origin(bad_local[i]));
    const char *bad[] = {"http://coaster.example", "https://user@host", "https://host/path", "https://host/",
        "https://host?x", "https://host#x", "https://host:0", "https://host:65536", "https://-host", "https://host..test"};
    for (unsigned i=0; i<sizeof(bad)/sizeof(bad[0]); ++i) assert(!provision_origin(bad[i]));
    assert(provision_fresh(299999, 0, 600000));
    assert(!provision_fresh(300000, 0, 600000));
    assert(!provision_fresh(600000, 590000, 600000));
    assert(!provision_fresh(10, 11, 600000));
    provision_frames_t f = {0};
    uint8_t start[] = {1,0,0,'{'}, end[] = {2,1,0,'}'};
    assert(provision_frame(&f, start, sizeof(start), 0) == PROVISION_FRAME_MORE);
    assert(provision_frame(&f, end, sizeof(end), 9999) == PROVISION_FRAME_DONE && !strcmp(f.data,"{}"));
    assert(provision_frame(&f, end, sizeof(end), 9999) == PROVISION_FRAME_ERROR);
    assert(provision_frame(&f, start, sizeof(start), 10000) == PROVISION_FRAME_MORE);
    assert(provision_frame(&f, end, sizeof(end), 20000) == PROVISION_FRAME_ERROR);
    start[1]=1; assert(provision_frame(&f,start,sizeof(start),0) == PROVISION_FRAME_ERROR); start[1]=0;
    start[0]=5; assert(provision_frame(&f,start,sizeof(start),0) == PROVISION_FRAME_ERROR); start[0]=1;
    assert(provision_frame(&f,start,sizeof(start),0) == PROVISION_FRAME_MORE);
    end[1]=2; assert(provision_frame(&f,end,sizeof(end),0) == PROVISION_FRAME_ERROR); end[1]=1;
    start[3]=0; assert(provision_frame(&f,start,sizeof(start),0) == PROVISION_FRAME_ERROR); start[3]='{';
    uint8_t frame[20] = {1,0,0}; memset(frame+3,'a',17);
    for (unsigned i=0; i<241; ++i) {
        frame[0] = i ? 0 : 1; frame[1]=i & 255; frame[2]=i >> 8;
        int result=provision_frame(&f,frame,sizeof(frame),0);
        assert(result == (i==240 ? PROVISION_FRAME_ERROR : PROVISION_FRAME_MORE));
    }
    assert(!f.active && !f.length);
}
`, ['provision_protocol.c']);
});

test('actual network-driven state machine persists before claim, recovers by GET and rolls back safely', () => {
  const state = readFileSync(join(firmware, 'provisioning.c'), 'utf8').replace(/^#include .+$/gm, '');
  const coaster = readFileSync(join(firmware, 'coaster.c'), 'utf8');
  runC(`
#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <string.h>
#include "provisioning.h"
#include "ble_provision.h"
#include "device.h"
#include "network.h"
#define portMAX_DELAY 0
#define portMUX_INITIALIZER_UNLOCKED 0
#define portENTER_CRITICAL(x) ((void)(x))
#define portEXIT_CRITICAL(x) ((void)(x))
typedef int portMUX_TYPE;
static int state_lock;
static void xSemaphoreTake(int x, int y) { (void)x; (void)y; }
static void xSemaphoreGive(int x) { (void)x; }
static int64_t clock_ms, epoch;
static int64_t esp_timer_get_time(void) { return clock_ms * 1000; }
bool network_has_time(void) { return epoch > 0; }
int64_t network_epoch_ms(void) { return epoch; }
bool network_set_time(int64_t value) { if (!epoch) epoch=value; return true; }
${fixtures}
static cJSON *input;
static cJSON *cJSON_ParseWithOpts(const char *s, const char **end, bool require_end) {
    (void)s; (void)end; (void)require_end; cJSON *r=input; input=NULL; return r;
}
static provision_record_t journal;
static bool journal_present, verify_ok, reuse_identity;
static int saves, claims, queries, completes, wifi_switches, save_error, cleanup_error, commit_error;
static int http_error;
static const char *remote_status;
static const char *owner="33333333-3333-4333-8333-333333333333";
static char last_stage[24], last_code[40], last_operation[37];
static device_config_t config, disk_config;
static cup_config_t cups, disk_cups;
static cup_setup_t cup_setup;
static binding_state_t binding, disk_binding;
static weighing_t machine;
void ble_provision_status(const char *op, const char *stage, const char *message, const char *code) {
    (void)message; snprintf(last_stage,sizeof(last_stage),"%s",stage);
    snprintf(last_code,sizeof(last_code),"%s",code ? code : "");
    snprintf(last_operation,sizeof(last_operation),"%s",op ? op : "");
}
esp_err_t storage_load_provision(provision_record_t *r) { if (!journal_present) return ESP_ERR_NVS_NOT_FOUND; *r=journal; return ESP_OK; }
esp_err_t storage_save_provision(const provision_record_t *r) { ++saves; if(save_error) return save_error; journal=*r; journal_present=true; return ESP_OK; }
esp_err_t storage_clear_provision(void) { if(cleanup_error) return cleanup_error; journal_present=false; return ESP_OK; }
esp_err_t storage_clear_wifi(void) { return ESP_OK; }
esp_err_t storage_load_trust(provision_trust_t *r) { memset(r,0,sizeof(*r)); r->version=1; strcpy(r->deployment_id,deployment); strcpy(r->public_key,public_key); return ESP_OK; }
bool provision_verify_signature(const char *p,const char *s,const char *k) { assert(p && s && k); return verify_ok; }
esp_err_t device_hardware_id(char out[13]) { strcpy(out,"aabbccddeeff"); return ESP_OK; }
bool provision_identity_proof(const char *token,const char *op,const char *hw,const char *ticket,char out[65]) {
    assert(token && op && hw && ticket); memset(out,'f',64); out[64]=0; return true;
}
void device_snapshot(device_status_t *s) { memset(s,0,sizeof(*s)); }
void network_snapshot(network_status_t *s) { memset(s,0,sizeof(*s)); }
esp_err_t storage_save_config(const device_config_t *c) { if(commit_error) return commit_error; disk_config=*c; return ESP_OK; }
esp_err_t storage_save_cups(const cup_config_t *c) { if(commit_error) return commit_error; assert(cups_valid(c)); disk_cups=*c; return ESP_OK; }
esp_err_t storage_save_binding(const binding_state_t *b) { if(commit_error) return commit_error; disk_binding=*b; return ESP_OK; }
${actual(coaster, 'void device_config_snapshot')}
${actual(coaster, 'esp_err_t device_commit_provision')}
${actual(coaster, 'esp_err_t device_change_binding')}
esp_err_t network_use_wifi(const char *s,const char *p) { assert(s && p); ++wifi_switches; return ESP_OK; }
void network_apply_config(const device_config_t *c) { assert(c->device_id[0]); }
esp_err_t network_provision_request(const char *url,const char *path,const cJSON *body,cJSON **reply,int *http) {
    assert(journal_present && provisioning_busy()); assert(!strcmp(url,"https://coaster.example:8443"));
    *reply=NULL; *http=http_error;
    if(strstr(path,"/claim")) { assert(body && journal.phase==1); ++claims; }
    else if(strstr(path,"/operations/")) { assert(!body); ++queries; }
    else { assert(strstr(path,"/complete") && body); ++completes;
        assert(journal.phase==3 && !strcmp(disk_config.ssid,"new-wifi") && !strcmp(disk_binding.binding_id,owner)); }
    if(http_error) return ESP_ERR_INVALID_RESPONSE;
    *http=200; *reply=cJSON_CreateObject();
    if(strstr(path,"/complete")) { cJSON_AddBoolToObject(*reply,"ok",true); cJSON_AddStringToObject(*reply,"status","completed"); }
    else { cJSON_AddStringToObject(*reply,"operationId",operation); cJSON_AddStringToObject(*reply,"status",remote_status);
        if(!strcmp(remote_status,"claimed") || !strcmp(remote_status,"completed")) cJSON_AddStringToObject(*reply,"bindingId",owner); }
    return ESP_OK;
}
esp_err_t network_enrollment_request(const char *url,const char *path,const cJSON *body,const char *id,const char *token,cJSON **reply,int *http) {
    assert(journal_present && provisioning_busy() && !strcmp(url,"http://192.168.1.10:3001"));
    *reply=NULL; *http=http_error;
    if(strstr(path,"/claim")) { assert(body && journal.phase==1 && !id && !token); ++claims; }
    else if(strstr(path,"/query")) { assert(body && !id && !token); ++queries; }
    else { assert(strstr(path,"/complete") && body); ++completes;
        assert(journal.phase==3 && !strcmp(disk_config.device_id,reuse_identity ? "coaster-test" : "coaster-654321"));
        assert(id && !strcmp(id,disk_config.device_id) && token && !strcmp(token,disk_config.token)); }
    if(http_error) return ESP_ERR_INVALID_RESPONSE;
    *http=200; *reply=cJSON_CreateObject();
    if(strstr(path,"/complete")) { cJSON_AddBoolToObject(*reply,"ok",true); cJSON_AddStringToObject(*reply,"status","completed"); }
    else { cJSON_AddStringToObject(*reply,"operationId",operation); cJSON_AddStringToObject(*reply,"status",remote_status);
        cJSON_AddStringToObject(*reply,"hardwareId","aabbccddeeff");
        if(!strcmp(remote_status,"claimed") || !strcmp(remote_status,"completed")) {
            cJSON_AddStringToObject(*reply,"bindingId",owner); cJSON_AddStringToObject(*reply,"deviceId",reuse_identity ? "coaster-test" : "coaster-654321");
            if(!reuse_identity && !strcmp(remote_status,"claimed")) cJSON_AddStringToObject(*reply,"token","${'cd'.repeat(32)}");
        }
    }
    return ESP_OK;
}
${state}
static void prepare(void) {
    release(); memset(&journal,0,sizeof(journal)); journal_present=false;
    memset(&config,0,sizeof(config)); config.version=1; strcpy(config.device_id,"coaster-test");
    strcpy(config.token,"secret-token-never-log"); strcpy(config.ssid,"old-wifi"); strcpy(config.password,"old-password");
    strcpy(config.server_url,"https://old.example"); config.calibrated=true; config.zero_set=true;
    config.zero=1234; config.counts_per_gram=-234.5; config.empty_cup=105.5;
    memset(&binding,0,sizeof(binding)); binding.version=1; strcpy(binding.binding_id,deployment);
    cups_init(&cups, binding.binding_id, config.empty_cup); disk_cups=cups;
    memset(&cup_setup,0,sizeof(cup_setup));
    disk_config=config; disk_binding=binding;
    saves=claims=queries=completes=wifi_switches=save_error=cleanup_error=commit_error=http_error=0;
    clock_ms=1000; epoch=1800000000000LL; next_action_ms=0; verify_ok=true; reuse_identity=false; remote_status="claimed";
    last_stage[0]=last_code[0]=last_operation[0]=0;
}
static void make_input(void) {
    input=cJSON_CreateObject(); cJSON_AddNumberToObject(input,"protocolVersion",1);
    cJSON_AddStringToObject(input,"operationId",operation); cJSON_AddStringToObject(input,"ssid","new-wifi");
    cJSON_AddStringToObject(input,"password","new-password");
    cJSON *auth=cJSON_AddObjectToObject(input,"authorization"); cJSON_AddStringToObject(auth,"payload",payload); cJSON_AddStringToObject(auth,"signature",signature);
}
static void submit(void) { make_input(); assert(provisioning_submit("{}",challenge,0,600000)==ESP_OK); }
static void submit_enrollment(bool fresh) {
    if(fresh) { config.token[0]=config.server_url[0]=0; binding.binding_id[0]=0; disk_config=config; disk_binding=binding; }
    input=cJSON_CreateObject(); cJSON_AddNumberToObject(input,"protocolVersion",2);
    cJSON_AddStringToObject(input,"operationId",operation); cJSON_AddStringToObject(input,"ssid","new-wifi");
    cJSON_AddStringToObject(input,"password","new-password"); cJSON_AddStringToObject(input,"hardwareId","aabbccddeeff");
    cJSON_AddStringToObject(input,"challenge",challenge); cJSON_AddStringToObject(input,"serverUrl","http://192.168.1.10:3001");
    cJSON_AddStringToObject(input,"ticket","${'ef'.repeat(32)}"); cJSON_AddNumberToObject(input,"expiresAt",1800000300000.0);
    assert(provisioning_submit("{}",challenge,0,600000)==ESP_OK);
}
static void tick(int64_t t, bool connected) { clock_ms=t; provisioning_poll(t,connected); }
static void reboot(void) {
    config=disk_config; binding=disk_binding; cups=disk_cups; config.empty_cup=cups_weight(&cups);
    memset(&cup_setup,0,sizeof(cup_setup)); release(); next_action_ms=0; epoch=0;
    assert(provisioning_start()==ESP_OK && provisioning_busy());
}
int main(void) {
    prepare(); submit_enrollment(true); tick(1000,false);
    assert(journal.version==2 && !config.token[0] && !strcmp(journal.hardware_id,"aabbccddeeff"));
    tick(2000,true); assert(claims==1 && phase==P_SAVE && !config.token[0]);
    tick(3000,true); assert(phase==P_FINISH && completes==1 && !strcmp(config.device_id,"coaster-654321"));
    assert(!strcmp(config.token,"${'cd'.repeat(32)}") && config.zero==1234 && config.counts_per_gram==-234.5);
    tick(4000,true); assert(!provisioning_busy() && !strcmp(last_stage,"completed"));
    prepare(); submit_enrollment(true); tick(1000,false); http_error=503; tick(2000,true);
    assert(claims==1 && phase==P_QUERY); reboot(); http_error=0;
    tick(3000,false); tick(4000,true); tick(9000,true); tick(10000,true);
    assert(claims==1 && completes==1 && !provisioning_busy() && !strcmp(config.device_id,"coaster-654321"));
    prepare(); submit_enrollment(true); tick(1000,false); tick(2000,true); tick(3000,true);
    reboot(); remote_status="completed"; tick(4000,false); tick(5000,true); tick(10000,true); tick(11000,true);
    assert(!provisioning_busy() && !strcmp(config.token,"${'cd'.repeat(32)}"));
    prepare(); submit_enrollment(true); tick(1000,false); tick(46000,false); tick(47000,false);
    assert(!provisioning_busy() && !config.token[0] && !strcmp(config.ssid,"old-wifi") && claims==0);
    prepare(); submit_enrollment(false); tick(1000,false);
    assert(!provisioning_busy() && claims==0 && saves==0);
    prepare(); reuse_identity=true; strcpy(config.server_url,"http://192.168.1.10:3001");
    memset(config.token,'x',128); config.token[128]=0; strcpy(binding.binding_id,owner);
    strcpy(cups.binding_id,owner); disk_cups=cups;
    disk_config=config; disk_binding=binding;
    submit_enrollment(false); tick(1000,false); tick(2000,true); tick(3000,true); tick(4000,true);
    assert(!provisioning_busy() && claims==1 && completes==1 && config.empty_cup==105.5);
    assert(strlen(config.token)==128 && !strcmp(config.device_id,"coaster-test"));
    prepare(); submit_enrollment(true); cJSON_GetObjectItemCaseSensitive(input,"hardwareId")->valuestring[0]='0'; tick(1000,false);
    assert(!provisioning_busy() && !saves && !claims && !wifi_switches);
    prepare(); submit_enrollment(true); cJSON_GetObjectItemCaseSensitive(input,"challenge")->valuestring[0]='0'; tick(1000,false);
    assert(!provisioning_busy() && !saves && !claims && !wifi_switches);
    prepare(); submit(); assert(provisioning_busy()); tick(1000,false);
    assert(journal_present && saves==1 && claims==0 && wifi_switches==1 && !strcmp(config.ssid,"old-wifi"));
    tick(2000,true); assert(claims==1 && phase==P_SAVE);
    tick(3000,true); assert(completes==1 && phase==P_FINISH && !strcmp(binding.binding_id,owner) && config.empty_cup==0);
    assert(config.zero==1234 && config.counts_per_gram==-234.5 && !strcmp(config.token,"secret-token-never-log"));
    tick(4000,true); assert(!provisioning_busy() && !journal_present && !strcmp(last_stage,"completed"));
    prepare(); strcpy(binding.binding_id,owner); disk_binding=binding; strcpy(cups.binding_id,owner); disk_cups=cups;
    submit(); tick(1000,false); tick(2000,true); tick(3000,true);
    assert(config.empty_cup==105.5); tick(4000,true);
    prepare(); submit(); tick(1000,false); tick(46000,false); assert(phase==P_ROLLBACK); tick(47000,false);
    assert(!provisioning_busy() && !strcmp(config.ssid,"old-wifi") && config.empty_cup==105.5 && claims==0);
    prepare(); submit(); tick(1000,false); http_error=503; tick(2000,true); assert(claims==1 && phase==P_QUERY);
    tick(3000,true); assert(queries==1 && provisioning_busy() && claims==1);
    http_error=0; tick(8000,true); tick(13000,true); tick(14000,true);
    assert(claims==1 && !provisioning_busy() && !strcmp(last_stage,"completed"));
    prepare(); submit(); tick(1000,false); reboot(); tick(2000,false); tick(3000,true);
    assert(claims==0 && queries==1 && epoch==1800000000000LL); tick(8000,true); tick(9000,true);
    assert(!provisioning_busy() && completes==1);
    prepare(); submit(); tick(1000,false); reboot(); remote_status="issued"; tick(2000,false); tick(3000,true); tick(8000,true);
    assert(claims==0 && !provisioning_busy() && !strcmp(last_code,"INTERRUPTED") && !strcmp(config.ssid,"old-wifi"));
    prepare(); submit(); tick(1000,false); tick(2000,true); commit_error=99; tick(3000,true);
    assert(provisioning_busy() && completes==0 && !strcmp(config.ssid,"old-wifi"));
    reboot(); commit_error=0; tick(4000,false); tick(5000,true); tick(10000,true); tick(11000,true);
    assert(!provisioning_busy() && claims==1 && completes==1);
    prepare(); submit(); tick(1000,false); tick(2000,true); tick(3000,true); cleanup_error=99; tick(4000,true);
    assert(provisioning_busy() && journal_present && journal.phase==3 && completes==1);
    cleanup_error=0; reboot(); remote_status="cancelled"; tick(5000,false); tick(6000,true); tick(11000,true);
    assert(!provisioning_busy() && !strcmp(config.ssid,"old-wifi") && !strcmp(binding.binding_id,deployment));
    prepare(); verify_ok=false; submit(); tick(1000,false);
    assert(!provisioning_busy() && claims==0 && wifi_switches==0 && saves==0 && !strcmp(last_stage,"failed") && !strcmp(last_operation,operation));
    prepare(); make_input(); cJSON_AddStringToObject(input,"token","injected-token");
    assert(provisioning_submit("{}",challenge,0,600000)==ESP_OK); tick(1000,false);
    assert(!provisioning_busy() && saves==0 && claims==0);
    prepare(); submit(); clock_ms=300000; provisioning_poll(clock_ms,false);
    assert(!provisioning_busy() && saves==0 && claims==0);
    prepare(); assert(device_change_binding(deployment)==ESP_OK && config.empty_cup==105.5);
    assert(device_change_binding(owner)==ESP_OK && config.empty_cup==0 && !strcmp(disk_binding.binding_id,owner));
    prepare(); submit(); save_error=99; tick(1000,false);
    assert(phase==P_ROLLBACK && claims==0 && !wifi_switches && provisioning_busy());
    tick(2000,false); assert(provisioning_busy() && claims==0);
    save_error=0; tick(3000,false); assert(!provisioning_busy() && !strcmp(config.ssid,"old-wifi"));
    prepare(); make_input(); cJSON_AddNumberToObject(input,"protocolVersion",1);
    assert(provisioning_submit("{}",challenge,0,600000)==ESP_OK); tick(1000,false);
    assert(!provisioning_busy() && saves==0);
    assert(!bounded_json("[[[[[]]]]]")); assert(bounded_json("{\\\"ssid\\\":\\\"a{b}\\\"}"));
    assert(!utf8((const unsigned char *)"\\xc0\\x80"));
    assert(!utf8((const unsigned char *)"\\xed\\xa0\\x80"));
    assert(utf8((const unsigned char *)"\\xe4\\xb8\\xad"));
}
`, ['provision_protocol.c', 'weighing.c', 'cups.c'], { ...basicHeaders, 'cJSON.h': jsonShim });
});

test('actual USB trust and factory-info commands preserve identity, reject invalid trust and expose only a fingerprint', () => {
  const coaster = readFileSync(join(firmware, 'coaster.c'), 'utf8');
  runC(`
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "device.h"
#define portMAX_DELAY 0
static int state_lock;
static device_config_t config;
static provision_trust_t trust, saved_trust;
static bool restart_required, busy;
static int save_error, saves;
static void xSemaphoreTake(int a,int b) {(void)a;(void)b;}
static void xSemaphoreGive(int a) {(void)a;}
static bool provisioning_busy(void) {return busy;}
${fixtures}
bool provision_public_key(const char *value) { return value && !strcmp(value,public_key); }
bool provision_fingerprint(const char *value,char output[65]) {
    assert(!strcmp(value,"device-secret-token")); memset(output,'a',64); output[64]=0; return true;
}
esp_err_t storage_save_trust(const provision_trust_t *value) {
    ++saves; if(save_error) return save_error; saved_trust=*value; return ESP_OK;
}
${actual(coaster, 'static const char *field')}
${actual(coaster, 'static cJSON *reply')}
${actual(coaster, 'static cJSON *factory_command')}
int main(void) {
    (void)payload; (void)signature; (void)operation; (void)challenge;
    strcpy(config.device_id,"coaster-test"); strcpy(config.token,"device-secret-token");
    strcpy(config.server_url,"https://saved.example");
    cJSON *request=cJSON_CreateObject(); cJSON_AddStringToObject(request,"cmd","trust");
    cJSON_AddStringToObject(request,"deploymentId",deployment); cJSON_AddStringToObject(request,"publicKey",public_key);
    cJSON *response=factory_command(request); assert(cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(response,"ok")));
    cJSON_Delete(response); assert(saves==1 && restart_required && !strcmp(trust.public_key,public_key));
    assert(!strcmp(config.token,"device-secret-token") && !strcmp(config.device_id,"coaster-test"));
    busy=true; response=factory_command(request); assert(!cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(response,"ok")) && saves==1);
    cJSON_Delete(response); busy=false; save_error=99; response=factory_command(request);
    assert(!cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(response,"ok")) && saves==2); cJSON_Delete(response);
    cJSON_GetObjectItemCaseSensitive(request,"publicKey")->valuestring[0]='0';
    cJSON_GetObjectItemCaseSensitive(request,"publicKey")->valuestring[1]='2';
    response=factory_command(request); assert(!cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(response,"ok")) && saves==2);
    cJSON_Delete(response); cJSON_Delete(request);
    request=cJSON_CreateObject(); cJSON_AddStringToObject(request,"cmd","factory-info");
    response=factory_command(request);
    assert(!cJSON_GetObjectItemCaseSensitive(response,"token"));
    assert(strlen(field(response,"tokenFingerprint"))==64 && !strcmp(field(response,"serverUrl"),config.server_url));
    assert(!strcmp(field(response,"firmwareVersion"),FIRMWARE_VERSION));
    assert(!strcmp(field(response,"deploymentId"),deployment) && !strcmp(field(response,"publicKey"),public_key));
    cJSON_Delete(response); cJSON_Delete(request);
}
`, ['provision_protocol.c'], { ...basicHeaders, 'cJSON.h': jsonShim });
});

test('actual storage reads legacy events without modifying their blobs or assigning a current binding', () => {
  const storage = readFileSync(join(firmware, 'storage.c'), 'utf8');
  runC(`
#include <assert.h>
#include <inttypes.h>
#include <math.h>
#include <stdio.h>
#include <string.h>
#include "storage.h"
static unsigned char blob[512], original[512];
static size_t blob_size;
static int events, writes;
static int nvs_get_blob(int handle,const char *key,void *out,size_t *size) {
    (void)handle; assert(!strcmp(key,"e00000001"));
    if(out) { assert(*size>=blob_size); memcpy(out,blob,blob_size); } *size=blob_size; return ESP_OK;
}
static int nvs_set_blob(int handle,const char *key,const void *in,size_t size) {
    (void)handle; assert(!strcmp(key,"e00000001")); ++writes; memcpy(blob,in,size); blob_size=size; return ESP_OK;
}
static int nvs_commit(int handle) { (void)handle; return ESP_OK; }
${actual(storage, 'static void key_for')}
${actual(storage, 'static bool valid_event')}
${actual(storage, 'static esp_err_t read_event')}
${actual(storage, 'static esp_err_t write_event')}
int main(void) {
    legacy_event_t old={.version=1,.boot_id=1,.uptime_ms=10,.epoch_ms=1800000000000LL,
        .change={.drink=true,.before=200,.after=180,.amount=20}};
    strcpy(old.id,"11111111-1111-4111-8111-111111111111");
    memcpy(blob,&old,sizeof(old)); blob_size=sizeof(old); memcpy(original,blob,blob_size);
    saved_event_t loaded;
    assert(read_event(1,&loaded)==ESP_OK && loaded.version==1 && !loaded.binding_id[0]);
    assert(!writes && blob_size==sizeof(old) && !memcmp(blob,original,blob_size));
    loaded.epoch_ms+=1000; assert(write_event(1,&loaded)==ESP_OK && blob_size==sizeof(old));
    assert(read_event(1,&loaded)==ESP_OK && loaded.epoch_ms==old.epoch_ms+1000 && !loaded.binding_id[0]);
    loaded.version=EVENT_VERSION; strcpy(loaded.binding_id,"22222222-2222-4222-8222-222222222222");
    assert(write_event(1,&loaded)==ESP_OK && blob_size==sizeof(loaded));
    assert(read_event(1,&loaded)==ESP_OK && !strcmp(loaded.binding_id,"22222222-2222-4222-8222-222222222222"));
    ((saved_event_t *)blob)->binding_id[0]='X'; assert(read_event(1,&loaded)==ESP_ERR_INVALID_RESPONSE);
    blob_size=7; assert(read_event(1,&loaded)==ESP_ERR_INVALID_RESPONSE);
}
`, ['provision_protocol.c'], basicHeaders);
});

test('actual storage resumes old provisioning journals and validates new identity records without rewriting flash', () => {
  const storage = readFileSync(join(firmware, 'storage.c'), 'utf8');
  runC(`
#include <assert.h>
#include <math.h>
#include <string.h>
#include "storage.h"
static unsigned char blob[sizeof(provision_record_t)];
static size_t blob_size;
static int settings, read_error;
static int nvs_get_blob(int handle,const char *key,void *out,size_t *size) {
    (void)handle; assert(!strcmp(key,"provision_v1"));
    if(read_error) return read_error;
    if(out) { assert(*size>=blob_size); memcpy(out,blob,blob_size); }
    *size=blob_size; return ESP_OK;
}
static void save(const void *record,size_t size) { memcpy(blob,record,size); blob_size=size; }
${actual(storage, 'esp_err_t storage_load_provision')}
int main(void) {
    legacy_provision_record_t old={.version=1,.phase=1,.previous={.version=CONFIG_VERSION,
        .zero_set=true,.calibrated=true,.zero=123,.counts_per_gram=-234.5,.empty_cup=105.5},.previous_binding={.version=1}};
    strcpy(old.candidate.operation_id,"22222222-2222-4222-8222-222222222222");
    strcpy(old.candidate.ssid,"new-wifi"); strcpy(old.candidate.password,"new-password");
    strcpy(old.candidate.server_url,"https://coaster.example");
    memset(old.candidate.ticket,'c',64); old.candidate.expires_at_ms=1800000300000LL;
    strcpy(old.previous.device_id,"coaster-old"); strcpy(old.previous.token,"existing-device-credential");
    save(&old,sizeof(old));
    provision_record_t loaded; memset(&loaded,0xa5,sizeof(loaded));
    assert(storage_load_provision(&loaded)==ESP_OK && loaded.version==1);
    assert(!loaded.hardware_id[0] && !loaded.device_id[0] && !loaded.token[0]);
    assert(loaded.previous.calibrated && loaded.previous.zero==123 && loaded.previous.empty_cup==105.5);
    assert(blob_size==sizeof(old) && !memcmp(blob,&old,blob_size));
    save(&loaded,sizeof(loaded)); assert(storage_load_provision(&loaded)==ESP_OK);
    provision_record_t record=loaded; record.version=2;
    strcpy(record.hardware_id,"aabbccddeeff"); strcpy(record.candidate.server_url,"http://192.168.1.10:3001");
    save(&record,sizeof(record)); assert(storage_load_provision(&loaded)==ESP_OK && loaded.version==2);
    record.phase=2; strcpy(record.binding_id,"33333333-3333-4333-8333-333333333333");
    strcpy(record.device_id,"coaster-654321");
    save(&record,sizeof(record)); assert(storage_load_provision(&loaded)==ESP_ERR_INVALID_RESPONSE);
    memset(record.token,'f',64); save(&record,sizeof(record));
    assert(storage_load_provision(&loaded)==ESP_OK && !strcmp(loaded.device_id,"coaster-654321"));
    record.phase=3; memset(record.token,'x',128); record.token[128]=0; save(&record,sizeof(record));
    assert(storage_load_provision(&loaded)==ESP_OK && strlen(loaded.token)==128);
    assert(blob_size==sizeof(record) && !memcmp(blob,&record,blob_size));
    record.token[128]='x'; save(&record,sizeof(record)); assert(storage_load_provision(&loaded)==ESP_ERR_INVALID_RESPONSE);
    record.token[128]=0; record.hardware_id[0]='z'; save(&record,sizeof(record));
    assert(storage_load_provision(&loaded)==ESP_ERR_INVALID_RESPONSE);
    record.hardware_id[0]='a'; memset(record.device_id,'x',sizeof(record.device_id)); save(&record,sizeof(record));
    assert(storage_load_provision(&loaded)==ESP_ERR_INVALID_RESPONSE);
    old.version=2; save(&old,sizeof(old)); assert(storage_load_provision(&loaded)==ESP_ERR_INVALID_RESPONSE);
    blob_size=7; assert(storage_load_provision(&loaded)==ESP_ERR_INVALID_RESPONSE);
    read_error=ESP_ERR_NVS_NOT_FOUND; assert(storage_load_provision(&loaded)==ESP_ERR_NVS_NOT_FOUND);
}
`, ['provision_protocol.c'], basicHeaders);
});
