/*
 * network_ops.c - structured network diagnostics for Windows 98 SE.
 *
 * Optional IP Helper and ICMP entry points are resolved at runtime. This is
 * deliberate: Win98 installations differ, and the agent must still start if
 * IPHLPAPI.DLL or ICMP.DLL is missing or exposes an older surface.
 *
 * C89/C90 - ANSI C only (VC6 target).
 */

#include <windows.h>
#include <winsock.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "network_ops.h"
#include "cJSON.h"

#ifndef ERROR_BUFFER_OVERFLOW
#define ERROR_BUFFER_OVERFLOW 111L
#endif

#ifndef ERROR_INSUFFICIENT_BUFFER
#define ERROR_INSUFFICIENT_BUFFER 122L
#endif

#define W98_MAX_ADAPTER_NAME_LENGTH        256
#define W98_MAX_ADAPTER_DESCRIPTION_LENGTH 128
#define W98_MAX_ADAPTER_ADDRESS_LENGTH       8
#define W98_MAX_HOSTNAME_LEN                128
#define W98_MAX_DOMAIN_NAME_LEN             128
#define W98_MAX_SCOPE_ID_LEN                256

typedef struct _W98_IP_ADDRESS_STRING {
    char String[16];
} W98_IP_ADDRESS_STRING;

typedef struct _W98_IP_ADDR_STRING {
    struct _W98_IP_ADDR_STRING *Next;
    W98_IP_ADDRESS_STRING IpAddress;
    W98_IP_ADDRESS_STRING IpMask;
    DWORD Context;
} W98_IP_ADDR_STRING;

typedef struct _W98_IP_ADAPTER_INFO {
    struct _W98_IP_ADAPTER_INFO *Next;
    DWORD ComboIndex;
    char AdapterName[W98_MAX_ADAPTER_NAME_LENGTH + 4];
    char Description[W98_MAX_ADAPTER_DESCRIPTION_LENGTH + 4];
    UINT AddressLength;
    BYTE Address[W98_MAX_ADAPTER_ADDRESS_LENGTH];
    DWORD Index;
    UINT Type;
    UINT DhcpEnabled;
    W98_IP_ADDR_STRING *CurrentIpAddress;
    W98_IP_ADDR_STRING IpAddressList;
    W98_IP_ADDR_STRING GatewayList;
    W98_IP_ADDR_STRING DhcpServer;
    BOOL HaveWins;
    W98_IP_ADDR_STRING PrimaryWinsServer;
    W98_IP_ADDR_STRING SecondaryWinsServer;
    time_t LeaseObtained;
    time_t LeaseExpires;
} W98_IP_ADAPTER_INFO;

typedef struct _W98_FIXED_INFO {
    char HostName[W98_MAX_HOSTNAME_LEN + 4];
    char DomainName[W98_MAX_DOMAIN_NAME_LEN + 4];
    W98_IP_ADDR_STRING *CurrentDnsServer;
    W98_IP_ADDR_STRING DnsServerList;
    UINT NodeType;
    char ScopeId[W98_MAX_SCOPE_ID_LEN + 4];
    UINT EnableRouting;
    UINT EnableProxy;
    UINT EnableDns;
} W98_FIXED_INFO;

typedef struct _W98_MIB_TCPROW {
    DWORD dwState;
    DWORD dwLocalAddr;
    DWORD dwLocalPort;
    DWORD dwRemoteAddr;
    DWORD dwRemotePort;
} W98_MIB_TCPROW;

typedef struct _W98_MIB_TCPTABLE {
    DWORD dwNumEntries;
    W98_MIB_TCPROW table[1];
} W98_MIB_TCPTABLE;

typedef struct _W98_MIB_UDPROW {
    DWORD dwLocalAddr;
    DWORD dwLocalPort;
} W98_MIB_UDPROW;

typedef struct _W98_MIB_UDPTABLE {
    DWORD dwNumEntries;
    W98_MIB_UDPROW table[1];
} W98_MIB_UDPTABLE;

typedef struct _W98_IP_OPTION_INFORMATION {
    UCHAR Ttl;
    UCHAR Tos;
    UCHAR Flags;
    UCHAR OptionsSize;
    PUCHAR OptionsData;
} W98_IP_OPTION_INFORMATION;

