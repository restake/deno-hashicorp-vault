# deno-hashicorp-vault

An opinionated HashiCorp Vault client library for Deno.

## Features

- [Zod](https://zod.dev/) type validation
- Raw read/write API
  - Bring your own Zod types and you can send requests to any available Vault API endpoint
  - Including a way to pass response-wrapped tokens
- Token & AppRole login with automatic token renewal
- [AbortSignal](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) support for requests

## Usage

### Importing

Add into your import map:

```json
{
    "vault": "https://raw.githubusercontent.com/restake/deno-hashicorp-vault/67b015694251a9f030bc419296c93e8900ebff84/mod.ts"
}
```

Or import directly via e.g. `deps.ts`

```typescript
export * as vault from "https://raw.githubusercontent.com/restake/deno-hashicorp-vault/67b015694251a9f030bc419296c93e8900ebff84/mod.ts";
```

### Logging in to Vault

```typescript
import { VAULT_AUTH_TYPE, VaultApproleCredentials, VaultAuthentication, VaultClient, VaultTokenCredentials } from "vault";

// Use your preferred configuration loading method
const CONFIG = {
    VAULT_TOKEN: "hcv.foobarbaz",
    VAULT_NAMESPACE: undefined,
    VAULT_APPROLE_MOUNTPOINT: "auth/approle",
    VAULT_APPROLE_ROLE_ID: "foo",
    VAULT_APPROLE_SECRET_ID: "bar",
};

// Configure authentication method
let authentication: VaultAuthentication;
if (config.VAULT_TOKEN) {
    authentication = <VaultTokenCredentials> {
        [VAULT_AUTH_TYPE]: "token",
        mountpoint: "auth/token",
        token: config.VAULT_TOKEN,
    };
} else if (config.VAULT_APPROLE_ROLE_ID) {
    authentication = <VaultApproleCredentials> {
        [VAULT_AUTH_TYPE]: "approle",
        mountpoint: config.VAULT_APPROLE_MOUNTPOINT,
        roleID: config.VAULT_APPROLE_ROLE_ID,
        secretID: config.VAULT_APPROLE_SECRET_ID,
    };
} else {
    throw new Error("No Vault token nor AppRole credentials available");
}

// Create client instance
export const client = new VaultClient({
    address: config.VAULT_ADDR,
    namespace: config.VAULT_NAMESPACE,
    authentication,
});

// Log in to Vault & start token renewal timer
await client.login();

addEventListener("unload", () => {
    vault.logout();
});
```

### Listing, reading & writing KV secrets

```typescript
import { createKVReadResponse, KVListResponse, VaultAuthentication, VaultClient } from "vault";
import { z } from "zod";

const client: VaultClient<VaultAuthentication> = new VaultClient({/* ... */});

const kvMount = "secrets";
const { data: { keys } } = await client.read(KVListResponse, `${kvMount}/metadata/`, {
    method: "LIST",
});

// Read all secrets we got, and reverse their keys & values
for (const key of keys) {
    // Skip directories
    if (key.endsWith("/")) {
        continue;
    }

    // Read secret
    const { data: { data } } = await client.read(createKVReadResponse(z.record(z.string(), z.string())), `${kvMount}/data/${key}`);

    const newData: Record<string, string> = {};
    for (const [k, v] of Object.entries(data)) {
        const newK = k.split("").reverse().join("");
        const newV = v.split("").reverse().join("");

        newData[newK] = newV;
    }
    await client.write(z.any(), `${kvMount}/data/${key}`, {
        data: newData,
    });
}
```