typedef struct _W98_ICMP_ECHO_REPLY {
    DWORD Address;
    DWORD Status;
    DWORD RoundTripTime;
    USHORT DataSize;
    USHORT Reserved;
    PVOID Data;
    W98_IP_OPTION_INFORMATION Options;
} W98_ICMP_ECHO_REPLY;

typedef DWORD (WINAPI *PFN_GET_ADAPTERS_INFO)(W98_IP_ADAPTER_INFO *, ULONG *);
typedef DWORD (WINAPI *PFN_GET_NETWORK_PARAMS)(W98_FIXED_INFO *, ULONG *);
typedef DWORD (WINAPI *PFN_GET_TCP_TABLE)(W98_MIB_TCPTABLE *, DWORD *, BOOL);
typedef DWORD (WINAPI *PFN_GET_UDP_TABLE)(W98_MIB_UDPTABLE *, DWORD *, BOOL);
typedef HANDLE (WINAPI *PFN_ICMP_CREATE_FILE)(void);
typedef BOOL (WINAPI *PFN_ICMP_CLOSE_HANDLE)(HANDLE);
typedef DWORD (WINAPI *PFN_ICMP_SEND_ECHO)(HANDLE, DWORD, LPVOID, WORD,
                                           W98_IP_OPTION_INFORMATION *,
                                           LPVOID, DWORD, DWORD);

static void add_ipv4_string(cJSON *arr, DWORD address)
{
    struct in_addr addr;
    const char *text;

    addr.s_addr = address;
    text = inet_ntoa(addr);
    cJSON_AddItemToArray(arr, cJSON_CreateString(text ? text : "0.0.0.0"));
}

static void ipv4_to_buffer(DWORD address, char *out, size_t out_size)
{
    struct in_addr addr;
    const char *text;

    if (!out || out_size == 0) return;
    addr.s_addr = address;
    text = inet_ntoa(addr);
    _snprintf(out, out_size, "%s", text ? text : "0.0.0.0");
    out[out_size - 1] = '\0';
}

static int resolve_ipv4(const char *host, DWORD *out_address,
                        char *out_text, size_t out_text_size)
{
    DWORD address;
    struct hostent *he;

    if (!host || !host[0] || !out_address) return 0;
    address = inet_addr(host);
    if (address == INADDR_NONE && strcmp(host, "255.255.255.255") != 0) {
        he = gethostbyname(host);
        if (!he || !he->h_addr_list || !he->h_addr_list[0]) return 0;
        memcpy(&address, he->h_addr_list[0], sizeof(address));
    }

    *out_address = address;
    if (out_text && out_text_size > 0) {
        ipv4_to_buffer(address, out_text, out_text_size);
    }
    return 1;
}

static const char *adapter_type_name(UINT type)
{
    switch (type) {
        case 1:  return "other";
        case 6:  return "ethernet";
        case 9:  return "token_ring";
        case 23: return "ppp";
        case 24: return "loopback";
        case 28: return "slip";
        default: return "unknown";
    }
}

static const char *tcp_state_name(DWORD state)
{
    switch (state) {
        case 1:  return "closed";
        case 2:  return "listen";
        case 3:  return "syn_sent";
        case 4:  return "syn_received";
        case 5:  return "established";
        case 6:  return "fin_wait_1";
        case 7:  return "fin_wait_2";
        case 8:  return "close_wait";
        case 9:  return "closing";
        case 10: return "last_ack";
        case 11: return "time_wait";
        case 12: return "delete_tcb";
        default: return "unknown";
    }
}

static void add_ip_addr_list(cJSON *arr, W98_IP_ADDR_STRING *head,
                             const char *address_key, const char *mask_key)
{
    W98_IP_ADDR_STRING *item;

    for (item = head; item != NULL; item = item->Next) {
        cJSON *entry;
        if (item->IpAddress.String[0] == '\0') continue;
        entry = cJSON_CreateObject();
        cJSON_AddStringToObject(entry, address_key, item->IpAddress.String);
        if (mask_key && item->IpMask.String[0]) {
            cJSON_AddStringToObject(entry, mask_key, item->IpMask.String);
        }
        cJSON_AddItemToArray(arr, entry);
    }
}

static void add_winsock_fallback(cJSON *result, cJSON *adapters)
{
    char hostname[256];
    struct hostent *he;
    cJSON *adapter;
    cJSON *addresses;
    int i;

    hostname[0] = '\0';
    if (gethostname(hostname, sizeof(hostname) - 1) != 0) return;
    hostname[sizeof(hostname) - 1] = '\0';
    cJSON_AddStringToObject(result, "hostname", hostname);

    he = gethostbyname(hostname);
    if (!he || !he->h_addr_list) return;

    adapter = cJSON_CreateObject();
    cJSON_AddStringToObject(adapter, "name", "winsock-local-host");
    cJSON_AddStringToObject(adapter, "description",
                            "Addresses reported by Winsock fallback");
    cJSON_AddStringToObject(adapter, "type", "unknown");
    addresses = cJSON_CreateArray();
    for (i = 0; he->h_addr_list[i] != NULL; i++) {
        DWORD address;
        cJSON *entry;
        char text[32];
        memcpy(&address, he->h_addr_list[i], sizeof(address));
        ipv4_to_buffer(address, text, sizeof(text));
        entry = cJSON_CreateObject();
        cJSON_AddStringToObject(entry, "address", text);
        cJSON_AddItemToArray(addresses, entry);
    }
    cJSON_AddItemToObject(adapter, "addresses", addresses);
    cJSON_AddItemToArray(adapters, adapter);
}

cJSON *tool_get_network_config(cJSON *params)
{
    HMODULE iphlp;
    PFN_GET_ADAPTERS_INFO get_adapters;
    PFN_GET_NETWORK_PARAMS get_params;
    cJSON *result;
    cJSON *adapters;
    cJSON *dns_servers;
    ULONG size;
    DWORD rc;
    DWORD fetch_rc;
    W98_IP_ADAPTER_INFO *buffer;
    W98_IP_ADAPTER_INFO *adapter;
    W98_FIXED_INFO *fixed_info;

    (void)params;
    result = cJSON_CreateObject();
    adapters = cJSON_CreateArray();
    dns_servers = cJSON_CreateArray();
    cJSON_AddBoolToObject(result, "supported", 1);
    cJSON_AddStringToObject(result, "address_family", "IPv4");

    iphlp = LoadLibraryA("IPHLPAPI.DLL");
    if (!iphlp) {
        cJSON_AddBoolToObject(result, "ip_helper_available", 0);
        cJSON_AddStringToObject(result, "source", "winsock_fallback");
        add_winsock_fallback(result, adapters);
        cJSON_AddItemToObject(result, "dns_servers", dns_servers);
        cJSON_AddItemToObject(result, "adapters", adapters);
        return result;
    }

    get_adapters = (PFN_GET_ADAPTERS_INFO)GetProcAddress(iphlp, "GetAdaptersInfo");
    get_params = (PFN_GET_NETWORK_PARAMS)GetProcAddress(iphlp, "GetNetworkParams");
    cJSON_AddBoolToObject(result, "ip_helper_available", get_adapters ? 1 : 0);
    cJSON_AddStringToObject(result, "source",
                            get_adapters ? "ip_helper" : "winsock_fallback");

    if (get_params) {
        size = 0;
        rc = get_params(NULL, &size);
        if ((rc == ERROR_BUFFER_OVERFLOW || rc == ERROR_INSUFFICIENT_BUFFER) &&
            size > 0) {
            fixed_info = (W98_FIXED_INFO *)malloc(size);
            if (fixed_info && get_params(fixed_info, &size) == ERROR_SUCCESS) {
                W98_IP_ADDR_STRING *dns;
                cJSON_AddStringToObject(result, "hostname", fixed_info->HostName);
                cJSON_AddStringToObject(result, "domain", fixed_info->DomainName);
                cJSON_AddBoolToObject(result, "routing_enabled",
                                      fixed_info->EnableRouting ? 1 : 0);
                cJSON_AddBoolToObject(result, "dns_enabled",
                                      fixed_info->EnableDns ? 1 : 0);
                for (dns = &fixed_info->DnsServerList; dns; dns = dns->Next) {
                    if (dns->IpAddress.String[0]) {
                        cJSON_AddItemToArray(dns_servers,
                            cJSON_CreateString(dns->IpAddress.String));
                    }
                }
            }
            if (fixed_info) free(fixed_info);
        }
    }

    if (get_adapters) {
        size = 0;
        rc = get_adapters(NULL, &size);
        if ((rc == ERROR_BUFFER_OVERFLOW || rc == ERROR_INSUFFICIENT_BUFFER) &&
            size > 0) {
            buffer = (W98_IP_ADAPTER_INFO *)malloc(size);
            fetch_rc = buffer ? get_adapters(buffer, &size) : ERROR_NOT_ENOUGH_MEMORY;
            if (buffer && fetch_rc == ERROR_SUCCESS) {
                for (adapter = buffer; adapter; adapter = adapter->Next) {
                    cJSON *entry;
                    cJSON *addresses;
                    cJSON *gateways;
                    char mac[32];
                    size_t used;
                    UINT i;

                    entry = cJSON_CreateObject();
                    cJSON_AddStringToObject(entry, "name", adapter->AdapterName);
                    cJSON_AddStringToObject(entry, "description", adapter->Description);
                    cJSON_AddNumberToObject(entry, "index", (double)adapter->Index);
                    cJSON_AddStringToObject(entry, "type",
                                            adapter_type_name(adapter->Type));
                    cJSON_AddNumberToObject(entry, "type_code", (double)adapter->Type);
                    cJSON_AddBoolToObject(entry, "dhcp_enabled",
                                          adapter->DhcpEnabled ? 1 : 0);

                    mac[0] = '\0';
                    used = 0;
                    for (i = 0; i < adapter->AddressLength &&
                                i < W98_MAX_ADAPTER_ADDRESS_LENGTH; i++) {
                        int wrote;
                        wrote = _snprintf(mac + used, sizeof(mac) - used,
                                          i ? "-%02X" : "%02X",
                                          (unsigned int)adapter->Address[i]);
                        if (wrote < 0 || (size_t)wrote >= sizeof(mac) - used) break;
                        used += (size_t)wrote;
                    }
                    mac[sizeof(mac) - 1] = '\0';
                    cJSON_AddStringToObject(entry, "mac_address", mac);

                    addresses = cJSON_CreateArray();
                    add_ip_addr_list(addresses, &adapter->IpAddressList,
                                     "address", "netmask");
                    cJSON_AddItemToObject(entry, "addresses", addresses);

                    gateways = cJSON_CreateArray();
                    add_ip_addr_list(gateways, &adapter->GatewayList,
                                     "address", NULL);
                    cJSON_AddItemToObject(entry, "gateways", gateways);

                    if (adapter->DhcpEnabled &&
                        adapter->DhcpServer.IpAddress.String[0]) {
                        cJSON_AddStringToObject(entry, "dhcp_server",
                            adapter->DhcpServer.IpAddress.String);
                    }
                    if (adapter->HaveWins) {
                        cJSON_AddStringToObject(entry, "primary_wins",
                            adapter->PrimaryWinsServer.IpAddress.String);
                        cJSON_AddStringToObject(entry, "secondary_wins",
                            adapter->SecondaryWinsServer.IpAddress.String);
                    }
                    cJSON_AddItemToArray(adapters, entry);
                }
            } else if (!buffer) {
                cJSON_AddStringToObject(result, "partial_error", "out_of_memory");
            } else {
                cJSON_AddNumberToObject(result, "ip_helper_error", (double)fetch_rc);
            }
            if (buffer) free(buffer);
        } else if (rc != ERROR_SUCCESS) {
            cJSON_AddNumberToObject(result, "ip_helper_error", (double)rc);
        }
    } else {
        add_winsock_fallback(result, adapters);
    }

    FreeLibrary(iphlp);
    cJSON_AddItemToObject(result, "dns_servers", dns_servers);
    cJSON_AddItemToObject(result, "adapters", adapters);
    return result;
}

cJSON *tool_dns_lookup(cJSON *params)
{
    cJSON *j_host;
    cJSON *result;
    cJSON *addresses;
    cJSON *aliases;
    struct hostent *he;
    int i;

    j_host = cJSON_GetObjectItemCaseSensitive(params, "host");
    if (!cJSON_IsString(j_host) || !j_host->valuestring[0]) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "host required");
        return result;
    }

    he = gethostbyname(j_host->valuestring);
    result = cJSON_CreateObject();
    cJSON_AddStringToObject(result, "query", j_host->valuestring);
    if (!he) {
        cJSON_AddBoolToObject(result, "resolved", 0);
        cJSON_AddNumberToObject(result, "winsock_error", (double)WSAGetLastError());
        return result;
    }

    cJSON_AddBoolToObject(result, "resolved", 1);
    cJSON_AddStringToObject(result, "canonical_name", he->h_name ? he->h_name : "");
    addresses = cJSON_CreateArray();
    if (he->h_addrtype == AF_INET && he->h_addr_list) {
        for (i = 0; he->h_addr_list[i] != NULL; i++) {
            DWORD address;
            memcpy(&address, he->h_addr_list[i], sizeof(address));
            add_ipv4_string(addresses, address);
        }
    }
    aliases = cJSON_CreateArray();
    if (he->h_aliases) {
        for (i = 0; he->h_aliases[i] != NULL; i++) {
            cJSON_AddItemToArray(aliases, cJSON_CreateString(he->h_aliases[i]));
        }
    }
    cJSON_AddItemToObject(result, "addresses", addresses);
    cJSON_AddItemToObject(result, "aliases", aliases);
    return result;
}

cJSON *tool_ping_host(cJSON *params)
{
    cJSON *j_host;
    cJSON *j_timeout;
    cJSON *result;
    HMODULE icmp_dll;
    PFN_ICMP_CREATE_FILE create_file;
    PFN_ICMP_CLOSE_HANDLE close_handle;
    PFN_ICMP_SEND_ECHO send_echo;
    HANDLE handle;
    DWORD destination;
    DWORD timeout;
    DWORD replies;
    DWORD last_error;
    char address_text[32];
    char payload[32];
    unsigned char reply_buffer[sizeof(W98_ICMP_ECHO_REPLY) + 64];
    W98_ICMP_ECHO_REPLY *reply;

    j_host = cJSON_GetObjectItemCaseSensitive(params, "host");
    j_timeout = cJSON_GetObjectItemCaseSensitive(params, "timeout_ms");
    if (!cJSON_IsString(j_host) || !j_host->valuestring[0]) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "host required");
        return result;
    }

    timeout = 2000;
    if (cJSON_IsNumber(j_timeout)) timeout = (DWORD)j_timeout->valuedouble;
    if (timeout < 100) timeout = 100;
    if (timeout > 30000) timeout = 30000;

    result = cJSON_CreateObject();
    cJSON_AddStringToObject(result, "host", j_host->valuestring);
    if (!resolve_ipv4(j_host->valuestring, &destination,
                      address_text, sizeof(address_text))) {
        cJSON_AddBoolToObject(result, "resolved", 0);
        cJSON_AddNumberToObject(result, "winsock_error", (double)WSAGetLastError());
        return result;
    }
    cJSON_AddBoolToObject(result, "resolved", 1);
    cJSON_AddStringToObject(result, "address", address_text);

    icmp_dll = LoadLibraryA("ICMP.DLL");
    if (!icmp_dll) icmp_dll = LoadLibraryA("IPHLPAPI.DLL");
    if (!icmp_dll) {
        cJSON_AddBoolToObject(result, "supported", 0);
        cJSON_AddStringToObject(result, "unsupported_reason", "icmp_api_unavailable");
        return result;
    }

    create_file = (PFN_ICMP_CREATE_FILE)GetProcAddress(icmp_dll, "IcmpCreateFile");
    close_handle = (PFN_ICMP_CLOSE_HANDLE)GetProcAddress(icmp_dll, "IcmpCloseHandle");
    send_echo = (PFN_ICMP_SEND_ECHO)GetProcAddress(icmp_dll, "IcmpSendEcho");
    if (!create_file || !close_handle || !send_echo) {
        FreeLibrary(icmp_dll);
        cJSON_AddBoolToObject(result, "supported", 0);
        cJSON_AddStringToObject(result, "unsupported_reason", "icmp_exports_unavailable");
        return result;
    }

    handle = create_file();
    if (handle == INVALID_HANDLE_VALUE) {
        last_error = GetLastError();
        FreeLibrary(icmp_dll);
        cJSON_AddBoolToObject(result, "supported", 1);
        cJSON_AddBoolToObject(result, "responded", 0);
        cJSON_AddNumberToObject(result, "win32_error", (double)last_error);
        return result;
    }

    memset(payload, 'W', sizeof(payload));
    memset(reply_buffer, 0, sizeof(reply_buffer));
    replies = send_echo(handle, destination, payload, (WORD)sizeof(payload),
                        NULL, reply_buffer, sizeof(reply_buffer), timeout);
    last_error = replies ? ERROR_SUCCESS : GetLastError();
    close_handle(handle);
    FreeLibrary(icmp_dll);

    cJSON_AddBoolToObject(result, "supported", 1);
    cJSON_AddNumberToObject(result, "timeout_ms", (double)timeout);
    cJSON_AddBoolToObject(result, "responded", replies > 0 ? 1 : 0);
    if (replies > 0) {
        reply = (W98_ICMP_ECHO_REPLY *)reply_buffer;
        cJSON_AddNumberToObject(result, "status_code", (double)reply->Status);
        cJSON_AddNumberToObject(result, "round_trip_ms",
                                (double)reply->RoundTripTime);
        cJSON_AddNumberToObject(result, "reply_bytes", (double)reply->DataSize);
        cJSON_AddNumberToObject(result, "ttl", (double)reply->Options.Ttl);
    } else {
        cJSON_AddNumberToObject(result, "win32_error", (double)last_error);
    }
    return result;
}

static void append_tcp_rows(cJSON *rows, W98_MIB_TCPTABLE *table,
                            int max_results, int include_listening,
                            int *count, int *truncated)
{
    DWORD i;

    for (i = 0; i < table->dwNumEntries; i++) {
        W98_MIB_TCPROW *row;
        cJSON *entry;
        char local[32];
        char remote[32];

        row = &table->table[i];
        if (!include_listening && row->dwState == 2) continue;
        if (*count >= max_results) {
            *truncated = 1;
            break;
        }
        ipv4_to_buffer(row->dwLocalAddr, local, sizeof(local));
        ipv4_to_buffer(row->dwRemoteAddr, remote, sizeof(remote));
        entry = cJSON_CreateObject();
        cJSON_AddStringToObject(entry, "protocol", "tcp");
        cJSON_AddStringToObject(entry, "local_address", local);
        cJSON_AddNumberToObject(entry, "local_port",
            (double)ntohs((u_short)(row->dwLocalPort & 0xFFFF)));
        cJSON_AddStringToObject(entry, "remote_address", remote);
        cJSON_AddNumberToObject(entry, "remote_port",
            (double)ntohs((u_short)(row->dwRemotePort & 0xFFFF)));
        cJSON_AddStringToObject(entry, "state", tcp_state_name(row->dwState));
        cJSON_AddNumberToObject(entry, "state_code", (double)row->dwState);
        cJSON_AddItemToArray(rows, entry);
        (*count)++;
    }
}

static void append_udp_rows(cJSON *rows, W98_MIB_UDPTABLE *table,
                            int max_results, int *count, int *truncated)
{
    DWORD i;

    for (i = 0; i < table->dwNumEntries; i++) {
        W98_MIB_UDPROW *row;
        cJSON *entry;
        char local[32];

        if (*count >= max_results) {
            *truncated = 1;
            break;
        }
        row = &table->table[i];
        ipv4_to_buffer(row->dwLocalAddr, local, sizeof(local));
        entry = cJSON_CreateObject();
        cJSON_AddStringToObject(entry, "protocol", "udp");
        cJSON_AddStringToObject(entry, "local_address", local);
        cJSON_AddNumberToObject(entry, "local_port",
            (double)ntohs((u_short)(row->dwLocalPort & 0xFFFF)));
        cJSON_AddItemToArray(rows, entry);
        (*count)++;
    }
}

cJSON *tool_list_network_connections(cJSON *params)
{
    cJSON *j_protocol;
    cJSON *j_max;
    cJSON *j_listening;
    cJSON *result;
    cJSON *rows;
    const char *protocol;
    HMODULE iphlp;
    PFN_GET_TCP_TABLE get_tcp;
    PFN_GET_UDP_TABLE get_udp;
    DWORD size;
    DWORD rc;
    W98_MIB_TCPTABLE *tcp_table;
    W98_MIB_UDPTABLE *udp_table;
    int max_results;
    int include_listening;
    int count;
    int truncated;

    j_protocol = cJSON_GetObjectItemCaseSensitive(params, "protocol");
    j_max = cJSON_GetObjectItemCaseSensitive(params, "max_results");
    j_listening = cJSON_GetObjectItemCaseSensitive(params, "include_listening");
    protocol = cJSON_IsString(j_protocol) ? j_protocol->valuestring : "all";
    if (_stricmp(protocol, "all") != 0 && _stricmp(protocol, "tcp") != 0 &&
        _stricmp(protocol, "udp") != 0) {
        result = cJSON_CreateObject();
        cJSON_AddStringToObject(result, "error", "protocol must be all, tcp, or udp");
        return result;
    }

    max_results = 500;
    if (cJSON_IsNumber(j_max)) max_results = j_max->valueint;
    if (max_results < 1) max_results = 1;
    if (max_results > 2000) max_results = 2000;
    include_listening = cJSON_IsBool(j_listening) ? cJSON_IsTrue(j_listening) : 1;

    result = cJSON_CreateObject();
    rows = cJSON_CreateArray();
    count = 0;
    truncated = 0;
    iphlp = LoadLibraryA("IPHLPAPI.DLL");
    if (!iphlp) {
        cJSON_AddBoolToObject(result, "supported", 0);
        cJSON_AddStringToObject(result, "unsupported_reason", "ip_helper_unavailable");
        cJSON_AddItemToObject(result, "connections", rows);
        return result;
    }

    get_tcp = (PFN_GET_TCP_TABLE)GetProcAddress(iphlp, "GetTcpTable");
    get_udp = (PFN_GET_UDP_TABLE)GetProcAddress(iphlp, "GetUdpTable");
    if (!get_tcp && !get_udp) {
        FreeLibrary(iphlp);
        cJSON_AddBoolToObject(result, "supported", 0);
        cJSON_AddStringToObject(result, "unsupported_reason",
                                "connection_table_exports_unavailable");
        cJSON_AddItemToObject(result, "connections", rows);
        return result;
    }

    if ((_stricmp(protocol, "all") == 0 || _stricmp(protocol, "tcp") == 0) &&
        get_tcp) {
        size = 0;
        rc = get_tcp(NULL, &size, TRUE);
        if ((rc == ERROR_INSUFFICIENT_BUFFER || rc == ERROR_BUFFER_OVERFLOW) &&
            size > 0) {
            tcp_table = (W98_MIB_TCPTABLE *)malloc(size);
            if (tcp_table && get_tcp(tcp_table, &size, TRUE) == ERROR_SUCCESS) {
                append_tcp_rows(rows, tcp_table, max_results, include_listening,
                                &count, &truncated);
            }
            if (tcp_table) free(tcp_table);
        }
    }

    if (!truncated &&
        (_stricmp(protocol, "all") == 0 || _stricmp(protocol, "udp") == 0) &&
        get_udp) {
        size = 0;
        rc = get_udp(NULL, &size, TRUE);
        if ((rc == ERROR_INSUFFICIENT_BUFFER || rc == ERROR_BUFFER_OVERFLOW) &&
            size > 0) {
            udp_table = (W98_MIB_UDPTABLE *)malloc(size);
            if (udp_table && get_udp(udp_table, &size, TRUE) == ERROR_SUCCESS) {
                append_udp_rows(rows, udp_table, max_results, &count, &truncated);
            }
            if (udp_table) free(udp_table);
        }
    }

    FreeLibrary(iphlp);
    cJSON_AddBoolToObject(result, "supported", 1);
    cJSON_AddStringToObject(result, "address_family", "IPv4");
    cJSON_AddNumberToObject(result, "count", (double)count);
    cJSON_AddBoolToObject(result, "truncated", truncated ? 1 : 0);
    cJSON_AddItemToObject(result, "connections", rows);
    return result;
}
